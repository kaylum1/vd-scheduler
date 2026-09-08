/**
 * Database row -> domain model mapping. One function per shape, used only
 * where naming/structure actually differ (snake_case -> camelCase) — no
 * business rules live here, just renaming/reshaping.
 */

import type { Database } from '../../types/database.generated';
import type {
  AvailabilityAnswer,
  ConfirmWeekOutcome,
  DriverRecord,
  DriverVisibleAssignment,
  DriverVisibleShift,
  ReopenWeekOutcome,
  ResortRecord,
  ShiftInstanceRecord,
  ShiftTemplateRecord,
  ShiftTypeRecord,
  WeekAvailabilityStatus,
} from '../domain';

type ResortRow = Database['public']['Tables']['resorts']['Row'];
type DriverRow = Database['public']['Tables']['drivers']['Row'];
type ShiftTypeRow = Database['public']['Tables']['shift_types']['Row'];
type ShiftTemplateRow = Database['public']['Tables']['shift_templates']['Row'];
type ShiftInstanceRow = Database['public']['Tables']['shift_instances']['Row'];
type AvailabilityRow = Database['public']['Tables']['availability']['Row'];
type DriverVisibleShiftRow = Database['public']['Views']['driver_visible_shifts']['Row'];
type DriverVisibleAssignmentRow = Database['public']['Views']['driver_visible_assignments']['Row'];
type WeekAvailabilityStatusRow = Database['public']['Functions']['week_availability_status']['Returns'][number];
type ConfirmWeekRow = Database['public']['Functions']['confirm_availability_week']['Returns'][number];
type ReopenWeekRow = Database['public']['Functions']['reopen_availability_week']['Returns'][number];

export function mapResort(row: ResortRow): ResortRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    isActive: row.is_active,
  };
}

export function mapDriver(row: DriverRow): DriverRecord {
  return {
    id: row.id,
    resortId: row.resort_id,
    fullName: row.full_name,
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
  };
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
    basePayChf: row.base_pay_chf,
    deliveryRateChf: row.delivery_rate_chf,
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
