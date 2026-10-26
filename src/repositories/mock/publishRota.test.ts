import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockRotaRepository } from './rota';
import { MockAvailabilityRepository } from './availability';
import {
  mockDrivers,
  mockResorts,
  mockRotaAssignments,
  mockRotaPublications,
  mockShiftTemplates,
  mockShiftTypes,
  resetMockFixturesForTesting,
} from './fixtures';
import {
  PublishRotaConfirmationRequiredError,
  PublishRotaError,
  isAutoRotaError,
  isPublishRotaConfirmationRequired,
  isPublishRotaError,
} from '../errors';

// Far from "today" in both directions so most of the suite never depends on when it runs.
// The time-sensitive cases (today / partially historical) pin the clock explicitly.
const FUTURE_WEEK = '2030-01-07';
const PAST_WEEK = '2025-01-06';
const CRANS = 'mock-crans';
const VERBIER = 'mock-verbier'; // no shift templates at all

// Baseline fixtures: Crans has one Dinner template on Mondays, required_drivers = 2, and one driver, Gianni.
const FUTURE_DINNER = `mock-crans-dinner-tpl-${FUTURE_WEEK}`;

let repo: MockRotaRepository;

function addDriver(id: string, fullName: string, isActive = true, resortId = CRANS) {
  mockDrivers.push({ id, resortId, fullName, isActive, preferredLanguage: 'en' });
}
function seed(shiftInstanceId: string, driverId: string, source: 'manual' | 'auto' = 'manual') {
  mockRotaAssignments.push({ id: `seed-${shiftInstanceId}-${driverId}`, shiftInstanceId, driverId, resortId: CRANS, source, assignedAt: '2030-01-01T10:00:00.000Z' });
}
const publish = (params: { weekStart?: string; resortId?: string; confirmUncovered?: boolean } = {}) =>
  repo.publishRota({ resortId: params.resortId ?? CRANS, weekStart: params.weekStart ?? FUTURE_WEEK, confirmUncovered: params.confirmUncovered });
const fillDinner = () => {
  addDriver('mock-maria', 'Maria');
  seed(FUTURE_DINNER, 'mock-gianni');
  seed(FUTURE_DINNER, 'mock-maria');
};

beforeEach(() => {
  resetMockFixturesForTesting();
  repo = new MockRotaRepository();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MockRotaRepository.publishRota: results', () => {
  it('1. a fully covered week publishes without confirmation and returns the domain result', async () => {
    fillDinner();
    const result = await publish();
    expect(result).toEqual({
      resortId: CRANS,
      weekStart: FUTURE_WEEK,
      publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      uncoveredSlots: 0,
      alreadyPublished: false,
    });
    expect(mockRotaPublications).toHaveLength(1);
    expect(mockRotaPublications[0]).toMatchObject({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: result.publishedAt, unpublishedAt: null });
  });

  it('exposes nothing beyond the five domain fields (no generation source, actor or row id)', async () => {
    fillDinner();
    expect(Object.keys(await publish()).sort()).toEqual(['alreadyPublished', 'publishedAt', 'resortId', 'uncoveredSlots', 'weekStart']);
  });
});

describe('MockRotaRepository.publishRota: uncovered confirmation', () => {
  it('2-3. an uncovered week asks for confirmation first, carrying the exact count, and publishes nothing', async () => {
    seed(FUTURE_DINNER, 'mock-gianni'); // required 2, one assigned -> 1 open
    const error = await publish().catch((e) => e);
    expect(error).toBeInstanceOf(PublishRotaConfirmationRequiredError);
    expect(isPublishRotaConfirmationRequired(error)).toBe(true);
    expect(isPublishRotaError(error)).toBe(false);
    expect((error as PublishRotaConfirmationRequiredError).uncoveredSlots).toBe(1);
    expect(mockRotaPublications).toEqual([]);
  });

  it('an explicit confirmUncovered: false behaves like omitting it', async () => {
    const error = await publish({ confirmUncovered: false }).catch((e) => e);
    expect(isPublishRotaConfirmationRequired(error)).toBe(true);
    expect(mockRotaPublications).toEqual([]);
  });

  it('4. a confirmed call publishes and reports the count at that moment', async () => {
    seed(FUTURE_DINNER, 'mock-gianni');
    const result = await publish({ confirmUncovered: true });
    expect(result).toMatchObject({ uncoveredSlots: 1, alreadyPublished: false });
    expect(mockRotaPublications).toHaveLength(1);
  });

  it('5. the confirmed call RECOUNTS: it returns the current number, not the one the manager was shown', async () => {
    addDriver('mock-maria', 'Maria');
    const prompted = (await publish().catch((e) => e)) as PublishRotaConfirmationRequiredError;
    expect(prompted.uncoveredSlots).toBe(2);
    seed(FUTURE_DINNER, 'mock-maria'); // someone fills a position in the meantime
    const result = await publish({ confirmUncovered: true });
    expect(result.uncoveredSlots).toBe(1);
  });

  it('a confirmed call on a week that became fully covered simply publishes with 0', async () => {
    const prompted = await publish().catch((e) => e);
    expect(isPublishRotaConfirmationRequired(prompted)).toBe(true);
    fillDinner();
    expect((await publish({ confirmUncovered: true })).uncoveredSlots).toBe(0);
  });

  it('6. zero assignments is publishable through the confirmation flow (every position open)', async () => {
    const prompted = (await publish().catch((e) => e)) as PublishRotaConfirmationRequiredError;
    expect(prompted.uncoveredSlots).toBe(2);
    expect(mockRotaAssignments).toHaveLength(0);
    const result = await publish({ confirmUncovered: true });
    expect(result).toMatchObject({ uncoveredSlots: 2, alreadyPublished: false });
  });

  it('coverage counts ACTIVE drivers only: an inactive assignee does not cover a position', async () => {
    fillDinner();
    mockDrivers.find((d) => d.id === 'mock-maria')!.isActive = false;
    expect(((await publish().catch((e) => e)) as PublishRotaConfirmationRequiredError).uncoveredSlots).toBe(1);
  });

  it('over-assignment never produces a negative count', async () => {
    fillDinner();
    addDriver('mock-pat', 'Pat');
    seed(FUTURE_DINNER, 'mock-pat'); // 3 assigned, 2 required
    expect((await publish()).uncoveredSlots).toBe(0);
  });

  it('assignments to another resort\'s shifts do not cover this resort', async () => {
    fillDinner();
    // Zermatt's own Monday dinner is not Crans', and publishing Crans never looks at it.
    expect((await publish()).uncoveredSlots).toBe(0);
    expect(isPublishRotaConfirmationRequired(await publish({ resortId: 'mock-zermatt' }).catch((e) => e))).toBe(true);
  });
});

describe('MockRotaRepository.publishRota: guards', () => {
  it('7. a week with no shifts is no_shifts, and nothing is published', async () => {
    const error = await publish({ resortId: VERBIER, confirmUncovered: true }).catch((e) => e);
    expect(isPublishRotaError(error, 'no_shifts')).toBe(true);
    expect(mockRotaPublications).toEqual([]);
  });

  it('a Crans week whose only template has been deactivated has no shifts either', async () => {
    mockShiftTemplates.find((t) => t.id === 'mock-crans-dinner-tpl')!.isActive = false;
    expect(isPublishRotaError(await publish().catch((e) => e), 'no_shifts')).toBe(true);
  });

  it('8. a wholly historical week is historical_week, even with shifts and full coverage', async () => {
    const pastDinner = `mock-crans-dinner-tpl-${PAST_WEEK}`;
    addDriver('mock-maria', 'Maria');
    seed(pastDinner, 'mock-gianni');
    seed(pastDinner, 'mock-maria');
    const error = await publish({ weekStart: PAST_WEEK, confirmUncovered: true }).catch((e) => e);
    expect(isPublishRotaError(error, 'historical_week')).toBe(true);
    expect(mockRotaPublications).toEqual([]);
  });

  it('a wholly past week with NO shifts is historical_week (past takes precedence over no_shifts)', async () => {
    expect(isPublishRotaError(await publish({ resortId: VERBIER, weekStart: PAST_WEEK }).catch((e) => e), 'historical_week')).toBe(true);
  });

  it('11. an inactive resort is resort_inactive and nothing is published', async () => {
    mockResorts.find((r) => r.id === CRANS)!.isActive = false;
    fillDinner();
    const error = await publish({ confirmUncovered: true }).catch((e) => e);
    expect(isPublishRotaError(error, 'resort_inactive')).toBe(true);
    expect(mockRotaPublications).toEqual([]);
  });

  it('12. an unknown resort is resort_not_found', async () => {
    expect(isPublishRotaError(await publish({ resortId: 'mock-nowhere' }).catch((e) => e), 'resort_not_found')).toBe(true);
  });

  it.each([['2030-01-08'], ['not-a-date'], ['']])('a week that is not a valid Monday (%j) is invalid_week', async (weekStart) => {
    expect(isPublishRotaError(await publish({ weekStart }).catch((e) => e), 'invalid_week')).toBe(true);
    expect(mockRotaPublications).toEqual([]);
  });

  it('a missing resort id is invalid_week', async () => {
    expect(isPublishRotaError(await publish({ resortId: '' }).catch((e) => e), 'invalid_week')).toBe(true);
  });

  it('throws the same typed error classes, with the same first-party copy, as the Supabase provider', async () => {
    const error = (await publish({ resortId: VERBIER }).catch((e) => e)) as PublishRotaError;
    expect(error).toBeInstanceOf(PublishRotaError);
    expect(error.userMessage).toBe('This rota can’t be published because there are no shifts this week.');
  });
});

describe('MockRotaRepository.publishRota: operational date (pinned clock)', () => {
  // Wednesday 2030-01-09, midday UTC (13:00 in Zurich). The week of 2030-01-07 has the baseline Monday
  // Dinner (required 2, already past) plus a Wednesday Lunch (required 1) added here.
  const TODAY_WEEK = '2030-01-07';
  const WED_LUNCH = `mock-crans-lunch-tpl-2030-01-09`;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-09T12:00:00Z'));
    mockShiftTypes.push({ id: 'mock-crans-lunch', resortId: CRANS, key: 'lunch', name: 'Lunch', sortOrder: 0, isActive: true });
    mockShiftTemplates.push({
      id: 'mock-crans-lunch-tpl', resortId: CRANS, shiftTypeId: 'mock-crans-lunch', weekday: 2,
      startTime: '12:00', endTime: '14:00', requiredDrivers: 1, basePayChf: null, deliveryRateChf: null, isPremium: null,
      effectiveFrom: '2024-01-01', effectiveTo: null, isActive: true, updatedAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('9. a partially historical week is publishable, and a PAST unstaffed shift is not counted as uncovered', async () => {
    seed(WED_LUNCH, 'mock-gianni'); // Monday Dinner (past, 2 open) is ignored; today's Lunch is covered
    const result = await publish({ weekStart: TODAY_WEEK });
    expect(result).toMatchObject({ uncoveredSlots: 0, alreadyPublished: false });
  });

  it('10. a shift dated TODAY counts and is allowed: an open position today asks for confirmation (1, not 3)', async () => {
    const prompted = (await publish({ weekStart: TODAY_WEEK }).catch((e) => e)) as PublishRotaConfirmationRequiredError;
    expect(prompted.uncoveredSlots).toBe(1);
    expect((await publish({ weekStart: TODAY_WEEK, confirmUncovered: true })).uncoveredSlots).toBe(1);
  });

  it('a current week whose every active shift is before today is historical_week', async () => {
    vi.setSystemTime(new Date('2030-01-10T12:00:00Z')); // Thursday: Monday Dinner and Wednesday Lunch are both past
    expect(isPublishRotaError(await publish({ weekStart: TODAY_WEEK, confirmUncovered: true }).catch((e) => e), 'historical_week')).toBe(true);
    expect(mockRotaPublications).toEqual([]);
  });

  it('the Sunday of a week is still "this week" for a wholly-past check (the week ended yesterday -> historical)', async () => {
    vi.setSystemTime(new Date('2030-01-14T12:00:00Z')); // the following Monday
    expect(isPublishRotaError(await publish({ weekStart: TODAY_WEEK, confirmUncovered: true }).catch((e) => e), 'historical_week')).toBe(true);
  });
});

describe('MockRotaRepository.publishRota: idempotency and republish', () => {
  it('13-14. publishing an already published week is a success: alreadyPublished, no duplicate, timestamp untouched', async () => {
    fillDinner();
    const first = await publish();
    const second = await publish();
    expect(second).toEqual({ ...first, alreadyPublished: true });
    expect(second.publishedAt).toBe(first.publishedAt);
    expect(mockRotaPublications).toHaveLength(1);
    expect(mockRotaPublications[0].publishedAt).toBe(first.publishedAt);
  });

  it('an already published week succeeds even when positions are uncovered, without asking again, reporting the current count', async () => {
    await publish({ confirmUncovered: true });
    const again = await publish(); // no confirmation flag
    expect(again).toMatchObject({ alreadyPublished: true, uncoveredSlots: 2 });
    seed(FUTURE_DINNER, 'mock-gianni');
    expect((await publish()).uncoveredSlots).toBe(1);
  });

  it('an already published mock row seeded directly (older fixture style, no generation source) is also idempotent', async () => {
    mockRotaPublications.push({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    const result = await publish();
    expect(result).toMatchObject({ alreadyPublished: true, publishedAt: '2030-01-01T00:00:00Z' });
    expect(mockRotaPublications).toHaveLength(1);
  });

  it('republishes a retracted row in place (one logical row per resort + week), refreshing the timestamp', async () => {
    fillDinner();
    mockRotaPublications.push({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: '2030-01-02T00:00:00Z', generationSource: 'manual' });
    const result = await publish();
    expect(result.alreadyPublished).toBe(false);
    expect(result.publishedAt).not.toBe('2030-01-01T00:00:00Z');
    expect(mockRotaPublications).toHaveLength(1);
    expect(mockRotaPublications[0]).toMatchObject({ publishedAt: result.publishedAt, unpublishedAt: null });
  });

  it('a retracted week still requires the uncovered confirmation', async () => {
    mockRotaPublications.push({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: '2030-01-02T00:00:00Z' });
    expect(isPublishRotaConfirmationRequired(await publish().catch((e) => e))).toBe(true);
    expect(mockRotaPublications[0].unpublishedAt).toBe('2030-01-02T00:00:00Z');
  });

  it('a publication of another week or another resort does not make this week "already published"', async () => {
    fillDinner();
    mockRotaPublications.push({ resortId: 'mock-zermatt', weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    mockRotaPublications.push({ resortId: CRANS, weekStart: '2030-01-14', publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    expect((await publish()).alreadyPublished).toBe(false);
    expect(mockRotaPublications).toHaveLength(3);
  });
});

describe('MockRotaRepository.publishRota: internal generation source', () => {
  it('22. manual assignments only -> manual; any auto assignment -> auto; zero assignments -> manual', async () => {
    await publish({ confirmUncovered: true });
    expect(mockRotaPublications[0].generationSource).toBe('manual'); // zero assignments

    resetMockFixturesForTesting();
    fillDinner();
    await publish();
    expect(mockRotaPublications[0].generationSource).toBe('manual');

    resetMockFixturesForTesting();
    addDriver('mock-maria', 'Maria');
    seed(FUTURE_DINNER, 'mock-gianni', 'manual');
    seed(FUTURE_DINNER, 'mock-maria', 'auto');
    await publish();
    expect(mockRotaPublications[0].generationSource).toBe('auto');
  });

  it('is recomputed (never carried over) when a retracted row is republished', async () => {
    fillDinner();
    mockRotaPublications.push({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: '2030-01-02T00:00:00Z', generationSource: 'auto' });
    await publish();
    expect(mockRotaPublications[0].generationSource).toBe('manual');
  });

  it('only counts auto assignments inside the target resort + week', async () => {
    fillDinner();
    seed('mock-crans-dinner-tpl-2030-01-14', 'mock-gianni', 'auto'); // a different week
    await publish();
    expect(mockRotaPublications[0].generationSource).toBe('manual');
  });

  it('is never part of the returned domain result', async () => {
    fillDinner();
    expect(await publish()).not.toHaveProperty('generationSource');
  });
});

describe('MockRotaRepository.publishRota: what publishing changes elsewhere', () => {
  it('15. the manager week read flips to Published', async () => {
    fillDinner();
    expect((await repo.getManagerWeekRota({ resortId: CRANS, weekStart: FUTURE_WEEK })).isPublished).toBe(false);
    await publish();
    expect((await repo.getManagerWeekRota({ resortId: CRANS, weekStart: FUTURE_WEEK })).isPublished).toBe(true);
  });

  it('a rejected or unconfirmed publish leaves the manager week unpublished', async () => {
    await publish().catch(() => undefined);
    await publish({ resortId: VERBIER }).catch(() => undefined);
    expect((await repo.getManagerWeekRota({ resortId: CRANS, weekStart: FUTURE_WEEK })).isPublished).toBe(false);
    expect(mockRotaPublications).toEqual([]);
  });

  it('16-17. Driver My Rota flips to Published and shows the driver\'s OWN assignment only', async () => {
    addDriver('mock-maria', 'Maria');
    seed(FUTURE_DINNER, 'mock-gianni');
    seed(FUTURE_DINNER, 'mock-maria');
    expect(await repo.getDriverWeekRota({ weekStart: FUTURE_WEEK, driverId: 'mock-gianni' })).toMatchObject({ isPublished: false, shifts: [] });

    await publish();
    const gianni = await repo.getDriverWeekRota({ weekStart: FUTURE_WEEK, driverId: 'mock-gianni' });
    expect(gianni.isPublished).toBe(true);
    expect(gianni.shifts.map((s) => s.shiftInstanceId)).toEqual([FUTURE_DINNER]);
    // the colleague sees their own copy of the same shift, never anyone else's identity
    expect(JSON.stringify(gianni)).not.toMatch(/Maria|mock-maria/);
  });

  it('18. a same-resort driver with no assignment sees Published + empty after a zero-assignment publish', async () => {
    await publish({ confirmUncovered: true });
    expect(await repo.getDriverWeekRota({ weekStart: FUTURE_WEEK, driverId: 'mock-gianni' })).toEqual({
      weekStart: FUTURE_WEEK,
      isPublished: true,
      shifts: [],
    });
  });

  it('a driver of ANOTHER resort sees nothing published', async () => {
    fillDinner();
    await publish();
    expect(await repo.getDriverWeekRota({ weekStart: FUTURE_WEEK, driverId: 'mock-alex' })).toMatchObject({ isPublished: false, shifts: [] });
  });

  it('19. driver Availability becomes locked: status locked, writes rejected', async () => {
    const availability = new MockAvailabilityRepository();
    fillDinner();
    expect((await availability.getWeekAvailabilityStatus('mock-gianni', FUTURE_WEEK)).state).not.toBe('locked');
    await publish();
    expect((await availability.getWeekAvailabilityStatus('mock-gianni', FUTURE_WEEK)).state).toBe('locked');
    await expect(
      availability.setAvailability({ driverId: 'mock-gianni', resortId: CRANS, shiftInstanceId: FUTURE_DINNER, status: 'available' })
    ).rejects.toMatchObject({ code: '42501' });
    expect((await availability.confirmAvailabilityWeek('mock-gianni', FUTURE_WEEK)).result).toBe('locked');
  });

  it('20. Auto-Rota generation is refused for the published week, and nothing is added', async () => {
    await publish({ confirmUncovered: true });
    const before = mockRotaAssignments.length;
    const error = await repo.generateAutoRota({ resortId: CRANS, weekStart: FUTURE_WEEK }).catch((e) => e);
    expect(isAutoRotaError(error, 'published_week')).toBe(true);
    expect(mockRotaAssignments).toHaveLength(before);
  });

  it('21. existing Manual Rota assignments are untouched, and manual edits stay possible afterwards', async () => {
    fillDinner();
    const before = JSON.parse(JSON.stringify(mockRotaAssignments));
    await publish();
    expect(mockRotaAssignments).toEqual(before);

    // The published week stays editable and the driver sees the change live (no snapshot).
    await repo.unassignDriver({ shiftInstanceId: FUTURE_DINNER, driverId: 'mock-gianni' });
    expect((await repo.getDriverWeekRota({ weekStart: FUTURE_WEEK, driverId: 'mock-gianni' })).shifts).toEqual([]);
    expect((await repo.getManagerWeekRota({ resortId: CRANS, weekStart: FUTURE_WEEK })).isPublished).toBe(true);
    expect(mockRotaPublications).toHaveLength(1);
  });

  it('publishing one resort does not publish the same week elsewhere', async () => {
    fillDinner();
    await publish();
    expect((await repo.getManagerWeekRota({ resortId: 'mock-zermatt', weekStart: FUTURE_WEEK })).isPublished).toBe(false);
  });

  it('23. resetMockFixturesForTesting clears every publication side effect', async () => {
    fillDinner();
    await publish();
    expect(mockRotaPublications).toHaveLength(1);
    resetMockFixturesForTesting();
    expect(mockRotaPublications).toEqual([]);
    expect(mockRotaAssignments).toEqual([]);
    expect((await repo.getManagerWeekRota({ resortId: CRANS, weekStart: FUTURE_WEEK })).isPublished).toBe(false);
    expect((await new MockAvailabilityRepository().getWeekAvailabilityStatus('mock-gianni', FUTURE_WEEK)).state).not.toBe('locked');
  });
});
