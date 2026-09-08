/**
 * Repository factory: the one place that decides mock vs Supabase, driven
 * by VITE_DATA_PROVIDER (see lib/env.ts). Components/pages should call
 * `getRepositories()` rather than importing a concrete implementation or
 * constructing a Supabase client themselves.
 *
 * Default is 'mock' — safe and obvious with zero configuration, per
 * Checkpoint 5 section 9.
 */

import { getDataProvider, type DataProvider } from '../lib/env';
import { getSupabaseClient } from '../lib/supabase/client';
import type { AvailabilityRepository, DriverRepository, ResortRepository, RotaRepository, ShiftConfigurationRepository } from './types';

import { MockResortRepository } from './mock/resorts';
import { MockDriverRepository } from './mock/drivers';
import { MockShiftConfigurationRepository } from './mock/shiftConfiguration';
import { MockAvailabilityRepository } from './mock/availability';
import { MockRotaRepository } from './mock/rota';

import { SupabaseResortRepository } from './supabase/resorts';
import { SupabaseDriverRepository } from './supabase/drivers';
import { SupabaseShiftConfigurationRepository } from './supabase/shiftConfiguration';
import { SupabaseAvailabilityRepository } from './supabase/availability';
import { SupabaseRotaRepository } from './supabase/rota';

export interface Repositories {
  resorts: ResortRepository;
  drivers: DriverRepository;
  shiftConfiguration: ShiftConfigurationRepository;
  availability: AvailabilityRepository;
  rota: RotaRepository;
}

function buildRepositories(provider: DataProvider): Repositories {
  if (provider === 'mock') {
    return {
      resorts: new MockResortRepository(),
      drivers: new MockDriverRepository(),
      shiftConfiguration: new MockShiftConfigurationRepository(),
      availability: new MockAvailabilityRepository(),
      rota: new MockRotaRepository(),
    };
  }

  const client = getSupabaseClient();
  return {
    resorts: new SupabaseResortRepository(client),
    drivers: new SupabaseDriverRepository(client),
    shiftConfiguration: new SupabaseShiftConfigurationRepository(client),
    availability: new SupabaseAvailabilityRepository(client),
    rota: new SupabaseRotaRepository(client),
  };
}

let cached: Repositories | null = null;

/** Returns the singleton repository set for the configured data provider. */
export function getRepositories(): Repositories {
  if (!cached) {
    cached = buildRepositories(getDataProvider());
  }
  return cached;
}

/** Test-only: clears the memoised instance so a test can force a fresh build. */
export function resetRepositoriesForTesting(): void {
  cached = null;
}
