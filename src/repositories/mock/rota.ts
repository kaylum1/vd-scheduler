import type { RotaRepository } from '../types';
import type {
  AssignDriverParams,
  AssignDriverResult,
  AttendanceMutationResult,
  AttendanceRecord,
  CheckInToShiftParams,
  ClearAttendanceParams,
  ClearAttendanceResult,
  DriverCheckInResult,
  RecordAttendanceParams,
  AutoRotaPlan,
  AutoRotaResult,
  GenerateAutoRotaParams,
  DriverVisibleAssignment,
  PublishRotaParams,
  PublishRotaResult,
  DriverWeekRota,
  ManagerWeekRota,
  RotaAvailabilityState,
  ShiftInstanceRecord,
  UnassignDriverParams,
  UnassignDriverResult,
} from '../domain';
import {
  AttendanceError,
  AutoRotaError,
  AvailabilityOverrideRequiredError,
  DriverCheckInError,
  PublishRotaConfirmationRequiredError,
  PublishRotaError,
  RotaAssignmentError,
} from '../errors';
import { ATTENDANCE_STATUSES } from '../domain';
import { runAutoRota } from '../autoRotaOrchestration';
import { summarizeOpenCoverage } from '../../lib/autoRotaPlanner';
import { buildDriverWeekRota } from '../driverRotaModel';
import { buildManagerWeekRota } from '../managerRotaModel';
import { addDays, parseISODate, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import {
  mockAttendance,
  mockAvailability,
  mockDriverCheckIns,
  mockDrivers,
  mockResorts,
  mockRotaAssignments,
  mockRotaPublications,
  mockShiftTemplates,
  nextMockAttendanceId,
  nextMockCheckInId,
  nextMockRotaAssignmentId,
} from './fixtures';
import { mockNow } from './clock';
import { mockCheckInWindow } from './checkInWindow';
import { getMockActingDriverId } from './session';
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
 *  - ATTENDANCE and CHECK-IN (AT-B) live in the shared mockAttendance /
 *    mockDriverCheckIns state and mirror record_attendance / clear_attendance /
 *    check_in_to_shift (same guards, same order, same typed errors), including the
 *    unassign guard: attendance -> attendance_recorded, else a check-in ->
 *    check_in_recorded. The mock's "operational today" is Europe/Zurich (every mock
 *    resort is), and its check-in window is computed by mock/checkInWindow.ts.
 *    A mock driver is not a session: checkInToShift reads the acting driver from
 *    mock/session.ts (the contract takes no driver id).
 *  - NO AUDIT. audit_log / audit context (the override reason, the attendance and
 *    clear reasons) is a database concern. `reason` is accepted and length-validated,
 *    then discarded.
 *  - NO CANCELLED SHIFTS. Mock shift instances are generated fresh from active
 *    templates and are always 'active', so the "cancelled shift" rejection
 *    cannot arise.
 *  - SHIFT-INSTANCE IDS are `${templateId}-${date}` (see shiftInstances.ts):
 *    deterministic, so repeated reads agree and assignments stay attached. But
 *    a mock reviseShift that retires and recreates a template changes the
 *    template id, so assignments made against the old instance ids stop
 *    appearing. The real database keeps instance identity across a revision.
 *  - PUBLISHED weeks stay editable, exactly like the database.
 *  - PUBLISH (publishRota) mirrors publish_rota's guards, order and
 *    confirmation rule over mockRotaPublications, so a mock publish feeds the
 *    manager rota, Driver My Rota, the Availability lock and Auto-Rota. Being a
 *    mock it has no lock or concurrency (the database's week lock is tested in
 *    supabase/tests/87_publish_rota.sql). There is no unpublish; a test may push
 *    a retracted row into mockRotaPublications and publishRota republishes it.
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
  attendanceRecorded: "Attendance has already been recorded for this driver on this shift, so the assignment can't be removed.",
  checkInRecorded: "This driver has already checked in to this shift, so the assignment can't be removed.",
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
      const window = mockCheckInWindow(shift, mockResorts.find((r) => r.id === shift.resortId)?.timezone ?? 'Europe/Zurich');
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
        // Only the driver's OWN check-in (the loop already filtered to their assignments); never attendance.
        checkedInAt: mockDriverCheckIns.find((c) => c.assignmentId === a.id)?.checkedInAt ?? null,
        checkInOpensAt: window.opensAt.toISOString(),
        checkInClosesAt: window.closesAt.toISOString(),
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
        .map((a) => {
          const attendance = mockAttendance.find((x) => x.assignmentId === a.id);
          const checkIn = mockDriverCheckIns.find((x) => x.assignmentId === a.id);
          return {
            id: a.id,
            shiftInstanceId: a.shiftInstanceId,
            driverId: a.driverId,
            source: a.source,
            assignedAt: a.assignedAt,
            attendance: attendance ? { status: attendance.status, recordedAt: attendance.recordedAt } : null,
            checkIn: checkIn ? { checkedInAt: checkIn.checkedInAt } : null,
          };
        }),
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

    // Same precedence as the database: attendance first, then a driver check-in (evidence, a distinct kind).
    const target = mockRotaAssignments[index];
    if (mockAttendance.some((x) => x.assignmentId === target.id)) {
      throw new RotaAssignmentError('attendance_recorded', MSG.attendanceRecorded, { operation, code: '55006' });
    }
    if (mockDriverCheckIns.some((x) => x.assignmentId === target.id)) {
      throw new RotaAssignmentError('check_in_recorded', MSG.checkInRecorded, { operation, code: '55006' });
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

  /**
   * Mock analogue of publish_rota (PB-A): same guards in the same order, same
   * typed errors, same confirmation rule. Coverage is counted here from the
   * current mock state, exactly as the database counts its own.
   */
  async publishRota(params: PublishRotaParams): Promise<PublishRotaResult> {
    const operation = 'rota.publishRota';
    const { resortId, weekStart } = params;
    const fail = (kind: ConstructorParameters<typeof PublishRotaError>[0]) => new PublishRotaError(kind, { operation });

    if (!resortId || !weekStart) throw fail('invalid_week');
    const week = parseISODate(weekStart);
    if (Number.isNaN(week.getTime()) || startOfWeek(week).getTime() !== week.getTime()) throw fail('invalid_week');

    const resort = mockResorts.find((r) => r.id === resortId);
    if (!resort) throw fail('resort_not_found');
    if (!resort.isActive) throw fail('resort_inactive');

    const today = operationalTodayIso();
    const shifts = generateMockShiftInstancesForWeek(resortId, weekStart).filter((s) => s.status === 'active');
    const uncoveredSlots = countUncoveredSlots(shifts, today);
    const existing = mockRotaPublications.find((p) => p.resortId === resortId && p.weekStart === weekStart);

    // Already published: a normal success -- nothing is written, the original timestamp is kept.
    if (existing && existing.publishedAt !== null && existing.unpublishedAt === null) {
      return { resortId, weekStart, publishedAt: existing.publishedAt, uncoveredSlots, alreadyPublished: true };
    }

    if (toISODate(addDays(week, 6)) < today) throw fail('historical_week');
    if (shifts.length === 0) throw fail('no_shifts');
    if (!shifts.some((s) => s.date >= today)) throw fail('historical_week');

    // The server (here: this mock) recounts on every call; a yes only acknowledges, it never supplies a number.
    if (uncoveredSlots > 0 && params.confirmUncovered !== true) {
      throw new PublishRotaConfirmationRequiredError(uncoveredSlots, { operation });
    }

    const shiftIds = new Set(shifts.map((s) => s.id));
    const generationSource = mockRotaAssignments.some((a) => shiftIds.has(a.shiftInstanceId) && a.source === 'auto') ? 'auto' : 'manual';
    const publishedAt = new Date().toISOString();
    if (existing) {
      // A retracted row: republish the same logical resort + week (one row per resort + week).
      existing.publishedAt = publishedAt;
      existing.unpublishedAt = null;
      existing.generationSource = generationSource;
    } else {
      mockRotaPublications.push({ resortId, weekStart, publishedAt, unpublishedAt: null, generationSource });
    }
    return { resortId, weekStart, publishedAt, uncoveredSlots, alreadyPublished: false };
  }

  // ---- Attendance (AT-B): mirrors record_attendance / clear_attendance --------------------------

  async recordAttendance(params: RecordAttendanceParams): Promise<AttendanceMutationResult> {
    const operation = 'rota.recordAttendance';
    const fail = (kind: ConstructorParameters<typeof AttendanceError>[0], code: string) => new AttendanceError(kind, { operation, code });

    if (!params.assignmentId || !params.status) throw fail('invalid_request', '22023');
    if (!ATTENDANCE_STATUSES.includes(params.status)) throw fail('invalid_status', '22023');
    const reason = params.reason?.trim() || null;
    if (reason !== null && reason.length > MAX_REASON_LENGTH) throw fail('reason_too_long', '23514');

    const assignment = mockRotaAssignments.find((a) => a.id === params.assignmentId);
    if (!assignment) throw fail('assignment_not_found', 'P0002');
    // (A retired template makes its instance ids unresolvable: a documented mock limitation, see the header.)
    const shift = findMockShiftInstance(assignment.shiftInstanceId);
    if (!shift) throw fail('assignment_not_found', 'P0002');

    if (shift.status !== 'active') throw fail('shift_cancelled', '55006');
    const today = operationalTodayIso();
    if (shift.date > today) throw fail('future_shift', '55006');
    const published = isMockWeekPublished(shift.resortId, shift.weekStart);
    if (shift.date === today && !published) throw fail('week_not_published', '55006');
    // A past shift in a week that is not currently published is a historical backfill: it needs a reason.
    const backfill = shift.date < today && !published;

    const existing = mockAttendance.find((x) => x.assignmentId === assignment.id);
    if (existing && existing.status === params.status) {
      return { record: toAttendanceRecord(existing, assignment), created: false, changed: false };
    }
    if (backfill && reason === null) throw fail('historical_backfill_reason_required', '23514');

    const now = mockNow().toISOString();
    if (existing) {
      // A correction updates the one row in place; recordedAt follows the latest recording action.
      existing.status = params.status;
      existing.recordedAt = now;
      existing.updatedAt = now;
      return { record: toAttendanceRecord(existing, assignment), created: false, changed: true };
    }
    const row = { id: nextMockAttendanceId(), assignmentId: assignment.id, status: params.status, recordedAt: now, updatedAt: now };
    mockAttendance.push(row);
    return { record: toAttendanceRecord(row, assignment), created: true, changed: true };
  }

  async clearAttendance(params: ClearAttendanceParams): Promise<ClearAttendanceResult> {
    const operation = 'rota.clearAttendance';
    const fail = (kind: ConstructorParameters<typeof AttendanceError>[0], code: string) => new AttendanceError(kind, { operation, code });

    if (!params.assignmentId) throw fail('invalid_request', '22023');
    const reason = params.reason?.trim() || null;
    if (reason === null) throw fail('reason_required', '23514');
    if (reason.length > MAX_REASON_LENGTH) throw fail('reason_too_long', '23514');
    const assignment = mockRotaAssignments.find((a) => a.id === params.assignmentId);
    if (!assignment) throw fail('assignment_not_found', 'P0002');

    // Not gated on date, publication or shift status. Never touches the assignment, publication or check-in.
    const index = mockAttendance.findIndex((x) => x.assignmentId === assignment.id);
    if (index === -1) return { assignmentId: assignment.id, previousStatus: null, changed: false };
    const [removed] = mockAttendance.splice(index, 1);
    return { assignmentId: assignment.id, previousStatus: removed.status, changed: true };
  }

  // ---- Driver Check-in (AT-B): mirrors check_in_to_shift ----------------------------------------

  async checkInToShift(params: CheckInToShiftParams): Promise<DriverCheckInResult> {
    const operation = 'rota.checkInToShift';
    const fail = (kind: ConstructorParameters<typeof DriverCheckInError>[0], code: string) => new DriverCheckInError(kind, { operation, code });

    // Only an ACTIVE driver may check in (the mock "session"): a manager, a signed-out caller and an inactive driver are denied.
    const driverId = getMockActingDriverId();
    const driver = driverId ? mockDrivers.find((d) => d.id === driverId) : undefined;
    if (!driver || !driver.isActive) throw fail('permission_denied', '42501');
    if (!params.assignmentId) throw fail('invalid_request', '22023');

    // Ownership is part of the lookup: someone else's assignment is indistinguishable from a missing one.
    const assignment = mockRotaAssignments.find((a) => a.id === params.assignmentId && a.driverId === driver.id);
    if (!assignment) throw fail('assignment_not_found', 'P0002');
    const shift = findMockShiftInstance(assignment.shiftInstanceId);
    if (!shift) throw fail('assignment_not_found', 'P0002');

    // An existing check-in is returned as-is BEFORE every gate (a retry stays a success after the window closed or attendance exists).
    const existing = mockDriverCheckIns.find((c) => c.assignmentId === assignment.id);
    if (existing) return { checkIn: toDriverCheckIn(existing, assignment), created: false };

    if (shift.status !== 'active') throw fail('shift_cancelled', '55006');
    if (!isMockWeekPublished(shift.resortId, shift.weekStart)) throw fail('week_not_published', '55006');

    const now = mockNow();
    const window = mockCheckInWindow(shift, mockResorts.find((r) => r.id === shift.resortId)?.timezone ?? 'Europe/Zurich');
    if (now.getTime() < window.opensAt.getTime()) throw fail('check_in_too_early', '55006');
    if (now.getTime() > window.closesAt.getTime()) throw fail('check_in_closed', '55006');

    // The window is tested first so a driver is never told, through the error, that final attendance exists.
    if (mockAttendance.some((x) => x.assignmentId === assignment.id)) throw fail('attendance_already_recorded', '55006');

    const row = { id: nextMockCheckInId(), assignmentId: assignment.id, checkedInAt: now.toISOString() };
    mockDriverCheckIns.push(row);
    return { checkIn: toDriverCheckIn(row, assignment), created: true };
  }
}

function toAttendanceRecord(row: (typeof mockAttendance)[number], assignment: (typeof mockRotaAssignments)[number]): AttendanceRecord {
  return {
    attendanceId: row.id,
    assignmentId: assignment.id,
    shiftInstanceId: assignment.shiftInstanceId,
    driverId: assignment.driverId,
    status: row.status,
    recordedAt: row.recordedAt,
    updatedAt: row.updatedAt,
  };
}

function toDriverCheckIn(row: (typeof mockDriverCheckIns)[number], assignment: (typeof mockRotaAssignments)[number]) {
  return { checkInId: row.id, assignmentId: assignment.id, shiftInstanceId: assignment.shiftInstanceId, checkedInAt: row.checkedInAt };
}

/**
 * Open positions on today/future ACTIVE shifts: required_drivers minus the
 * assignments of ACTIVE drivers (an inactive assignee does not cover), never
 * negative. Past gaps are ignored. Mirrors _auto_rota_open_slots.
 */
function countUncoveredSlots(shifts: ShiftInstanceRecord[], today: string): number {
  let open = 0;
  for (const shift of shifts) {
    if (shift.date < today) continue;
    const covering = mockRotaAssignments.filter(
      (a) => a.shiftInstanceId === shift.id && mockDrivers.some((d) => d.id === a.driverId && d.isActive)
    ).length;
    open += Math.max(shift.requiredDrivers - covering, 0);
  }
  return open;
}
