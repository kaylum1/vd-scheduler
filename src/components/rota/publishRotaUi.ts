import { RepositoryError, isPublishRotaError } from '../../repositories/errors';
import type { ManagerWeekRota, PublishRotaResult } from '../../repositories/domain';
import { getShiftCoverage } from '../../lib/rotaCoverage';

/**
 * Presentation rules for the Publish Rota control. Pure functions over the
 * repository's domain types -- no SQLSTATEs, no database text, no coverage
 * maths: the UI only decides WHEN Publish is offered and HOW the server's
 * authoritative result or a typed error is worded. Every business rule (what is
 * publishable, what counts as uncovered) is the database's.
 */

export interface PublishAvailability {
  enabled: boolean;
  /** Label for the header control: "Published" once published, otherwise "Publish Rota". */
  label: 'Publish Rota' | 'Published';
  /** Why Publish is unavailable, as visible text (never colour alone). Null while loading or when enabled. */
  reason: string | null;
}

/**
 * Publish is offered for a draft week with at least one shift dated today
 * or later. `operationalToday` is the resort's operational date (Europe/Zurich),
 * so today is never "historical" and a partially historical week stays publishable.
 * The repository only returns ACTIVE shifts, so "no shifts" means no active shift.
 */
export function getPublishAvailability(rota: ManagerWeekRota | undefined, operationalToday: string): PublishAvailability {
  if (!rota) return { enabled: false, label: 'Publish Rota', reason: null };
  if (rota.isPublished) return { enabled: false, label: 'Published', reason: 'This rota has already been published.' };
  if (rota.shifts.length === 0) return { enabled: false, label: 'Publish Rota', reason: 'There are no shifts to publish this week.' };
  if (rota.shifts.every((shift) => shift.date < operationalToday)) {
    return { enabled: false, label: 'Publish Rota', reason: 'This rota can’t be published because the week is in the past.' };
  }
  return { enabled: true, label: 'Publish Rota', reason: null };
}

/**
 * True when the loaded week has no ACTIVE driver assigned to any shift. Used only
 * to add a supplementary "No drivers are assigned yet." line to a warning the
 * SERVER already triggered -- it never decides whether a warning is shown.
 */
export function hasNoActiveAssignments(rota: ManagerWeekRota | undefined): boolean {
  return !!rota && rota.shifts.every((shift) => getShiftCoverage(shift).activeAssigned === 0);
}

/** "1 position is still uncovered." / "3 positions are still uncovered." */
export function describeUncoveredWarning(uncoveredSlots: number): string {
  return uncoveredSlots === 1 ? '1 position is still uncovered.' : `${uncoveredSlots} positions are still uncovered.`;
}

export interface DescribedPublishResult {
  tone: 'success' | 'info' | 'warning';
  text: string;
}

/**
 * Wording for a SUCCESSFUL publish, from the server's final result (never the
 * count shown in the earlier warning). Uncovered positions never read as an
 * error and never imply full coverage; an already-published week is a plain
 * success.
 */
export function describePublishResult(result: Pick<PublishRotaResult, 'uncoveredSlots' | 'alreadyPublished'>): DescribedPublishResult {
  if (result.alreadyPublished) return { tone: 'info', text: 'This rota is already published.' };
  if (result.uncoveredSlots > 0) {
    return { tone: 'warning', text: `Rota published. ${describeUncoveredWarning(result.uncoveredSlots)} Drivers can now see their assigned shifts.` };
  }
  return { tone: 'success', text: 'Rota published. Drivers can now see their assigned shifts.' };
}

export interface DescribedPublishError {
  message: string;
  /** The screen may be showing stale state (the week passed, was emptied, the resort changed): refetch the week. */
  shouldRefresh: boolean;
}

/** Manager-facing copy for a failed publish: the repository's first-party userMessage, never DB detail. */
export function describePublishError(error: unknown): DescribedPublishError {
  const message = error instanceof RepositoryError ? error.userMessage : 'Couldn’t publish the rota. Please try again.';
  const shouldRefresh =
    isPublishRotaError(error, 'historical_week') ||
    isPublishRotaError(error, 'no_shifts') ||
    isPublishRotaError(error, 'resort_inactive') ||
    isPublishRotaError(error, 'resort_not_found') ||
    isPublishRotaError(error, 'invalid_week');
  return { message, shouldRefresh };
}
