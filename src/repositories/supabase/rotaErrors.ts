/**
 * The ONE place that understands how the database reports assign_driver /
 * unassign_driver failures (MR-A's stable error contract), translating it
 * into the provider-agnostic typed errors in ../errors. Nothing outside the
 * Supabase adapter should ever see SQLSTATEs, `VD001`, or PostgREST's
 * `details` field.
 *
 *   VD001  override required; DETAIL = unavailable | not_submitted
 *   23505  already assigned
 *   55006  locked; DETAIL = historical_shift | attendance_recorded | check_in_recorded
 *   P0002  shift / driver / assignment not found
 *   23514  business-rule rejection (inactive driver, other resort, cancelled shift, long reason)
 *
 * The machine-readable state is read from DETAIL -- never parsed out of the
 * human-readable message. An unrecognised DETAIL on VD001 / 55006 falls back
 * to a plain RepositoryError rather than being silently mistaken for a known
 * state.
 */

import {
  AttendanceError,
  type AttendanceErrorKind,
  DriverCheckInError,
  type DriverCheckInErrorKind,
  PublishRotaConfirmationRequiredError,
  PublishRotaError,
  type PublishRotaErrorKind,
  AutoRotaError,
  AvailabilityOverrideRequiredError,
  RepositoryError,
  RotaAssignmentError,
  type AutoRotaErrorKind,
  type PostgrestLikeError,
} from '../errors';

export type RotaRpcOperation = 'rota.assignDriver' | 'rota.unassignDriver';

export function mapRotaRpcError(operation: RotaRpcOperation, error: PostgrestLikeError): RepositoryError {
  const options = { operation, code: error.code, cause: error };
  const detail = error.details ?? null;

  switch (error.code) {
    case 'VD001':
      if (detail === 'unavailable' || detail === 'not_submitted') {
        return new AvailabilityOverrideRequiredError(detail, { operation, cause: error });
      }
      break;
    case '23505':
      return new RotaAssignmentError('duplicate_assignment', error.message, options);
    case '55006':
      if (detail === 'historical_shift') return new RotaAssignmentError('historical_shift', error.message, options);
      if (detail === 'attendance_recorded') return new RotaAssignmentError('attendance_recorded', error.message, options);
      // A driver check-in (AT-A2) is evidence, NOT attendance: a distinct kind with its own copy.
      if (detail === 'check_in_recorded') return new RotaAssignmentError('check_in_recorded', error.message, options);
      break;
    case 'P0002':
      return new RotaAssignmentError(operation === 'rota.unassignDriver' ? 'assignment_not_found' : 'not_found', error.message, options);
    case '23514':
      return new RotaAssignmentError('rule_violation', error.message, options);
  }

  // 42501 (not a manager), anything unrecognised, VD001/55006 with an
  // unexpected DETAIL: the generic error -- its userMessage never leaks DB text.
  return new RepositoryError(`${operation} failed: ${error.message}`, options);
}

/**
 * apply_auto_rota's contract (AR-A migration 20261019110000):
 *   VD002  DETAIL stale_plan        the plan no longer fits current state
 *   55006  DETAIL published_week | historical_week | historical_shift
 *   42501  not a manager            P0002  resort not found
 *   22023  malformed request: DETAIL plan_malformed / plan_shift_not_in_week /
 *          plan_driver_not_in_resort -> invalid_plan; no DETAIL (null argument,
 *          not a Monday) -> invalid_week
 * Anything unrecognised -- including a known SQLSTATE with an unexpected DETAIL --
 * becomes kind 'unknown' rather than being mistaken for a known state.
 */
export function mapAutoRotaRpcError(operation: string, error: PostgrestLikeError): AutoRotaError {
  const options = { operation, code: error.code, cause: error };
  const detail = error.details ?? null;
  let kind: AutoRotaErrorKind = 'unknown';

  switch (error.code) {
    case 'VD002':
      if (detail === 'stale_plan') kind = 'stale_plan';
      break;
    case '55006':
      if (detail === 'published_week' || detail === 'historical_week' || detail === 'historical_shift') kind = detail;
      break;
    case '42501':
      kind = 'permission_denied';
      break;
    case 'P0002':
      kind = 'resort_not_found';
      break;
    case '22023':
      kind = detail === null ? 'invalid_week' : 'invalid_plan';
      break;
  }
  return new AutoRotaError(kind, options);
}

/**
 * publish_rota's contract (PB-A migration 20261026100000):
 *   VD003  DETAIL = the uncovered position count ("3")  -> confirmation required
 *   55006  DETAIL historical_week
 *   23514  DETAIL no_shifts | resort_inactive
 *   42501  not a manager     P0002  resort not found
 *   22023  null argument / not a Monday (no DETAIL)
 * Already published is a success row, never an error. The machine-readable value
 * comes from DETAIL only -- never from the message -- and anything unrecognised,
 * including a known SQLSTATE with an unexpected DETAIL, becomes kind 'unknown'.
 */
export function mapPublishRotaRpcError(operation: string, error: PostgrestLikeError): PublishRotaError | PublishRotaConfirmationRequiredError {
  const options = { operation, code: error.code, cause: error };
  const detail = error.details ?? null;
  let kind: PublishRotaErrorKind = 'unknown';

  switch (error.code) {
    case 'VD003': {
      const uncovered = parseUncoveredCount(detail);
      if (uncovered !== null) return new PublishRotaConfirmationRequiredError(uncovered, { operation, cause: error });
      break;
    }
    case '55006':
      if (detail === 'historical_week') kind = 'historical_week';
      break;
    case '23514':
      if (detail === 'no_shifts' || detail === 'resort_inactive') kind = detail;
      break;
    case '42501':
      kind = 'permission_denied';
      break;
    case 'P0002':
      kind = 'resort_not_found';
      break;
    case '22023':
      if (detail === null) kind = 'invalid_week';
      break;
  }
  return new PublishRotaError(kind, options);
}

/** A strictly positive integer written in plain digits ("1", "17"); everything else ("", "0", "-1", "2.5", " 3", "abc", null) is not a count. */
function parseUncoveredCount(detail: string | null): number | null {
  if (detail === null || !/^[1-9][0-9]*$/.test(detail)) return null;
  const count = Number(detail);
  return Number.isSafeInteger(count) ? count : null;
}

/**
 * record_attendance / clear_attendance contract (AT-A migration 20261027100000):
 *   42501  not an active manager
 *   22023  DETAIL invalid_status -> invalid_status; no DETAIL (null argument) -> invalid_request
 *   P0002  assignment not found
 *   55006  DETAIL week_not_published | future_shift | shift_cancelled
 *   23514  DETAIL historical_backfill_reason_required | reason_required | reason_too_long
 * Anything unrecognised -- including a known SQLSTATE with an unexpected DETAIL -- is
 * kind 'unknown'. The kind is read from DETAIL only, never from the message text.
 */
export function mapAttendanceRpcError(operation: string, error: PostgrestLikeError): AttendanceError {
  const options = { operation, code: error.code, cause: error };
  const detail = error.details ?? null;
  let kind: AttendanceErrorKind = 'unknown';

  switch (error.code) {
    case '42501':
      kind = 'permission_denied';
      break;
    case '22023':
      if (detail === 'invalid_status') kind = 'invalid_status';
      else if (detail === null) kind = 'invalid_request';
      break;
    case 'P0002':
      kind = 'assignment_not_found';
      break;
    case '55006':
      if (detail === 'week_not_published' || detail === 'future_shift' || detail === 'shift_cancelled') kind = detail;
      break;
    case '23514':
      if (detail === 'historical_backfill_reason_required' || detail === 'reason_required' || detail === 'reason_too_long') kind = detail;
      break;
  }
  return new AttendanceError(kind, options);
}

/**
 * check_in_to_shift contract (AT-A2 migration 20261028100000):
 *   42501  not an active driver (manager, inactive driver, anon)
 *   22023  null argument (no DETAIL)
 *   P0002  assignment not found -- ALSO another driver's (ownership is hidden, so there is no "not yours" kind)
 *   55006  DETAIL week_not_published | shift_cancelled | check_in_too_early | check_in_closed | attendance_already_recorded
 * Anything else is 'unknown'. Read from DETAIL only.
 */
export function mapCheckInRpcError(operation: string, error: PostgrestLikeError): DriverCheckInError {
  const options = { operation, code: error.code, cause: error };
  const detail = error.details ?? null;
  let kind: DriverCheckInErrorKind = 'unknown';

  switch (error.code) {
    case '42501':
      kind = 'permission_denied';
      break;
    case '22023':
      if (detail === null) kind = 'invalid_request';
      break;
    case 'P0002':
      kind = 'assignment_not_found';
      break;
    case '55006':
      if (
        detail === 'week_not_published' ||
        detail === 'shift_cancelled' ||
        detail === 'check_in_too_early' ||
        detail === 'check_in_closed' ||
        detail === 'attendance_already_recorded'
      ) {
        kind = detail;
      }
      break;
  }
  return new DriverCheckInError(kind, options);
}
