/**
 * Small date helpers shared by the mock-data generators and the rota UI.
 * Pure functions only — no business logic (fairness, publishing rules, etc.)
 * lives here, that will arrive with the real scheduling service.
 */

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAY_LABELS_FULL = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/** Parses a "YYYY-MM-DD" string as a local-time Date (avoids UTC parsing shifts). */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toISODate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Returns the Monday of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addWeeks(date: Date, weeks: number): Date {
  return addDays(date, weeks * 7);
}

export function getWeekDates(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function formatDayLabel(date: Date): string {
  return `${date.getDate()} ${date.toLocaleString('en-GB', { month: 'short' })}`;
}

export function formatWeekRangeLabel(weekStart: Date): string {
  const weekEnd = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const startLabel = weekStart.toLocaleString('en-GB', { month: 'short' });
  const endLabel = weekEnd.toLocaleString('en-GB', { month: 'short' });
  if (sameMonth) {
    return `${weekStart.getDate()} – ${weekEnd.getDate()} ${endLabel} ${weekEnd.getFullYear()}`;
  }
  return `${weekStart.getDate()} ${startLabel} – ${weekEnd.getDate()} ${endLabel} ${weekEnd.getFullYear()}`;
}

export function isSameDate(a: Date, b: Date): boolean {
  return toISODate(a) === toISODate(b);
}

export function isToday(date: Date): boolean {
  return isSameDate(date, new Date());
}

export function isTomorrow(date: Date): boolean {
  return isSameDate(date, addDays(new Date(), 1));
}

/** Whole weeks between two Monday-anchored week-starts (b - a, in weeks). */
export function getWeekOffset(weekStart: Date, referenceWeekStart: Date): number {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.round((weekStart.getTime() - referenceWeekStart.getTime()) / msPerWeek);
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

/** Short label for <input type="date"> fields, e.g. "2026-09-04". */
export const formatDateInputValue = toISODate;

export function formatShortDate(date: Date): string {
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
