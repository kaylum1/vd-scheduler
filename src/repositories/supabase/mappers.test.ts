import { describe, expect, it } from 'vitest';
import {
  mapApplyTemplateCancellationResult,
  mapApplyTemplateRefreshResult,
  mapAvailability,
  mapConfirmWeekOutcome,
  mapDriver,
  mapDriverVisibleAssignment,
  mapDriverVisibleShift,
  mapMaterialiseShiftsResult,
  mapReopenWeekOutcome,
  mapResort,
  mapShiftInstance,
  mapTemplateCancellationPreviewRow,
  mapTemplateRefreshPreviewRow,
  mapWeekAvailabilityStatus,
} from './mappers';

describe('mapResort', () => {
  it('maps snake_case DB columns to the camelCase domain shape', () => {
    expect(
      mapResort({
        id: 'r1',
        slug: 'crans',
        name: 'Crans',
        timezone: 'Europe/Zurich',
        is_active: true,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      })
    ).toEqual({ id: 'r1', slug: 'crans', name: 'Crans', timezone: 'Europe/Zurich', isActive: true });
  });
});

describe('mapDriver', () => {
  it('maps a driver row', () => {
    expect(
      mapDriver({
        id: 'd1',
        resort_id: 'r1',
        full_name: 'Gianni',
        is_active: true,
        created_at: '',
        updated_at: '',
      })
    ).toEqual({ id: 'd1', resortId: 'r1', fullName: 'Gianni', isActive: true });
  });
});

describe('mapShiftInstance', () => {
  it('narrows status/origin to the domain literal unions and preserves pay/premium fields', () => {
    const mapped = mapShiftInstance({
      id: 's1',
      resort_id: 'r1',
      date: '2024-01-01',
      week_start: '2024-01-01',
      shift_type_id: 'st1',
      template_id: null,
      shift_key: 'daily',
      name: 'Daily',
      sort_order: 1,
      start_time: '08:00',
      end_time: '12:00',
      required_drivers: 1,
      base_pay_chf: 100,
      delivery_rate_chf: 5,
      is_premium: true,
      status: 'active',
      origin: 'adhoc',
      created_at: '',
      updated_at: '',
      cancelled_at: null,
      cancelled_by: null,
      cancelled_reason: null,
    });
    expect(mapped.status).toBe('active');
    expect(mapped.origin).toBe('adhoc');
    expect(mapped.isPremium).toBe(true);
    expect(mapped.basePayChf).toBe(100);
  });

  it('falls back to `date` for weekStart in the (practically unreachable) case week_start is null', () => {
    const mapped = mapShiftInstance({
      id: 's1',
      resort_id: 'r1',
      date: '2024-01-03',
      week_start: null,
      shift_type_id: 'st1',
      template_id: null,
      shift_key: 'daily',
      name: 'Daily',
      sort_order: 1,
      start_time: '08:00',
      end_time: '12:00',
      required_drivers: 1,
      base_pay_chf: 100,
      delivery_rate_chf: 5,
      is_premium: false,
      status: 'active',
      origin: 'adhoc',
      created_at: '',
      updated_at: '',
      cancelled_at: null,
      cancelled_by: null,
      cancelled_reason: null,
    });
    expect(mapped.weekStart).toBe('2024-01-03');
  });
});

describe('mapDriverVisibleShift', () => {
  it('carries only driver-safe fields — no is_premium/pay/required_drivers exist to map in the first place', () => {
    const mapped = mapDriverVisibleShift({
      id: 's1',
      resort_id: 'r1',
      date: '2024-01-01',
      week_start: '2024-01-01',
      shift_type_id: 'st1',
      shift_key: 'daily',
      name: 'Daily',
      sort_order: 1,
      start_time: '08:00',
      end_time: '12:00',
      status: 'active',
    });
    expect(mapped).toEqual({
      id: 's1',
      resortId: 'r1',
      date: '2024-01-01',
      weekStart: '2024-01-01',
      shiftTypeId: 'st1',
      shiftKey: 'daily',
      name: 'Daily',
      sortOrder: 1,
      startTime: '08:00',
      endTime: '12:00',
      status: 'active',
    });
    expect(mapped).not.toHaveProperty('isPremium');
    expect(mapped).not.toHaveProperty('basePayChf');
  });
});

describe('mapDriverVisibleAssignment', () => {
  it('carries no driver-identifying field — colleagues stay structurally invisible', () => {
    const mapped = mapDriverVisibleAssignment({
      assignment_id: 'a1',
      shift_instance_id: 's1',
      resort_id: 'r1',
      date: '2024-01-01',
      week_start: '2024-01-01',
      shift_key: 'daily',
      name: 'Daily',
      start_time: '08:00',
      end_time: '12:00',
    });
    expect(mapped.assignmentId).toBe('a1');
    expect(mapped).not.toHaveProperty('driverId');
  });
});

describe('mapAvailability', () => {
  it('maps an availability answer row', () => {
    const mapped = mapAvailability({
      id: 'av1',
      driver_id: 'd1',
      resort_id: 'r1',
      shift_instance_id: 's1',
      status: 'available',
      answered_at: '2024-01-01T00:00:00Z',
      created_at: '',
      updated_at: '',
    });
    expect(mapped).toEqual({
      id: 'av1',
      driverId: 'd1',
      resortId: 'r1',
      shiftInstanceId: 's1',
      status: 'available',
      answeredAt: '2024-01-01T00:00:00Z',
    });
  });
});

describe('RPC response mapping', () => {
  it('maps week_availability_status(), defaulting a null missing_shift_ids to []', () => {
    const mapped = mapWeekAvailabilityStatus({
      state: 'incomplete',
      resort_id: 'r1',
      week_start: '2024-01-01',
      total_shifts: 3,
      answered_count: 2,
      missing_count: 1,
      missing_shift_ids: null as unknown as string[],
    });
    expect(mapped.state).toBe('incomplete');
    expect(mapped.missingShiftIds).toEqual([]);
  });

  it('maps confirm_availability_week()', () => {
    const mapped = mapConfirmWeekOutcome({
      result: 'confirmed',
      resort_id: 'r1',
      week_start: '2024-01-01',
      total_shifts: 2,
      answered_count: 2,
      missing_shift_ids: [],
      submitted_at: '2024-01-01T00:00:00Z',
    });
    expect(mapped).toEqual({
      result: 'confirmed',
      resortId: 'r1',
      weekStart: '2024-01-01',
      totalShifts: 2,
      answeredCount: 2,
      missingShiftIds: [],
      submittedAt: '2024-01-01T00:00:00Z',
    });
  });

  it('maps reopen_availability_week()', () => {
    const mapped = mapReopenWeekOutcome({
      result: 'reopened',
      resort_id: 'r1',
      week_start: '2024-01-01',
      reopened_at: '2024-01-02T00:00:00Z',
      reopened_reason: 'driver_reopened',
    });
    expect(mapped.result).toBe('reopened');
    expect(mapped.reopenedReason).toBe('driver_reopened');
  });
});

describe('Stage 2C RPC response mapping', () => {
  it('maps materialise_shift_instances()', () => {
    const mapped = mapMaterialiseShiftsResult({
      created_count: 5,
      skipped_existing_count: 2,
      from_date: '2024-01-01',
      to_date: '2024-02-29',
    });
    expect(mapped).toEqual({ createdCount: 5, skippedExistingCount: 2, fromDate: '2024-01-01', toDate: '2024-02-29' });
  });

  it('maps a preview_template_refresh() row, including the changed_fields diff', () => {
    const mapped = mapTemplateRefreshPreviewRow({
      shift_instance_id: 's1',
      date: '2024-01-01',
      shift_type_id: 'st1',
      shift_key: 'dinner',
      name: 'Dinner',
      current_template_id: 't1',
      new_template_id: 't2',
      will_change: true,
      changed_fields: { start_time: { old: '18:00', new: '18:30' } },
      assignment_count: 2,
      current_required_drivers: 2,
      new_required_drivers: 1,
      would_be_overassigned: true,
      time_would_change: true,
    });
    expect(mapped.willChange).toBe(true);
    expect(mapped.changedFields).toEqual({ start_time: { old: '18:00', new: '18:30' } });
    expect(mapped.wouldBeOverassigned).toBe(true);
  });

  it('maps apply_template_refresh(), defaulting a null overassigned id array to []', () => {
    const mapped = mapApplyTemplateRefreshResult({
      updated_count: 3,
      overassigned_count: 0,
      overassigned_shift_instance_ids: null as unknown as string[],
      reopened_submission_count: 1,
    });
    expect(mapped.overassignedShiftInstanceIds).toEqual([]);
    expect(mapped.reopenedSubmissionCount).toBe(1);
  });

  it('maps a preview_template_cancellation() row', () => {
    const mapped = mapTemplateCancellationPreviewRow({
      shift_instance_id: 's1',
      date: '2024-01-01',
      shift_type_id: 'st1',
      shift_key: 'dinner',
      name: 'Dinner',
      is_published: false,
      assignment_count: 0,
      has_availability_answers: false,
      has_attendance: false,
      is_safe_to_cancel: true,
    });
    expect(mapped.isSafeToCancel).toBe(true);
    expect(mapped.isPublished).toBe(false);
  });

  it('maps apply_template_cancellation()', () => {
    const mapped = mapApplyTemplateCancellationResult({
      cancelled_count: 2,
      cancelled_shift_instance_ids: ['s1', 's2'],
    });
    expect(mapped).toEqual({ cancelledCount: 2, cancelledShiftInstanceIds: ['s1', 's2'] });
  });
});
