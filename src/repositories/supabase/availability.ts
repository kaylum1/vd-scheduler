import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { AvailabilityRepository } from '../types';
import type {
  AvailabilityAnswer,
  AvailabilityStatus,
  ConfirmWeekOutcome,
  DriverVisibleShift,
  ReopenWeekOutcome,
  WeekAvailabilityStatus,
} from '../domain';
import { RepositoryError, unwrap } from '../errors';
import {
  mapAvailability,
  mapConfirmWeekOutcome,
  mapDriverVisibleShift,
  mapReopenWeekOutcome,
  mapWeekAvailabilityStatus,
} from './mappers';

export class SupabaseAvailabilityRepository implements AvailabilityRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async listDriverVisibleShifts(resortId: string): Promise<DriverVisibleShift[]> {
    // The view itself scopes rows to the calling driver's own resort via
    // current_app_user() (Checkpoint 4) — resortId is used here only as an
    // additional, redundant client-side filter, not the source of trust.
    const rows = await unwrap(
      'availability.listDriverVisibleShifts',
      this.client.from('driver_visible_shifts').select('*').eq('resort_id', resortId).order('date', { ascending: true })
    );
    return rows.map(mapDriverVisibleShift);
  }

  /**
   * Driver-scoped for V1: filters by week via driver_visible_shifts rather
   * than joining shift_instances directly, because a driver session has no
   * SELECT grant on shift_instances at all (Checkpoint 4) — PostgREST
   * embedding would fail under RLS for that role. A manager-facing
   * equivalent (joining the real table) can be added when Configuration
   * needs it.
   */
  async listAvailability(params: {
    driverId: string;
    resortId: string;
    weekStart: string;
  }): Promise<AvailabilityAnswer[]> {
    const shiftRows = await unwrap(
      'availability.list.shiftLookup',
      this.client.from('driver_visible_shifts').select('id').eq('resort_id', params.resortId).eq('week_start', params.weekStart)
    );
    const shiftIds = shiftRows.map((row) => row.id).filter((id): id is string => id !== null);
    if (shiftIds.length === 0) return [];

    const rows = await unwrap(
      'availability.list',
      this.client.from('availability').select('*').eq('driver_id', params.driverId).in('shift_instance_id', shiftIds)
    );
    return rows.map(mapAvailability);
  }

  async setAvailability(params: {
    driverId: string;
    resortId: string;
    shiftInstanceId: string;
    status: AvailabilityStatus;
  }): Promise<AvailabilityAnswer> {
    const rows = await unwrap(
      'availability.set',
      this.client
        .from('availability')
        .upsert(
          {
            driver_id: params.driverId,
            resort_id: params.resortId,
            shift_instance_id: params.shiftInstanceId,
            status: params.status,
          },
          { onConflict: 'driver_id,shift_instance_id' }
        )
        .select('*')
    );
    return mapAvailability(rows[0]);
  }

  async getWeekAvailabilityStatus(driverId: string, weekStart: string): Promise<WeekAvailabilityStatus> {
    const rows = await unwrap(
      'availability.getWeekStatus',
      this.client.rpc('week_availability_status', { p_driver_id: driverId, p_week_start: weekStart })
    );
    const row = rows[0];
    if (!row) {
      throw new RepositoryError('availability.getWeekStatus returned no rows', {
        operation: 'availability.getWeekStatus',
      });
    }
    return mapWeekAvailabilityStatus(row);
  }

  async confirmAvailabilityWeek(driverId: string, weekStart: string): Promise<ConfirmWeekOutcome> {
    const rows = await unwrap(
      'availability.confirmWeek',
      this.client.rpc('confirm_availability_week', { p_driver_id: driverId, p_week_start: weekStart })
    );
    const row = rows[0];
    if (!row) {
      throw new RepositoryError('availability.confirmWeek returned no rows', { operation: 'availability.confirmWeek' });
    }
    return mapConfirmWeekOutcome(row);
  }

  async reopenAvailabilityWeek(driverId: string, weekStart: string): Promise<ReopenWeekOutcome> {
    const rows = await unwrap(
      'availability.reopenWeek',
      this.client.rpc('reopen_availability_week', { p_driver_id: driverId, p_week_start: weekStart })
    );
    const row = rows[0];
    if (!row) {
      throw new RepositoryError('availability.reopenWeek returned no rows', { operation: 'availability.reopenWeek' });
    }
    return mapReopenWeekOutcome(row);
  }
}
