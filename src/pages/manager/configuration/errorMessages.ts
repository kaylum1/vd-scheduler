import { RepositoryError } from '../../../repositories/errors';

/**
 * Manager-facing copy for repository errors raised by the Configuration
 * page's mutations. Matches on the stable signals both providers agree on
 * (RepositoryError.code — a real Postgres SQLSTATE from Supabase, or the
 * same code deliberately mirrored by the mock repositories) rather than
 * parsing message text, so mock and Supabase mode show the same wording.
 * Falls back to RepositoryError.userMessage (already safe/generic) for
 * anything unmatched — never renders a raw Postgres/PostgREST message.
 *
 * The 'shift' context (Stage 2D Checkpoint 4) is the one exception to
 * "never parse message text": create_shift/revise_shift/deactivate_shift/
 * reactivate_shift raise several distinct business-rule violations that
 * all share SQLSTATE 23514 (no other signal distinguishes them), and their
 * exact message text is first-party, stable copy this project authored in
 * the same migration this file is maintained alongside — not an opaque
 * Postgres/constraint-name string. Matching on it here is what lets each
 * one map to its own precise, still-never-raw manager-facing sentence.
 */
export function describeConfigurationError(
  error: unknown,
  context: 'driver' | 'shiftType' | 'shiftTemplate' | 'shift',
  detail?: { shiftTypeName?: string; weekdayLabel?: string }
): string {
  if (!(error instanceof RepositoryError)) {
    return 'Something went wrong. Please try again.';
  }

  if (context === 'shift') {
    return describeShiftError(error, detail);
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

/** describeConfigurationError's 'shift' branch — see its doc comment for why message text is matched here. */
function describeShiftError(error: RepositoryError, detail?: { shiftTypeName?: string; weekdayLabel?: string }): string {
  const raw = error.message;

  switch (error.code) {
    case '23514':
      if (/needs a name/i.test(raw)) return 'Give this shift a name.';
      if (/at least one day/i.test(raw)) return 'Select at least one day of the week.';
      if (/end time must be after/i.test(raw)) return 'End time must be after the start time.';
      if (/already active/i.test(raw)) return 'This shift is already active.';
      if (/effective_to|effective range|must not be after/i.test(raw)) return 'The end date must be on or after the start date.';
      return 'Check the shift details and try again.';
    case '55006': // reused here for "must be reactivated before it can be revised"
      return 'This shift is inactive. Reactivate it before making changes.';
    case 'P0002': // no_data_found — the shift record itself couldn't be found
      return 'This shift could not be found. It may have changed elsewhere — refresh and try again.';
    case '23P01': // exclusion_violation — should not normally occur through these RPCs, kept as a safe fallback
      return `There is already a ${detail?.shiftTypeName ?? 'shift'} schedule covering ${detail?.weekdayLabel ?? 'this day'} for these dates.`;
    case '23503':
      return 'That resort is no longer valid. Refresh and try again.';
    case '42501':
      return error.userMessage;
    case 'mock_unsupported':
      return 'This action needs Supabase mode (VITE_DATA_PROVIDER=supabase) — not available in this mock demo.';
    default:
      return error.userMessage;
  }
}
