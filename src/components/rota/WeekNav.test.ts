import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWeekRelation } from './WeekNav';
import { startOfWeek } from '../../mock-data/date-utils';

/**
 * getWeekRelation's default `today` used to be a bare `new Date()`. "This
 * Week"/"Next Week" must mean the same calendar week for every viewer
 * regardless of device timezone, so it now defaults to the operational
 * (Europe/Zurich) date.
 */
describe('getWeekRelation default uses the operational (Zurich) week, not the device timezone', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a week that is "current" in Zurich is reported as current, at an instant where a New York device\'s own wall clock would still be in the prior day', () => {
    // Same cross-midnight scenario as operationalTime.test.ts: Zurich has
    // rolled into Dec 19 (still the same ISO week as Dec 14-20); New
    // York's own wall clock still reads Dec 18.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-19T04:30:00Z'));

    const zurichCurrentWeekStart = startOfWeek(new Date(2026, 11, 15)); // Dec 15 2026 is a Tuesday, in the Mon 14 - Sun 20 week
    expect(getWeekRelation(zurichCurrentWeekStart)).toBe('current');
  });
});
