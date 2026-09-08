import { describe, expect, it, vi, afterEach } from 'vitest';
import { RepositoryError } from '../errors';

/**
 * Real integration test against the actual local Supabase stack (no mocks,
 * no service role) — proves the Supabase repository really talks to
 * Postgres over the network, and that our error-wrapping layer surfaces a
 * real PostgREST rejection cleanly.
 *
 * This deliberately uses only the anon/publishable key, exactly as a real
 * unauthenticated browser session would. Per Checkpoint 4, anon has zero
 * grants on every application table — so the *correct*, security-proving
 * outcome is that this throws a RepositoryError, not that it returns data.
 * If it ever returns resort rows instead, that's an RLS regression, not a
 * passing test — this intentionally does NOT weaken RLS to make itself pass.
 */
describe('SupabaseResortRepository (live local Supabase, anon key)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('surfaces the anon RLS rejection as a RepositoryError instead of returning resort rows or crashing', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH');

    const { getSupabaseClient } = await import('../../lib/supabase/client');
    const { SupabaseResortRepository } = await import('./resorts');
    const repo = new SupabaseResortRepository(getSupabaseClient());

    await expect(repo.listResorts()).rejects.toBeInstanceOf(RepositoryError);
  });
});
