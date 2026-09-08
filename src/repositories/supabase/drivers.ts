import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { DriverRepository } from '../types';
import type { DriverOnfleetMappingRecord, DriverRecord, SupportedLanguageRecord } from '../domain';
import { unwrap } from '../errors';
import { mapDriver, mapDriverOnfleetMapping, mapSupportedLanguage } from './mappers';

export class SupabaseDriverRepository implements DriverRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async listDrivers(params?: { resortId?: string }): Promise<DriverRecord[]> {
    let query = this.client.from('drivers').select('*').order('full_name', { ascending: true });
    if (params?.resortId) {
      query = query.eq('resort_id', params.resortId);
    }
    const rows = await unwrap('drivers.list', query);
    return rows.map(mapDriver);
  }

  async getDriverById(driverId: string): Promise<DriverRecord | null> {
    const rows = await unwrap('drivers.getById', this.client.from('drivers').select('*').eq('id', driverId).limit(1));
    return rows[0] ? mapDriver(rows[0]) : null;
  }

  async createDriver(input: { resortId: string; fullName: string; preferredLanguage?: string }): Promise<DriverRecord> {
    const rows = await unwrap(
      'drivers.create',
      this.client
        .from('drivers')
        .insert({
          resort_id: input.resortId,
          full_name: input.fullName,
          ...(input.preferredLanguage ? { preferred_language: input.preferredLanguage } : {}),
        })
        .select('*')
    );
    return mapDriver(rows[0]);
  }

  async updateDriverName(driverId: string, fullName: string): Promise<DriverRecord> {
    const rows = await unwrap(
      'drivers.updateName',
      this.client.from('drivers').update({ full_name: fullName }).eq('id', driverId).select('*')
    );
    return mapDriver(rows[0]);
  }

  async updateDriverLanguage(driverId: string, preferredLanguage: string): Promise<DriverRecord> {
    const rows = await unwrap(
      'drivers.updateLanguage',
      this.client.from('drivers').update({ preferred_language: preferredLanguage }).eq('id', driverId).select('*')
    );
    return mapDriver(rows[0]);
  }

  async deactivateDriver(driverId: string): Promise<DriverRecord> {
    const rows = await unwrap(
      'drivers.deactivate',
      this.client.from('drivers').update({ is_active: false }).eq('id', driverId).select('*')
    );
    return mapDriver(rows[0]);
  }

  async listDriverIdsWithLogin(driverIds?: string[]): Promise<Set<string>> {
    let query = this.client.from('app_users').select('driver_id').not('driver_id', 'is', null);
    if (driverIds) {
      if (driverIds.length === 0) return new Set();
      query = query.in('driver_id', driverIds);
    }
    const rows = await unwrap('drivers.listDriverIdsWithLogin', query);
    return new Set(rows.map((r) => r.driver_id as string));
  }

  async listSupportedLanguages(): Promise<SupportedLanguageRecord[]> {
    const rows = await unwrap(
      'drivers.listSupportedLanguages',
      this.client.from('supported_languages').select('*').order('code', { ascending: true })
    );
    return rows.map(mapSupportedLanguage);
  }

  async listActiveOnfleetMappings(driverIds?: string[]): Promise<Map<string, DriverOnfleetMappingRecord>> {
    let query = this.client.from('driver_onfleet_mappings').select('*').eq('is_active', true);
    if (driverIds) {
      if (driverIds.length === 0) return new Map();
      query = query.in('driver_id', driverIds);
    }
    const rows = await unwrap('drivers.listActiveOnfleetMappings', query);
    return new Map(rows.map((r) => [r.driver_id, mapDriverOnfleetMapping(r)]));
  }

  async setOnfleetMapping(driverId: string, onfleetWorkerId: string): Promise<DriverOnfleetMappingRecord> {
    const row = await unwrap(
      'drivers.setOnfleetMapping',
      this.client.rpc('set_driver_onfleet_mapping', { p_driver_id: driverId, p_onfleet_worker_id: onfleetWorkerId })
    );
    return mapDriverOnfleetMapping(row);
  }
}
