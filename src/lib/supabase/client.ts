import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import { getSupabaseEnv } from '../env';

/**
 * Single shared browser Supabase client, typed with the generated
 * Database schema. Created lazily (only when something actually needs
 * it — i.e. the Supabase repositories, see repositories/index.ts) and
 * cached for the lifetime of the page.
 *
 * Only ever configured with the publishable/anon key (getSupabaseEnv()
 * refuses a secret key outright). There is no service-role path here and
 * none should ever be added — RLS (Stage 2A Checkpoint 4) is the real
 * security boundary, not this key.
 */
let client: SupabaseClient<Database> | null = null;

export function getSupabaseClient(): SupabaseClient<Database> {
  if (client) return client;

  const { supabaseUrl, supabasePublishableKey } = getSupabaseEnv();

  client = createClient<Database>(supabaseUrl, supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  return client;
}
