import type { RotaRepository } from '../types';
import type {
  AssignDriverParams,
  AssignDriverResult,
  AutoRotaPlan,
  AutoRotaResult,
  GenerateAutoRotaParams,
  DriverVisibleAssignment,
  DriverWeekRota,
  ManagerWeekRota,
  RotaAvailabilityState,
  ShiftInstanceRecord,
  UnassignDriverParams,
  UnassignDriverResult,
} from '../domain';
import { AutoRotaError, AvailabilityOverrideRequiredError, RotaAssignmentError } from '../errors';
import { runAutoRota } from '../autoRotaOrchestration';
import { summarizeOpenCoverage } from '../../lib/autoRotaPlanner';
import { buildDriverWeekRota } from '../driverRotaModel';
import { buildManagerWeekRota } from '../managerRotaModel';
import { parseISODate, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import { mockAvailability, mockDrivers, mockResorts, mockRotaAssignments, mockShiftTemplates, nextMockRotaAssignmentId } from './fixtures';
import { isMockWeekPublished } from './availability';
import { generateMockShiftInstancesForWeek } from './shiftInstances';

/**
 * Mock analogue of the manager Manual Rota data boundary (MR-B).
 *
 * It models the database's assignment rules faithfully enough for UI tests --
 * same typed errors, same first-party message text, same ORDER of checks as
 * assign_driver / unassign_driver (supabase/migrations/20261009100100_*) --
 * but it is a mock, so a few things are deliberately different:
 *
 *  - AUTO-ROTA (generateAutoRota) uses the SAME planner and the SAME retry
 *    orchestration as the Supabase provider, then applies the proposed rows to the
 *    mock assignment state (source 'auto', additive, never touching existing rows).
 *    It enforces the obvious rules -- a published week and a wholly past week are
 *    refused with the same typed AutoRotaError -- but, being a mock, it has no
 *    transaction, no week lock, no real concurrency (so the stale-plan path is
 *    never taken) and no SQLSTATEs. Concurrency safety is the database's, tested
 *    in supabase/tests/86_auto_rota.sql.
 *  - NO ATTENDANCE. The mock domain has no attendance state, so the "attendance
 *    blocks unassign" guard is not reproduced. The real database stays
 *    authoritative for it (DB-tested); do not rely on the mock to exercise it.
 *  - NO AUDIT. audit_log / audit context (the override reason) is a database
 *    concern. `reason` is accepted and length-validated, then discarded.
 *  - NO CANCELLED SHIFTS. Mock shift instances are generated fresh from active
 *    templates and are always 'active', so the "cancelled shift" rejection
 *    cannot arise.
 *  - SHIFT-INSTANCE IDS are `${templateId}-${date}` (see shiftInstances.ts):
 *    deterministic, so repeated reads agree and assignments stay attached. But
 *    a mock reviseShift that retires and recreates a template changes the
 *    template id, so assignments made against the old instance ids stop
 *    appearing. The real database keeps instance identity across a revision.
 *  - PUBLISHED weeks stay editable, exactly like the database. There is no
 *    mock Publish action; a test pushes a row into mockRotaPublications.
 */

const MAX_REASON_LENGTH = 500;

// First-party copy, mirroring the database's RAISE EXCEPTION text.
const MSG = {
  shiftNotFound: 'Shift not found.',
  historical: "This shift is in the past. Past assignments can't be changed from the weekly rota.",
  driverNotFound: 'Driver not found.',
  inactiveDriver: "This driver is inactive and can't be assigned to new shifts.",
  otherResort: 'This driver belongs to a different resort than this shift.',
  reasonTooLong: 'The reason must be 500 characters or fewer.',
  duplicate: 'This driver is already assigned to this shift.',
  notAssigned: 'This driver is not assigned to this shift.',
} as const;

const ISO_DATE_SUFFIX = /(\d{4}-\d{2}-\d{2})$/;

function operationalTodayIso(): string {
  return toISODate(getOperationalToday());
}

/** The date a mock shift-instance id encodes (`${templateId}-${date}`). Works even if the template has since been retired. */
function dateFromShiftInstanceId(shiftInstanceId: string): string | null {
  return ISO_DATE_SUFFIX.exec(shiftInstanceId)?.[1] ?? null;
}

function findMockShiftInstance(shiftInstanceId: string): ShiftInstanceRecord | null {
  const date = dateFromShiftInstanceId(shiftInstanceId);
  if (!date) return null;
  const weekStart = toISODate(startOfWeek(parseISODate(date)));
  const resortIds = new Set(mockShiftTemplates.map((t) => t.resortId));
  for (const resortId of resortIds) {
    const match = generateMockShiftInstancesForWeek(resortId, weekStart).find((s) => s.id === shiftInstanceId);
    if (match) return match;
  }
  return null;
}

let mockAutoRotaRunSeq = 0;

export class MockRotaRepository implements RotaRepository {
  /**
   * Mock analogue of the driver-safe My Rota read. There is no session in mock
   * mode, so the driver comes from `driverId` (already bridged to the
   * repository id space by the caller). Publication state is the existing
   * mockRotaPublications fixture -- empty by default, so a normal mock session
   * shows every week as "not published yet"; tests publish explicitly.
   */
  async getDriverWeekRota(params: { weekStart: string; driverId: string }): Promise<DriverWeekRota> {
    const { weekStart, driverId } = params;
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) return buildDriverWeekRota({ weekStart, isPublished: false, assignments: [] });

    const shiftsById = new Map(
      generateMockShiftInstancesForWeek(driver.resortId, weekStart)
        .filter((s) => s.status === 'active')
        .map((s) => [s.id, s])
    );
    const assignments: DriverVisibleAssignment[] = [];
    for (const a of mockRotaAssignments) {
      const shift = shiftsById.get(a.shiftInstanceId);
      if (a.driverId !== driverId || !shift) continue;
      assignments.push({
        assignmentId: a.id,
        shiftInstanceId: shift.id,
        resortId: shift.resortId,
        date: shift.date,
        weekStart: shift.weekStart,
        shiftKey: shift.shiftKey,
        name: shift.name,
        startTime: shift.startTime,
        endTime: shift.endTime,
      });
    }

    return buildDriverWeekRota({ weekStart, isPublished: isMockWeekPublished(driver.resortId, weekStart), assignments });
  }

  async getManagerWeekRota(params: { resortId: string; weekStart: string }): Promise<ManagerWeekRota> {
    const { resortId, weekStart } = params;
    const shifts = generateMockShiftInstancesForWeek(resortId, weekStart).filter((s) => s.status === 'active');
    const shiftIds = new Set(shifts.map((s) => s.id));

    return buildManagerWeekRota({
      resortId,
      weekStart,
      isPublished: isMockWeekPublished(resortId, weekStart),
      shifts,
      drivers: mockDrivers.filter((d) => d.resortId === resortId).map((d) => ({ id: d.id, fullName: d.fullName, isActive: d.isActive })),
      assignments: mockRotaAssignments
        .filter((a) => shiftIds.has(a.shiftInstanceId))
        .map((a) => ({ id: a.id, shiftInstanceId: a.shiftInstanceId, driverId: a.driverId, source: a.source, assignedAt: a.assignedAt })),
      availability: mockAvailability
        .filter((a) => shiftIds.has(a.shiftInstanceId))
        .map((a) => ({ shiftInstanceId: a.shiftInstanceId, driverId: a.driverId, status: a.status })),
    });
  }

  async assignDriver(params: AssignDriverParams): Promise<AssignDriverResult> {
    const operation = 'rota.assignDriver';
    const fail = (kind: ConstructorParameters<typeof RotaAssignmentError>[0], message: string, code: string) =>
      new RotaAssignmentError(kind, message, { operation, code });

    // Same order as the database function.
    const shift = findMockShiftInstance(params.shiftInstanceId);
    if (!shift) throw fail('not_found', MSG.shiftNotFound, 'P0002');
    if (shift.date < operationalTodayIso()) throw fail('historical_shift', MSG.historical, '55006');

    const driver = mockDrivers.find((d) => d.id === params.driverId);
    if (!driver) throw fail('not_found', MSG.driverNotFound, 'P0002');
    if (!driver.isActive) throw fail('rule_violation', MSG.inactiveDriver, '23514');
    if (driver.resortId !== shift.resortId) throw fail('rule_violation', MSG.otherResort, '23514');

    const reason = params.reason?.trim() ?? '';
    if (reason.length > MAX_REASON_LENGTH) throw fail('rule_violation', MSG.reasonTooLong, '23514');

    if (mockRotaAssignments.some((a) => a.shiftInstanceId === shift.id && a.driverId === driver.id)) {
      throw fail('duplicate_assignment', MSG.duplicate, '23505');
    }

    // The state is read here, never taken from the caller.
    const answer = mockAvailability.find((a) => a.shiftInstanceId === shift.id && a.driverId === driver.id);
    const availabilityState: RotaAvailabilityState = answer?.status ?? 'not_submitted';
    if (availabilityState !== 'available' && !params.confirmAvailabilityOverride) {
      throw new AvailabilityOverrideRequiredError(availabilityState, { operation });
    }

    const assignment = {
      id: nextMockRotaAssignmentId(),
      shiftInstanceId: shift.id,
      driverId: driver.id,
      resortId: shift.resortId,
      source: 'manual' as const,
      assignedAt: new Date().toISOString(),
    };
    mockRotaAssignments.push(assignment);
    return { assignmentId: assignment.id, availabilityState };
  }

  async unassignDriver(params: UnassignDriverParams): Promise<UnassignDriverResult> {
    const operation = 'rota.unassignDriver';
    const index = mockRotaAssignments.findIndex((a) => a.shiftInstanceId === params.shiftInstanceId && a.driverId === params.driverId);
    if (index === -1) {
      throw new RotaAssignmentError('assignment_not_found', MSG.notAssigned, { operation, code: 'P0002' });
    }

    const date = dateFromShiftInstanceId(params.shiftInstanceId);
    if (date !== null && date < operationalTodayIso()) {
      throw new RotaAssignmentError('historical_shift', MSG.historical, { operation, code: '55006' });
    }

    const [removed] = mockRotaAssignments.splice(index, 1);
    return { assignmentId: removed.id };
  }

  async generateAutoRota(params: GenerateAutoRotaParams): Promise<AutoRotaResult> {
    return runAutoRota({
      readWeek: () => this.getManagerWeekRota(params),
      applyPlan: (plan) => this.applyAutoRotaPlan(plan),
      operationalToday: () => toISODate(getOperationalToday()),
    });
  }

  private async applyAutoRotaPlan(plan: AutoRotaPlan): Promise<AutoRotaResult> {
    const operation = 'rota.generateAutoRota';
    if (!mockResorts.some((r) => r.id === plan.resortId)) throw new AutoRotaError('resort_not_found', { operation });
    if (startOfWeek(parseISODate(plan.weekStart)).getTime() !== parseISODate(plan.weekStart).getTime()) throw new AutoRotaError('invalid_week', { operation });
    if (isMockWeekPublished(plan.resortId, plan.weekStart)) throw new AutoRotaError('published_week', { operation });
    if (plan.weekIsHistorical) throw new AutoRotaError('historical_week', { operation });

    const assignedAt = new Date().toISOString();
    let assignedCount = 0;
    for (const proposed of plan.assignments) {
      // Defensive only (the planner never proposes these): never duplicate a driver on a shift.
      if (mockRotaAssignments.some((a) => a.shiftInstanceId === proposed.shiftInstanceId && a.driverId === proposed.driverId)) continue;
      mockRotaAssignments.push({
        id: nextMockRotaAssignmentId(),
        shiftInstanceId: proposed.shiftInstanceId,
        driverId: proposed.driverId,
        resortId: plan.resortId,
        source: 'auto',
        assignedAt,
      });
      assignedCount += 1;
    }

    // The result is computed from the state AFTER the apply, like the database does -- not from the plan's own numbers.
    const week = await this.getManagerWeekRota({ resortId: plan.resortId, weekStart: plan.weekStart });
    const coverage = summarizeOpenCoverage(week, toISODate(getOperationalToday()));
    mockAutoRotaRunSeq += 1;
    return {
      resortId: plan.resortId,
      weekStart: plan.weekStart,
      assignedCount,
      remainingOpenSlots: coverage.remainingOpenSlots,
      uncoveredShiftIds: coverage.uncoveredShiftIds,
      skippedPastShiftCount: coverage.skippedPastShiftCount,
      runId: `mock-auto-rota-run-${mockAutoRotaRunSeq}`,
    };
  }
}
