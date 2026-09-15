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

describe('MockPayrollRulesRepository: rate corrections (Stage 2D Payroll Checkpoint B.1)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockPayrollRulesRepository();

  it('corrects an already-real current shift base rate in place -- same row, dates preserved, no new row', async () => {
    const result = await repo.correctShiftBasePayRate('mock-crans-dinner', 'mock-crans', 'mock-base-pay-crans-dinner', 32);
    expect(result).toMatchObject({ id: 'mock-base-pay-crans-dinner', basePayChf: 32, effectiveFrom: '2024-01-01', effectiveTo: null });
    expect(await repo.listShiftBasePayRules('mock-crans')).toHaveLength(1);
  });

  it('corrects an already-real current driver rate in place', async () => {
    const result = await repo.correctDriverDeliveryRate('mock-gianni', 'mock-rate-gianni', 13);
    expect(result).toMatchObject({ id: 'mock-rate-gianni', rateChf: 13, effectiveFrom: '2024-01-01', effectiveTo: null });
    expect(await repo.listDriverDeliveryRates('mock-crans')).toHaveLength(1);
  });

  it('corrects a rate set effective today, same day -- the key product requirement', async () => {
    const set = await repo.setShiftBasePayRate('mock-zermatt-dinner', 'mock-zermatt', 13);
    const corrected = await repo.correctShiftBasePayRate('mock-zermatt-dinner', 'mock-zermatt', set.id, 12);
    expect(corrected).toMatchObject({ id: set.id, basePayChf: 12, effectiveFrom: set.effectiveFrom });
  });

  it('corrects a scheduled future rate before it takes effect, without touching the current rate', async () => {
    const scheduled = await repo.setShiftBasePayRate('mock-crans-dinner', 'mock-crans', 35, futureIso(30));
    const corrected = await repo.correctShiftBasePayRate('mock-crans-dinner', 'mock-crans', scheduled.id, 40);
    expect(corrected).toMatchObject({ id: scheduled.id, basePayChf: 40, effectiveFrom: scheduled.effectiveFrom });

    const current = (await repo.listShiftBasePayRules('mock-crans')).find((r) => r.id === 'mock-base-pay-crans-dinner')!;
    expect(current.basePayChf).toBe(30); // untouched
    expect(await repo.listShiftBasePayRules('mock-crans')).toHaveLength(2); // no unnecessary third row
  });

  it('rejects correcting an already-closed historical period', async () => {
    // Close the baseline row by scheduling a genuine future change.
    await repo.setShiftBasePayRate('mock-crans-dinner', 'mock-crans', 35, futureIso(30));
    await expect(repo.correctShiftBasePayRate('mock-crans-dinner', 'mock-crans', 'mock-base-pay-crans-dinner', 99)).rejects.toMatchObject({
      code: '55006',
    });
  });

  it('rejects a negative corrected amount', async () => {
    await expect(repo.correctShiftBasePayRate('mock-crans-dinner', 'mock-crans', 'mock-base-pay-crans-dinner', -1)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(repo.correctDriverDeliveryRate('mock-gianni', 'mock-rate-gianni', -1)).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an unknown rule id', async () => {
    await expect(repo.correctShiftBasePayRate('mock-crans-dinner', 'mock-crans', 'mock-nonexistent-rule', 30)).rejects.toMatchObject({
      code: 'P0002',
    });
    await expect(repo.correctDriverDeliveryRate('mock-gianni', 'mock-nonexistent-rule', 12)).rejects.toMatchObject({ code: 'P0002' });
  });

  it('never creates a new row -- correction is always an in-place amount update', async () => {
    const before = mockShiftBasePayRules.length;
    await repo.correctShiftBasePayRate('mock-crans-dinner', 'mock-crans', 'mock-base-pay-crans-dinner', 31);
    expect(mockShiftBasePayRules.length).toBe(before);
  });
});
