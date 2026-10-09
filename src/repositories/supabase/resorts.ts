import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { ResortRepository } from '../types';
import type { ResortRecord } from '../domain';
import { unwrap } from '../errors';
import { mapCreateResortResult, mapResort, mapResortMutationResult } from './mappers';

export class SupabaseResortRepository implements ResortRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async listResorts(): Promise<ResortRecord[]> {
    const rows = await unwrap(
      'resorts.list',
      this.client.from('resorts').select('*').order('name', { ascending: true })
    );
    return rows.map(mapResort);
  }

  async getResortById(resortId: string): Promise<ResortRecord | null> {
    const rows = await unwrap('resorts.getById', this.client.from('resorts').select('*').eq('id', resortId).limit(1));
    return rows[0] ? mapResort(rows[0]) : null;
  }

  async createResort(name: string): Promise<{ resortId: string; slug: string }> {
    const rows = await unwrap('resorts.create', this.client.rpc('create_resort', { p_name: name }));
    return mapCreateResortResult(rows[0]);
  }

  async deactivateResort(resortId: string): Promise<{ resortId: string }> {
    const rows = await unwrap('resorts.deactivate', this.client.rpc('deactivate_resort', { p_resort_id: resortId }));
    return mapResortMutationResult(rows[0]);
  }

  async reactivateResort(resortId: string): Promise<{ resortId: string }> {
    const rows = await unwrap('resorts.reactivate', this.client.rpc('reactivate_resort', { p_resort_id: resortId }));
    return mapResortMutationResult(rows[0]);
  }
}
