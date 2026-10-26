import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockRotaRepository } from './rota';
import {
  mockAttendance,
  mockCancelledShiftInstanceIds,
  mockDriverCheckIns,
  mockDrivers,
  mockResorts,
  mockRotaAssignments,
  mockRotaPublications,
  mockShiftTemplates,
  mockShiftTypes,
  resetMockFixturesForTesting,
} from './fixtures';
import { getMockActingDriverId, setMockActingDriver } from './session';
import {
  isAttendanceError,
  isDriverCheckInError,
  isRotaAssignmentError,
  type AttendanceErrorKind,
  type DriverCheckInErrorKind,
} from '../errors';

// The mock clock is the (faked) Date. BASE is Wednesday 2030-01-09 12:00 Zurich (CET, UTC+1) = 11:00Z.
//   Monday 2030-01-07 Dinner 18:00-21:30  : a PAST shift of the current week (window 16:30Z-20:30Z that Monday)
//   Wednesday 2030-01-09 Lunch 12:00-14:00 : TODAY (window 10:30Z-13:00Z)
//   Wednesday 2030-01-09 Dinner 18:00-21:00: TODAY, later (window 16:30Z-20:00Z)
//   Monday 2030-01-14 Dinner               : a FUTURE shift (next week)
//   Monday 2029-12-31 Dinner               : a PAST shift in a different (never published) week
const BASE = '2030-01-09T11:00:00.000Z';
const CRANS = 'mock-crans';
const WEEK = '2030-01-07';
const PAST_DINNER = `mock-crans-dinner-tpl-${WEEK}`;
const TODAY_LUNCH = 'mock-crans-lunch-tpl-2030-01-09';
const TODAY_DINNER = 'mock-crans-wdinner-tpl-2030-01-09';
const FUTURE_DINNER = 'mock-crans-dinner-tpl-2030-01-14';
const UNPUBLISHED_PAST_DINNER = 'mock-crans-dinner-tpl-2029-12-31';

let repo: MockRotaRepository;

function addTemplate(key: string, name: string, weekday: number, start: string, end: string, required = 1) {
  mockShiftTypes.push({ id: `mock-crans-${key}`, resortId: CRANS, key, name, sortOrder: 5, isActive: true });
  mockShiftTemplates.push({
    id: `mock-crans-${key}-tpl`, resortId: CRANS, shiftTypeId: `mock-crans-${key}`, weekday,
    startTime: start, endTime: end, requiredDrivers: required, basePayChf: null, deliveryRateChf: null, isPremium: null,
    effectiveFrom: '2024-01-01', effectiveTo: null, isActive: true, updatedAt: '2024-01-01T00:00:00.000Z',
  });
}
function addDriver(id: string, fullName: string, isActive = true) {
  mockDrivers.push({ id, resortId: CRANS, fullName, isActive, preferredLanguage: 'en' });
}
function seed(shiftInstanceId: string, driverId: string) {
  mockRotaAssignments.push({ id: `seed-${shiftInstanceId}-${driverId}`, shiftInstanceId, driverId, resortId: CRANS, source: 'manual', assignedAt: '2030-01-01T10:00:00.000Z' });
  return `seed-${shiftInstanceId}-${driverId}`;
}
const publish = (week = WEEK) => mockRotaPublications.push({ resortId: CRANS, weekStart: week, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
const setNow = (iso: string) => vi.setSystemTime(new Date(iso));
const managerRota = (week = WEEK) => repo.getManagerWeekRota({ resortId: CRANS, weekStart: week });
const myRota = (driverId = 'mock-gianni', week = WEEK) => repo.getDriverWeekRota({ weekStart: week, driverId });

beforeEach(() => {
  resetMockFixturesForTesting();
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(BASE);
  repo = new MockRotaRepository();
  addTemplate('lunch', 'Lunch', 2, '12:00', '14:00');
  addTemplate('wdinner', 'Wednesday Dinner', 2, '18:00', '21:00');
  addDriver('mock-maria', 'Maria');
  addDriver('mock-pat', 'Pat');
  addDriver('mock-sam', 'Sam');
});

afterEach(() => {
  vi.useRealTimers();
});

// =======================================================================
// recordAttendance
// =======================================================================
describe('MockRotaRepository.recordAttendance', () => {
  it('records the FIRST attendance: created + changed, with the derived shift and driver and no raw DB fields', async () => {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    const result = await repo.recordAttendance({ assignmentId: a, status: 'worked' });
    expect(result).toEqual({
      record: {
        attendanceId: expect.stringMatching(/^mock-attendance-/),
        assignmentId: a,
        shiftInstanceId: PAST_DINNER,
        driverId: 'mock-gianni',
        status: 'worked',
        recordedAt: BASE,
        updatedAt: BASE,
      },
      created: true,
      changed: true,
    });
    expect(mockAttendance).toHaveLength(1);
    expect(Object.keys(result.record)).not.toContain('recordedBy');
  });

  it.each(['worked', 'no_show', 'excused', 'cancelled'] as const)('records %s', async (status) => {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    expect((await repo.recordAttendance({ assignmentId: a, status })).record.status).toBe(status);
  });

  it('requires an EXISTING assignment', async () => {
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: 'nope', status: 'worked' }).catch((e) => e), 'assignment_not_found')).toBe(true);
    expect(mockAttendance).toEqual([]);
  });

  it('rejects an invalid status and an empty request', async () => {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: a, status: 'late' as never }).catch((e) => e), 'invalid_status')).toBe(true);
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: '', status: 'worked' }).catch((e) => e), 'invalid_request')).toBe(true);
  });

  it('blocks a FUTURE shift, published or not', async () => {
    const a = seed(FUTURE_DINNER, 'mock-gianni');
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: a, status: 'worked' }).catch((e) => e), 'future_shift')).toBe(true);
    publish('2030-01-14');
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: a, status: 'worked' }).catch((e) => e), 'future_shift')).toBe(true);
    expect(mockAttendance).toEqual([]);
  });

  it('blocks a CANCELLED shift instance for new attendance', async () => {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    mockCancelledShiftInstanceIds.add(PAST_DINNER);
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: a, status: 'worked' }).catch((e) => e), 'shift_cancelled')).toBe(true);
  });

  it('TODAY requires a currently published week', async () => {
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: a, status: 'worked' }).catch((e) => e), 'week_not_published')).toBe(true);
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: a, status: 'worked', reason: 'a reason does not override it' }).catch((e) => e), 'week_not_published')).toBe(true);
    publish();
    expect((await repo.recordAttendance({ assignmentId: a, status: 'worked' })).created).toBe(true);
  });

  it('a retracted publication does not count as published', async () => {
    mockRotaPublications.push({ resortId: CRANS, weekStart: WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: '2030-01-02T00:00:00Z' });
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: a, status: 'worked' }).catch((e) => e), 'week_not_published')).toBe(true);
  });

  it('a PAST shift in a PUBLISHED week needs no reason', async () => {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    expect((await repo.recordAttendance({ assignmentId: a, status: 'no_show' })).created).toBe(true);
  });

  it('a PAST shift in an UNPUBLISHED week is a historical backfill: a non-empty reason is required, and nothing is published', async () => {
    const a = seed(UNPUBLISHED_PAST_DINNER, 'mock-gianni');
    for (const reason of [undefined, null, '', '   \n\t ']) {
      expect(isAttendanceError(await repo.recordAttendance({ assignmentId: a, status: 'worked', reason }).catch((e) => e), 'historical_backfill_reason_required')).toBe(true);
    }
    expect(mockAttendance).toEqual([]);
    const result = await repo.recordAttendance({ assignmentId: a, status: 'worked', reason: '  Covered it; the rota was never published ' });
    expect(result).toMatchObject({ created: true, changed: true });
    expect(mockRotaPublications).toEqual([]); // the old rota is NOT published automatically
  });

  it('a past day of the CURRENT unpublished week also needs the reason', async () => {
    const a = seed(PAST_DINNER, 'mock-gianni');
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: a, status: 'worked' }).catch((e) => e), 'historical_backfill_reason_required')).toBe(true);
  });

  it('allows an INACTIVE driver\'s historical assignment', async () => {
    publish();
    addDriver('mock-gone', 'Gone', false);
    const a = seed(PAST_DINNER, 'mock-gone');
    expect((await repo.recordAttendance({ assignmentId: a, status: 'worked' })).record.driverId).toBe('mock-gone');
  });

  it('allows a past shift of an INACTIVE resort (history stays correctable)', async () => {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    mockResorts.find((r) => r.id === CRANS)!.isActive = false;
    expect((await repo.recordAttendance({ assignmentId: a, status: 'worked' })).created).toBe(true);
  });

  it('a CORRECTION updates the same row in place: created = false, changed = true, one row, recordedAt follows the latest action', async () => {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    const first = await repo.recordAttendance({ assignmentId: a, status: 'no_show' });
    setNow('2030-01-09T11:05:00.000Z');
    const corrected = await repo.recordAttendance({ assignmentId: a, status: 'worked' });
    expect(corrected).toMatchObject({ created: false, changed: true, record: { status: 'worked', attendanceId: first.record.attendanceId, recordedAt: '2030-01-09T11:05:00.000Z' } });
    expect(mockAttendance).toHaveLength(1);
  });

  it('the SAME status again is a no-op: changed = false, nothing updated -- even with a different reason, even in a backfill week without one', async () => {
    const a = seed(UNPUBLISHED_PAST_DINNER, 'mock-gianni');
    const first = await repo.recordAttendance({ assignmentId: a, status: 'worked', reason: 'backfill' });
    setNow('2030-01-09T11:30:00.000Z');
    const again = await repo.recordAttendance({ assignmentId: a, status: 'worked' });
    expect(again).toMatchObject({ created: false, changed: false, record: { attendanceId: first.record.attendanceId, recordedAt: BASE, updatedAt: BASE } });
    expect((await repo.recordAttendance({ assignmentId: a, status: 'worked', reason: 'a different reason' })).changed).toBe(false);
    expect(mockAttendance).toHaveLength(1);
  });

  it('validates the reason: more than 500 characters is rejected, exactly 500 is accepted', async () => {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    expect(isAttendanceError(await repo.recordAttendance({ assignmentId: a, status: 'worked', reason: 'x'.repeat(501) }).catch((e) => e), 'reason_too_long')).toBe(true);
    expect((await repo.recordAttendance({ assignmentId: a, status: 'worked', reason: 'y'.repeat(500) })).created).toBe(true);
  });

  it('shows up on the manager week through shared state (never fabricated by a component)', async () => {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    expect((await managerRota()).shifts[0].assignments[0].attendance).toBeNull();
    await repo.recordAttendance({ assignmentId: a, status: 'excused' });
    expect((await managerRota()).shifts[0].assignments[0].attendance).toEqual({ status: 'excused', recordedAt: BASE });
  });

  it('throws the same typed error class and first-party copy as the Supabase provider', async () => {
    const error = await repo.recordAttendance({ assignmentId: 'nope', status: 'worked' }).catch((e) => e);
    expect(error.userMessage).toBe('This assignment could not be found.');
    expect(error.kind satisfies AttendanceErrorKind).toBe('assignment_not_found');
  });
});

// =======================================================================
// clearAttendance
// =======================================================================
describe('MockRotaRepository.clearAttendance', () => {
  async function recorded() {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    await repo.recordAttendance({ assignmentId: a, status: 'no_show' });
    return a;
  }

  it('requires an existing assignment and a non-empty reason (max 500)', async () => {
    const a = await recorded();
    expect(isAttendanceError(await repo.clearAttendance({ assignmentId: 'nope', reason: 'x' }).catch((e) => e), 'assignment_not_found')).toBe(true);
    for (const reason of ['', '   ', null as never, undefined as never]) {
      expect(isAttendanceError(await repo.clearAttendance({ assignmentId: a, reason }).catch((e) => e), 'reason_required')).toBe(true);
    }
    expect(isAttendanceError(await repo.clearAttendance({ assignmentId: a, reason: 'x'.repeat(501) }).catch((e) => e), 'reason_too_long')).toBe(true);
    expect(mockAttendance).toHaveLength(1);
  });

  it('removes the row: changed = true with the previous status, and the assignment goes back to Not recorded', async () => {
    const a = await recorded();
    expect(await repo.clearAttendance({ assignmentId: a, reason: ' wrong driver ' })).toEqual({ assignmentId: a, previousStatus: 'no_show', changed: true });
    expect(mockAttendance).toEqual([]);
    expect((await managerRota()).shifts[0].assignments[0].attendance).toBeNull();
  });

  it('an assignment that is already Not recorded is a success with changed = false and no previous status', async () => {
    publish();
    const a = seed(PAST_DINNER, 'mock-gianni');
    expect(await repo.clearAttendance({ assignmentId: a, reason: 'checking' })).toEqual({ assignmentId: a, previousStatus: null, changed: false });
  });

  it('leaves the assignment, the publication and the driver\'s check-in untouched', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    setMockActingDriver('mock-gianni');
    const checkIn = await repo.checkInToShift({ assignmentId: a });
    await repo.recordAttendance({ assignmentId: a, status: 'no_show' });
    const publicationsBefore = JSON.stringify(mockRotaPublications);
    await repo.clearAttendance({ assignmentId: a, reason: 'accidental' });
    expect(mockDriverCheckIns).toHaveLength(1);
    expect(mockDriverCheckIns[0].checkedInAt).toBe(checkIn.checkIn.checkedInAt);
    expect(mockRotaAssignments.some((x) => x.id === a)).toBe(true);
    expect(JSON.stringify(mockRotaPublications)).toBe(publicationsBefore);
    // ...and the manager can then record the corrected attendance.
    expect((await repo.recordAttendance({ assignmentId: a, status: 'worked' })).created).toBe(true);
  });

  it('is not gated on date or publication: it removes a corrupt FUTURE row and a backfill row without a published week', async () => {
    const future = seed(FUTURE_DINNER, 'mock-gianni');
    mockAttendance.push({ id: 'legacy', assignmentId: future, status: 'worked', recordedAt: BASE, updatedAt: BASE });
    expect((await repo.clearAttendance({ assignmentId: future, reason: 'corrupt future row' })).changed).toBe(true);
    const past = seed(UNPUBLISHED_PAST_DINNER, 'mock-gianni');
    await repo.recordAttendance({ assignmentId: past, status: 'worked', reason: 'backfill' });
    expect((await repo.clearAttendance({ assignmentId: past, reason: 'wrong week' })).changed).toBe(true);
  });
});

// =======================================================================
// checkInToShift
// =======================================================================
describe('MockRotaRepository.checkInToShift', () => {
  const drive = (driverId: string | null = 'mock-gianni') => setMockActingDriver(driverId);

  it('checks the owning, active driver in with the mock clock: created = true and a checkedInAt that is exactly the clock', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    drive();
    expect(await repo.checkInToShift({ assignmentId: a })).toEqual({
      checkIn: { checkInId: expect.stringMatching(/^mock-check-in-/), assignmentId: a, shiftInstanceId: TODAY_LUNCH, checkedInAt: BASE },
      created: true,
    });
    expect(mockDriverCheckIns).toHaveLength(1);
  });

  it('only an ACTIVE DRIVER may check in: nobody signed in, a manager (no acting driver), an unknown id and an inactive driver are all denied', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    expect(getMockActingDriverId()).toBeNull();
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: a }).catch((e) => e), 'permission_denied')).toBe(true);
    drive('mock-nobody');
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: a }).catch((e) => e), 'permission_denied')).toBe(true);
    mockDrivers.find((d) => d.id === 'mock-gianni')!.isActive = false;
    drive('mock-gianni');
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: a }).catch((e) => e), 'permission_denied')).toBe(true);
    expect(mockDriverCheckIns).toEqual([]);
  });

  it('another driver\'s assignment and a missing one are both assignment_not_found (ownership is hidden)', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    drive('mock-maria');
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: a }).catch((e) => e), 'assignment_not_found')).toBe(true);
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: 'nope' }).catch((e) => e), 'assignment_not_found')).toBe(true);
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: '' }).catch((e) => e), 'invalid_request')).toBe(true);
  });

  it('requires a published week and an active shift', async () => {
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    drive();
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: a }).catch((e) => e), 'week_not_published')).toBe(true);
    publish();
    mockCancelledShiftInstanceIds.add(TODAY_LUNCH);
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: a }).catch((e) => e), 'shift_cancelled')).toBe(true);
    expect(mockDriverCheckIns).toEqual([]);
  });

  describe('the inclusive window (Lunch 12:00-14:00 Zurich = 10:30:00Z through 13:00:00Z)', () => {
    async function at(iso: string) {
      publish();
      const a = seed(TODAY_LUNCH, 'mock-gianni');
      drive();
      setNow(iso);
      return repo.checkInToShift({ assignmentId: a }).catch((e) => e);
    }

    it('one millisecond before opening is too early', async () => {
      expect(isDriverCheckInError(await at('2030-01-09T10:29:59.999Z'), 'check_in_too_early')).toBe(true);
    });
    it('the EXACT opening instant (11:30 local) is accepted', async () => {
      expect((await at('2030-01-09T10:30:00.000Z')).checkIn.checkedInAt).toBe('2030-01-09T10:30:00.000Z');
    });
    it('the scheduled start (12:00 local) is accepted', async () => {
      expect((await at('2030-01-09T11:00:00.000Z')).created).toBe(true);
    });
    it('a LATE check-in inside the shift is accepted (no lateness is stored)', async () => {
      const result = await at('2030-01-09T12:40:00.000Z');
      expect(result.created).toBe(true);
      expect(Object.keys(result.checkIn).sort()).toEqual(['assignmentId', 'checkInId', 'checkedInAt', 'shiftInstanceId']);
    });
    it('the EXACT closing instant (14:00 local) is accepted', async () => {
      expect((await at('2030-01-09T13:00:00.000Z')).created).toBe(true);
    });
    it('one millisecond after closing is closed', async () => {
      expect(isDriverCheckInError(await at('2030-01-09T13:00:00.001Z'), 'check_in_closed')).toBe(true);
    });
    it('a shift days away is too early and a past shift is closed', async () => {
      publish();
      publish('2030-01-14');
      const future = seed(FUTURE_DINNER, 'mock-gianni');
      const past = seed(PAST_DINNER, 'mock-gianni');
      drive();
      expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: future }).catch((e) => e), 'check_in_too_early')).toBe(true);
      expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: past }).catch((e) => e), 'check_in_closed')).toBe(true);
    });
  });

  it('is IMMUTABLE and idempotent: a repeat returns the original id and timestamp with created = false, one row only', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    drive();
    const first = await repo.checkInToShift({ assignmentId: a });
    setNow('2030-01-09T12:30:00.000Z');
    const repeat = await repo.checkInToShift({ assignmentId: a });
    expect(repeat).toEqual({ checkIn: first.checkIn, created: false });
    expect(repeat.checkIn.checkedInAt).toBe(BASE);
    expect(mockDriverCheckIns).toHaveLength(1);
  });

  it('an existing check-in is returned BEFORE the window and attendance gates (a retry after closing, or after attendance, still succeeds)', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    drive();
    const first = await repo.checkInToShift({ assignmentId: a });
    await repo.recordAttendance({ assignmentId: a, status: 'no_show' });
    setNow('2030-01-09T20:00:00.000Z'); // long after the window closed
    const retry = await repo.checkInToShift({ assignmentId: a });
    expect(retry).toEqual({ checkIn: first.checkIn, created: false });
    // ...but ownership is still proved first.
    drive('mock-maria');
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: a }).catch((e) => e), 'assignment_not_found')).toBe(true);
  });

  it('final attendance recorded BEFORE any check-in blocks the first check-in (inside the window), and the window error wins outside it', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    drive();
    await repo.recordAttendance({ assignmentId: a, status: 'no_show' });
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: a }).catch((e) => e), 'attendance_already_recorded')).toBe(true);
    setNow('2030-01-09T09:00:00.000Z');
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: a }).catch((e) => e), 'check_in_too_early')).toBe(true);
    expect(mockDriverCheckIns).toEqual([]);
  });

  it('a check-in FIRST allows any attendance afterwards, and a check-in never creates attendance', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    drive();
    await repo.checkInToShift({ assignmentId: a });
    expect(mockAttendance).toEqual([]);
    for (const status of ['no_show', 'worked', 'excused', 'cancelled'] as const) {
      expect((await repo.recordAttendance({ assignmentId: a, status })).record.status).toBe(status);
    }
    expect(mockDriverCheckIns).toHaveLength(1);
  });

  it('Lunch and Dinner on the same day are independent check-ins', async () => {
    publish();
    const lunch = seed(TODAY_LUNCH, 'mock-gianni');
    const dinner = seed(TODAY_DINNER, 'mock-gianni');
    drive();
    await repo.checkInToShift({ assignmentId: lunch });
    // Dinner opens 16:30Z: not yet.
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: dinner }).catch((e) => e), 'check_in_too_early')).toBe(true);
    setNow('2030-01-09T17:00:00.000Z');
    expect((await repo.checkInToShift({ assignmentId: dinner })).created).toBe(true);
    expect(mockDriverCheckIns.map((c) => c.assignmentId).sort()).toEqual([dinner, lunch].sort());
  });

  it('works across the DST change: the Sunday after the spring switch uses CEST (UTC+2)', async () => {
    addTemplate('sundin', 'Sunday Dinner', 6, '18:00', '21:00');
    publish('2030-03-25');
    const a = seed('mock-crans-sundin-tpl-2030-03-31', 'mock-gianni');
    drive();
    setNow('2030-03-31T15:29:59.999Z');
    expect(isDriverCheckInError(await repo.checkInToShift({ assignmentId: a }).catch((e) => e), 'check_in_too_early')).toBe(true);
    setNow('2030-03-31T15:30:00.000Z');
    expect((await repo.checkInToShift({ assignmentId: a })).created).toBe(true);
  });

  it('reset clears every check-in, attendance row, cancelled marker and the acting driver', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    drive();
    await repo.checkInToShift({ assignmentId: a });
    await repo.recordAttendance({ assignmentId: a, status: 'worked' });
    mockCancelledShiftInstanceIds.add('x');
    resetMockFixturesForTesting();
    expect(mockDriverCheckIns).toEqual([]);
    expect(mockAttendance).toEqual([]);
    expect(mockCancelledShiftInstanceIds.size).toBe(0);
    expect(getMockActingDriverId()).toBeNull();
  });
});

// =======================================================================
// the unassign interaction and the manager / driver read models
// =======================================================================
describe('Mock unassign guard (mirrors unassign_driver)', () => {
  it('attendance blocks removal with attendance_recorded', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    await repo.recordAttendance({ assignmentId: a, status: 'worked' });
    const error = await repo.unassignDriver({ shiftInstanceId: TODAY_LUNCH, driverId: 'mock-gianni' }).catch((e) => e);
    expect(isRotaAssignmentError(error, 'attendance_recorded')).toBe(true);
    expect(mockRotaAssignments.some((x) => x.id === a)).toBe(true);
  });

  it('a driver check-in alone blocks removal with the DISTINCT check_in_recorded', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    setMockActingDriver('mock-gianni');
    await repo.checkInToShift({ assignmentId: a });
    const error = await repo.unassignDriver({ shiftInstanceId: TODAY_LUNCH, driverId: 'mock-gianni' }).catch((e) => e);
    expect(isRotaAssignmentError(error, 'check_in_recorded')).toBe(true);
    expect(isRotaAssignmentError(error, 'attendance_recorded')).toBe(false);
  });

  it('with BOTH, attendance keeps precedence', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    setMockActingDriver('mock-gianni');
    await repo.checkInToShift({ assignmentId: a });
    await repo.recordAttendance({ assignmentId: a, status: 'no_show' });
    expect(isRotaAssignmentError(await repo.unassignDriver({ shiftInstanceId: TODAY_LUNCH, driverId: 'mock-gianni' }).catch((e) => e), 'attendance_recorded')).toBe(true);
  });

  it('after clearing attendance a check-in still blocks; with neither, removal works as before', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    setMockActingDriver('mock-gianni');
    await repo.checkInToShift({ assignmentId: a });
    await repo.recordAttendance({ assignmentId: a, status: 'no_show' });
    await repo.clearAttendance({ assignmentId: a, reason: 'accidental' });
    expect(isRotaAssignmentError(await repo.unassignDriver({ shiftInstanceId: TODAY_LUNCH, driverId: 'mock-gianni' }).catch((e) => e), 'check_in_recorded')).toBe(true);

    const free = seed(TODAY_LUNCH, 'mock-maria');
    expect((await repo.unassignDriver({ shiftInstanceId: TODAY_LUNCH, driverId: 'mock-maria' })).assignmentId).toBe(free);
  });

  it('a past assignment stays frozen by the existing historical rule first', async () => {
    publish();
    seed(PAST_DINNER, 'mock-gianni');
    expect(isRotaAssignmentError(await repo.unassignDriver({ shiftInstanceId: PAST_DINNER, driverId: 'mock-gianni' }).catch((e) => e), 'historical_shift')).toBe(true);
  });
});

describe('Mock read models: manager week and driver week', () => {
  it('the manager week shows attendance and check-in per assignment from shared state: none / check-in only / attendance only / both', async () => {
    publish();
    const none = seed(TODAY_LUNCH, 'mock-maria');
    const onlyCheckIn = seed(TODAY_LUNCH, 'mock-gianni');
    const onlyAttendance = seed(TODAY_LUNCH, 'mock-pat');
    const both = seed(TODAY_LUNCH, 'mock-sam');
    for (const driver of ['mock-gianni', 'mock-sam']) {
      setMockActingDriver(driver);
      await repo.checkInToShift({ assignmentId: `seed-${TODAY_LUNCH}-${driver}` });
    }
    await repo.recordAttendance({ assignmentId: onlyAttendance, status: 'no_show' });
    await repo.recordAttendance({ assignmentId: both, status: 'worked' });

    const lunch = (await managerRota()).shifts.find((s) => s.shiftInstanceId === TODAY_LUNCH)!;
    const row = (id: string) => lunch.assignments.find((a) => a.assignmentId === id)!;
    expect(row(none)).toMatchObject({ attendance: null, checkIn: null });
    expect(row(onlyCheckIn)).toMatchObject({ attendance: null, checkIn: { checkedInAt: BASE } });
    expect(row(onlyAttendance)).toMatchObject({ attendance: { status: 'no_show' }, checkIn: null });
    expect(row(both)).toMatchObject({ attendance: { status: 'worked' }, checkIn: { checkedInAt: BASE } });
  });

  it('every combination is legal: no check-in + Worked, no check-in + No show, check-in + No show', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-maria');
    const b = seed(TODAY_LUNCH, 'mock-pat');
    const c = seed(TODAY_LUNCH, 'mock-gianni');
    setMockActingDriver('mock-gianni');
    await repo.checkInToShift({ assignmentId: c });
    expect((await repo.recordAttendance({ assignmentId: a, status: 'worked' })).created).toBe(true);
    expect((await repo.recordAttendance({ assignmentId: b, status: 'no_show' })).created).toBe(true);
    expect((await repo.recordAttendance({ assignmentId: c, status: 'no_show' })).created).toBe(true);
  });

  it('the driver week carries the assignment id, own check-in time and the window, before and after checking in', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    expect((await myRota()).shifts.find((s) => s.shiftInstanceId === TODAY_LUNCH)).toMatchObject({
      assignmentId: a,
      checkedInAt: null,
      checkInOpensAt: '2030-01-09T10:30:00.000Z',
      checkInClosesAt: '2030-01-09T13:00:00.000Z',
    });
    setMockActingDriver('mock-gianni');
    await repo.checkInToShift({ assignmentId: a });
    expect((await myRota()).shifts.find((s) => s.shiftInstanceId === TODAY_LUNCH)?.checkedInAt).toBe(BASE);
  });

  it('privacy: another driver never sees a colleague\'s check-in, and no driver ever sees attendance', async () => {
    publish();
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    seed(TODAY_LUNCH, 'mock-maria');
    setMockActingDriver('mock-gianni');
    await repo.checkInToShift({ assignmentId: a });
    await repo.recordAttendance({ assignmentId: a, status: 'excused' });
    const maria = await myRota('mock-maria');
    expect(maria.shifts.map((s) => s.checkedInAt)).toEqual([null]);
    expect(JSON.stringify(await myRota('mock-gianni'))).not.toMatch(/excused|attendance|recordedAt/);
    expect(JSON.stringify(maria)).not.toMatch(/mock-gianni|Gianni/);
  });

  it('an unpublished week still shows no shifts (and no check-in data) to the driver', async () => {
    const a = seed(TODAY_LUNCH, 'mock-gianni');
    mockDriverCheckIns.push({ id: 'legacy', assignmentId: a, checkedInAt: BASE });
    expect(await myRota()).toEqual({ weekStart: WEEK, isPublished: false, shifts: [] });
  });
});
