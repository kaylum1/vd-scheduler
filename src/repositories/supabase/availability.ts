import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { AvailabilityRepository } from '../types';
import type {
  AvailabilityAnswer,
  AvailabilitySubmissionRecord,
  AvailabilitySubmissionSummary,
  AvailabilityStatus,
  ConfirmWeekOutcome,
  DriverShiftAvailability,
  DriverVisibleShift,
  DriverWeekAvailabilityState,
  ReopenWeekOutcome,
  WeekAvailabilityStatus,
} from '../domain';
import { RepositoryError, unwrap } from '../errors';
import {
  mapAvailability,
  mapAvailabilitySubmission,
  mapConfirmWeekOutcome,
  mapDriverVisibleShift,
  mapReopenWeekOutcome,
  mapWeekAvailabilityStatus,
} from './mappers';

/**
 * Shared by both manager-facing methods below and the driver-facing
 * `getAvailabilitySubmission` -- the exact same state derivation the
 * driver-facing page uses for itself, applied per-driver for the manager's
 * list. Never a separately stored status column; see
 * docs/business-rules.md for the mapping this implements.
 */
function deriveWeekState(params: {
  isPublished: boolean;
  answeredCount: number;
  submission: AvailabilitySubmissionRecord | undefined;
}): DriverWeekAvailabilityState {
  if (params.isPublished) return 'locked';
  if (params.submission?.submittedAt) return 'confirmed';
  if (params.submission?.reopenedReason && params.submission.reopenedReason !== 'driver_reopened') {
    return 'needs_reconfirmation';
  }
  if (params.answeredCount > 0) return 'in_progress';
  return 'not_started';
}

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

  async getAvailabilitySubmission(driverId: string, weekStart: string): Promise<AvailabilitySubmissionRecord | null> {
    const rows = await unwrap(
      'availability.getSubmission',
      this.client
        .from('availability_submissions')
        .select('*')
        .eq('driver_id', driverId)
        .eq('week_start', weekStart)
        .limit(1)
    );
    return rows[0] ? mapAvailabilitySubmission(rows[0]) : null;
  }

  /**
   * Manager-only. Composed from plain authorized reads (drivers/
   * shift_instances/availability/availability_submissions/
   * rota_publications) -- the manager role has full SELECT on all five via
   * `is_active_manager()` RLS policies, so no new RPC/migration is needed.
   * Five queries regardless of driver count, combined here rather than one
   * embedded/joined query, since a driver session's much narrower RLS
   * grants make embedding brittle across roles -- keeping every query role-
   * agnostic in shape is simpler to reason about than relying on
   * PostgREST embedding succeeding only for the manager role.
   */
  async listAvailabilitySubmissionStatus(resortId: string, weekStart: string): Promise<AvailabilitySubmissionSummary[]> {
    const [driverRows, shiftRows, submissionRows, publicationRows] = await Promise.all([
      unwrap(
        'availability.submissionStatus.drivers',
        this.client.from('drivers').select('id, full_name').eq('resort_id', resortId).eq('is_active', true)
      ),
      unwrap(
        'availability.submissionStatus.shifts',
        this.client.from('shift_instances').select('id').eq('resort_id', resortId).eq('week_start', weekStart).eq('status', 'active')
      ),
      unwrap(
        'availability.submissionStatus.submissions',
        this.client.from('availability_submissions').select('*').eq('resort_id', resortId).eq('week_start', weekStart)
      ),
      unwrap(
        'availability.submissionStatus.publication',
        this.client.from('rota_publications').select('published_at, unpublished_at').eq('resort_id', resortId).eq('week_start', weekStart)
      ),
    ]);

    const shiftIds = shiftRows.map((s) => s.id);
    const totalShifts = shiftIds.length;
    const isPublished = publicationRows.some((p) => p.published_at !== null && p.unpublished_at === null);
    const submissionsByDriver = new Map(submissionRows.map(mapAvailabilitySubmission).map((s) => [s.driverId, s]));

    let answeredCountByDriver = new Map<string, number>();
    if (shiftIds.length > 0) {
      const answerRows = await unwrap(
        'availability.submissionStatus.answers',
        this.client.from('availability').select('driver_id').in('shift_instance_id', shiftIds)
      );
      answeredCountByDriver = answerRows.reduce((map, row) => {
        map.set(row.driver_id, (map.get(row.driver_id) ?? 0) + 1);
        return map;
      }, new Map<string, number>());
    }

    return driverRows.map((driver) => {
      const answeredCount = answeredCountByDriver.get(driver.id) ?? 0;
      const submission = submissionsByDriver.get(driver.id);
      return {
        driverId: driver.id,
        driverFullName: driver.full_name,
        totalShifts,
        answeredCount,
        state: deriveWeekState({ isPublished, answeredCount, submission }),
      };
    });
  }

  /** Manager-only. See docs/business-rules.md -- same underlying tables as listAvailabilitySubmissionStatus, scoped to one driver's own answers instead of every driver's counts. */
  async getResortWeekAvailability(driverId: string, weekStart: string): Promise<DriverShiftAvailability[]> {
    const driverRows = await unwrap(
      'availability.resortWeek.driver',
      this.client.from('drivers').select('resort_id').eq('id', driverId).limit(1)
    );
    const resortId = driverRows[0]?.resort_id;
    if (!resortId) {
      throw new RepositoryError('driver not found', { operation: 'availability.resortWeek', code: 'P0002' });
    }

    const shiftRows = await unwrap(
      'availability.resortWeek.shifts',
      this.client
        .from('shift_instances')
        .select('id, date, name, start_time, end_time')
        .eq('resort_id', resortId)
        .eq('week_start', weekStart)
        .eq('status', 'active')
        .order('date', { ascending: true })
        .order('sort_order', { ascending: true })
    );
    if (shiftRows.length === 0) return [];

    const answerRows = await unwrap(
      'availability.resortWeek.answers',
      this.client
        .from('availability')
        .select('shift_instance_id, status')
        .eq('driver_id', driverId)
        .in(
          'shift_instance_id',
          shiftRows.map((s) => s.id)
        )
    );
    const statusByShift = new Map(answerRows.map((a) => [a.shift_instance_id, a.status as AvailabilityStatus]));

    return shiftRows.map((shift) => ({
      shiftInstanceId: shift.id,
      date: shift.date,
      name: shift.name,
      startTime: shift.start_time,
      endTime: shift.end_time,
      status: statusByShift.get(shift.id) ?? null,
    }));
  }
}
