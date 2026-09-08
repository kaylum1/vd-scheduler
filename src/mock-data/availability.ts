import type { AvailabilityEntry, AvailabilityStatus, ShiftInstance } from '../types';
import { addWeeks, startOfWeek } from './date-utils';
import { getOperationalToday } from '../lib/operationalTime';
import { generateWeekShiftInstances } from './shifts';

/** How many past weeks are kept visible as read-only archive/history. */
export const ARCHIVE_WEEKS_BACK = 2;

/**
 * Returns every shift instance for a driver's resort across a small archive
 * window (a couple of past weeks, for history) through the end of next
 * month. Each week is tagged with whether it's published — archive weeks
 * and the current week are always published (already happened / already
 * locked); everything from next week onward is still open for submissions.
 * This publish boundary is mock-only — a real scheduling service decides
 * it for real later.
 */
export function getAvailabilityWindowInstances(resortId: string, today = getOperationalToday()): ShiftInstance[] {
  const currentWeekStart = startOfWeek(today);
  const windowStart = addWeeks(currentWeekStart, -ARCHIVE_WEEKS_BACK);
  const endOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 2, 0);

  const instances: ShiftInstance[] = [];
  let cursor = windowStart;
  let weekOffset = -ARCHIVE_WEEKS_BACK;

  while (cursor <= endOfNextMonth) {
    const isPublished = weekOffset <= 0;
    instances.push(
      ...generateWeekShiftInstances(cursor, isPublished).filter((s) => s.resortId === resortId)
    );
    cursor = addWeeks(cursor, 1);
    weekOffset += 1;
  }

  return instances;
}

/**
 * Deterministic mock availability status per driver/shift so the demo looks
 * intentional rather than random on every reload.
 */
export function mockAvailabilityStatus(
  driverId: string,
  shift: ShiftInstance,
  index: number
): AvailabilityStatus {
  if (shift.isPublished) {
    // Already-submitted, now-locked responses.
    return index % 4 === 3 ? 'unavailable' : 'available';
  }
  // Open weeks: mostly not yet submitted, with a few example responses.
  if (index % 5 === 0) return 'available';
  if (index % 7 === 0) return 'unavailable';
  return 'not-submitted';
}

export function buildAvailabilityEntries(driverId: string, resortId: string): AvailabilityEntry[] {
  const shifts = getAvailabilityWindowInstances(resortId);
  return shifts.map((shift, index) => ({
    driverId,
    shiftInstanceId: shift.id,
    status: mockAvailabilityStatus(driverId, shift, index),
  }));
}

export const availabilityStatusLabel: Record<AvailabilityStatus, string> = {
  available: 'Available',
  unavailable: 'Unavailable',
  'not-submitted': 'Not submitted',
};

/**
 * Week offsets (relative to the current week) that start out already
 * confirmed/submitted by the driver in this demo, purely to show the
 * "submitted, can still reopen before publish" state without any clicking.
 */
export const mockConfirmedWeekOffsets = [1];
