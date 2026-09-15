import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { ShiftConfigurationRepository, ShiftScheduleInput } from '../types';
import { assembleShifts } from '../assembleShift';
import type {
  ApplyTemplateCancellationResult,
  ApplyTemplateRefreshResult,
  MaterialiseShiftsResult,
  ShiftInstanceRecord,
  ShiftRecord,
  ShiftTemplateRecord,
  ShiftTypeRecord,
  TemplateCancellationPreviewRow,
  TemplateRefreshPreviewRow,
} from '../domain';
import { unwrap } from '../errors';
import {
  mapApplyTemplateCancellationResult,
  mapApplyTemplateRefreshResult,
  mapCreateShiftResult,
  mapMaterialiseShiftsResult,
  mapShiftInstance,
  mapShiftMutationResult,
  mapShiftTemplate,
  mapShiftType,
  mapTemplateCancellationPreviewRow,
  mapTemplateRefreshPreviewRow,
} from './mappers';

export class SupabaseShiftConfigurationRepository implements ShiftConfigurationRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  // Internal detail methods (not part of the public ShiftConfigurationRepository
  // contract as of Stage 2D Checkpoint 4 -- Shift Setup and every other
  // manager-facing consumer works through listShifts/createShift/reviseShift/
  // deactivateShift/reactivateShift instead) used only to assemble listShifts.
  private async listShiftTypes(resortId: string): Promise<ShiftTypeRecord[]> {
    const rows = await unwrap(
      'shiftConfiguration.listShiftTypes',
      this.client.from('shift_types').select('*').eq('resort_id', resortId).order('sort_order', { ascending: true })
    );
    return rows.map(mapShiftType);
  }

  private async listShiftTemplates(shiftTypeId: string): Promise<ShiftTemplateRecord[]> {
    const rows = await unwrap(
      'shiftConfiguration.listShiftTemplates',
      this.client
        .from('shift_templates')
        .select('*')
        .eq('shift_type_id', shiftTypeId)
        .order('weekday', { ascending: true })
        .order('effective_from', { ascending: true })
    );
    return rows.map(mapShiftTemplate);
  }

  async listShifts(resortId: string): Promise<ShiftRecord[]> {
    const shiftTypes = await this.listShiftTypes(resortId);
    const templatesByType = new Map<string, ShiftTemplateRecord[]>(
      await Promise.all(shiftTypes.map(async (t): Promise<[string, ShiftTemplateRecord[]]> => [t.id, await this.listShiftTemplates(t.id)]))
    );
    return assembleShifts(shiftTypes, templatesByType);
  }

  async listShiftInstances(params: { resortId: string; weekStart: string }): Promise<ShiftInstanceRecord[]> {
    const rows = await unwrap(
      'shiftConfiguration.listShiftInstances',
      this.client
        .from('shift_instances')
        .select('*')
        .eq('resort_id', params.resortId)
        .eq('week_start', params.weekStart)
        .order('date', { ascending: true })
        .order('sort_order', { ascending: true })
    );
    return rows.map(mapShiftInstance);
  }

  async createShift(resortId: string, input: ShiftScheduleInput): Promise<{ shiftTypeId: string }> {
    const rows = await unwrap(
      'shiftConfiguration.createShift',
      this.client.rpc('create_shift', {
        p_resort_id: resortId,
        p_name: input.name,
        p_start_time: input.startTime,
        p_end_time: input.endTime,
        p_weekdays: input.weekdays,
        p_required_drivers: input.requiredDrivers,
        p_effective_from: input.effectiveFrom,
        p_effective_to: input.effectiveTo,
      })
    );
    return mapCreateShiftResult(rows[0]);
  }

  async reviseShift(shiftTypeId: string, resortId: string, input: ShiftScheduleInput): Promise<{ shiftTypeId: string }> {
    const rows = await unwrap(
      'shiftConfiguration.reviseShift',
      this.client.rpc('revise_shift', {
        p_shift_type_id: shiftTypeId,
        p_resort_id: resortId,
        p_name: input.name,
        p_start_time: input.startTime,
        p_end_time: input.endTime,
        p_weekdays: input.weekdays,
        p_required_drivers: input.requiredDrivers,
        p_effective_from: input.effectiveFrom,
        p_effective_to: input.effectiveTo,
      })
    );
    return mapShiftMutationResult(rows[0]);
  }

  async deactivateShift(shiftTypeId: string, resortId: string, effectiveTo?: string): Promise<{ shiftTypeId: string }> {
    const rows = await unwrap(
      'shiftConfiguration.deactivateShift',
      this.client.rpc('deactivate_shift', { p_shift_type_id: shiftTypeId, p_resort_id: resortId, p_effective_to: effectiveTo })
    );
    return mapShiftMutationResult(rows[0]);
  }

  async reactivateShift(shiftTypeId: string, resortId: string, input: ShiftScheduleInput): Promise<{ shiftTypeId: string }> {
    const rows = await unwrap(
      'shiftConfiguration.reactivateShift',
      this.client.rpc('reactivate_shift', {
        p_shift_type_id: shiftTypeId,
        p_resort_id: resortId,
        p_start_time: input.startTime,
        p_end_time: input.endTime,
        p_weekdays: input.weekdays,
        p_required_drivers: input.requiredDrivers,
        p_effective_from: input.effectiveFrom,
        p_effective_to: input.effectiveTo,
      })
    );
    return mapShiftMutationResult(rows[0]);
  }

  async materialiseShifts(resortId: string, fromDate?: string, toDate?: string): Promise<MaterialiseShiftsResult> {
    const rows = await unwrap(
      'shiftConfiguration.materialiseShifts',
      this.client.rpc('materialise_shift_instances', { p_resort_id: resortId, p_from_date: fromDate, p_to_date: toDate })
    );
    return mapMaterialiseShiftsResult(rows[0]);
  }

  async previewTemplateRefresh(resortId: string, fromDate?: string): Promise<TemplateRefreshPreviewRow[]> {
    const rows = await unwrap(
      'shiftConfiguration.previewTemplateRefresh',
      this.client.rpc('preview_template_refresh', { p_resort_id: resortId, p_from_date: fromDate })
    );
    return rows.map(mapTemplateRefreshPreviewRow);
  }

  async applyTemplateRefresh(resortId: string, fromDate?: string): Promise<ApplyTemplateRefreshResult> {
    const rows = await unwrap(
      'shiftConfiguration.applyTemplateRefresh',
      this.client.rpc('apply_template_refresh', { p_resort_id: resortId, p_from_date: fromDate })
    );
    return mapApplyTemplateRefreshResult(rows[0]);
  }

  async previewTemplateCancellation(resortId: string, shiftTypeId?: string): Promise<TemplateCancellationPreviewRow[]> {
    const rows = await unwrap(
      'shiftConfiguration.previewTemplateCancellation',
      this.client.rpc('preview_template_cancellation', { p_resort_id: resortId, p_shift_type_id: shiftTypeId })
    );
    return rows.map(mapTemplateCancellationPreviewRow);
  }

  async applyTemplateCancellation(
    resortId: string,
    shiftTypeId?: string,
    reason?: string
  ): Promise<ApplyTemplateCancellationResult> {
    const rows = await unwrap(
      'shiftConfiguration.applyTemplateCancellation',
      this.client.rpc('apply_template_cancellation', { p_resort_id: resortId, p_shift_type_id: shiftTypeId, p_reason: reason })
    );
    return mapApplyTemplateCancellationResult(rows[0]);
  }
}
