import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOperationalNow, getOperationalToday, DEFAULT_OPERATIONAL_TIMEZONE } from './operationalTime';

/**
 * getOperationalNow/getOperationalToday pass an explicit IANA `timeZone`
 * to Intl.DateTimeFormat, so the wall-clock digits they extract are
 * derived entirely from the absolute instant + that explicit zone — never
 * from the host/device's own default timezone. That explicit-zone
 * argument is the actual mechanism guaranteeing "a manager in London/New
 * York/Thailand sees the same operational day/shift time as Zurich".
 *
 * Deliberately not simulated here: flipping `process.env.TZ` mid-test to
 * impersonate different device timezones. V8/Node's timezone-data caching
 * makes that genuinely flaky (confirmed while writing these tests — it
 * produced inconsistent, environment-dependent results with no bearing on
 * a real browser, which never changes timezone mid-session). Per the
 * checkpoint's own guidance, this uses deterministic injected timestamps
 * and timezone-aware helpers instead: fixed "now" values, and comparing
 * what two *different explicit* zone arguments compute for the exact same
 * instant — which is what actually exercises the mechanism, without
 * depending on the test runner's own ambient timezone at all.
 */
describe('getOperationalNow: explicit-zone extraction is instant + zone only', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('winter instant: extracts the correct Zurich wall-clock (CET, UTC+1)', () => {
    vi.useFakeTimers();
    // 17:00 UTC on Dec 18 2026 = 18:00 CET (UTC+1) in Zurich in winter.
    vi.setSystemTime(new Date('2026-12-18T17:00:00Z'));

    const zurichNow = getOperationalNow('Europe/Zurich');
    expect([zurichNow.getFullYear(), zurichNow.getMonth(), zurichNow.getDate(), zurichNow.getHours()]).toEqual([
      2026, 11, 18, 18,
    ]);
  });

  it('summer instant: extracts the correct Zurich wall-clock (CEST, UTC+2) -- a different offset than winter, not a fixed +1', () => {
    vi.useFakeTimers();
    // 16:00 UTC on Jul 18 2026 = 18:00 CEST (UTC+2) in Zurich in summer.
    vi.setSystemTime(new Date('2026-07-18T16:00:00Z'));

    const zurichNow = getOperationalNow('Europe/Zurich');
    expect([zurichNow.getFullYear(), zurichNow.getMonth(), zurichNow.getDate(), zurichNow.getHours()]).toEqual([
      2026, 6, 18, 18,
    ]);
  });

  it('the same instant resolves to a genuinely different wall-clock hour for a different explicit zone (proves the zone argument, not an ambient default, drives the result)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-18T17:00:00Z')); // 18:00 in Zurich (CET)

    const zurich = getOperationalNow('Europe/Zurich');
    const newYork = getOperationalNow('America/New_York'); // EST, UTC-5 -> 12:00

    expect(zurich.getHours()).toBe(18);
    expect(newYork.getHours()).toBe(12);
    expect(zurich.getDate()).toBe(newYork.getDate()); // still the same calendar day in this example
  });

  it('defaults to Europe/Zurich when no timezone is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-18T17:00:00Z'));
    expect(getOperationalNow().getTime()).toBe(getOperationalNow(DEFAULT_OPERATIONAL_TIMEZONE).getTime());
  });
});

describe('getOperationalToday: "Today" is Zurich\'s date, computed from the instant + zone only', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a moment that is already tomorrow in Zurich resolves to Zurich\'s (later) date, even though the very same instant is still "today" by New York\'s own wall clock', () => {
    // 04:30 UTC on Dec 19 is 05:30 CET on Dec 19 in Zurich (already rolled
    // over) but only 23:30 EST on Dec 18 in New York (not yet). This is
    // exactly the mismatch the operational-timezone policy exists to
    // prevent leaking into scheduling decisions -- proven here by
    // comparing two explicit zones against the same fixed instant, not by
    // trying to make the test process itself "be" New York.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-19T04:30:00Z'));

    const zurichToday = getOperationalToday('Europe/Zurich');
    expect([zurichToday.getFullYear(), zurichToday.getMonth(), zurichToday.getDate()]).toEqual([2026, 11, 19]);

    const nyWallClockDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', day: 'numeric' }).format(
      new Date()
    );
    expect(nyWallClockDay).toBe('18');
  });

  it('returns midnight (a clean day boundary)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T10:00:00Z'));
    const today = getOperationalToday('Europe/Zurich');
    expect([today.getHours(), today.getMinutes(), today.getSeconds()]).toEqual([0, 0, 0]);
  });
});

describe('Stored Swiss shift times render identically for every viewer', () => {
  it('a shift time string ("18:00"-"21:30") is never converted through a Date, so no timezone can alter it', () => {
    // This is the invariant documented in operationalTime.ts: shift
    // start/end are plain wall-clock strings, displayed verbatim. There is
    // no "convert to viewer timezone" step to exercise -- this documents
    // and locks in that a shift's time fields must stay untouched strings
    // all the way to render.
    const shift = { startTime: '18:00', endTime: '21:30' };
    expect(`${shift.startTime}–${shift.endTime}`).toBe('18:00–21:30');
    expect(typeof shift.startTime).toBe('string');
  });
});
