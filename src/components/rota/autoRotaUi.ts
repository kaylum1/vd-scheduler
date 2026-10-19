import { RepositoryError, isAutoRotaError } from '../../repositories/errors';
import type { AutoRotaResult, ManagerWeekRota } from '../../repositories/domain';

/**
 * Presentation rules for the Generate Rota control. Pure functions over the
 * repository's domain types -- no SQLSTATEs, no database text, no planner: the
 * UI only decides WHEN Generate is offered and HOW the authoritative result or
 * a typed error is worded.
 */

export interface GenerateAvailability {
  enabled: boolean;
  /** Why Generate is unavailable, as visible text (never colour alone). Null while loading or when enabled. */
  reason: string | null;
}

/**
 * Generate Rota is offered for an unpublished week that has at least one shift
 * dated today or later. `operationalToday` is the resort's operational date
 * (Europe/Zurich), so today is never "historical".
 */
export function getGenerateAvailability(rota: ManagerWeekRota | undefined, operationalToday: string): GenerateAvailability {
  if (!rota) return { enabled: false, reason: null };
  if (rota.isPublished) return { enabled: false, reason: 'Auto-Rota can’t run after this rota has been published.' };
  if (rota.shifts.length === 0) return { enabled: false, reason: 'There are no shifts to fill this week.' };
  if (rota.shifts.every((shift) => shift.date < operationalToday)) return { enabled: false, reason: 'Auto-Rota can’t generate a historical rota.' };
  return { enabled: true, reason: null };
}

/** True when the week has both past shifts and shifts still to fill (the dialog then says past shifts are left alone). */
export function hasPastShifts(rota: ManagerWeekRota | undefined, operationalToday: string): boolean {
  return !!rota && rota.shifts.some((shift) => shift.date < operationalToday);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface DescribedAutoRotaResult {
  tone: 'success' | 'info';
  text: string;
}

/**
 * Wording for a SUCCESSFUL generation, from the database's authoritative
 * result. Leaving positions uncovered is a normal outcome, never an error.
 */
export function describeAutoRotaResult(result: Pick<AutoRotaResult, 'assignedCount' | 'remainingOpenSlots'>): DescribedAutoRotaResult {
  const { assignedCount, remainingOpenSlots } = result;
  const uncovered = `${plural(remainingOpenSlots, 'position remains', 'positions remain')} uncovered.`;

  if (assignedCount > 0) {
    const added = `${plural(assignedCount, 'assignment', 'assignments')} added.`;
    return { tone: 'success', text: remainingOpenSlots === 0 ? `${added} All scheduled positions are covered.` : `${added} ${uncovered}` };
  }
  return {
    tone: 'info',
    text: remainingOpenSlots === 0 ? 'No new assignments were needed. The rota is fully covered.' : `No assignments could be added. ${uncovered}`,
  };
}

export interface DescribedAutoRotaError {
  message: string;
  /** The screen may be showing stale state (it was published, a shift passed, the plan went stale): refetch the week. */
  shouldRefresh: boolean;
}

/** Manager-facing copy for a failed generation: the repository's first-party userMessage, never DB detail. */
export function describeAutoRotaError(error: unknown): DescribedAutoRotaError {
  const message = error instanceof RepositoryError ? error.userMessage : 'Something went wrong. Please try again.';
  const shouldRefresh =
    isAutoRotaError(error, 'published_week') ||
    isAutoRotaError(error, 'historical_week') ||
    isAutoRotaError(error, 'historical_shift') ||
    isAutoRotaError(error, 'stale_plan');
  return { message, shouldRefresh };
}
