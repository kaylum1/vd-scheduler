import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { RotaRepository } from '../types';
import type {
  AssignDriverParams,
  AssignDriverResult,
  AttendanceMutationResult,
  CheckInToShiftParams,
  ClearAttendanceParams,
  ClearAttendanceResult,
  DriverCheckInResult,
  RecordAttendanceParams,
  AutoRotaPlan,
  AutoRotaResult,
  GenerateAutoRotaParams,
  DriverWeekRota,
  ManagerWeekRota,
  PublishRotaParams,
  PublishRotaResult,
  UnassignDriverParams,
  UnassignDriverResult,
} from '../domain';
import { RepositoryError, unwrap } from '../errors';
import { runAutoRota } from '../autoRotaOrchestration';
import { getOperationalToday } from '../../lib/operationalTime';
import { toISODate } from '../../mock-data/date-utils';
import { buildDriverWeekRota } from '../driverRotaModel';
import { buildManagerWeekRota } from '../managerRotaModel';
import {
  mapAttendanceMutationResult,
  mapCheckInResult,
  mapClearAttendanceResult,
  mapDriverVisibleAssignment,
  mapPublishRotaResult,
  mapRotaBuildAssignment,
  mapRotaBuildAvailability,
  mapRotaBuildDriver,
  mapShiftInstance,
  parseRotaAvailabilityState,
} from './mappers';
import { mapAttendanceRpcError, mapAutoRotaRpcError, mapCheckInRpcError, mapPublishRotaRpcError, mapRotaRpcError } from './rotaErrors';

export class SupabaseRotaRepository implements RotaRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  /**
   * The driver's own rota for one week, from exactly two driver-safe views read
   * in parallel (never the base tables, which drivers cannot read):
   *   - driver_visible_week_publications: a row means this week is currently
   *     published for the caller's own resort;
   *   - driver_visible_assignments: the caller's own assignments in published
   *     weeks, active shifts only.
   * Both views resolve the driver from the authenticated session and have no
   * driver column, so identity is never sent: `driverId` is deliberately
   * unused here (it exists on the contract only for the mock provider).
   */
  async getDriverWeekRota(params: { weekStart: string; driverId: string }): Promise<DriverWeekRota> {
    const { weekStart } = params;
    const [publicationRows, assignmentRows] = await Promise.all([
      unwrap(
        'rota.driverWeek.publication',
        this.client.from('driver_visible_week_publications').select('resort_id, week_start').eq('week_start', weekStart)
      ),
      unwrap(
        'rota.driverWeek.assignments',
        this.client
          .from('driver_visible_assignments')
          .select('*')
          .eq('week_start', weekStart)
          .order('date', { ascending: true })
          .order('start_time', { ascending: true })
      ),
    ]);

    return buildDriverWeekRota({
      weekStart,
      isPublished: publicationRows.length > 0,
      assignments: assignmentRows.map(mapDriverVisibleAssignment),
    });
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
              // Attendance and the driver's check-in are EMBEDDED through their FKs to the assignment: one query, never one per assignment.
              this.client
                .from('rota_assignments')
                .select('id, shift_instance_id, driver_id, assignment_source, assigned_at, attendance(status, recorded_at), driver_check_ins(checked_in_at)')
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

  /**
   * See RotaRepository.generateAutoRota. Orchestration only: the fairness
   * algorithm is the pure planner's, every safety rule is the database's. One
   * apply_auto_rota call per attempt (two at most), never a direct write to
   * rota_assignments and never a loop over assign_driver.
   */
  async generateAutoRota(params: GenerateAutoRotaParams): Promise<AutoRotaResult> {
    return runAutoRota({
      readWeek: () => this.getManagerWeekRota(params),
      applyPlan: (plan) => this.applyAutoRotaPlan(plan),
      operationalToday: () => toISODate(getOperationalToday()),
    });
  }

  private async applyAutoRotaPlan(plan: AutoRotaPlan): Promise<AutoRotaResult> {
    const { data, error } = await this.client.rpc('apply_auto_rota', {
      p_resort_id: plan.resortId,
      p_week_start: plan.weekStart,
      // ONLY the pair. Planning metadata, counts and coverage never reach the database.
      p_plan: plan.assignments.map((a) => ({ shift_instance_id: a.shiftInstanceId, driver_id: a.driverId })),
    });
    if (error) throw mapAutoRotaRpcError('rota.generateAutoRota', error);

    const row = data?.[0];
    if (!row) throw new RepositoryError('rota.generateAutoRota returned an unexpected result', { operation: 'rota.generateAutoRota', cause: data });
    // The result is the DATABASE's, computed after the insert -- never the planner's numbers.
    return {
      resortId: row.resort_id,
      weekStart: row.week_start,
      assignedCount: row.assigned_count,
      remainingOpenSlots: row.remaining_open_slots,
      uncoveredShiftIds: row.uncovered_shift_ids,
      skippedPastShiftCount: row.skipped_past_shift_count,
      runId: row.run_id,
    };
  }

  /**
   * RPC wrapper only: exactly one publish_rota call per invocation. Writes to
   * rota_publications are revoked for every client role, so this is the sole
   * publish path; coverage counting, the confirmation rule, history / shift /
   * resort guards, idempotency and the publication metadata are all the database's
   * (PB-A) -- nothing is re-implemented or derived here.
   */
  async publishRota(params: PublishRotaParams): Promise<PublishRotaResult> {
    const operation = 'rota.publishRota';
    const { data, error } = await this.client.rpc('publish_rota', {
      p_resort_id: params.resortId,
      p_week_start: params.weekStart,
      p_confirm_uncovered: params.confirmUncovered === true,
    });
    if (error) throw mapPublishRotaRpcError(operation, error);

    // Already published is a normal success row; the server's own counts are returned untouched.
    const result = mapPublishRotaResult(data?.[0]);
    if (!result) throw new RepositoryError('rota.publishRota returned an unexpected result', { operation, cause: data });
    return result;
  }

  /**
   * RPC wrapper only (AT-A): exactly one record_attendance call. Publication, the shift date vs
   * the resort's operational today, the historical-backfill reason rule, cancelled shifts and the
   * same-status no-op are all the database's; nothing is decided or derived here, and attendance
   * is never written directly (managers have no write grant on the table).
   */
  async recordAttendance(params: RecordAttendanceParams): Promise<AttendanceMutationResult> {
    const operation = 'rota.recordAttendance';
    const { data, error } = await this.client.rpc('record_attendance', {
      p_assignment_id: params.assignmentId,
      p_status: params.status,
      p_reason: params.reason ?? undefined,
    });
    if (error) throw mapAttendanceRpcError(operation, error);

    const result = mapAttendanceMutationResult(data?.[0]);
    if (!result) throw new RepositoryError('rota.recordAttendance returned an unexpected result', { operation, cause: data });
    return result;
  }

  /** RPC wrapper only (AT-A): exactly one clear_attendance call; the reason is required and validated by the server. */
  async clearAttendance(params: ClearAttendanceParams): Promise<ClearAttendanceResult> {
    const operation = 'rota.clearAttendance';
    const { data, error } = await this.client.rpc('clear_attendance', {
      p_assignment_id: params.assignmentId,
      p_reason: params.reason,
    });
    if (error) throw mapAttendanceRpcError(operation, error);

    const result = mapClearAttendanceResult(data?.[0]);
    if (!result) throw new RepositoryError('rota.clearAttendance returned an unexpected result', { operation, cause: data });
    return result;
  }

  /**
   * RPC wrapper only (AT-A2): exactly one check_in_to_shift call carrying ONLY the assignment id.
   * The driver comes from the session and the timestamp from the server -- neither is ever sent.
   */
  async checkInToShift(params: CheckInToShiftParams): Promise<DriverCheckInResult> {
    const operation = 'rota.checkInToShift';
    const { data, error } = await this.client.rpc('check_in_to_shift', { p_assignment_id: params.assignmentId });
    if (error) throw mapCheckInRpcError(operation, error);

    const result = mapCheckInResult(data?.[0]);
    if (!result) throw new RepositoryError('rota.checkInToShift returned an unexpected result', { operation, cause: data });
    return result;
  }
}
