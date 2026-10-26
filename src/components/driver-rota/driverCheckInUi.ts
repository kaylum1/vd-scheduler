import { RepositoryError, isDriverCheckInError } from '../../repositories/errors';
import type { DriverRotaShift } from '../../repositories/domain';
import { formatOperationalClock } from '../../lib/operationalTime';

/**
 * Presentation rules for the driver's Check in control (Driver My Rota). Pure functions over the
 * repository's domain types: they compare the SERVER-SUPPLIED check-in window instants with the
 * device clock to decide what to SHOW. They never rebuild the window (no timezone, no shift
 * times, no "30 minutes") and never validate anything -- check_in_to_shift stays authoritative,
 * so a wrong device clock can only change what is displayed, never what is allowed.
 *
 * Check-in is evidence that the signed-in driver tapped the control at the server's time. These
 * rules say nothing about whether the shift was worked.
 */

export type DriverCheckInState =
  /** Nothing to show: the window is far away, or the instants are unusable. */
  | { kind: 'not_applicable' }
  /** Not open yet -- shown as informational text, no button. */
  | { kind: 'opens_later'; opensAt: string }
  /** Inside the inclusive window: the Check in button. */
  | { kind: 'open' }
  /** The driver's own check-in exists (the server's instant). It always wins. */
  | { kind: 'checked_in'; checkedInAt: string }
  /** The window passed without a check-in. No retrospective check-in. */
  | { kind: 'closed' };

/**
 * What the server just said about this shift, after a rejected tap. It beats the local clock for the
 * display (a device clock can be wrong): `closed` / `unavailable` stay until reload, `too_early`
 * only briefly (a tap a few ms before the opening instant must not strand the button).
 */
export type ServerCheckInHint = 'closed' | 'too_early' | 'unavailable';

/** "Check-in opens at 17:30" is only useful for a window that opens soon; further away nothing is shown. */
export const OPENS_LATER_HORIZON_MS = 24 * 60 * 60 * 1000;
/** How long a `too_early` rejection overrides the local clock. */
export const TOO_EARLY_HINT_MS = 30 * 1000;

export type CheckInWindowFields = Pick<DriverRotaShift, 'checkedInAt' | 'checkInOpensAt' | 'checkInClosesAt'>;

export function getDriverCheckInState(shift: CheckInWindowFields, now: Date, hint: ServerCheckInHint | null = null): DriverCheckInState {
  if (shift.checkedInAt) return { kind: 'checked_in', checkedInAt: shift.checkedInAt };

  if (hint === 'closed') return { kind: 'closed' };
  if (hint === 'unavailable') return { kind: 'not_applicable' };

  const opens = Date.parse(shift.checkInOpensAt);
  const closes = Date.parse(shift.checkInClosesAt);
  if (Number.isNaN(opens) || Number.isNaN(closes)) return { kind: 'not_applicable' };

  const t = now.getTime();
  if (hint === 'too_early' || t < opens) {
    return opens - t <= OPENS_LATER_HORIZON_MS ? { kind: 'opens_later', opensAt: shift.checkInOpensAt } : { kind: 'not_applicable' };
  }
  // The window is inclusive at both ends: the opening instant already counts, and so does the closing one.
  return t <= closes ? { kind: 'open' } : { kind: 'closed' };
}

export const describeCheckInOpens = (opensAt: string) => `Check-in opens at ${formatOperationalClock(opensAt)}`;
export const describeCheckedIn = (checkedInAt: string) => `Checked in at ${formatOperationalClock(checkedInAt)}`;
export const CHECK_IN_CLOSED_TEXT = 'Check-in window closed';
export const CHECK_IN_SUCCESS_TEXT = 'Checked in successfully.';

/**
 * The next instant at which any shift's DISPLAY state will change (a window opening, or just after one
 * closing), so a single timer can wake exactly then. Null when nothing is pending.
 */
export function nextCheckInBoundary(shifts: CheckInWindowFields[], now: Date): number | null {
  const t = now.getTime();
  let next: number | null = null;
  for (const shift of shifts) {
    if (shift.checkedInAt) continue;
    const opens = Date.parse(shift.checkInOpensAt);
    const closes = Date.parse(shift.checkInClosesAt);
    for (const edge of [opens, closes + 1]) {
      if (!Number.isNaN(edge) && edge > t && (next === null || edge < next)) next = edge;
    }
  }
  return next;
}

export interface DescribedCheckInError {
  message: string;
  /** The screen may be showing a stale window / publication / assignment: refetch the week. */
  shouldRefresh: boolean;
  /** What to remember about this shift so the display follows the server, not the device clock. */
  hint: ServerCheckInHint | null;
}

/** Driver-facing copy for a failed check-in: the repository's first-party, privacy-safe userMessage, never DB detail. */
export function describeCheckInError(error: unknown): DescribedCheckInError {
  const message = error instanceof RepositoryError ? error.userMessage : 'Couldn’t check in. Please try again.';
  if (isDriverCheckInError(error, 'check_in_closed')) return { message, shouldRefresh: true, hint: 'closed' };
  if (isDriverCheckInError(error, 'check_in_too_early')) return { message, shouldRefresh: true, hint: 'too_early' };
  if (
    isDriverCheckInError(error, 'assignment_not_found') ||
    isDriverCheckInError(error, 'week_not_published') ||
    isDriverCheckInError(error, 'shift_cancelled') ||
    isDriverCheckInError(error, 'attendance_already_recorded')
  ) {
    return { message, shouldRefresh: true, hint: 'unavailable' };
  }
  return { message, shouldRefresh: false, hint: null };
}
