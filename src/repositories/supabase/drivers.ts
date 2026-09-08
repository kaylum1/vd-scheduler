import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { DriverRepository } from '../types';
import type { DriverRecord } from '../domain';
import { unwrap } from '../errors';
import { mapDriver } from './mappers';

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

  async createDriver(input: { resortId: string; fullName: string }): Promise<DriverRecord> {
    const rows = await unwrap(
      'drivers.create',
      this.client
        .from('drivers')
        .insert({ resort_id: input.resortId, full_name: input.fullName })
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
}
