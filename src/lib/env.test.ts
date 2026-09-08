import { describe, expect, it, afterEach, vi } from 'vitest';
import { EnvConfigError, getDataProvider, getSupabaseEnv } from './env';

describe('getDataProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to "mock" when unset', () => {
    vi.stubEnv('VITE_DATA_PROVIDER', undefined as unknown as string);
    expect(getDataProvider()).toBe('mock');
  });

  it('accepts "mock" explicitly', () => {
    vi.stubEnv('VITE_DATA_PROVIDER', 'mock');
    expect(getDataProvider()).toBe('mock');
  });

  it('accepts "supabase" explicitly', () => {
    vi.stubEnv('VITE_DATA_PROVIDER', 'supabase');
    expect(getDataProvider()).toBe('supabase');
  });

  it('is case-insensitive and trims whitespace', () => {
    vi.stubEnv('VITE_DATA_PROVIDER', '  SUPABASE  ');
    expect(getDataProvider()).toBe('supabase');
  });

  it('throws EnvConfigError for an unrecognised value rather than silently picking one', () => {
    vi.stubEnv('VITE_DATA_PROVIDER', 'production-db');
    expect(() => getDataProvider()).toThrow(EnvConfigError);
  });
});

describe('getSupabaseEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the url/key when both are valid', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_abc123');
    expect(getSupabaseEnv()).toEqual({
      supabaseUrl: 'http://127.0.0.1:54321',
      supabasePublishableKey: 'sb_publishable_abc123',
    });
  });

  it('throws when the URL is missing', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_abc123');
    expect(() => getSupabaseEnv()).toThrow(EnvConfigError);
  });

  it('throws when the URL is malformed', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'not-a-url');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_abc123');
    expect(() => getSupabaseEnv()).toThrow(EnvConfigError);
  });

  it('throws when the key is missing', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    expect(() => getSupabaseEnv()).toThrow(EnvConfigError);
  });

  it('refuses a secret key even if someone put one in the publishable-key variable', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_secret_should_never_be_here');
    expect(() => getSupabaseEnv()).toThrow(/secret key/i);
  });
});
