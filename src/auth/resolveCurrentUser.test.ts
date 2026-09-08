import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveCurrentUser } from './resolveCurrentUser';

function mockClient(rpcResult: { data: unknown; error: { message: string } | null }) {
  return { rpc: async () => rpcResult } as unknown as SupabaseClient;
}

const authUser = { id: 'auth-1', email: 'gianni@vd-scheduler.local' } as any;

describe('resolveCurrentUser', () => {
  it('returns no identity and no denial for an unauthenticated (null) user', async () => {
    const client = mockClient({ data: null, error: null });
    const result = await resolveCurrentUser(client, null);
    expect(result).toEqual({ user: null, deniedReason: null });
  });

  it('case A: no app_users row at all -> no_app_user', async () => {
    // current_app_user() returns an all-null composite when there's no
    // matching app_users row (PostgREST encodes a NULL composite this way,
    // not as JSON null).
    const client = mockClient({
      data: { role: null, driver_id: null, resort_id: null, is_active: null },
      error: null,
    });
    const result = await resolveCurrentUser(client, authUser);
    expect(result).toEqual({ user: null, deniedReason: 'no_app_user' });
  });

  it('case B/D: is_active=false -> inactive_account', async () => {
    const client = mockClient({
      data: { role: 'driver', driver_id: 'd1', resort_id: 'r1', is_active: false },
      error: null,
    });
    const result = await resolveCurrentUser(client, authUser);
    expect(result).toEqual({ user: null, deniedReason: 'inactive_account' });
  });

  it('case C: role=driver with a missing driver_id -> driver_missing_driver_id (defensive; unreachable given the DB CHECK constraint)', async () => {
    const client = mockClient({
      data: { role: 'driver', driver_id: null, resort_id: null, is_active: true },
      error: null,
    });
    const result = await resolveCurrentUser(client, authUser);
    expect(result).toEqual({ user: null, deniedReason: 'driver_missing_driver_id' });
  });

  it('case E: an unrecognised role fails closed -> invalid_role', async () => {
    const client = mockClient({
      data: { role: 'superadmin', driver_id: null, resort_id: null, is_active: true },
      error: null,
    });
    const result = await resolveCurrentUser(client, authUser);
    expect(result).toEqual({ user: null, deniedReason: 'invalid_role' });
  });

  it('resolves a valid manager identity', async () => {
    const client = mockClient({
      data: { role: 'manager', driver_id: null, resort_id: null, is_active: true },
      error: null,
    });
    const result = await resolveCurrentUser(client, authUser);
    expect(result).toEqual({
      user: { authUserId: 'auth-1', role: 'manager', driverId: null, resortId: null, email: 'gianni@vd-scheduler.local' },
      deniedReason: null,
    });
  });

  it('resolves a valid driver identity, with resortId taken from current_app_user() (drivers.resort_id), never client input', async () => {
    const client = mockClient({
      data: { role: 'driver', driver_id: 'driver-1', resort_id: 'resort-1', is_active: true },
      error: null,
    });
    const result = await resolveCurrentUser(client, authUser);
    expect(result).toEqual({
      user: { authUserId: 'auth-1', role: 'driver', driverId: 'driver-1', resortId: 'resort-1', email: 'gianni@vd-scheduler.local' },
      deniedReason: null,
    });
  });

  it('fails closed (no_app_user) rather than throwing if the RPC itself errors', async () => {
    const client = mockClient({ data: null, error: { message: 'connection reset' } });
    const result = await resolveCurrentUser(client, authUser);
    expect(result).toEqual({ user: null, deniedReason: 'no_app_user' });
  });
});
