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
export function describeConfigurationError(
  error: unknown,
  context: 'driver' | 'shiftType' | 'shiftTemplate',
  detail?: { shiftTypeName?: string; weekdayLabel?: string }
): string {
  if (!(error instanceof RepositoryError)) {
    return 'Something went wrong. Please try again.';
  }

  switch (error.code) {
    case '23505': // unique_violation
      return context === 'shiftType'
        ? 'That key is already used at this resort. Choose a different one.'
        : 'That value is already in use.';
    case '23514': // check_violation — several distinct guards share this SQLSTATE
      if (context === 'driver') {
        return "A driver's resort cannot be changed. Deactivate this driver and create a new driver profile at the new resort instead.";
      }
      if (context === 'shiftTemplate') {
        // shift_templates_effective_range_check: the new version's start
        // date must be after the version it replaces started (the UI's own
        // date picker already enforces this — see minEffectiveFrom in
        // RecurringScheduleCard — so this is a defensive fallback, not the
        // expected path).
        return 'The effective date must be after the current version started. Choose a later date.';
      }
      return "A shift type's key and resort cannot be changed after creation.";
    case '55006': // object_in_use — the unsafe shift-type deactivation guard
      return 'This shift type still has an active recurring template. Deactivate its templates first, then try again.';
    case '23P01': // exclusion_violation — shift_templates_no_overlap
      return `There is already a ${detail?.shiftTypeName ?? 'shift'} schedule covering ${
        detail?.weekdayLabel ?? 'this day'
      } for these dates.`;
    case '23503': // foreign_key_violation
      return 'That resort is no longer valid. Refresh and try again.';
    case '42501': // insufficient_privilege (RLS rejection)
      return error.userMessage;
    case 'mock_unsupported': // materialise/refresh/cancellation RPCs — mock mode has no real equivalent, never faked
      return 'This action needs Supabase mode (VITE_DATA_PROVIDER=supabase) — not available in this mock demo.';
    default:
      return error.userMessage;
  }
}
