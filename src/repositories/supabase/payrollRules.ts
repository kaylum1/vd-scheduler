import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import type { PayrollRulesRepository } from '../types';
import type { DriverDeliveryRateRecord, ShiftBasePayRuleRecord } from '../domain';
import { unwrap } from '../errors';
import {
  mapCorrectDriverDeliveryRateResult,
  mapCorrectShiftBasePayRateResult,
  mapDriverDeliveryRate,
  mapSetDriverDeliveryRateResult,
  mapSetShiftBasePayRateResult,
  mapShiftBasePayRule,
} from './mappers';

export class SupabasePayrollRulesRepository implements PayrollRulesRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async listShiftBasePayRules(resortId: string): Promise<ShiftBasePayRuleRecord[]> {
    const rows = await unwrap(
      'payrollRules.listShiftBasePayRules',
      this.client.from('shift_base_pay_rules').select('*').eq('resort_id', resortId).order('effective_from', { ascending: true })
    );
    return rows.map(mapShiftBasePayRule);
  }

  async setShiftBasePayRate(
    shiftTypeId: string,
    resortId: string,
    basePayChf: number,
    effectiveFrom?: string
  ): Promise<ShiftBasePayRuleRecord> {
    const rows = await unwrap(
      'payrollRules.setShiftBasePayRate',
      this.client.rpc('set_shift_base_pay_rate', {
        p_resort_id: resortId,
        p_shift_type_id: shiftTypeId,
        p_base_pay_chf: basePayChf,
        p_effective_from: effectiveFrom,
      })
    );
    return mapSetShiftBasePayRateResult(rows[0]);
  }

  async listDriverDeliveryRates(resortId: string): Promise<DriverDeliveryRateRecord[]> {
    const rows = await unwrap(
      'payrollRules.listDriverDeliveryRates',
      this.client.from('driver_delivery_rates').select('*').eq('resort_id', resortId).order('effective_from', { ascending: true })
    );
    return rows.map(mapDriverDeliveryRate);
  }

  async setDriverDeliveryRate(driverId: string, rateChf: number, effectiveFrom?: string): Promise<DriverDeliveryRateRecord> {
    const rows = await unwrap(
      'payrollRules.setDriverDeliveryRate',
      this.client.rpc('set_driver_delivery_rate', {
        p_driver_id: driverId,
        p_rate_chf: rateChf,
        p_effective_from: effectiveFrom,
      })
    );
    return mapSetDriverDeliveryRateResult(rows[0]);
  }

  async correctShiftBasePayRate(
    shiftTypeId: string,
    resortId: string,
    ruleId: string,
    newBasePayChf: number
  ): Promise<ShiftBasePayRuleRecord> {
    const rows = await unwrap(
      'payrollRules.correctShiftBasePayRate',
      this.client.rpc('correct_shift_base_pay_rate', {
        p_resort_id: resortId,
        p_shift_type_id: shiftTypeId,
        p_rule_id: ruleId,
        p_new_base_pay_chf: newBasePayChf,
      })
    );
    return mapCorrectShiftBasePayRateResult(rows[0]);
  }

  async correctDriverDeliveryRate(driverId: string, ruleId: string, newRateChf: number): Promise<DriverDeliveryRateRecord> {
    const rows = await unwrap(
      'payrollRules.correctDriverDeliveryRate',
      this.client.rpc('correct_driver_delivery_rate', {
        p_driver_id: driverId,
        p_rule_id: ruleId,
        p_new_rate_chf: newRateChf,
      })
    );
    return mapCorrectDriverDeliveryRateResult(rows[0]);
  }
}
