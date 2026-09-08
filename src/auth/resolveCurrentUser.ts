/**
 * Resolves a Supabase auth session to the application's identity by
 * calling the current_app_user() RPC (Checkpoint 4) — a SECURITY DEFINER
 * function that reads auth.uid() -> app_users -> drivers server-side.
 * This is the ONLY safe current-user database access this checkpoint
 * needs; no additional migration was required (see Checkpoint 5 report,
 * item 6: "prefer using existing secure structures if sufficient").
 *
 * A driver can only ever get their own identity back — current_app_user()
 * takes no parameters and is keyed entirely off the caller's own
 * auth.uid(), so there is no way to request someone else's.
 */

import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '../types/database.generated';
import type { AccessDeniedReason, CurrentUser, ResolvedIdentity } from './types';

export async function resolveCurrentUser(
  client: SupabaseClient<Database>,
  authUser: User | null
): Promise<ResolvedIdentity> {
  if (!authUser) {
    return { user: null, deniedReason: null };
  }

  const { data, error } = await client.rpc('current_app_user');
  if (error) {
    // Treat an unexpected RPC failure as "no identity" rather than
    // throwing through the auth flow -- fail closed, not crash.
    return { user: null, deniedReason: 'no_app_user' };
  }

  return classify(data, authUser);
}

function classify(
  row: { role: string | null; driver_id: string | null; resort_id: string | null; is_active: boolean | null } | null,
  authUser: User
): ResolvedIdentity {
  // A: no app_users row at all.
  if (!row || row.role === null) {
    return { user: null, deniedReason: 'no_app_user' as AccessDeniedReason };
  }

  // B/D: app_users inactive, or (for a driver) the linked driver inactive
  // -- current_app_user() folds both into this one flag.
  if (!row.is_active) {
    return { user: null, deniedReason: 'inactive_account' };
  }

  if (row.role === 'manager') {
    const user: CurrentUser = {
      authUserId: authUser.id,
      role: 'manager',
      driverId: null,
      resortId: row.resort_id,
      email: authUser.email ?? null,
    };
    return { user, deniedReason: null };
  }

  if (row.role === 'driver') {
    // C: should be unreachable (app_users_role_scope_check enforces
    // driver_id NOT NULL for role='driver') -- handled defensively anyway.
    if (!row.driver_id || !row.resort_id) {
      return { user: null, deniedReason: 'driver_missing_driver_id' };
    }
    const user: CurrentUser = {
      authUserId: authUser.id,
      role: 'driver',
      driverId: row.driver_id,
      resortId: row.resort_id,
      email: authUser.email ?? null,
    };
    return { user, deniedReason: null };
  }

  // E: anything else -- fail closed.
  return { user: null, deniedReason: 'invalid_role' };
}
