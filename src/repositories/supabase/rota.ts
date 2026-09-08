import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { RotaRepository } from '../types';
import type { DriverVisibleAssignment } from '../domain';
import { unwrap } from '../errors';
import { mapDriverVisibleAssignment } from './mappers';

export class SupabaseRotaRepository implements RotaRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async listDriverVisibleAssignments(_driverId: string): Promise<DriverVisibleAssignment[]> {
    // driver_visible_assignments has no driver-identifying column at all —
    // it is already scoped to the calling session's own driver_id via
    // current_app_user() (Checkpoint 4). _driverId is accepted only for
    // interface symmetry with the mock implementation, which has no real
    // session to infer identity from.
    const rows = await unwrap(
      'rota.listDriverVisibleAssignments',
      this.client.from('driver_visible_assignments').select('*').order('date', { ascending: true })
    );
    return rows.map(mapDriverVisibleAssignment);
  }
}
