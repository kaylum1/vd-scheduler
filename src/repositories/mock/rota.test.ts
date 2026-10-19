import { beforeEach, describe, expect, it } from 'vitest';
import { MockRotaRepository } from './rota';
import {
  mockAvailability,
  mockDrivers,
  mockRotaAssignments,
  mockRotaPublications,
  mockShiftTemplates,
  mockShiftTypes,
  resetMockFixturesForTesting,
} from './fixtures';
import { isAvailabilityOverrideRequired, isRotaAssignmentError } from '../errors';
import { getShiftCoverage } from '../../lib/rotaCoverage';
import type { AvailabilityStatus } from '../domain';

// Two real Mondays, far from "today" in both directions so the suite never
// depends on when it runs: 2030-01-07 is in the future, 2025-01-06 is past.
const FUTURE_WEEK = '2030-01-07';
const PAST_WEEK = '2025-01-06';
const CRANS = 'mock-crans';

// Baseline fixtures: Crans has one Dinner template on Mondays (weekday 0),
// required_drivers = 2, and one driver, Gianni.
const dinnerOn = (week: string) => `mock-crans-dinner-tpl-${week}`;
const FUTURE_DINNER = dinnerOn(FUTURE_WEEK);
const PAST_DINNER = dinnerOn(PAST_WEEK);

let repo: MockRotaRepository;

function addDriver(id: string, fullName: string, isActive = true, resortId = CRANS) {
  mockDrivers.push({ id, resortId, fullName, isActive, preferredLanguage: 'en' });
}
function answer(shiftInstanceId: string, driverId: string, status: AvailabilityStatus) {
  mockAvailability.push({ id: `ans-${shiftInstanceId}-${driverId}`, driverId, resortId: CRANS, shiftInstanceId, status, answeredAt: '2030-01-01T00:00:00Z' });
}
function seedAssignment(shiftInstanceId: string, driverId: string, assignedAt = '2030-01-01T10:00:00.000Z') {
  mockRotaAssignments.push({ id: `seed-${shiftInstanceId}-${driverId}`, shiftInstanceId, driverId, resortId: CRANS, source: 'manual', assignedAt });
}
const read = (weekStart = FUTURE_WEEK, resortId = CRANS) => repo.getManagerWeekRota({ resortId, weekStart });

beforeEach(() => {
  resetMockFixturesForTesting();
  repo = new MockRotaRepository();
  addDriver('mock-maria', 'Maria');
});

describe('MockRotaRepository.getManagerWeekRota', () => {
  it('1. returns the manager week read model for a resort and Monday', async () => {
    const rota = await read();
    expect(rota).toMatchObject({ resortId: CRANS, weekStart: FUTURE_WEEK, isPublished: false });
    expect(rota.shifts).toHaveLength(1);
    expect(rota.shifts[0]).toMatchObject({
      shiftInstanceId: FUTURE_DINNER,
      name: 'Dinner',
      date: FUTURE_WEEK,
      startTime: '18:00',
      endTime: '21:30',
      requiredDrivers: 2,
      assignments: [],
    });
  });

  it('2. shows shifts dynamically -- a newly-configured Shift appears with its own name and required_drivers, nothing is hard-coded', async () => {
    mockShiftTypes.push({ id: 'mock-crans-brunch', resortId: CRANS, key: 'brunch', name: 'Brunch (3P)', sortOrder: 2, isActive: true });
    mockShiftTemplates.push({
      id: 'mock-crans-brunch-tpl', resortId: CRANS, shiftTypeId: 'mock-crans-brunch', weekday: 4,
      startTime: '10:00', endTime: '14:00', requiredDrivers: 3, basePayChf: null, deliveryRateChf: null, isPremium: null,
      effectiveFrom: '2024-01-01', effectiveTo: null, isActive: true, updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const rota = await read();
    expect(rota.shifts.map((s) => [s.date, s.name, s.requiredDrivers])).toEqual([
      ['2030-01-07', 'Dinner', 2],
      ['2030-01-11', 'Brunch (3P)', 3],
    ]);
  });

  it('a week with no service is a valid empty model, and a resort with no shifts at all too', async () => {
    const rota = await read('2030-01-14', 'mock-verbier');
    expect(rota.shifts).toEqual([]);
    expect(rota.isPublished).toBe(false);
    expect(rota.candidateDrivers).toEqual([]);
  });

  it('3. lists the resort\'s ACTIVE drivers as candidates -- not other resorts\' drivers, not inactive ones', async () => {
    addDriver('mock-gone', 'Gone', false);
    const rota = await read();
    expect(rota.candidateDrivers.map((d) => d.fullName)).toEqual(['Gianni', 'Maria']);
  });

  it('4. an existing assignee who has since become INACTIVE stays visible, flagged inactive, and does not count toward coverage', async () => {
    addDriver('mock-gone', 'Gone', false);
    seedAssignment(FUTURE_DINNER, 'mock-gianni', '2030-01-01T10:00:00.000Z');
    seedAssignment(FUTURE_DINNER, 'mock-gone', '2030-01-01T11:00:00.000Z');

    const rota = await read();
    const shift = rota.shifts[0];
    expect(shift.assignments.map((a) => [a.driverName, a.isDriverActive])).toEqual([['Gianni', true], ['Gone', false]]);
    expect(rota.candidateDrivers.some((d) => d.driverId === 'mock-gone')).toBe(false);
    // required 2, one active + one inactive -> uncovered.
    expect(getShiftCoverage(shift)).toMatchObject({ required: 2, activeAssigned: 1, inactiveAssigned: 1, isCovered: false });
  });

  it('5-7. derives availability: available / unavailable / not_submitted (no row)', async () => {
    addDriver('mock-pat', 'Pat');
    answer(FUTURE_DINNER, 'mock-gianni', 'available');
    answer(FUTURE_DINNER, 'mock-maria', 'unavailable');
    const rota = await read();
    expect(rota.shifts[0].availabilityByDriver).toEqual({ 'mock-gianni': 'available', 'mock-maria': 'unavailable', 'mock-pat': 'not_submitted' });
  });

  it('availability for one shift/week never answers another', async () => {
    answer(FUTURE_DINNER, 'mock-gianni', 'available');
    const other = await read('2030-01-14');
    expect(other.shifts[0].availabilityByDriver['mock-gianni']).toBe('not_submitted');
  });

  it('22. shift-instance IDs are stable across repeated reads (so persistent mock assignments stay attached)', async () => {
    const first = (await read()).shifts.map((s) => s.shiftInstanceId);
    const second = (await read()).shifts.map((s) => s.shiftInstanceId);
    expect(second).toEqual(first);
    expect(first).toEqual([FUTURE_DINNER]);
    // Even through a fresh repository instance and after unrelated mutations.
    await new MockRotaRepository().assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni', confirmAvailabilityOverride: true });
    expect((await new MockRotaRepository().getManagerWeekRota({ resortId: CRANS, weekStart: FUTURE_WEEK })).shifts[0].shiftInstanceId).toBe(FUTURE_DINNER);
  });

  it('exposes no audit context / override reason (the mock keeps none)', async () => {
    await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni', confirmAvailabilityOverride: true, reason: 'secret reason' });
    expect(JSON.stringify(await read())).not.toMatch(/secret reason|reason|context/i);
  });
});

describe('MockRotaRepository.assignDriver', () => {
  it('8. an Available driver is assigned immediately, as a manual assignment', async () => {
    answer(FUTURE_DINNER, 'mock-gianni', 'available');
    const result = await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' });
    expect(result.availabilityState).toBe('available');
    expect(mockRotaAssignments.find((a) => a.id === result.assignmentId)).toMatchObject({ source: 'manual', driverId: 'mock-gianni', shiftInstanceId: FUTURE_DINNER });

    const shift = (await read()).shifts[0];
    expect(shift.assignments.map((a) => [a.driverName, a.source, a.assignmentId])).toEqual([['Gianni', 'manual', result.assignmentId]]);
  });

  it('9. an Unavailable driver without confirmation is rejected with the typed state, and nothing is assigned', async () => {
    answer(FUTURE_DINNER, 'mock-gianni', 'unavailable');
    const attempt = repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' });
    await expect(attempt).rejects.toSatisfy((e: unknown) => isAvailabilityOverrideRequired(e) && e.availabilityState === 'unavailable');
    expect(mockRotaAssignments).toHaveLength(0);
  });

  it('10. the SAME call with confirmation assigns the Unavailable driver, reporting the state actually used (reason accepted)', async () => {
    answer(FUTURE_DINNER, 'mock-gianni', 'unavailable');
    const result = await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni', confirmAvailabilityOverride: true, reason: 'Confirmed by phone' });
    expect(result.availabilityState).toBe('unavailable');
    expect(mockRotaAssignments).toHaveLength(1);
  });

  it('11. a Not Submitted driver without confirmation is rejected with its own distinct state', async () => {
    const attempt = repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' });
    await expect(attempt).rejects.toSatisfy((e: unknown) => isAvailabilityOverrideRequired(e) && e.availabilityState === 'not_submitted');
    expect(mockRotaAssignments).toHaveLength(0);
  });

  it('12. ...and with confirmation it is assigned, reporting not_submitted', async () => {
    const result = await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni', confirmAvailabilityOverride: true });
    expect(result.availabilityState).toBe('not_submitted');
    expect(mockRotaAssignments).toHaveLength(1);
  });

  it('the state is read at write time, never trusted from earlier: a driver who turns Unavailable after the page loaded is blocked', async () => {
    answer(FUTURE_DINNER, 'mock-gianni', 'available');
    await read(); // the manager "loads the page": Available.
    mockAvailability.find((a) => a.driverId === 'mock-gianni')!.status = 'unavailable';
    await expect(repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' })).rejects.toSatisfy(
      (e: unknown) => isAvailabilityOverrideRequired(e) && e.availabilityState === 'unavailable'
    );
    // A confirm flag never overrides the truth: for an actually-Available driver it reports 'available'.
    mockAvailability.find((a) => a.driverId === 'mock-gianni')!.status = 'available';
    expect((await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni', confirmAvailabilityOverride: true })).availabilityState).toBe('available');
  });

  it('13. assigning the same driver to the same shift twice is rejected as a duplicate', async () => {
    answer(FUTURE_DINNER, 'mock-gianni', 'available');
    await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' });
    await expect(repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni', confirmAvailabilityOverride: true })).rejects.toSatisfy(
      (e: unknown) => isRotaAssignmentError(e, 'duplicate_assignment')
    );
    expect(mockRotaAssignments).toHaveLength(1);
  });

  it('14. a driver from a DIFFERENT resort is rejected', async () => {
    await expect(repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-alex', confirmAvailabilityOverride: true })).rejects.toSatisfy(
      (e: unknown) => isRotaAssignmentError(e, 'rule_violation')
    );
    expect(mockRotaAssignments).toHaveLength(0);
  });

  it('15. an inactive driver is rejected', async () => {
    addDriver('mock-gone', 'Gone', false);
    await expect(repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gone', confirmAvailabilityOverride: true })).rejects.toSatisfy(
      (e: unknown) => isRotaAssignmentError(e, 'rule_violation')
    );
    expect(mockRotaAssignments).toHaveLength(0);
  });

  it('16. over-assignment is allowed: required 2 with 3 assigned stays covered, and coverage updates at each step', async () => {
    addDriver('mock-pat', 'Pat');
    for (const id of ['mock-gianni', 'mock-maria', 'mock-pat']) answer(FUTURE_DINNER, id, 'available');

    const coverageAfter = async () => getShiftCoverage((await read()).shifts[0]);

    await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' });
    expect(await coverageAfter()).toMatchObject({ required: 2, activeAssigned: 1, isCovered: false });
    await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-maria' });
    expect(await coverageAfter()).toMatchObject({ activeAssigned: 2, isCovered: true });
    await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-pat' });
    expect(await coverageAfter()).toMatchObject({ activeAssigned: 3, isCovered: true });
  });

  it('17. a shift dated before the operational today is rejected as historical, and nothing is assigned', async () => {
    await expect(repo.assignDriver({ shiftInstanceId: PAST_DINNER, driverId: 'mock-gianni', confirmAvailabilityOverride: true })).rejects.toSatisfy(
      (e: unknown) => isRotaAssignmentError(e, 'historical_shift')
    );
    expect(mockRotaAssignments).toHaveLength(0);
  });

  it('an unknown shift or driver is a not-found error', async () => {
    await expect(repo.assignDriver({ shiftInstanceId: 'nope-2030-01-07', driverId: 'mock-gianni' })).rejects.toSatisfy((e: unknown) => isRotaAssignmentError(e, 'not_found'));
    await expect(repo.assignDriver({ shiftInstanceId: 'garbage', driverId: 'mock-gianni' })).rejects.toSatisfy((e: unknown) => isRotaAssignmentError(e, 'not_found'));
    await expect(repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'nobody' })).rejects.toSatisfy((e: unknown) => isRotaAssignmentError(e, 'not_found'));
  });

  it('the optional reason: trimmed/blank is fine, exactly 500 characters is fine, 501 is rejected', async () => {
    addDriver('mock-pat', 'Pat');
    addDriver('mock-sam', 'Sam');
    const go = (driverId: string, reason: string | null | undefined) =>
      repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId, confirmAvailabilityOverride: true, reason });

    await expect(go('mock-gianni', '   ')).resolves.toBeDefined();
    await expect(go('mock-maria', 'y'.repeat(500))).resolves.toBeDefined();
    await expect(go('mock-pat', 'x'.repeat(501))).rejects.toSatisfy((e: unknown) => isRotaAssignmentError(e, 'rule_violation'));
    await expect(go('mock-sam', null)).resolves.toBeDefined();
  });

  it('20. a PUBLISHED week stays editable, exactly like the database', async () => {
    mockRotaPublications.push({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    answer(FUTURE_DINNER, 'mock-gianni', 'available');
    expect((await read()).isPublished).toBe(true);

    const { assignmentId } = await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' });
    expect((await read()).shifts[0].assignments).toHaveLength(1);
    await repo.unassignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' });
    expect((await read()).shifts[0].assignments).toHaveLength(0);
    expect(assignmentId).toBeTruthy();
    // ...and the publication is untouched.
    expect(mockRotaPublications).toEqual([{ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null }]);
    expect((await read()).isPublished).toBe(true);
  });

  it('a publication for another resort or week does not make this week look published', async () => {
    mockRotaPublications.push({ resortId: 'mock-zermatt', weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    mockRotaPublications.push({ resortId: CRANS, weekStart: '2030-01-14', publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    expect((await read()).isPublished).toBe(false);
  });
});

describe('MockRotaRepository.unassignDriver', () => {
  it('18. removes exactly that assignment and leaves the others untouched', async () => {
    addDriver('mock-pat', 'Pat');
    for (const id of ['mock-gianni', 'mock-maria', 'mock-pat']) await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: id, confirmAvailabilityOverride: true });

    const removed = await repo.unassignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-maria' });
    expect(removed.assignmentId).toBeTruthy();
    expect((await read()).shifts[0].assignments.map((a) => a.driverName).sort()).toEqual(['Gianni', 'Pat']);
  });

  it('19. unassigning someone who is not assigned is an explicit not-found, never a silent success', async () => {
    await expect(repo.unassignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' })).rejects.toSatisfy(
      (e: unknown) => isRotaAssignmentError(e, 'assignment_not_found')
    );
  });

  it('is rejected for a shift dated before the operational today (the assignment survives)', async () => {
    seedAssignment(PAST_DINNER, 'mock-gianni');
    await expect(repo.unassignDriver({ shiftInstanceId: PAST_DINNER, driverId: 'mock-gianni' })).rejects.toSatisfy(
      (e: unknown) => isRotaAssignmentError(e, 'historical_shift')
    );
    expect(mockRotaAssignments).toHaveLength(1);
  });

  it('an inactive assignee can still be removed (needed so the manager can replace them)', async () => {
    addDriver('mock-gone', 'Gone', false);
    seedAssignment(FUTURE_DINNER, 'mock-gone');
    await repo.unassignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gone' });
    expect(mockRotaAssignments).toHaveLength(0);
  });
});

describe('mock state and scope', () => {
  it('21. reset restores the fixture state -- assignments, added drivers, availability and publications are all cleared', async () => {
    addDriver('mock-extra', 'Extra');
    answer(FUTURE_DINNER, 'mock-gianni', 'available');
    await repo.assignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' });
    mockRotaPublications.push({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: 'x', unpublishedAt: null });
    expect(mockRotaAssignments).toHaveLength(1);

    resetMockFixturesForTesting();

    expect(mockRotaAssignments).toHaveLength(0);
    const rota = await read();
    expect(rota.shifts[0].assignments).toEqual([]);
    expect(rota.isPublished).toBe(false);
    expect(rota.candidateDrivers.map((d) => d.fullName)).toEqual(['Gianni']);
    expect(rota.shifts[0].availabilityByDriver['mock-gianni']).toBe('not_submitted');
  });

});

// ---------------------------------------------------------------------------
// Live Driver My Rota: getDriverWeekRota (mock analogue of the driver-safe views)
// ---------------------------------------------------------------------------

describe('MockRotaRepository.getDriverWeekRota', () => {
  const publish = (weekStart = FUTURE_WEEK, resortId = CRANS) =>
    mockRotaPublications.push({ resortId, weekStart, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
  const myRota = (driverId = 'mock-gianni', weekStart = FUTURE_WEEK) => repo.getDriverWeekRota({ weekStart, driverId });

  it('14. an unpublished week is not published and empty -- even when the driver IS assigned (draft assignments stay hidden)', async () => {
    seedAssignment(FUTURE_DINNER, 'mock-gianni');
    expect(await myRota()).toEqual({ weekStart: FUTURE_WEEK, isPublished: false, shifts: [] });
  });

  it('15. a published week with no own assignment is published with zero shifts', async () => {
    publish();
    expect(await myRota()).toEqual({ weekStart: FUTURE_WEEK, isPublished: true, shifts: [] });
  });

  it('16. a published week shows the driver\'s own assignment with name and HH:MM times', async () => {
    publish();
    seedAssignment(FUTURE_DINNER, 'mock-gianni');
    expect(await myRota()).toEqual({
      weekStart: FUTURE_WEEK,
      isPublished: true,
      shifts: [{ shiftInstanceId: FUTURE_DINNER, date: FUTURE_WEEK, shiftName: 'Dinner', startTime: '18:00', endTime: '21:30' }],
    });
  });

  it('shows several shifts on the same day, and reflects a manager adding then removing one (no republish)', async () => {
    mockShiftTypes.push({ id: 'mock-crans-lunch', resortId: CRANS, key: 'lunch', name: 'Lunch', sortOrder: 0, isActive: true });
    mockShiftTemplates.push({
      id: 'mock-crans-lunch-tpl', resortId: CRANS, shiftTypeId: 'mock-crans-lunch', weekday: 0,
      startTime: '12:00', endTime: '14:00', requiredDrivers: 1, basePayChf: null, deliveryRateChf: null, isPremium: null,
      effectiveFrom: '2024-01-01', effectiveTo: null, isActive: true, updatedAt: '2024-01-01T00:00:00.000Z',
    });
    publish();
    seedAssignment(FUTURE_DINNER, 'mock-gianni');
    expect((await myRota()).shifts.map((s) => s.shiftName)).toEqual(['Dinner']);

    // Manager assigns the lunch on the already-published week, through the real mock write path.
    await repo.assignDriver({ shiftInstanceId: `mock-crans-lunch-tpl-${FUTURE_WEEK}`, driverId: 'mock-gianni', confirmAvailabilityOverride: true });
    expect((await myRota()).shifts.map((s) => s.shiftName)).toEqual(['Lunch', 'Dinner']);

    await repo.unassignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' });
    expect((await myRota()).shifts.map((s) => s.shiftName)).toEqual(['Lunch']);
    expect((await myRota()).isPublished).toBe(true);
  });

  it('17. drivers are isolated: another driver\'s assignment never appears, and an unknown driver sees nothing', async () => {
    publish();
    seedAssignment(FUTURE_DINNER, 'mock-maria');
    expect((await myRota('mock-gianni')).shifts).toEqual([]);
    expect((await myRota('mock-maria')).shifts.map((s) => s.shiftInstanceId)).toEqual([FUTURE_DINNER]);
    expect(await myRota('nobody')).toEqual({ weekStart: FUTURE_WEEK, isPublished: false, shifts: [] });
  });

  it('a retracted (unpublished) week is not published', async () => {
    mockRotaPublications.push({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: '2030-01-02T00:00:00Z' });
    seedAssignment(FUTURE_DINNER, 'mock-gianni');
    expect((await myRota()).isPublished).toBe(false);
  });

  it('a published week of ANOTHER resort does not publish this driver\'s week', async () => {
    publish(FUTURE_WEEK, 'mock-zermatt');
    seedAssignment(FUTURE_DINNER, 'mock-gianni');
    expect((await myRota()).isPublished).toBe(false);
  });

  it('18. repeated reads of the same week are stable and independent of other weeks', async () => {
    publish();
    seedAssignment(FUTURE_DINNER, 'mock-gianni');
    const first = await myRota();
    expect(await myRota()).toEqual(first);
    expect(await myRota('mock-gianni', '2030-01-14')).toEqual({ weekStart: '2030-01-14', isPublished: false, shifts: [] });
  });

  it('exposes only driver-safe fields (no manager/colleague/source data)', async () => {
    publish();
    seedAssignment(FUTURE_DINNER, 'mock-gianni');
    const json = JSON.stringify(await myRota());
    expect(json).not.toMatch(/requiredDrivers|source|assignedAt|manual|mock-maria|availability/);
  });
});
