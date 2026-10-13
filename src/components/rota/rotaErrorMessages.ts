import { RepositoryError, isAvailabilityOverrideRequired, isRotaAssignmentError } from '../../repositories/errors';

/**
 * Manager-facing copy for a failed assign/remove. Works only from the typed
 * repository errors -- never SQLSTATEs or database text -- so it behaves the
 * same for the Supabase and mock providers.
 *
 * `shouldRefresh` marks failures that mean the screen is showing stale data
 * (someone else already changed the assignment, the shift moved into the
 * past, ...), so the caller refetches the week instead of leaving it wrong.
 */
export interface DescribedRotaError {
  message: string;
  shouldRefresh: boolean;
}

const GENERIC = 'Something went wrong. Please try again.';

export function describeRotaError(error: unknown): DescribedRotaError {
  if (isAvailabilityOverrideRequired(error)) {
    // Normally handled by the confirmation dialog before it can get here.
    return { message: error.userMessage, shouldRefresh: false };
  }

  if (isRotaAssignmentError(error)) {
    switch (error.kind) {
      case 'historical_shift':
        return { message: 'This shift is in the past, so its assignments can’t be changed.', shouldRefresh: true };
      case 'attendance_recorded':
        return { message: 'This assignment can’t be removed because attendance has already been recorded.', shouldRefresh: false };
      case 'duplicate_assignment':
        return { message: 'This driver is already assigned to this shift. The rota has been refreshed.', shouldRefresh: true };
      case 'assignment_not_found':
        return { message: 'That assignment no longer exists. The rota has been refreshed.', shouldRefresh: true };
      case 'not_found':
        return { message: 'That shift or driver could no longer be found. The rota has been refreshed.', shouldRefresh: true };
      case 'rule_violation':
        // First-party, manager-facing copy from the database (inactive driver, other resort, ...).
        return { message: error.userMessage, shouldRefresh: true };
    }
  }

  return { message: error instanceof RepositoryError ? error.userMessage : GENERIC, shouldRefresh: false };
}
