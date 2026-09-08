/**
 * The one place the frontend asks "what is 'now'/'today' for operational
 * scheduling purposes" (Stage 2C.1 timezone policy).
 *
 * Scheduling/operational calendar data (shift dates, "Today"/"Tomorrow",
 * rota/availability week boundaries) is always anchored to the resort's
 * operational timezone — Europe/Zurich for every V1 resort — never the
 * viewer's browser/device timezone. A manager in London at 23:30 local
 * time, or a driver in Thailand, must see the same operational day
 * Zurich is currently in.
 *
 * System/event timestamps (createdAt, submittedAt, auditedAt, ...) are a
 * completely separate concern — they're already absolute instants
 * (`new Date().toISOString()`, DB `timestamptz`) and are correctly
 * timezone-independent already. Nothing here applies to them.
 *
 * Also note: shift start/end times (e.g. "18:00") are plain wall-clock
 * strings, displayed verbatim — never converted through a JS `Date`. A
 * `Date` object always carries an implicit timezone interpretation on
 * every getter/formatter, which is exactly what a bare "18:00" label must
 * never be subject to. Do not introduce a `formatShiftTime`-style helper
 * that round-trips a shift time through `Date` — there is nothing for it
 * to safely do that raw string interpolation doesn't already do correctly.
 */

/** Authoritative operational timezone for every V1 resort. Once a resort
 * with a different timezone exists, pass its own `resorts.timezone` value
 * as the `timezone` argument below instead of relying on this default —
 * mirrors the database's `operational_today(resort_id)` (Stage 2C.1). */
export const DEFAULT_OPERATIONAL_TIMEZONE = 'Europe/Zurich';

/**
 * "Now", expressed as a `Date` whose local getters (getFullYear/getMonth/
 * getDate/getDay/getHours/...) return the wall-clock values of `timezone`
 * — regardless of what timezone the browser itself is in. This is the
 * standard trick for timezone-correct calendar arithmetic in JS: the
 * returned Date's *absolute instant* (getTime()) is deliberately not
 * meaningful (never use it for elapsed-time math or comparisons against a
 * real Date) — only its calendar-component getters are, which is exactly
 * what the existing pure calendar-arithmetic helpers in
 * `mock-data/date-utils.ts` (addDays, startOfWeek, toISODate, ...) already
 * consume safely once given a correct starting point.
 */
export function getOperationalNow(timezone: string = DEFAULT_OPERATIONAL_TIMEZONE): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // A midnight instant can format its hour as "24" under hour12:false in
  // some engines -- normalise to 0 so the constructed Date stays on the
  // intended calendar day rather than rolling into the next one.
  const hour = part('hour') % 24;

  return new Date(part('year'), part('month') - 1, part('day'), hour, part('minute'), part('second'));
}

/** Midnight, "today" in `timezone` (default: Europe/Zurich). */
export function getOperationalToday(timezone: string = DEFAULT_OPERATIONAL_TIMEZONE): Date {
  const now = getOperationalNow(timezone);
  now.setHours(0, 0, 0, 0);
  return now;
}
