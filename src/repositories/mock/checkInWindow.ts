/**
 * The MOCK's check-in window: 30 minutes before a shift's scheduled start through its scheduled
 * end, both inclusive, computed in the resort's timezone. The mock has no database to do this,
 * so it mirrors _check_in_window here -- and ONLY here: the Supabase provider and every
 * component take the server-computed instants and do no timezone arithmetic.
 */

const OPEN_BEFORE_START_MS = 30 * 60 * 1000;

/** The zone's UTC offset (ms) at a given instant. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second'));
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/** 'YYYY-MM-DD' + 'HH:MM' wall-clock in `timeZone` -> the absolute instant (DST-safe except for a nonexistent / ambiguous local time). */
export function zonedWallTimeToInstant(isoDate: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return new Date(guess - zoneOffsetMs(first, timeZone));
}

export interface MockCheckInWindow {
  opensAt: Date;
  closesAt: Date;
}

export function mockCheckInWindow(shift: { date: string; startTime: string; endTime: string }, timeZone: string): MockCheckInWindow {
  const start = zonedWallTimeToInstant(shift.date, shift.startTime.slice(0, 5), timeZone);
  const end = zonedWallTimeToInstant(shift.date, shift.endTime.slice(0, 5), timeZone);
  return { opensAt: new Date(start.getTime() - OPEN_BEFORE_START_MS), closesAt: end };
}
