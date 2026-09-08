import { RepositoryError } from '../../../repositories/errors';

/**
 * Manager-facing copy for repository errors raised by the Configuration
 * page's mutations. Matches on the stable signals both providers agree on
 * (RepositoryError.code — a real Postgres SQLSTATE from Supabase, or the
 * same code deliberately mirrored by the mock repositories) rather than
 * parsing message text, so mock and Supabase mode show the same wording.
 * Falls back to RepositoryError.userMessage (already safe/generic) for
 * anything unmatched — never renders a raw Postgres/PostgREST message.
 */
export function describeConfigurationError(error: unknown, context: 'driver' | 'shiftType'): string {
  if (!(error instanceof RepositoryError)) {
    return 'Something went wrong. Please try again.';
  }

  switch (error.code) {
    case '23505': // unique_violation
      return context === 'shiftType'
        ? 'That key is already used at this resort. Choose a different one.'
        : 'That value is already in use.';
    case '23514': // check_violation — the resort/key immutability guards
      return context === 'driver'
        ? "A driver's resort cannot be changed. Deactivate this driver and create a new driver profile at the new resort instead."
        : "A shift type's key and resort cannot be changed after creation.";
    case '55006': // object_in_use — the unsafe shift-type deactivation guard
      return 'This shift type still has an active recurring template. Deactivate its templates first, then try again.';
    case '23503': // foreign_key_violation
      return 'That resort is no longer valid. Refresh and try again.';
    case '42501': // insufficient_privilege (RLS rejection)
      return error.userMessage;
    default:
      return error.userMessage;
  }
}
