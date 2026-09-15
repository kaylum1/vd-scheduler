import { beforeEach, describe, expect, it } from 'vitest';
import { MockPayrollRulesRepository } from './payrollRules';
import { RepositoryError } from '../errors';
import { mockDriverDeliveryRates, mockShiftBasePayRules, mockShiftTypes, nextMockShiftTypeId, resetMockFixturesForTesting } from './fixtures';

function futureIso(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

describe('MockPayrollRulesRepository: shift base pay (Stage 2D Payroll Checkpoint B)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockPayrollRulesRepository();

  it('lists the baseline configured rate for a resort', async () => {
    const rules = await repo.listShiftBasePayRules('mock-crans');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ shiftTypeId: 'mock-crans-dinner', basePayChf: 30, effectiveTo: null });
  });

  it('a shift with no rule at all lists as empty (never a fabricated CHF 0)', async () => {
    const rules = await repo.listShiftBasePayRules('mock-verbier');
    expect(rules).toEqual([]);
  });

  it('scheduling a genuine future change creates a new row and closes the old one -- never rewrites it', async () => {
    const from = futureIso(10);
    const result = await repo.setShiftBasePayRate('mock-crans-dinner', 'mock-crans', 35, from);
    expect(result).toMatchObject({ basePayChf: 35, effectiveFrom: from, effectiveTo: null });

    const rules = await repo.listShiftBasePayRules('mock-crans');
    expect(rules).toHaveLength(2);
    const original = rules.find((r) => r.id === 'mock-base-pay-crans-dinner')!;
    expect(original.basePayChf).toBe(30); // never rewritten
    expect(original.effectiveTo).not.toBeNull();
  });

  it('returns genuinely new objects, not the live fixture rows', async () => {
    const rules = await repo.listShiftBasePayRules('mock-crans');
    rules[0].basePayChf = 999;
    expect(mockShiftBasePayRules.find((r) => r.id === 'mock-base-pay-crans-dinner')?.basePayChf).toBe(30);
  });

  it('rejects a negative amount', async () => {
    await expect(repo.setShiftBasePayRate('mock-crans-dinner', 'mock-crans', -5)).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a Shift belonging to a different resort', async () => {
    await expect(repo.setShiftBasePayRate('mock-zermatt-dinner', 'mock-crans', 40)).rejects.toMatchObject({ code: '23503' });
  });

  it('backdating on/before the already-in-effect rate\'s own start is rejected', async () => {
    await expect(repo.setShiftBasePayRate('mock-crans-dinner', 'mock-crans', 99, '2020-01-01')).rejects.toMatchObject({ code: '23514' });
  });

  it('REGRESSION: a rate set today is preserved (never discarded) when a genuine future change is scheduled the same day', async () => {
    // A genuinely fresh Shift with no rate configured at all, so "today's
    // rate" below is unambiguously the first-ever row.
    const shiftTypeId = nextMockShiftTypeId();
    mockShiftTypes.push({ id: shiftTypeId, resortId: 'mock-crans', key: 'today_test', name: 'Today Test', sortOrder: 99, isActive: true });

    const today = new Date().toISOString().slice(0, 10);
    const todayResult = await repo.setShiftBasePayRate(shiftTypeId, 'mock-crans', 30); // no explicit date -- defaults to today
    expect(todayResult.effectiveFrom).toBe(today);

    const from = futureIso(20);
    await repo.setShiftBasePayRate(shiftTypeId, 'mock-crans', 35, from);

    const rules = (await repo.listShiftBasePayRules('mock-crans')).filter((r) => r.shiftTypeId === shiftTypeId);
    expect(rules).toHaveLength(2);
    const todaysRule = rules.find((r) => r.id === todayResult.id)!;
    expect(todaysRule.basePayChf).toBe(30); // preserved, not discarded
    expect(todaysRule.effectiveTo).not.toBeNull(); // closed the day before the future change
  });

  it('correcting a not-yet-real scheduled future change updates it in place, no redundant row', async () => {
    const from1 = futureIso(10);
    await repo.setShiftBasePayRate('mock-crans-dinner', 'mock-crans', 35, from1);
    const before = (await repo.listShiftBasePayRules('mock-crans')).length;

    const from2 = futureIso(20);
    const result = await repo.setShiftBasePayRate('mock-crans-dinner', 'mock-crans', 36, from2);
    const after = (await repo.listShiftBasePayRules('mock-crans')).length;

    expect(after).toBe(before); // no new row
    expect(result).toMatchObject({ basePayChf: 36, effectiveFrom: from2 });
  });
});

describe('MockPayrollRulesRepository: driver delivery rates (Stage 2D Payroll Checkpoint B)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockPayrollRulesRepository();

  it('lists the baseline configured rates for a resort, across multiple drivers', async () => {
    const rules = await repo.listDriverDeliveryRates('mock-crans');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ driverId: 'mock-gianni', rateChf: 12 });
  });

  it('a driver with no rule at all is simply absent from the list (never a fabricated CHF 12)', async () => {
    const rules = await repo.listDriverDeliveryRates('mock-zermatt');
    expect(rules.find((r) => r.driverId === 'mock-tomas')).toBeUndefined();
  });

  it('different drivers have independently different rates', async () => {
    await repo.setDriverDeliveryRate('mock-tomas', 14);
    const rules = await repo.listDriverDeliveryRates('mock-zermatt');
    expect(rules.find((r) => r.driverId === 'mock-alex')?.rateChf).toBe(12);
    expect(rules.find((r) => r.driverId === 'mock-tomas')?.rateChf).toBe(14);
  });

  it('editing one driver\'s rate never affects another driver\'s rate', async () => {
    const from = futureIso(10);
    await repo.setDriverDeliveryRate('mock-alex', 20, from);
    const rules = await repo.listDriverDeliveryRates('mock-zermatt');
    // Tomas still has no rule at all -- Alex's change didn't create one for him.
    expect(rules.find((r) => r.driverId === 'mock-tomas')).toBeUndefined();
  });

  it('resolves resort_id from the driver, never client-supplied', async () => {
    const result = await repo.setDriverDeliveryRate('mock-tomas', 12);
    expect(result.resortId).toBe('mock-zermatt'); // Tomas's true resort
  });

  it('scheduling a future change preserves history and creates a new row', async () => {
    const from = futureIso(10);
    await repo.setDriverDeliveryRate('mock-gianni', 14, from);
    const rules = await repo.listDriverDeliveryRates('mock-crans');
    expect(rules).toHaveLength(2);
    const original = rules.find((r) => r.id === 'mock-rate-gianni')!;
    expect(original.rateChf).toBe(12);
    expect(original.effectiveTo).not.toBeNull();
  });

  it('rejects a negative rate', async () => {
    await expect(repo.setDriverDeliveryRate('mock-gianni', -1)).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an unknown driver', async () => {
    await expect(repo.setDriverDeliveryRate('mock-nonexistent', 12)).rejects.toMatchObject({ code: 'P0002' });
  });

  it('rejects backdating on/before an already-in-effect rate\'s own start', async () => {
    await expect(repo.setDriverDeliveryRate('mock-gianni', 99, '2020-01-01')).rejects.toMatchObject({ code: '23514' });
  });

  it('returns genuinely new objects, not the live fixture rows', async () => {
    const rules = await repo.listDriverDeliveryRates('mock-crans');
    rules[0].rateChf = 999;
    expect(mockDriverDeliveryRates.find((r) => r.id === 'mock-rate-gianni')?.rateChf).toBe(12);
  });
});
