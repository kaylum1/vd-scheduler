import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { ShiftConfigurationRepository } from '../types';
import type {
  ApplyTemplateCancellationResult,
  ApplyTemplateRefreshResult,
  MaterialiseShiftsResult,
  ShiftInstanceRecord,
  ShiftTemplateRecord,
  ShiftTypeRecord,
  TemplateCancellationPreviewRow,
  TemplateRefreshPreviewRow,
} from '../domain';
import { unwrap } from '../errors';
import {
  mapApplyTemplateCancellationResult,
  mapApplyTemplateRefreshResult,
  mapMaterialiseShiftsResult,
  mapShiftInstance,
  mapShiftTemplate,
  mapShiftType,
  mapTemplateCancellationPreviewRow,
  mapTemplateRefreshPreviewRow,
} from './mappers';

export class SupabaseShiftConfigurationRepository implements ShiftConfigurationRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async listShiftTypes(resortId: string): Promise<ShiftTypeRecord[]> {
    const rows = await unwrap(
      'shiftConfiguration.listShiftTypes',
      this.client.from('shift_types').select('*').eq('resort_id', resortId).order('sort_order', { ascending: true })
    );
    return rows.map(mapShiftType);
  }

  async listShiftTemplates(shiftTypeId: string): Promise<ShiftTemplateRecord[]> {
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

  async createShiftType(input: {
    resortId: string;
    key: string;
    name: string;
    sortOrder: number;
  }): Promise<ShiftTypeRecord> {
    const rows = await unwrap(
      'shiftConfiguration.createShiftType',
      this.client
        .from('shift_types')
        .insert({ resort_id: input.resortId, key: input.key, name: input.name, sort_order: input.sortOrder })
        .select('*')
    );
    return mapShiftType(rows[0]);
  }

  async renameShiftType(shiftTypeId: string, name: string): Promise<ShiftTypeRecord> {
    const rows = await unwrap(
      'shiftConfiguration.renameShiftType',
      this.client.from('shift_types').update({ name }).eq('id', shiftTypeId).select('*')
    );
    return mapShiftType(rows[0]);
  }

  async deactivateShiftType(shiftTypeId: string): Promise<ShiftTypeRecord> {
    const rows = await unwrap(
      'shiftConfiguration.deactivateShiftType',
      this.client.from('shift_types').update({ is_active: false }).eq('id', shiftTypeId).select('*')
    );
    return mapShiftType(rows[0]);
  }

  async createShiftTemplateVersion(input: {
    shiftTypeId: string;
    resortId: string;
    weekday: number;
    startTime: string;
    endTime: string;
    requiredDrivers: number;
    basePayChf: number;
    deliveryRateChf: number;
    isPremium: boolean;
    effectiveFrom: string;
  }): Promise<ShiftTemplateRecord> {
    const rows = await unwrap(
      'shiftConfiguration.createShiftTemplateVersion',
      this.client
        .from('shift_templates')
        .insert({
          shift_type_id: input.shiftTypeId,
          resort_id: input.resortId,
          weekday: input.weekday,
          start_time: input.startTime,
          end_time: input.endTime,
          required_drivers: input.requiredDrivers,
          base_pay_chf: input.basePayChf,
          delivery_rate_chf: input.deliveryRateChf,
          is_premium: input.isPremium,
          effective_from: input.effectiveFrom,
        })
        .select('*')
    );
    return mapShiftTemplate(rows[0]);
  }

  async deactivateShiftTemplate(templateId: string, effectiveTo: string): Promise<ShiftTemplateRecord> {
    const rows = await unwrap(
      'shiftConfiguration.deactivateShiftTemplate',
      this.client
        .from('shift_templates')
        .update({ effective_to: effectiveTo, is_active: false })
        .eq('id', templateId)
        .select('*')
    );
    return mapShiftTemplate(rows[0]);
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
