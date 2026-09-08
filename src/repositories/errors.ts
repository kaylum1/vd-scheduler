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
