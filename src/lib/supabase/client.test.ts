import { afterEach, describe, expect, it, vi } from 'vitest';

// getSupabaseClient() memoises a module-level singleton, so each test that
// needs a fresh client re-imports the module after resetting it.
async function freshClientModule() {
  vi.resetModules();
  return import('./client');
}

describe('getSupabaseClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('configures the client with only the publishable key, never a secret key', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test_key');

    const { getSupabaseClient } = await freshClientModule();
    const client = getSupabaseClient();

    // supabaseUrl/supabaseKey are `protected` in the SDK's types (compile-time
    // only) — reading them here is the pragmatic way to assert what the
    // client was actually constructed with, without relying on a live
    // network call.
    const internals = client as unknown as { supabaseUrl: string; supabaseKey: string };
    expect(internals.supabaseUrl).toBe('http://127.0.0.1:54321');
    expect(internals.supabaseKey).toBe('sb_publishable_test_key');
    expect(internals.supabaseKey.startsWith('sb_secret_')).toBe(false);
  });

  it('refuses to build a client at all when given a secret key', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_secret_leaked_key');

    const { getSupabaseClient } = await freshClientModule();
    expect(() => getSupabaseClient()).toThrow(/secret key/i);
  });

  it('fails clearly rather than silently when required env vars are missing', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');

    const { getSupabaseClient } = await freshClientModule();
    expect(() => getSupabaseClient()).toThrow();
  });
});
