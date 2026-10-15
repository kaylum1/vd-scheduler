import type { RotaRepository } from '../types';
import type {
  AssignDriverParams,
  AssignDriverResult,
  DriverVisibleAssignment,
  ManagerWeekRota,
  RotaAvailabilityState,
  ShiftInstanceRecord,
  UnassignDriverParams,
  UnassignDriverResult,
} from '../domain';
import { AvailabilityOverrideRequiredError, RotaAssignmentError } from '../errors';
import { buildManagerWeekRota } from '../managerRotaModel';
import { parseISODate, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import { mockAvailability, mockDrivers, mockRotaAssignments, mockShiftTemplates, nextMockRotaAssignmentId } from './fixtures';
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

export class MockRotaRepository implements RotaRepository {
  async listDriverVisibleAssignments(_driverId: string): Promise<DriverVisibleAssignment[]> {
    // No driver-facing published-rota concept exists in the mock fixtures
    // (Stage 1.1's own mock data models "published" per-shift-instance, which
    // this repository layer deliberately does not copy -- see mock/fixtures.ts).
    // Returns an empty list until Driver My Rota is converted to live data.
    return [];
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
}
