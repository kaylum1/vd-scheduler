import { afterEach, describe, expect, it, vi } from 'vitest';
import { isToday, isTomorrow, parseISODate } from './date-utils';

/**
 * Regression coverage for the Stage 2C.1 fix: isToday/isTomorrow used to
 * default to a bare `new Date()` (the device's own timezone); they now
 * resolve "today" via getOperationalToday() (Europe/Zurich). These tests
 * reproduce the exact device-vs-Zurich mismatch scenario from
 * operationalTime.test.ts through the actual UI-facing helpers.
 */
describe('isToday / isTomorrow use the operational (Zurich) date, not the device timezone', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a date that is "today" in Zurich is reported as today, at an instant where a New York device\'s own wall clock would still show yesterday', () => {
    // 04:30 UTC on Dec 19 is already Dec 19 in Zurich (CET, UTC+1) but
    // still Dec 18 by New York's own wall clock (EST, UTC-5) -- this is
    // the exact mismatch the operational-timezone policy exists to
    // prevent leaking into "today" (see operationalTime.test.ts for the
    // same instant checked directly against both explicit zones).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-19T04:30:00Z'));

    expect(isToday(parseISODate('2026-12-19'))).toBe(true);
    expect(isToday(parseISODate('2026-12-18'))).toBe(false);
  });

  it('isTomorrow is one day after the operational (Zurich) today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-19T04:30:00Z'));

    expect(isTomorrow(parseISODate('2026-12-20'))).toBe(true);
    expect(isTomorrow(parseISODate('2026-12-19'))).toBe(false);
  });
});
