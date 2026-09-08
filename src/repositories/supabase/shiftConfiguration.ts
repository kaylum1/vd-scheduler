import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { ShiftConfigurationRepository } from '../types';
import type { ShiftInstanceRecord, ShiftTemplateRecord, ShiftTypeRecord } from '../domain';
import { unwrap } from '../errors';
import { mapShiftInstance, mapShiftTemplate, mapShiftType } from './mappers';

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
}
