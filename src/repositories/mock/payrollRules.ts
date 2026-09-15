import type { PayrollRulesRepository } from '../types';
import type { DriverDeliveryRateRecord, ShiftBasePayRuleRecord } from '../domain';
import { RepositoryError } from '../errors';
import { mockDriverDeliveryRates, mockDrivers, mockShiftBasePayRules, mockShiftTypes, nextMockDriverDeliveryRateId, nextMockShiftBasePayRuleId } from './fixtures';

/** Same simplification as shiftConfiguration.ts's own todayIso() -- plain UTC "today", not resort-timezone-aware; acceptable for mock/demo use. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addIsoDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export class MockPayrollRulesRepository implements PayrollRulesRepository {
  async listShiftBasePayRules(resortId: string): Promise<ShiftBasePayRuleRecord[]> {
    return mockShiftBasePayRules.filter((r) => r.resortId === resortId).map((r) => ({ ...r }));
  }

  async setShiftBasePayRate(
    shiftTypeId: string,
    resortId: string,
    basePayChf: number,
    effectiveFrom?: string
  ): Promise<ShiftBasePayRuleRecord> {
    const operation = 'payrollRules.setShiftBasePayRate';
    if (basePayChf == null || basePayChf < 0) {
      throw new RepositoryError('Base pay cannot be negative.', { operation, code: '23514' });
    }
    const shiftType = mockShiftTypes.find((t) => t.id === shiftTypeId && t.resortId === resortId);
    if (!shiftType) {
      throw new RepositoryError('That Shift does not belong to this resort.', { operation, code: '23503' });
    }

    const today = todayIso();
    const resolvedFrom = effectiveFrom ?? today;
    // At most one open-ended (effectiveTo === null) row per shift_type_id --
    // mirrors the real table's own exclusion constraint (see fixtures.ts).
    const open = mockShiftBasePayRules.find((r) => r.shiftTypeId === shiftTypeId && r.resortId === resortId && r.effectiveTo === null);

    if (!open) {
      const created: ShiftBasePayRuleRecord = {
        id: nextMockShiftBasePayRuleId(),
        resortId,
        shiftTypeId,
        basePayChf,
        effectiveFrom: resolvedFrom,
        effectiveTo: null,
      };
      mockShiftBasePayRules.push(created);
      return created;
    }

    if (open.effectiveFrom > today) {
      // Still a future/not-yet-started plan -- safe to replace in place.
      open.basePayChf = basePayChf;
      open.effectiveFrom = resolvedFrom;
      return { ...open };
    }

    if (resolvedFrom <= open.effectiveFrom) {
      throw new RepositoryError('A new base-pay rate cannot start before the currently active rate already took effect.', {
        operation,
        code: '23514',
      });
    }

    open.effectiveTo = addIsoDays(resolvedFrom, -1);
    const created: ShiftBasePayRuleRecord = {
      id: nextMockShiftBasePayRuleId(),
      resortId,
      shiftTypeId,
      basePayChf,
      effectiveFrom: resolvedFrom,
      effectiveTo: null,
    };
    mockShiftBasePayRules.push(created);
    return created;
  }

  async listDriverDeliveryRates(resortId: string): Promise<DriverDeliveryRateRecord[]> {
    return mockDriverDeliveryRates.filter((r) => r.resortId === resortId).map((r) => ({ ...r }));
  }

  async setDriverDeliveryRate(driverId: string, rateChf: number, effectiveFrom?: string): Promise<DriverDeliveryRateRecord> {
    const operation = 'payrollRules.setDriverDeliveryRate';
    if (rateChf == null || rateChf < 0) {
      throw new RepositoryError('Delivery rate cannot be negative.', { operation, code: '23514' });
    }
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) {
      throw new RepositoryError('Driver not found.', { operation, code: 'P0002' });
    }

    const today = todayIso();
    const resolvedFrom = effectiveFrom ?? today;
    const open = mockDriverDeliveryRates.find((r) => r.driverId === driverId && r.effectiveTo === null);

    if (!open) {
      const created: DriverDeliveryRateRecord = {
        id: nextMockDriverDeliveryRateId(),
        resortId: driver.resortId,
        driverId,
        rateChf,
        effectiveFrom: resolvedFrom,
        effectiveTo: null,
      };
      mockDriverDeliveryRates.push(created);
      return created;
    }

    if (open.effectiveFrom > today) {
      open.rateChf = rateChf;
      open.effectiveFrom = resolvedFrom;
      return { ...open };
    }

    if (resolvedFrom <= open.effectiveFrom) {
      throw new RepositoryError('A new delivery rate cannot start before the currently active rate already took effect.', {
        operation,
        code: '23514',
      });
    }

    open.effectiveTo = addIsoDays(resolvedFrom, -1);
    const created: DriverDeliveryRateRecord = {
      id: nextMockDriverDeliveryRateId(),
      resortId: driver.resortId,
      driverId,
      rateChf,
      effectiveFrom: resolvedFrom,
      effectiveTo: null,
    };
    mockDriverDeliveryRates.push(created);
    return created;
  }
}
