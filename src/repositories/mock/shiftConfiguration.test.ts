import { beforeEach, describe, expect, it } from 'vitest';
import { MockShiftConfigurationRepository } from './shiftConfiguration';
import { RepositoryError } from '../errors';
import { resetMockFixturesForTesting } from './fixtures';

describe('MockShiftConfigurationRepository: Stage 2C manager operations', () => {
  const repo = new MockShiftConfigurationRepository();

  it('materialiseShifts throws a clear RepositoryError rather than faking DB logic', async () => {
    await expect(repo.materialiseShifts('r1')).rejects.toBeInstanceOf(RepositoryError);
    await expect(repo.materialiseShifts('r1')).rejects.toThrow(/not supported in mock mode/i);
  });

  it('previewTemplateRefresh / applyTemplateRefresh throw the same way', async () => {
    await expect(repo.previewTemplateRefresh('r1')).rejects.toThrow(/not supported in mock mode/i);
    await expect(repo.applyTemplateRefresh('r1')).rejects.toThrow(/not supported in mock mode/i);
  });

  it('previewTemplateCancellation / applyTemplateCancellation throw the same way', async () => {
    await expect(repo.previewTemplateCancellation('r1')).rejects.toThrow(/not supported in mock mode/i);
    await expect(repo.applyTemplateCancellation('r1')).rejects.toThrow(/not supported in mock mode/i);
  });
});

// =======================================================================
// Stage 2D Checkpoint 4: the simplified manager "Shift" -- listShifts and
// the four atomic create/revise/deactivate/reactivate operations. Replaces
// the Checkpoint 1/2 per-shift-type and per-template-version tests, which
// exercised UI/repository methods removed in this checkpoint
// (createShiftType/renameShiftType/reorderShiftType/deactivateShiftType/
// createShiftTemplateVersion/deactivateShiftTemplate).
// =======================================================================
describe('MockShiftConfigurationRepository: listShifts (Stage 2D Checkpoint 4)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockShiftConfigurationRepository();

  it('assembles the baseline fixture into one Shift with a consistent schedule', async () => {
    const shifts = await repo.listShifts('mock-crans');
    expect(shifts).toHaveLength(1);
    expect(shifts[0]).toMatchObject({
      shiftTypeId: 'mock-crans-dinner',
      name: 'Dinner',
      isActive: true,
      schedule: { startTime: '18:00', endTime: '21:30', weekdays: [0], effectiveFrom: '2024-01-01', effectiveTo: null },
    });
  });

  it('is scoped per resort — a Zermatt shift never appears under Crans', async () => {
    const cransShifts = await repo.listShifts('mock-crans');
    expect(cransShifts.some((s) => s.shiftTypeId === 'mock-zermatt-dinner')).toBe(false);
  });
});

describe('MockShiftConfigurationRepository: createShift (Stage 2D Checkpoint 4)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockShiftConfigurationRepository();

  it('creates one Shift with every requested weekday, atomically (from the caller\'s point of view)', async () => {
    const { shiftTypeId } = await repo.createShift('mock-crans', {
      name: 'Lunch',
      startTime: '12:00',
      endTime: '14:30',
      weekdays: [5, 6],
      requiredDrivers: 1,
      effectiveFrom: '2026-01-01',
    });
    const shifts = await repo.listShifts('mock-crans');
    const lunch = shifts.find((s) => s.shiftTypeId === shiftTypeId);
    expect(lunch?.schedule).toMatchObject({ startTime: '12:00', endTime: '14:30', weekdays: [5, 6], requiredDrivers: 1 });
  });

  it('generates the internal key from the name without ever asking the caller for one, and disambiguates a collision', async () => {
    const first = await repo.createShift('mock-verbier', { name: 'Dinner', startTime: '18:00', endTime: '21:00', weekdays: [0], requiredDrivers: 1 });
    const second = await repo.createShift('mock-verbier', { name: 'Dinner', startTime: '19:00', endTime: '22:00', weekdays: [1], requiredDrivers: 1 });
    expect(first.shiftTypeId).not.toBe(second.shiftTypeId);
    // Both succeed -- no manager-facing "key already used" rejection, unlike the old per-shift-type UI.
  });

  it('rejects an empty weekday selection', async () => {
    await expect(
      repo.createShift('mock-crans', { name: 'Breakfast', startTime: '08:00', endTime: '09:00', weekdays: [], requiredDrivers: 1 })
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects a blank name', async () => {
    await expect(
      repo.createShift('mock-crans', { name: '  ', startTime: '08:00', endTime: '09:00', weekdays: [0], requiredDrivers: 1 })
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects end time not after start time', async () => {
    await expect(
      repo.createShift('mock-crans', { name: 'Breakfast', startTime: '09:00', endTime: '08:00', weekdays: [0], requiredDrivers: 1 })
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('requires required_drivers (Stage 2D staffing simplification): 0 is rejected', async () => {
    await expect(
      repo.createShift('mock-crans', { name: 'Breakfast', startTime: '08:00', endTime: '09:00', weekdays: [0], requiredDrivers: 0 })
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('stores the required staffing count on the assembled Shift, never pay/high-value (still not part of ShiftScheduleInput at all)', async () => {
    const { shiftTypeId } = await repo.createShift('mock-crans', {
      name: 'Breakfast',
      startTime: '08:00',
      endTime: '09:00',
      weekdays: [0],
      requiredDrivers: 2,
    });
    const shift = (await repo.listShifts('mock-crans')).find((s) => s.shiftTypeId === shiftTypeId);
    expect(shift?.schedule?.requiredDrivers).toBe(2);
    expect(shift?.schedule).not.toHaveProperty('basePayChf');
    expect(shift?.schedule).not.toHaveProperty('isPremium');
  });
});

describe('MockShiftConfigurationRepository: reviseShift (Stage 2D Checkpoint 4)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockShiftConfigurationRepository();

  it('renames, retimes, and changes the weekday set in one call', async () => {
    await repo.reviseShift('mock-crans-dinner', 'mock-crans', {
      name: 'Dinner Service',
      startTime: '18:30',
      endTime: '22:00',
      weekdays: [0, 5, 6],
      requiredDrivers: 2,
      effectiveFrom: '2026-06-01',
    });
    const shift = (await repo.listShifts('mock-crans')).find((s) => s.shiftTypeId === 'mock-crans-dinner');
    expect(shift).toMatchObject({
      name: 'Dinner Service',
      schedule: { startTime: '18:30', endTime: '22:00', weekdays: [0, 5, 6], effectiveFrom: '2026-06-01', requiredDrivers: 2 },
    });
  });

  it('changing the required staffing count is supported through the same versioned revision', async () => {
    await repo.reviseShift('mock-crans-dinner', 'mock-crans', {
      name: 'Dinner',
      startTime: '18:00',
      endTime: '21:30',
      weekdays: [0],
      requiredDrivers: 3,
      effectiveFrom: '2026-06-01',
    });
    const shift = (await repo.listShifts('mock-crans')).find((s) => s.shiftTypeId === 'mock-crans-dinner');
    expect(shift?.schedule?.requiredDrivers).toBe(3);
  });

  it('rejects revising an inactive shift (must be reactivated first)', async () => {
    await repo.deactivateShift('mock-crans-dinner', 'mock-crans', '2026-01-01');
    await expect(
      repo.reviseShift('mock-crans-dinner', 'mock-crans', { name: 'Dinner', startTime: '18:00', endTime: '21:00', weekdays: [0], requiredDrivers: 2 })
    ).rejects.toMatchObject({ code: '55006' });
  });

  it('rejects an empty weekday selection', async () => {
    await expect(
      repo.reviseShift('mock-crans-dinner', 'mock-crans', { name: 'Dinner', startTime: '18:00', endTime: '21:00', weekdays: [], requiredDrivers: 2 })
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects required_drivers = 0', async () => {
    await expect(
      repo.reviseShift('mock-crans-dinner', 'mock-crans', { name: 'Dinner', startTime: '18:00', endTime: '21:00', weekdays: [0], requiredDrivers: 0 })
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('MockShiftConfigurationRepository: deactivateShift / reactivateShift (Stage 2D Checkpoint 4)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockShiftConfigurationRepository();

  it('deactivateShift marks the Shift inactive without deleting it', async () => {
    await repo.deactivateShift('mock-crans-dinner', 'mock-crans', '2026-01-01');
    const shifts = await repo.listShifts('mock-crans');
    const dinner = shifts.find((s) => s.shiftTypeId === 'mock-crans-dinner');
    expect(dinner?.isActive).toBe(false);
    expect(dinner).toBeTruthy(); // still present, not removed from the list
  });

  it('reactivateShift brings it back under the same shiftTypeId, with a fresh schedule', async () => {
    await repo.deactivateShift('mock-crans-dinner', 'mock-crans', '2026-01-01');
    await repo.reactivateShift('mock-crans-dinner', 'mock-crans', {
      name: 'Dinner',
      startTime: '19:00',
      endTime: '22:00',
      weekdays: [2, 3],
      requiredDrivers: 1,
      effectiveFrom: '2026-06-01',
    });
    const shift = (await repo.listShifts('mock-crans')).find((s) => s.shiftTypeId === 'mock-crans-dinner');
    expect(shift).toMatchObject({
      isActive: true,
      schedule: { startTime: '19:00', endTime: '22:00', weekdays: [2, 3], effectiveFrom: '2026-06-01', requiredDrivers: 1 },
    });
  });

  it('REGRESSION (found via manual Stage 2D Checkpoint 4 testing): a weekday retired by an earlier reviseShift is not dragged into the "last known schedule" just because it coincidentally shares its effectiveTo date with a later deactivateShift', async () => {
    // Reproduces the exact bug: add Saturday, then a later revision drops
    // Monday effective 2026-02-01 (retiring Monday's row with
    // effectiveTo=2026-02-01), then the shift is deactivated with that
    // SAME date. Grouping "last known schedule" by effectiveTo alone would
    // incorrectly pull Monday's long-retired row back in, since it happens
    // to share that date -- updatedAt (a distinct transaction/call each
    // time) is what correctly tells the two retirement events apart.
    await repo.reviseShift('mock-crans-dinner', 'mock-crans', { name: 'Dinner', startTime: '18:00', endTime: '21:30', weekdays: [0, 5], requiredDrivers: 2, effectiveFrom: '2026-01-01' });
    await repo.reviseShift('mock-crans-dinner', 'mock-crans', { name: 'Dinner', startTime: '18:00', endTime: '21:30', weekdays: [5], requiredDrivers: 2, effectiveFrom: '2026-02-01' });
    await repo.deactivateShift('mock-crans-dinner', 'mock-crans', '2026-02-01');

    const shift = (await repo.listShifts('mock-crans')).find((s) => s.shiftTypeId === 'mock-crans-dinner');
    expect(shift?.schedule).toMatchObject({ weekdays: [5] }); // Saturday only -- never [0, 5]
  });

  it('reactivateShift rejects a shift that is already active', async () => {
    await expect(
      repo.reactivateShift('mock-crans-dinner', 'mock-crans', { name: 'Dinner', startTime: '18:00', endTime: '21:00', weekdays: [0], requiredDrivers: 2 })
    ).rejects.toMatchObject({ code: '23514' });
  });
});
