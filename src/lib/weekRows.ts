import { getWeekDates, toISODate } from '../mock-data/date-utils';
import type { ShiftInstance } from '../types';

export interface WeekRow {
  /** The shift name shared by every populated cell in this row (computed from data, never hard-coded). */
  name: string;
  cells: (ShiftInstance | null)[];
}

/**
 * Aligns a week's shifts into rows so the same shift name lands in the same
 * row on every day it occurs, with empty/disabled cells where it doesn't.
 * Row order follows each name's earliest start time that week (e.g. a
 * 12:00 "Lunch" row above an 18:00 "Dinner" row) — nothing about the shape
 * of the grid is hard-coded, it falls entirely out of the week's data, so
 * a resort with a third shift type, or none at all, is handled the same way.
 *
 * Shared by the Manager Rota grid and the Driver Availability week grid so
 * both present the same underlying week the same way.
 */
export function buildWeekRows(weekStart: Date, shifts: ShiftInstance[]): WeekRow[] {
  const dates = getWeekDates(weekStart);
  const isoDates = dates.map(toISODate);

  const earliestStartByName = new Map<string, string>();
  for (const shift of shifts) {
    const current = earliestStartByName.get(shift.name);
    if (!current || shift.startTime < current) {
      earliestStartByName.set(shift.name, shift.startTime);
    }
  }

  const names = Array.from(earliestStartByName.keys()).sort((a, b) => {
    const timeCompare = earliestStartByName.get(a)!.localeCompare(earliestStartByName.get(b)!);
    return timeCompare !== 0 ? timeCompare : a.localeCompare(b);
  });

  return names.map((name) => ({
    name,
    cells: isoDates.map(
      (iso) => shifts.find((s) => s.date === iso && s.name === name) ?? null
    ),
  }));
}
