/**
 * The ONE place that understands how the database reports assign_driver /
 * unassign_driver failures (MR-A's stable error contract), translating it
 * into the provider-agnostic typed errors in ../errors. Nothing outside the
 * Supabase adapter should ever see SQLSTATEs, `VD001`, or PostgREST's
 * `details` field.
 *
 *   VD001  override required; DETAIL = unavailable | not_submitted
 *   23505  already assigned
 *   55006  locked; DETAIL = historical_shift | attendance_recorded
 *   P0002  shift / driver / assignment not found
 *   23514  business-rule rejection (inactive driver, other resort, cancelled shift, long reason)
 *
 * The machine-readable state is read from DETAIL -- never parsed out of the
 * human-readable message. An unrecognised DETAIL on VD001 / 55006 falls back
 * to a plain RepositoryError rather than being silently mistaken for a known
 * state.
 */

import {
  AvailabilityOverrideRequiredError,
  RepositoryError,
  RotaAssignmentError,
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
