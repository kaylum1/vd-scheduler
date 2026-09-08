/**
 * Application authentication types. The authoritative role/driver/resort
 * for a session always comes from the secured `app_users` database record
 * (via the current_app_user() RPC — see resolveCurrentUser.ts), never from
 * Supabase auth `user_metadata`, which a client could in principle send
 * arbitrary values for at sign-up time.
 */

import type { Session } from '@supabase/supabase-js';

export type AppRole = 'manager' | 'driver';

export interface ManagerCurrentUser {
  authUserId: string;
  role: 'manager';
  driverId: null;
  /** Nullable manager resort scope, unused in V1 (all resorts). */
  resortId: string | null;
  email: string | null;
}

export interface DriverCurrentUser {
  authUserId: string;
  role: 'driver';
  driverId: string;
  resortId: string;
  email: string | null;
}

export type CurrentUser = ManagerCurrentUser | DriverCurrentUser;

/**
 * Why a real, successfully-authenticated Supabase user was denied
 * application access. Distinguished internally even though the UI mostly
 * collapses B/C/D into one generic message — see AccessDeniedScreen.
 */
export type AccessDeniedReason =
  /** A: Supabase user exists but has no app_users row at all. */
  | 'no_app_user'
  /** B and D folded together: app_users.is_active=false, or (for a driver) the linked drivers row is inactive — current_app_user() reports both as a single is_active flag. */
  | 'inactive_account'
  /** C: role='driver' but driver_id is null. Should be unreachable given the app_users CHECK constraint; handled defensively anyway. */
  | 'driver_missing_driver_id'
  /** E: any other unrecognised role/state. Fail closed. */
  | 'invalid_role';

export interface ResolvedIdentity {
  user: CurrentUser | null;
  deniedReason: AccessDeniedReason | null;
}

export interface AuthErrorInfo {
  message: string;
}

export interface SignInOutcome {
  user: CurrentUser | null;
  error: AuthErrorInfo | null;
  accessDenied: AccessDeniedReason | null;
}

/**
 * `event` is forwarded mainly so the caller can detect
 * 'PASSWORD_RECOVERY' (the user followed a password-reset email link) and
 * show the reset-password form regardless of whatever the router's own
 * path state happens to be at that moment.
 */
export type AuthChangeListener = (identity: ResolvedIdentity, session: Session | null, event: string) => void;

/**
 * Boundary around Supabase Auth — no page/component calls
 * `supabase.auth.*` directly. See supabaseAuthService.ts for the real
 * implementation; mock mode doesn't use this interface at all (see
 * AuthContext.tsx for why).
 */
export interface AuthService {
  initialize(): Promise<{ identity: ResolvedIdentity; session: Session | null }>;
  onChange(listener: AuthChangeListener): () => void;
  signIn(email: string, password: string): Promise<SignInOutcome>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<{ error: AuthErrorInfo | null }>;
  updatePassword(newPassword: string): Promise<{ error: AuthErrorInfo | null }>;
}
