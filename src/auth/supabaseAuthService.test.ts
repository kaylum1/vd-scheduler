// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseAuthService } from './supabaseAuthService';

function makeMockClient(overrides: Partial<Record<string, unknown>> = {}) {
  const authUser = { id: 'auth-1', email: 'gianni@vd-scheduler.local' };
  const session = { user: authUser } as any;

  const auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session } }),
    onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
    updateUser: vi.fn().mockResolvedValue({ error: null }),
    ...overrides,
  };

  const rpc = vi.fn().mockResolvedValue({
    data: { role: 'driver', driver_id: 'driver-1', resort_id: 'resort-1', is_active: true },
    error: null,
  });

  return { client: { auth, rpc } as unknown as SupabaseClient, auth, rpc };
}

describe('SupabaseAuthService.signIn', () => {
  it('returns the resolved user on a valid, active account', async () => {
    const { client } = makeMockClient();
    const service = new SupabaseAuthService(client);
    const outcome = await service.signIn('gianni@vd-scheduler.local', 'correct-password');
    expect(outcome.error).toBeNull();
    expect(outcome.accessDenied).toBeNull();
    expect(outcome.user).toMatchObject({ role: 'driver', driverId: 'driver-1' });
  });

  it('returns a generic error message on invalid credentials, never confirming/denying account existence', async () => {
    const { client, auth } = makeMockClient({
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null }, error: { message: 'Invalid login credentials', status: 400 } }),
    });
    const service = new SupabaseAuthService(client);
    const outcome = await service.signIn('nobody@nowhere.local', 'whatever');
    expect(outcome.user).toBeNull();
    expect(outcome.error?.message).toBe('Incorrect email or password.');
    expect(outcome.error?.message).not.toMatch(/nobody@nowhere\.local/);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('fails closed and signs the user back out when the account is not a valid app user', async () => {
    const { client, auth, rpc } = makeMockClient();
    rpc.mockResolvedValue({ data: { role: null, driver_id: null, resort_id: null, is_active: null }, error: null });
    const service = new SupabaseAuthService(client);
    const outcome = await service.signIn('orphan@vd-scheduler.local', 'correct-password');
    expect(outcome.user).toBeNull();
    expect(outcome.error).toBeNull();
    expect(outcome.accessDenied).toBe('no_app_user');
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('SupabaseAuthService.requestPasswordReset', () => {
  it('never surfaces whether the account exists', async () => {
    const { client } = makeMockClient();
    const service = new SupabaseAuthService(client);
    const { error } = await service.requestPasswordReset('anyone@anywhere.local');
    expect(error).toBeNull();
  });

  it('only surfaces a generic message for a genuine transport/server failure', async () => {
    const { client } = makeMockClient({
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: { message: 'internal error', status: 500 } }),
    });
    const service = new SupabaseAuthService(client);
    const { error } = await service.requestPasswordReset('anyone@anywhere.local');
    expect(error?.message).toMatch(/could not send/i);
  });
});

describe('SupabaseAuthService.updatePassword / signOut', () => {
  it('updatePassword surfaces a genuine error', async () => {
    const { client } = makeMockClient({
      updateUser: vi.fn().mockResolvedValue({ error: { message: 'Password should be at least 6 characters' } }),
    });
    const service = new SupabaseAuthService(client);
    const { error } = await service.updatePassword('abc');
    expect(error?.message).toMatch(/6 characters/);
  });

  it('signOut delegates to supabase.auth.signOut', async () => {
    const { client, auth } = makeMockClient();
    const service = new SupabaseAuthService(client);
    await service.signOut();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});
