import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { ResortRepository } from '../types';
import type { ResortRecord } from '../domain';
import { unwrap } from '../errors';
import { mapResort } from './mappers';

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
}
