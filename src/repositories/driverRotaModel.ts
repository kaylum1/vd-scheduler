/**
 * Pure assembly of the DRIVER's weekly rota from the two driver-safe reads
 * (publication state + own published assignments). Both providers feed this
 * the same ingredients, so ordering, time formatting and the "unpublished is
 * always empty" rule are identical by construction.
 *
 * No I/O. Deliberately separate from managerRotaModel.ts: the driver read
 * model carries none of the manager data (headcount, other drivers,
 * availability, ...), so nothing here could leak it.
 */

import type { DriverRotaShift, DriverVisibleAssignment, DriverWeekRota } from './domain';

export interface DriverRotaBuildInput {
  weekStart: string;
  /** True iff the driver-safe publication view returned a row for this week. */
  isPublished: boolean;
  /** Rows from the driver-safe assignments view. Order is irrelevant -- the builder sorts. */
  assignments: DriverVisibleAssignment[];
}

/** 'HH:MM:SS' (Postgres time) and 'HH:MM' (mock) both become 'HH:MM'. */
const clock = (time: string): string => time.slice(0, 5);

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildDriverWeekRota(input: DriverRotaBuildInput): DriverWeekRota {
  // Defence in depth. The views already guarantee both, but the model must
  // not rely on that: an unpublished week never carries shifts, and a row from
  // another week never leaks into this one.
  if (!input.isPublished) {
    return { weekStart: input.weekStart, isPublished: false, shifts: [] };
  }

  const shifts: DriverRotaShift[] = input.assignments
    .filter((a) => a.weekStart === input.weekStart)
    .map((a) => ({
      shiftInstanceId: a.shiftInstanceId,
      date: a.date,
      shiftName: a.name,
      startTime: clock(a.startTime),
      endTime: clock(a.endTime),
    }))
    .sort(
      (a, b) =>
        byString(a.date, b.date) ||
        byString(a.startTime, b.startTime) ||
        byString(a.shiftName, b.shiftName) ||
        byString(a.shiftInstanceId, b.shiftInstanceId)
    );

  return { weekStart: input.weekStart, isPublished: true, shifts };
}
