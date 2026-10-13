import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { RotaRepository } from '../types';
import type {
  AssignDriverParams,
  AssignDriverResult,
  DriverVisibleAssignment,
  ManagerWeekRota,
  UnassignDriverParams,
  UnassignDriverResult,
} from '../domain';
import { RepositoryError, unwrap } from '../errors';
import { buildManagerWeekRota } from '../managerRotaModel';
import {
  mapDriverVisibleAssignment,
  mapRotaBuildAssignment,
  mapRotaBuildAvailability,
  mapRotaBuildDriver,
  mapShiftInstance,
  parseRotaAvailabilityState,
} from './mappers';
import { mapRotaRpcError } from './rotaErrors';

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

  /**
   * Manager-only. Composed from plain authorised reads -- the manager role
   * has SELECT on all five tables via `is_active_manager()` policies, so no
   * new RPC/view is needed (same approach as listAvailabilitySubmissionStatus):
   *
   *   stage 1 (parallel): shift_instances, drivers, rota_publications
   *   stage 2 (parallel, only if the week has shifts): rota_assignments,
   *                       availability -- both filtered by the stage-1 shift ids
   *
   * Always at most five queries, whatever the number of drivers or shifts --
   * never one per driver or per shift. A week with no shift instances skips
   * stage 2 entirely (so there is never an empty `IN ()` list) and returns a
   * valid empty model.
   *
   * Every resort driver is read, INCLUDING inactive ones: an existing
   * assignment must still resolve its driver's name/state after that driver
   * is deactivated. The model itself decides who is a candidate (active only).
   */
  async getManagerWeekRota(params: { resortId: string; weekStart: string }): Promise<ManagerWeekRota> {
    const { resortId, weekStart } = params;

    const [shiftRows, driverRows, publicationRows] = await Promise.all([
      unwrap(
        'rota.managerWeek.shifts',
        this.client
          .from('shift_instances')
          .select('*')
          .eq('resort_id', resortId)
          .eq('week_start', weekStart)
          .eq('status', 'active')
          .order('date', { ascending: true })
          .order('sort_order', { ascending: true })
      ),
      unwrap('rota.managerWeek.drivers', this.client.from('drivers').select('id, full_name, is_active').eq('resort_id', resortId)),
      unwrap(
        'rota.managerWeek.publication',
        this.client.from('rota_publications').select('published_at, unpublished_at').eq('resort_id', resortId).eq('week_start', weekStart)
      ),
    ]);

    const shiftIds = shiftRows.map((s) => s.id);

    const [assignmentRows, availabilityRows] =
      shiftIds.length === 0
        ? [[], []]
        : await Promise.all([
            unwrap(
              'rota.managerWeek.assignments',
              this.client
                .from('rota_assignments')
                .select('id, shift_instance_id, driver_id, assignment_source, assigned_at')
                .in('shift_instance_id', shiftIds)
            ),
            unwrap(
              'rota.managerWeek.availability',
              this.client.from('availability').select('shift_instance_id, driver_id, status').in('shift_instance_id', shiftIds)
            ),
          ]);

    return buildManagerWeekRota({
      resortId,
      weekStart,
      isPublished: publicationRows.some((p) => p.published_at !== null && p.unpublished_at === null),
      shifts: shiftRows.map(mapShiftInstance),
      drivers: driverRows.map(mapRotaBuildDriver),
      assignments: assignmentRows.map(mapRotaBuildAssignment),
      availability: availabilityRows.map(mapRotaBuildAvailability),
    });
  }

  /**
   * RPC wrapper only -- writes to rota_assignments are revoked for every
   * client role, so this and unassignDriver are the sole write path. All
   * rules (availability override, active driver, same resort, duplicate,
   * history, ...) live in the database; nothing is re-implemented here.
   */
  async assignDriver(params: AssignDriverParams): Promise<AssignDriverResult> {
    const { data, error } = await this.client.rpc('assign_driver', {
      p_shift_instance_id: params.shiftInstanceId,
      p_driver_id: params.driverId,
      p_confirm_availability_override: params.confirmAvailabilityOverride ?? false,
      // No availability-state parameter exists, by design: the server reads it.
      p_reason: params.reason ?? undefined,
    });
    if (error) throw mapRotaRpcError('rota.assignDriver', error);

    const row = data?.[0];
    const availabilityState = row ? parseRotaAvailabilityState(row.availability_state) : null;
    if (!row || !availabilityState) {
      throw new RepositoryError('rota.assignDriver returned an unexpected result', { operation: 'rota.assignDriver', cause: data });
    }
    return { assignmentId: row.assignment_id, availabilityState };
  }

  async unassignDriver(params: UnassignDriverParams): Promise<UnassignDriverResult> {
    const { data, error } = await this.client.rpc('unassign_driver', {
      p_shift_instance_id: params.shiftInstanceId,
      p_driver_id: params.driverId,
    });
    if (error) throw mapRotaRpcError('rota.unassignDriver', error);

    const row = data?.[0];
    if (!row) {
      throw new RepositoryError('rota.unassignDriver returned an unexpected result', { operation: 'rota.unassignDriver', cause: data });
    }
    return { assignmentId: row.assignment_id };
  }
}
