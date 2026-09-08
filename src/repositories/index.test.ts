import { afterEach, describe, expect, it, vi } from 'vitest';

async function freshRepositoriesModule() {
  vi.resetModules();
  return import('./index');
}

describe('getRepositories (mock vs Supabase selection)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to mock repositories when VITE_DATA_PROVIDER is unset', async () => {
    vi.stubEnv('VITE_DATA_PROVIDER', undefined as unknown as string);
    const { getRepositories } = await freshRepositoriesModule();
    const { MockResortRepository } = await import('./mock/resorts');
    expect(getRepositories().resorts).toBeInstanceOf(MockResortRepository);
  });

  it('selects mock repositories for every interface when VITE_DATA_PROVIDER=mock', async () => {
    vi.stubEnv('VITE_DATA_PROVIDER', 'mock');
    const { getRepositories } = await freshRepositoriesModule();
    const { MockResortRepository } = await import('./mock/resorts');
    const { MockDriverRepository } = await import('./mock/drivers');
    const { MockShiftConfigurationRepository } = await import('./mock/shiftConfiguration');
    const { MockAvailabilityRepository } = await import('./mock/availability');
    const { MockRotaRepository } = await import('./mock/rota');

    const repos = getRepositories();
    expect(repos.resorts).toBeInstanceOf(MockResortRepository);
    expect(repos.drivers).toBeInstanceOf(MockDriverRepository);
    expect(repos.shiftConfiguration).toBeInstanceOf(MockShiftConfigurationRepository);
    expect(repos.availability).toBeInstanceOf(MockAvailabilityRepository);
    expect(repos.rota).toBeInstanceOf(MockRotaRepository);
  });

  it('selects Supabase repositories for every interface when VITE_DATA_PROVIDER=supabase', async () => {
    vi.stubEnv('VITE_DATA_PROVIDER', 'supabase');
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test_key');

    const { getRepositories } = await freshRepositoriesModule();
    const { SupabaseResortRepository } = await import('./supabase/resorts');
    const { SupabaseDriverRepository } = await import('./supabase/drivers');
    const { SupabaseShiftConfigurationRepository } = await import('./supabase/shiftConfiguration');
    const { SupabaseAvailabilityRepository } = await import('./supabase/availability');
    const { SupabaseRotaRepository } = await import('./supabase/rota');

    const repos = getRepositories();
    expect(repos.resorts).toBeInstanceOf(SupabaseResortRepository);
    expect(repos.drivers).toBeInstanceOf(SupabaseDriverRepository);
    expect(repos.shiftConfiguration).toBeInstanceOf(SupabaseShiftConfigurationRepository);
    expect(repos.availability).toBeInstanceOf(SupabaseAvailabilityRepository);
    expect(repos.rota).toBeInstanceOf(SupabaseRotaRepository);
  });

  it('throws clearly for an unrecognised VITE_DATA_PROVIDER rather than silently defaulting', async () => {
    vi.stubEnv('VITE_DATA_PROVIDER', 'nonsense');
    const { getRepositories } = await freshRepositoriesModule();
    expect(() => getRepositories()).toThrow();
  });

  it('memoises the same instance across repeated calls', async () => {
    vi.stubEnv('VITE_DATA_PROVIDER', 'mock');
    const { getRepositories } = await freshRepositoriesModule();
    expect(getRepositories()).toBe(getRepositories());
  });
});
