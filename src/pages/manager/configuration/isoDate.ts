/**
 * Tiny pure-calendar helpers for plain "YYYY-MM-DD" date strings (shift
 * template effective_from/effective_to — DATE columns, never timestamps).
 * Deliberately self-contained rather than importing from
 * `mock-data/date-utils` — Configuration must never depend on the Stage 1.1
 * mock-data module (see Configuration.test.tsx's architecture check), and
 * these three functions are simple enough that duplicating them here is
 * cheaper than the alternative. Safe per the Stage 2C.1 timezone policy:
 * these never touch `Date.prototype.getTime()`/UTC, only local
 * year/month/day components on Dates built from already-local numbers, so
 * no timezone conversion ever happens.
 */

/** A `Date` (from getOperationalToday() or similar) -> "YYYY-MM-DD". */
export function toIsoDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "YYYY-MM-DD" + a day offset (may be negative) -> "YYYY-MM-DD". */
export function addIsoDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return toIsoDateString(new Date(y, m - 1, d + days));
}

/** The later of two "YYYY-MM-DD" strings — safe as plain string comparison since the format is zero-padded and lexicographically ordered. */
export function maxIsoDate(a: string, b: string): string {
  return a > b ? a : b;
}

/** "YYYY-MM-DD" -> "1 December 2026", for effective-date display. */
export function formatIsoDateLong(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
