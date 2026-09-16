import { beforeEach, describe, expect, it } from 'vitest';
import { MockAvailabilityRepository } from './availability';
import { RepositoryError } from '../errors';
import { mockRotaPublications, resetMockFixturesForTesting } from './fixtures';
import { startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';

// The baseline mock-crans-dinner-tpl fixture is a Monday-only (weekday=0),
// open-ended (effectiveFrom 2024-01-01, effectiveTo null) Shift -- so "this
// week's Monday" always has exactly one real shift_instance for mock-crans,
// deterministically, regardless of when the suite runs.
const thisMonday = toISODate(startOfWeek(getOperationalToday()));

describe('MockAvailabilityRepository: Stage 3 driver availability', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockAvailabilityRepository();

  it('listDriverVisibleShifts returns only the weekdays a Shift actually runs on -- not every day of every week', async () => {
    const shifts = await repo.listDriverVisibleShifts('mock-crans');
    const thisWeekShifts = shifts.filter((s) => s.weekStart === thisMonday);
    expect(thisWeekShifts).toHaveLength(1);
    expect(thisWeekShifts[0]).toMatchObject({ name: 'Dinner', startTime: '18:00', endTime: '21:30', date: thisMonday });
  });

  it('listDriverVisibleShifts is scoped per resort -- a Zermatt shift never appears under Crans', async () => {
    const shifts = await repo.listDriverVisibleShifts('mock-crans');
    expect(shifts.every((s) => s.resortId === 'mock-crans')).toBe(true);
  });

  it('a driver with no answer at all counts as Not Submitted (no row, never a stored third status)', async () => {
    const answers = await repo.listAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', weekStart: thisMonday });
    expect(answers).toHaveLength(0);
    const status = await repo.getWeekAvailabilityStatus('mock-gianni', thisMonday);
    expect(status.answeredCount).toBe(0);
    expect(status.missingCount).toBe(1);
  });

  it('setAvailability(available) persists and is reflected in listAvailability/getWeekAvailabilityStatus', async () => {
    const shifts = await repo.listDriverVisibleShifts('mock-crans');
    const monday = shifts.find((s) => s.weekStart === thisMonday)!;
    await repo.setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });

    const answers = await repo.listAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', weekStart: thisMonday });
    expect(answers).toMatchObject([{ shiftInstanceId: monday.id, status: 'available' }]);
    const status = await repo.getWeekAvailabilityStatus('mock-gianni', thisMonday);
    expect(status).toMatchObject({ state: 'complete', answeredCount: 1, missingCount: 0 });
  });

  it('setAvailability(unavailable) persists, and answering again changes the same row rather than adding a second one', async () => {
    const shifts = await repo.listDriverVisibleShifts('mock-crans');
    const monday = shifts.find((s) => s.weekStart === thisMonday)!;
    await repo.setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'unavailable' });
    await repo.setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });

    const answers = await repo.listAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', weekStart: thisMonday });
    expect(answers).toHaveLength(1);
    expect(answers[0].status).toBe('available');
  });

  it('partial answers persist across separate calls -- answering one shift does not require answering the whole week at once', async () => {
    const { MockShiftConfigurationRepository } = await import('./shiftConfiguration');
    const shiftRepo = new MockShiftConfigurationRepository();
    await shiftRepo.createShift('mock-crans', {
      name: 'Lunch',
      startTime: '12:00',
      endTime: '14:00',
      weekdays: [0, 1],
      requiredDrivers: 1,
      effectiveFrom: '2024-01-01',
    });

    const shifts = (await repo.listDriverVisibleShifts('mock-crans')).filter((s) => s.weekStart === thisMonday);
    expect(shifts.length).toBeGreaterThanOrEqual(2); // Dinner (Mon) + Lunch (Mon, Tue)
    const monday = shifts[0];
    await repo.setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });

    // Re-fetch as if the driver navigated away and back.
    const answersAfter = await repo.listAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', weekStart: thisMonday });
    expect(answersAfter.some((a) => a.shiftInstanceId === monday.id)).toBe(true);
  });

  it('confirmAvailabilityWeek is rejected as incomplete until every current active shift is answered', async () => {
    const outcome = await repo.confirmAvailabilityWeek('mock-gianni', thisMonday);
    expect(outcome.result).toBe('incomplete');
  });

  it('confirmAvailabilityWeek succeeds once every shift is answered, and stamps submittedAt', async () => {
    const shifts = await repo.listDriverVisibleShifts('mock-crans');
    const monday = shifts.find((s) => s.weekStart === thisMonday)!;
    await repo.setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });

    const outcome = await repo.confirmAvailabilityWeek('mock-gianni', thisMonday);
    expect(outcome.result).toBe('confirmed');
    expect(outcome.submittedAt).not.toBeNull();

    const submission = await repo.getAvailabilitySubmission('mock-gianni', thisMonday);
    expect(submission?.submittedAt).not.toBeNull();
  });

  it('reopenAvailabilityWeek clears the confirmation but preserves every existing answer', async () => {
    const shifts = await repo.listDriverVisibleShifts('mock-crans');
    const monday = shifts.find((s) => s.weekStart === thisMonday)!;
    await repo.setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });
    await repo.confirmAvailabilityWeek('mock-gianni', thisMonday);

    const outcome = await repo.reopenAvailabilityWeek('mock-gianni', thisMonday);
    expect(outcome.result).toBe('reopened');

    const submission = await repo.getAvailabilitySubmission('mock-gianni', thisMonday);
    expect(submission?.submittedAt).toBeNull();
    expect(submission?.reopenedReason).toBe('driver_reopened');

    const answers = await repo.listAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', weekStart: thisMonday });
    expect(answers).toMatchObject([{ shiftInstanceId: monday.id, status: 'available' }]);
  });

  it('reopenAvailabilityWeek reports not_submitted when the week was never confirmed', async () => {
    const outcome = await repo.reopenAvailabilityWeek('mock-gianni', thisMonday);
    expect(outcome.result).toBe('not_submitted');
  });

  it('getAvailabilitySubmission returns null when the driver has never confirmed this week', async () => {
    expect(await repo.getAvailabilitySubmission('mock-gianni', thisMonday)).toBeNull();
  });

  it('a published week is reported as locked, and confirm/reopen/setAvailability are all rejected', async () => {
    const shifts = await repo.listDriverVisibleShifts('mock-crans');
    const monday = shifts.find((s) => s.weekStart === thisMonday)!;
    mockRotaPublications.push({ resortId: 'mock-crans', weekStart: thisMonday, publishedAt: new Date().toISOString(), unpublishedAt: null });

    const status = await repo.getWeekAvailabilityStatus('mock-gianni', thisMonday);
    expect(status.state).toBe('locked');

    const confirmOutcome = await repo.confirmAvailabilityWeek('mock-gianni', thisMonday);
    expect(confirmOutcome.result).toBe('locked');

    const reopenOutcome = await repo.reopenAvailabilityWeek('mock-gianni', thisMonday);
    expect(reopenOutcome.result).toBe('locked');

    await expect(
      repo.setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' })
    ).rejects.toBeInstanceOf(RepositoryError);
  });

  it('a resort with zero configured Shifts reports state=no_shifts, never a fabricated confirmation requirement', async () => {
    // Verbier has no shift types/templates configured at all in the
    // baseline fixtures -- a genuine "nothing scheduled" resort, not just
    // an unlucky week.
    const { MockDriverRepository } = await import('./drivers');
    const driverRepo = new MockDriverRepository();
    const verbierDriver = await driverRepo.createDriver({ resortId: 'mock-verbier', fullName: 'Zero Shift Driver' });

    const shifts = await repo.listDriverVisibleShifts('mock-verbier');
    expect(shifts).toHaveLength(0);

    const status = await repo.getWeekAvailabilityStatus(verbierDriver.id, thisMonday);
    expect(status).toMatchObject({ state: 'no_shifts', totalShifts: 0, answeredCount: 0 });
    // The underlying readiness/confirm primitives allow confirming a
    // trivially-complete (0 of 0) week -- this is existing, deliberate RPC
    // behaviour (see confirm_availability_week), not something this
    // checkpoint changes. The product rule ("don't require a meaningless
    // confirmation") is enforced at the UI layer instead -- see
    // Availability.test.tsx's "zero-shift week never offers Confirm".
  });

  describe('manager-facing visibility', () => {
    it('listAvailabilitySubmissionStatus reports one row per active driver at the resort, not_started by default', async () => {
      const summary = await repo.listAvailabilitySubmissionStatus('mock-zermatt', thisMonday);
      expect(summary.map((s) => s.driverFullName).sort()).toEqual(['Alex', 'Tomas']);
      expect(summary.every((s) => s.state === 'not_started')).toBe(true);
    });

    it('listAvailabilitySubmissionStatus reflects in_progress/confirmed state transitions', async () => {
      const shifts = (await repo.listDriverVisibleShifts('mock-zermatt')).filter((s) => s.weekStart === thisMonday);
      const monday = shifts[0];
      await repo.setAvailability({ driverId: 'mock-alex', resortId: 'mock-zermatt', shiftInstanceId: monday.id, status: 'available' });

      let summary = await repo.listAvailabilitySubmissionStatus('mock-zermatt', thisMonday);
      expect(summary.find((s) => s.driverId === 'mock-alex')?.state).toBe('in_progress');
      expect(summary.find((s) => s.driverId === 'mock-tomas')?.state).toBe('not_started');

      await repo.confirmAvailabilityWeek('mock-alex', thisMonday);
      summary = await repo.listAvailabilitySubmissionStatus('mock-zermatt', thisMonday);
      expect(summary.find((s) => s.driverId === 'mock-alex')?.state).toBe('confirmed');
    });

    it('listAvailabilitySubmissionStatus reports needs_reconfirmation for a stale (system-reopened) submission', async () => {
      const shifts = (await repo.listDriverVisibleShifts('mock-zermatt')).filter((s) => s.weekStart === thisMonday);
      const monday = shifts[0];
      await repo.setAvailability({ driverId: 'mock-alex', resortId: 'mock-zermatt', shiftInstanceId: monday.id, status: 'available' });
      await repo.confirmAvailabilityWeek('mock-alex', thisMonday);

      const { mockAvailabilitySubmissions } = await import('./fixtures');
      const row = mockAvailabilitySubmissions.find((s) => s.driverId === 'mock-alex' && s.weekStart === thisMonday)!;
      row.submittedAt = null;
      row.reopenedReason = 'shift_time_changed';

      const summary = await repo.listAvailabilitySubmissionStatus('mock-zermatt', thisMonday);
      expect(summary.find((s) => s.driverId === 'mock-alex')?.state).toBe('needs_reconfirmation');
    });

    it('listAvailabilitySubmissionStatus reports locked once the resort/week is published', async () => {
      mockRotaPublications.push({ resortId: 'mock-zermatt', weekStart: thisMonday, publishedAt: new Date().toISOString(), unpublishedAt: null });
      const summary = await repo.listAvailabilitySubmissionStatus('mock-zermatt', thisMonday);
      expect(summary.every((s) => s.state === 'locked')).toBe(true);
    });

    it("getResortWeekAvailability returns one driver's own per-shift answers only, never another driver's", async () => {
      const shifts = (await repo.listDriverVisibleShifts('mock-zermatt')).filter((s) => s.weekStart === thisMonday);
      const monday = shifts[0];
      await repo.setAvailability({ driverId: 'mock-alex', resortId: 'mock-zermatt', shiftInstanceId: monday.id, status: 'available' });
      await repo.setAvailability({ driverId: 'mock-tomas', resortId: 'mock-zermatt', shiftInstanceId: monday.id, status: 'unavailable' });

      const alexDetail = await repo.getResortWeekAvailability('mock-alex', thisMonday);
      expect(alexDetail).toMatchObject([{ shiftInstanceId: monday.id, status: 'available' }]);

      const tomasDetail = await repo.getResortWeekAvailability('mock-tomas', thisMonday);
      expect(tomasDetail).toMatchObject([{ shiftInstanceId: monday.id, status: 'unavailable' }]);
    });
  });
});
