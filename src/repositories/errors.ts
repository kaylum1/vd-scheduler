/**
 * Consistent repository error handling, so components never need to
 * understand raw Supabase/PostgREST error shapes — but developers don't
 * lose useful detail either. Never expose `cause`/DB messages directly in
 * user-facing UI; use `.userMessage` there instead.
 */

export interface PostgrestLikeError {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

export class RepositoryError extends Error {
  /** Machine-readable label for what was being attempted, e.g. "drivers.deactivate". */
  readonly operation: string;
  /** Postgres/PostgREST error code where available (e.g. "42501", "23505"). */
  readonly code?: string;
  /** The original error/cause, retained for logging — never rendered directly to end users. */
  readonly cause?: unknown;

  constructor(message: string, options: { operation: string; code?: string; cause?: unknown }) {
    super(message);
    this.name = 'RepositoryError';
    this.operation = options.operation;
    this.code = options.code;
    this.cause = options.cause;
  }

  /** Generic, safe message for end-user UI. Never leaks DB detail. */
  get userMessage(): string {
    if (this.code === '42501') return 'You do not have permission to do that.';
    return 'Something went wrong. Please try again.';
  }
}

/**
 * Awaits a Supabase query builder / RPC promise (which resolves to
 * `{ data, error }`) and throws a RepositoryError on failure, otherwise
 * returns `data`. Centralises the one bit of raw-Supabase-shape knowledge
 * so no other repository code (or any component) has to know about it.
 */
export async function unwrap<T>(
  operation: string,
  promise: PromiseLike<{ data: T | null; error: PostgrestLikeError | null }>
): Promise<T> {
  const { data, error } = await promise;
  if (error) {
    throw new RepositoryError(`${operation} failed: ${error.message}`, {
      operation,
      code: error.code,
      cause: error,
    });
  }
  if (data === null) {
    // Supabase types `data` as nullable defensively, but a successful
    // query (no error) never actually returns null — surface it as an
    // error rather than letting `null` silently masquerade as `T`.
    throw new RepositoryError(`${operation} returned no data`, { operation });
  }
  return data;
}

// ---------------------------------------------------------------------
// Manual Rota (MR-B): typed assignment errors.
//
// The database owns every assignment rule (assign_driver/unassign_driver,
// MR-A) and reports failures through SQLSTATE/DETAIL. Components must never
// see that: the Supabase adapter translates it (see
// repositories/supabase/rotaErrors.ts) into the stable, provider-agnostic
// errors below, and the mock provider throws the very same classes, so UI
// code written against either behaves identically.
// ---------------------------------------------------------------------

/** The two driver availability states that require an explicit manager acknowledgement before assigning. */
export type AvailabilityOverrideState = 'unavailable' | 'not_submitted';

/**
 * assign_driver refused to insert because the driver's CURRENT availability
 * (read by the server at write time, never trusted from the client) is
 * Unavailable or Not Submitted and the caller did not acknowledge the
 * override. Nothing was assigned. The UI shows the matching warning and, only
 * after the manager explicitly confirms, retries the same assignDriver call
 * with `confirmAvailabilityOverride: true`.
 */
export class AvailabilityOverrideRequiredError extends RepositoryError {
  readonly availabilityState: AvailabilityOverrideState;

  constructor(availabilityState: AvailabilityOverrideState, options: { operation: string; cause?: unknown }) {
    super(`${options.operation} requires an availability override (${availabilityState})`, { ...options, code: 'VD001' });
    this.name = 'AvailabilityOverrideRequiredError';
    this.availabilityState = availabilityState;
  }

  override get userMessage(): string {
    return this.availabilityState === 'unavailable'
      ? 'This driver marked themselves unavailable for this shift.'
      : 'This driver has not submitted availability for this shift.';
  }
}

/** Type guard so React code never needs `instanceof`, SQLSTATEs, or PostgREST error shapes. */
export function isAvailabilityOverrideRequired(error: unknown): error is AvailabilityOverrideRequiredError {
  return error instanceof AvailabilityOverrideRequiredError;
}

/**
 * Stable reasons an assign/unassign can be refused. `rule_violation` groups the
 * database's business-rule rejections that share one SQLSTATE (inactive
 * driver, driver from a different resort, cancelled shift, over-long reason):
 * the specific cause is in the first-party `userMessage`, which the database
 * guarantees is friendly (never a raw constraint name -- DB-tested).
 */
export type RotaAssignmentErrorKind =
  | 'duplicate_assignment'
  | 'historical_shift'
  | 'attendance_recorded'
  | 'rule_violation'
  | 'not_found'
  | 'assignment_not_found';

export class RotaAssignmentError extends RepositoryError {
  readonly kind: RotaAssignmentErrorKind;
  private readonly managerMessage: string;

  /** `managerMessage` is first-party, manager-facing copy (from the database, or mirrored by the mock) -- safe to display. */
  constructor(kind: RotaAssignmentErrorKind, managerMessage: string, options: { operation: string; code?: string; cause?: unknown }) {
    super(`${options.operation} failed: ${managerMessage}`, options);
    this.name = 'RotaAssignmentError';
    this.kind = kind;
    this.managerMessage = managerMessage;
  }

  override get userMessage(): string {
    return this.managerMessage;
  }
}

export function isRotaAssignmentError(error: unknown, kind?: RotaAssignmentErrorKind): error is RotaAssignmentError {
  return error instanceof RotaAssignmentError && (kind === undefined || error.kind === kind);
}
