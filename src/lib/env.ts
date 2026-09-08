/**
 * Environment configuration + validation for the frontend data layer.
 *
 * Fails loudly and early when the configuration is malformed, rather than
 * silently falling back to a broken Supabase client or a confusing runtime
 * fetch failure later. Mock mode never requires Supabase variables at all
 * — that is the safe default (see getDataProvider()).
 */

export type DataProvider = 'mock' | 'supabase';

export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvConfigError';
  }
}

/**
 * VITE_DATA_PROVIDER selects which repository implementations power the
 * app. Defaults to 'mock' — the safe, always-available option that needs
 * no external service. An unrecognised value fails loudly rather than
 * silently choosing one or the other.
 */
export function getDataProvider(): DataProvider {
  const raw = (import.meta.env.VITE_DATA_PROVIDER ?? 'mock').trim().toLowerCase();
  if (raw === 'mock' || raw === 'supabase') return raw;
  throw new EnvConfigError(`VITE_DATA_PROVIDER must be "mock" or "supabase", got ${JSON.stringify(raw)}.`);
}

export interface SupabaseEnv {
  supabaseUrl: string;
  supabasePublishableKey: string;
}

/**
 * Validates and returns the Supabase connection config. Only called when
 * the data provider is actually 'supabase' (see repositories/index.ts) —
 * mock mode is never blocked by missing/invalid Supabase variables.
 */
export function getSupabaseEnv(): SupabaseEnv {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url) {
    throw new EnvConfigError('VITE_SUPABASE_URL is required when VITE_DATA_PROVIDER=supabase.');
  }
  if (!key) {
    throw new EnvConfigError('VITE_SUPABASE_PUBLISHABLE_KEY is required when VITE_DATA_PROVIDER=supabase.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EnvConfigError(`VITE_SUPABASE_URL is not a valid URL: ${JSON.stringify(url)}.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EnvConfigError(`VITE_SUPABASE_URL must use http or https, got ${JSON.stringify(url)}.`);
  }

  // Defense in depth: the browser must only ever hold the publishable
  // (anon-equivalent) key. A secret key pasted into a VITE_* variable
  // would otherwise ship straight into the client bundle.
  if (key.startsWith('sb_secret_')) {
    throw new EnvConfigError(
      'VITE_SUPABASE_PUBLISHABLE_KEY looks like a secret key (sb_secret_...). ' +
        'Only the publishable/anon key may be used in frontend code — RLS is the security boundary, not this key.'
    );
  }

  return { supabaseUrl: url, supabasePublishableKey: key };
}
