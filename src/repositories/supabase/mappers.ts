/**
 * Database row -> domain model mapping. One function per shape, used only
 * where naming/structure actually differ (snake_case -> camelCase) — no
 * business rules live here, just renaming/reshaping.
 */

import type { Database } from '../../types/database.generated';
import { RepositoryError } from '../errors';
import type { RotaBuildAssignment, RotaBuildAvailability, RotaBuildDriver } from '../managerRotaModel';
import type {
  ApplyTemplateCancellationResult,
  ApplyTemplateRefreshResult,
  AvailabilityAnswer,
  AvailabilitySubmissionRecord,
  ConfirmWeekOutcome,
  DriverDeliveryRateRecord,
  DriverOnfleetMappingRecord,
  DriverRecord,
  AttendanceMutationResult,
  AttendanceRecord,
  AttendanceStatus,
  ClearAttendanceResult,
  DriverCheckInResult,
  DriverVisibleAssignment,
  DriverVisibleShift,
  MaterialiseShiftsResult,
  PublishRotaResult,
  ReopenWeekOutcome,
  ResortRecord,
  RotaAssignmentSource,
  RotaAvailabilityState,
  ShiftBasePayRuleRecord,
  ShiftInstanceRecord,
  ShiftTemplateRecord,
  ShiftTypeRecord,
  SupportedLanguageRecord,
  TemplateCancellationPreviewRow,
  TemplateRefreshFieldChange,
  TemplateRefreshPreviewRow,
  WeekAvailabilityStatus,
} from '../domain';

type ResortRow = Database['public']['Tables']['resorts']['Row'];
type CreateResortRow = Database['public']['Functions']['create_resort']['Returns'][number];
// deactivate_resort/reactivate_resort both return the same single
// { resort_id } shape -- one shared row type/mapper for both.
type ResortMutationRow = { resort_id: string };
type DriverRow = Database['public']['Tables']['drivers']['Row'];
type SupportedLanguageRow = Database['public']['Tables']['supported_languages']['Row'];
type DriverOnfleetMappingRow = Database['public']['Tables']['driver_onfleet_mappings']['Row'];
type ShiftTypeRow = Database['public']['Tables']['shift_types']['Row'];
type ShiftTemplateRow = Database['public']['Tables']['shift_templates']['Row'];
type ShiftInstanceRow = Database['public']['Tables']['shift_instances']['Row'];
type AvailabilityRow = Database['public']['Tables']['availability']['Row'];
type AvailabilitySubmissionRow = Database['public']['Tables']['availability_submissions']['Row'];
type DriverVisibleShiftRow = Database['public']['Views']['driver_visible_shifts']['Row'];
type DriverVisibleAssignmentRow = Database['public']['Views']['driver_visible_assignments']['Row'];
type WeekAvailabilityStatusRow = Database['public']['Functions']['week_availability_status']['Returns'][number];
type ConfirmWeekRow = Database['public']['Functions']['confirm_availability_week']['Returns'][number];
type ReopenWeekRow = Database['public']['Functions']['reopen_availability_week']['Returns'][number];
type MaterialiseShiftsRow = Database['public']['Functions']['materialise_shift_instances']['Returns'][number];
type TemplateRefreshPreviewDbRow = Database['public']['Functions']['preview_template_refresh']['Returns'][number];
type ApplyTemplateRefreshRow = Database['public']['Functions']['apply_template_refresh']['Returns'][number];
type TemplateCancellationPreviewDbRow = Database['public']['Functions']['preview_template_cancellation']['Returns'][number];
type ShiftBasePayRuleRow = Database['public']['Tables']['shift_base_pay_rules']['Row'];
type SetShiftBasePayRateRow = Database['public']['Functions']['set_shift_base_pay_rate']['Returns'][number];
type DriverDeliveryRateRow = Database['public']['Tables']['driver_delivery_rates']['Row'];
type SetDriverDeliveryRateRow = Database['public']['Functions']['set_driver_delivery_rate']['Returns'][number];
type CorrectShiftBasePayRateRow = Database['public']['Functions']['correct_shift_base_pay_rate']['Returns'][number];
type CorrectDriverDeliveryRateRow = Database['public']['Functions']['correct_driver_delivery_rate']['Returns'][number];
type ApplyTemplateCancellationRow = Database['public']['Functions']['apply_template_cancellation']['Returns'][number];
type CreateShiftRow = Database['public']['Functions']['create_shift']['Returns'][number];
// revise_shift/deactivate_shift/reactivate_shift all return the same single
// { shift_type_id } shape -- one shared row type/mapper for all three.
type ShiftMutationRow = { shift_type_id: string };

export function mapResort(row: ResortRow): ResortRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    isActive: row.is_active,
  };
}

/** create_resort's row also carries the auto-generated slug -- never surfaced to the manager, kept here only in case a caller ever needs it for logging/debugging. */
export function mapCreateResortResult(row: CreateResortRow): { resortId: string; slug: string } {
  return { resortId: row.resort_id, slug: row.slug };
}

/** Shared by deactivate_resort/reactivate_resort -- both return just the resort id. */
export function mapResortMutationResult(row: ResortMutationRow): { resortId: string } {
  return { resortId: row.resort_id };
}

export function mapDriver(row: DriverRow): DriverRecord {
  return {
    id: row.id,
    resortId: row.resort_id,
    fullName: row.full_name,
    isActive: row.is_active,
    preferredLanguage: row.preferred_language,
  };
}

export function mapSupportedLanguage(row: SupportedLanguageRow): SupportedLanguageRecord {
  return {
    code: row.code,
    name: row.name,
  };
}

export function mapDriverOnfleetMapping(row: DriverOnfleetMappingRow): DriverOnfleetMappingRecord {
  return {
    id: row.id,
    driverId: row.driver_id,
    resortId: row.resort_id,
    onfleetWorkerId: row.onfleet_worker_id,
    isActive: row.is_active,
  };
}

export function mapShiftType(row: ShiftTypeRow): ShiftTypeRecord {
  return {
    id: row.id,
    resortId: row.resort_id,
    key: row.key,
    name: row.name,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

export function mapShiftTemplate(row: ShiftTemplateRow): ShiftTemplateRecord {
  return {
    id: row.id,
    resortId: row.resort_id,
    shiftTypeId: row.shift_type_id,
    weekday: row.weekday,
    startTime: row.start_time,
    endTime: row.end_time,
    requiredDrivers: row.required_drivers,
    basePayChf: row.base_pay_chf,
    deliveryRateChf: row.delivery_rate_chf,
    isPremium: row.is_premium,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  };
}

/** create_shift's row also carries the auto-generated internal key -- never surfaced to the manager, kept here only in case a caller ever needs it for logging/debugging. */
export function mapCreateShiftResult(row: CreateShiftRow): { shiftTypeId: string; key: string } {
  return { shiftTypeId: row.shift_type_id, key: row.key };
}

/** Shared by revise_shift/deactivate_shift/reactivate_shift -- all three return just the stable shift_type_id. */
export function mapShiftMutationResult(row: ShiftMutationRow): { shiftTypeId: string } {
  return { shiftTypeId: row.shift_type_id };
}

export function mapShiftInstance(row: ShiftInstanceRow): ShiftInstanceRecord {
  return {
    id: row.id,
    resortId: row.resort_id,
    date: row.date,
    // week_start is a generated column and is technically nullable in the
    // generated type; it is NOT NULL in practice (derived from `date`,
    // which is itself NOT NULL) — see migration 06.
    weekStart: row.week_start ?? row.date,
    shiftTypeId: row.shift_type_id,
    templateId: row.template_id,
    shiftKey: row.shift_key,
    name: row.name,
    sortOrder: row.sort_order,
    startTime: row.start_time,
    endTime: row.end_time,
    requiredDrivers: row.required_drivers,
    isPremium: row.is_premium,
    // status/origin are CHECK-constrained at the DB level (migration 06)
    // but the generator can't see CHECK constraints, only the base `text`
    // column type — narrowing here is safe given that invariant.
    status: row.status as ShiftInstanceRecord['status'],
    origin: row.origin as ShiftInstanceRecord['origin'],
  };
}

export function mapDriverVisibleShift(row: DriverVisibleShiftRow): DriverVisibleShift {
  return {
    id: row.id!,
    resortId: row.resort_id!,
    date: row.date!,
    weekStart: row.week_start!,
    shiftTypeId: row.shift_type_id!,
    shiftKey: row.shift_key!,
    name: row.name!,
    sortOrder: row.sort_order!,
    startTime: row.start_time!,
    endTime: row.end_time!,
    status: row.status!,
  };
}

export function mapDriverVisibleAssignment(row: DriverVisibleAssignmentRow): DriverVisibleAssignment {
  // The server computes the check-in window (resort timezone); a row without it is a contract break, not something to guess.
  if (!row.check_in_opens_at || !row.check_in_closes_at) {
    throw new RepositoryError('driver_visible_assignments returned a row without its check-in window', {
      operation: 'rota.driverWeek.assignments',
      cause: row,
    });
  }
  return {
    assignmentId: row.assignment_id!,
    shiftInstanceId: row.shift_instance_id!,
    resortId: row.resort_id!,
    date: row.date!,
    weekStart: row.week_start!,
    shiftKey: row.shift_key!,
    name: row.name!,
    startTime: row.start_time!,
    endTime: row.end_time!,
    checkedInAt: row.checked_in_at ?? null,
    checkInOpensAt: row.check_in_opens_at,
    checkInClosesAt: row.check_in_closes_at,
  };
}

export function mapAvailability(row: AvailabilityRow): AvailabilityAnswer {
  return {
    id: row.id,
    driverId: row.driver_id,
    resortId: row.resort_id,
    shiftInstanceId: row.shift_instance_id,
    status: row.status as AvailabilityAnswer['status'],
    answeredAt: row.answered_at,
  };
}

export function mapAvailabilitySubmission(row: AvailabilitySubmissionRow): AvailabilitySubmissionRecord {
  return {
    driverId: row.driver_id,
    resortId: row.resort_id,
    weekStart: row.week_start,
    submittedAt: row.submitted_at,
    reopenedAt: row.reopened_at,
    reopenedReason: row.reopened_reason,
  };
}

export function mapWeekAvailabilityStatus(row: WeekAvailabilityStatusRow): WeekAvailabilityStatus {
  return {
    state: row.state,
    resortId: row.resort_id,
    weekStart: row.week_start,
    totalShifts: row.total_shifts,
    answeredCount: row.answered_count,
    missingCount: row.missing_count,
    missingShiftIds: row.missing_shift_ids ?? [],
  };
}

export function mapConfirmWeekOutcome(row: ConfirmWeekRow): ConfirmWeekOutcome {
  return {
    result: row.result,
    resortId: row.resort_id,
    weekStart: row.week_start,
    totalShifts: row.total_shifts,
    answeredCount: row.answered_count,
    missingShiftIds: row.missing_shift_ids ?? [],
    submittedAt: row.submitted_at,
  };
}

export function mapReopenWeekOutcome(row: ReopenWeekRow): ReopenWeekOutcome {
  return {
    result: row.result,
    resortId: row.resort_id,
    weekStart: row.week_start,
    reopenedAt: row.reopened_at,
    reopenedReason: row.reopened_reason,
  };
}

export function mapMaterialiseShiftsResult(row: MaterialiseShiftsRow): MaterialiseShiftsResult {
  return {
    createdCount: row.created_count,
    skippedExistingCount: row.skipped_existing_count,
    fromDate: row.from_date,
    toDate: row.to_date,
  };
}

export function mapTemplateRefreshPreviewRow(row: TemplateRefreshPreviewDbRow): TemplateRefreshPreviewRow {
  return {
    shiftInstanceId: row.shift_instance_id,
    date: row.date,
    shiftTypeId: row.shift_type_id,
    shiftKey: row.shift_key,
    name: row.name,
    currentTemplateId: row.current_template_id,
    newTemplateId: row.new_template_id,
    willChange: row.will_change,
    changedFields: (row.changed_fields ?? {}) as unknown as Record<string, TemplateRefreshFieldChange>,
    assignmentCount: row.assignment_count,
    timeWouldChange: row.time_would_change,
  };
}

export function mapApplyTemplateRefreshResult(row: ApplyTemplateRefreshRow): ApplyTemplateRefreshResult {
  return {
    updatedCount: row.updated_count,
    reopenedSubmissionCount: row.reopened_submission_count,
  };
}

export function mapTemplateCancellationPreviewRow(row: TemplateCancellationPreviewDbRow): TemplateCancellationPreviewRow {
  return {
    shiftInstanceId: row.shift_instance_id,
    date: row.date,
    shiftTypeId: row.shift_type_id,
    shiftKey: row.shift_key,
    name: row.name,
    isPublished: row.is_published,
    assignmentCount: row.assignment_count,
    hasAvailabilityAnswers: row.has_availability_answers,
    hasAttendance: row.has_attendance,
    isSafeToCancel: row.is_safe_to_cancel,
  };
}

export function mapApplyTemplateCancellationResult(row: ApplyTemplateCancellationRow): ApplyTemplateCancellationResult {
  return {
    cancelledCount: row.cancelled_count,
    cancelledShiftInstanceIds: row.cancelled_shift_instance_ids ?? [],
  };
}

export function mapShiftBasePayRule(row: ShiftBasePayRuleRow): ShiftBasePayRuleRecord {
  return {
    id: row.id,
    resortId: row.resort_id,
    shiftTypeId: row.shift_type_id,
    basePayChf: row.base_pay_chf,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

export function mapSetShiftBasePayRateResult(row: SetShiftBasePayRateRow): ShiftBasePayRuleRecord {
  return {
    id: row.rule_id,
    resortId: row.resort_id,
    shiftTypeId: row.shift_type_id,
    basePayChf: row.base_pay_chf,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

export function mapDriverDeliveryRate(row: DriverDeliveryRateRow): DriverDeliveryRateRecord {
  return {
    id: row.id,
    resortId: row.resort_id,
    driverId: row.driver_id,
    rateChf: row.rate_chf,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

export function mapSetDriverDeliveryRateResult(row: SetDriverDeliveryRateRow): DriverDeliveryRateRecord {
  return {
    id: row.rule_id,
    resortId: row.resort_id,
    driverId: row.driver_id,
    rateChf: row.rate_chf,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

/** Stage 2D Payroll Checkpoint B.1 -- correct_shift_base_pay_rate returns the identical row shape as set_shift_base_pay_rate. */
export function mapCorrectShiftBasePayRateResult(row: CorrectShiftBasePayRateRow): ShiftBasePayRuleRecord {
  return {
    id: row.rule_id,
    resortId: row.resort_id,
    shiftTypeId: row.shift_type_id,
    basePayChf: row.base_pay_chf,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

/** Stage 2D Payroll Checkpoint B.1 -- correct_driver_delivery_rate returns the identical row shape as set_driver_delivery_rate. */
export function mapCorrectDriverDeliveryRateResult(row: CorrectDriverDeliveryRateRow): DriverDeliveryRateRecord {
  return {
    id: row.rule_id,
    resortId: row.resort_id,
    driverId: row.driver_id,
    rateChf: row.rate_chf,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  };
}

// ---------------------------------------------------------------------
// Manual Rota (MR-B). Each takes only the columns the manager week read
// selects -- notably NOT assigned_by, and nothing from audit_log: the
// override reason / audit context never enters the rota read model.
// ---------------------------------------------------------------------
type RotaAssignmentRow = Database['public']['Tables']['rota_assignments']['Row'];
type PublishRotaRow = Database['public']['Functions']['publish_rota']['Returns'][number];
type RecordAttendanceRow = Database['public']['Functions']['record_attendance']['Returns'][number];
type ClearAttendanceRow = Database['public']['Functions']['clear_attendance']['Returns'][number];
type CheckInRow = Database['public']['Functions']['check_in_to_shift']['Returns'][number];

export function mapRotaBuildDriver(row: Pick<DriverRow, 'id' | 'full_name' | 'is_active'>): RotaBuildDriver {
  return { id: row.id, fullName: row.full_name, isActive: row.is_active };
}

/** PostgREST returns a one-to-one embed as an object (or null); accept a one-element array defensively. */
type Embedded<T> = T | T[] | null | undefined;
const one = <T>(value: Embedded<T>): T | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

/** The assignments read, with this assignment's attendance and check-in EMBEDDED (no extra query per assignment). */
export type RotaAssignmentEmbedRow = Pick<RotaAssignmentRow, 'id' | 'shift_instance_id' | 'driver_id' | 'assignment_source' | 'assigned_at'> & {
  attendance?: Embedded<{ status: string; recorded_at: string }>;
  driver_check_ins?: Embedded<{ checked_in_at: string }>;
};

export function mapRotaBuildAssignment(row: RotaAssignmentEmbedRow): RotaBuildAssignment {
  const attendance = one(row.attendance);
  const checkIn = one(row.driver_check_ins);
  return {
    id: row.id,
    shiftInstanceId: row.shift_instance_id,
    driverId: row.driver_id,
    // CHECK-constrained to ('manual','auto') at the DB level (migration 08).
    source: row.assignment_source as RotaAssignmentSource,
    assignedAt: row.assigned_at,
    // No row is "Not recorded" / "Not checked in": null, never a status-like value.
    attendance: attendance ? { status: requireAttendanceStatus(attendance.status, 'rota.managerWeek.assignments'), recordedAt: attendance.recorded_at } : null,
    checkIn: checkIn ? { checkedInAt: checkIn.checked_in_at } : null,
  };
}

const ATTENDANCE_STATUS_SET: ReadonlySet<string> = new Set<AttendanceStatus>(['worked', 'no_show', 'excused', 'cancelled']);

/** The four stored statuses only. Anything else is a contract break, never passed along as a string. */
export function parseAttendanceStatus(value: unknown): AttendanceStatus | null {
  return typeof value === 'string' && ATTENDANCE_STATUS_SET.has(value) ? (value as AttendanceStatus) : null;
}

function requireAttendanceStatus(value: unknown, operation: string): AttendanceStatus {
  const status = parseAttendanceStatus(value);
  if (!status) throw new RepositoryError(`${operation} returned an unknown attendance status`, { operation, cause: value });
  return status;
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** record_attendance's single result row -> the domain result; null for anything but the documented shape. */
export function mapAttendanceMutationResult(row: RecordAttendanceRow | null | undefined): AttendanceMutationResult | null {
  if (!row) return null;
  const status = parseAttendanceStatus(row.status);
  if (
    !status ||
    !isString(row.attendance_id) ||
    !isString(row.assignment_id) ||
    !isString(row.shift_instance_id) ||
    !isString(row.driver_id) ||
    !isString(row.recorded_at) ||
    !isString(row.updated_at) ||
    typeof row.created !== 'boolean' ||
    typeof row.changed !== 'boolean'
  ) {
    return null;
  }
  const record: AttendanceRecord = {
    attendanceId: row.attendance_id,
    assignmentId: row.assignment_id,
    shiftInstanceId: row.shift_instance_id,
    driverId: row.driver_id,
    status,
    recordedAt: row.recorded_at,
    updatedAt: row.updated_at,
  };
  return { record, created: row.created, changed: row.changed };
}

/**
 * clear_attendance's result row. previous_status is non-null exactly when something was cleared;
 * a row that contradicts that (changed with no previous status, or the reverse) is malformed.
 */
export function mapClearAttendanceResult(row: ClearAttendanceRow | null | undefined): ClearAttendanceResult | null {
  if (!row || !isString(row.assignment_id) || typeof row.changed !== 'boolean') return null;
  const previousStatus = row.previous_status === null || row.previous_status === undefined ? null : parseAttendanceStatus(row.previous_status);
  if (row.previous_status !== null && row.previous_status !== undefined && previousStatus === null) return null;
  if (row.changed !== (previousStatus !== null)) return null;
  return { assignmentId: row.assignment_id, previousStatus, changed: row.changed };
}

/** check_in_to_shift's result row -> the domain result; null for anything but the documented shape. */
export function mapCheckInResult(row: CheckInRow | null | undefined): DriverCheckInResult | null {
  if (
    !row ||
    !isString(row.check_in_id) ||
    !isString(row.assignment_id) ||
    !isString(row.shift_instance_id) ||
    !isString(row.checked_in_at) ||
    typeof row.created !== 'boolean'
  ) {
    return null;
  }
  return {
    checkIn: { checkInId: row.check_in_id, assignmentId: row.assignment_id, shiftInstanceId: row.shift_instance_id, checkedInAt: row.checked_in_at },
    created: row.created,
  };
}

export function mapRotaBuildAvailability(row: Pick<AvailabilityRow, 'shift_instance_id' | 'driver_id' | 'status'>): RotaBuildAvailability {
  return {
    shiftInstanceId: row.shift_instance_id,
    driverId: row.driver_id,
    // CHECK-constrained to ('available','unavailable'); "not submitted" is never stored.
    status: row.status as RotaBuildAvailability['status'],
  };
}

/** assign_driver reports exactly these three states; anything else is a contract break, not a value to pass along. */
export function parseRotaAvailabilityState(value: string): RotaAvailabilityState | null {
  return value === 'available' || value === 'unavailable' || value === 'not_submitted' ? value : null;
}

/**
 * publish_rota's single result row -> the domain result. The only place its
 * snake_case names are read, so none of them leak upward. Returns null for a row
 * that is not the documented shape, which the caller reports as a contract
 * break rather than passing a half-valid result to React.
 */
export function mapPublishRotaResult(row: PublishRotaRow | null | undefined): PublishRotaResult | null {
  if (
    !row ||
    typeof row.resort_id !== 'string' ||
    typeof row.week_start !== 'string' ||
    typeof row.published_at !== 'string' ||
    typeof row.uncovered_slots !== 'number' ||
    typeof row.already_published !== 'boolean'
  ) {
    return null;
  }
  return {
    resortId: row.resort_id,
    weekStart: row.week_start,
    publishedAt: row.published_at,
    uncoveredSlots: row.uncovered_slots,
    alreadyPublished: row.already_published,
  };
}
