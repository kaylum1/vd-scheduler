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

describe('MockShiftConfigurationRepository: Stage 2D Checkpoint 1 (live Configuration)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockShiftConfigurationRepository();

  it('listShiftTypes is scoped per resort — a Zermatt type never appears under Crans', async () => {
    const cransTypes = await repo.listShiftTypes('mock-crans');
    expect(cransTypes.map((t) => t.id)).toEqual(['mock-crans-dinner']);
    expect(cransTypes.some((t) => t.id === 'mock-zermatt-dinner')).toBe(false);
  });

  it('createShiftType creates an active shift type with the given key/name/sortOrder', async () => {
    const created = await repo.createShiftType({ resortId: 'mock-crans', key: 'lunch', name: 'Lunch', sortOrder: 2 });
    expect(created).toMatchObject({ resortId: 'mock-crans', key: 'lunch', name: 'Lunch', sortOrder: 2, isActive: true });
  });

  it('createShiftType rejects a duplicate key at the same resort (mirrors shift_types_resort_key_unique)', async () => {
    await expect(repo.createShiftType({ resortId: 'mock-crans', key: 'dinner', name: 'Dinner Again', sortOrder: 3 })).rejects.toMatchObject(
      { code: '23505' }
    );
  });

  it('the same key is fine at a different resort', async () => {
    const created = await repo.createShiftType({ resortId: 'mock-verbier', key: 'dinner', name: 'Dinner', sortOrder: 1 });
    expect(created.resortId).toBe('mock-verbier');
  });

  it('renameShiftType changes the display name but never the stable key', async () => {
    const renamed = await repo.renameShiftType('mock-crans-dinner', 'Dinner Service');
    expect(renamed.name).toBe('Dinner Service');
    expect(renamed.key).toBe('dinner');
  });

  it('reorderShiftType updates sortOrder only', async () => {
    const reordered = await repo.reorderShiftType('mock-crans-dinner', 5);
    expect(reordered.sortOrder).toBe(5);
    expect(reordered.key).toBe('dinner');
    expect(reordered.name).toBe('Dinner');
  });

  it('deactivateShiftType is blocked while an active recurring template still references it', async () => {
    await expect(repo.deactivateShiftType('mock-crans-dinner')).rejects.toMatchObject({ code: '55006' });
    const stillActive = (await repo.listShiftTypes('mock-crans')).find((t) => t.id === 'mock-crans-dinner');
    expect(stillActive?.isActive).toBe(true);
  });

  it('deactivateShiftType succeeds once its templates are no longer active', async () => {
    await repo.deactivateShiftTemplate('mock-crans-dinner-tpl', '2024-06-01');
    const deactivated = await repo.deactivateShiftType('mock-crans-dinner');
    expect(deactivated.isActive).toBe(false);
  });
});

describe('MockShiftConfigurationRepository: Stage 2D Checkpoint 2 (recurring schedule)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockShiftConfigurationRepository();

  it('createShiftTemplateVersion accepts an optional effectiveTo (open-ended when omitted)', async () => {
    const openEnded = await repo.createShiftTemplateVersion({
      shiftTypeId: 'mock-crans-dinner',
      resortId: 'mock-crans',
      weekday: 5, // Saturday -- Monday (0) is already taken by the baseline fixture
      startTime: '12:00',
      endTime: '14:30',
      requiredDrivers: 1,
      basePayChf: 30,
      deliveryRateChf: 12,
      effectiveFrom: '2026-01-01',
      isPremium: false,
    });
    expect(openEnded.effectiveTo).toBeNull();

    const bounded = await repo.createShiftTemplateVersion({
      shiftTypeId: 'mock-crans-dinner',
      resortId: 'mock-crans',
      weekday: 6, // Sunday
      startTime: '12:00',
      endTime: '14:30',
      requiredDrivers: 1,
      basePayChf: 30,
      deliveryRateChf: 12,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-03-01',
      isPremium: false,
    });
    expect(bounded.effectiveTo).toBe('2026-03-01');
  });

  it('rejects a second active template for the same weekday with overlapping dates (mirrors shift_templates_no_overlap)', async () => {
    // mock-crans-dinner-tpl already covers Monday (weekday 0) from 2024-01-01, open-ended.
    await expect(
      repo.createShiftTemplateVersion({
        shiftTypeId: 'mock-crans-dinner',
        resortId: 'mock-crans',
        weekday: 0,
        startTime: '19:00',
        endTime: '22:00',
        requiredDrivers: 2,
        basePayChf: 30,
        deliveryRateChf: 12,
        effectiveFrom: '2026-06-01',
        isPremium: false,
      })
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('allows a non-overlapping revision: deactivate the old version, then create a new one starting after it ends', async () => {
    await repo.deactivateShiftTemplate('mock-crans-dinner-tpl', '2026-05-31');
    const revised = await repo.createShiftTemplateVersion({
      shiftTypeId: 'mock-crans-dinner',
      resortId: 'mock-crans',
      weekday: 0,
      startTime: '18:30',
      endTime: '21:30',
      requiredDrivers: 1,
      basePayChf: 30,
      deliveryRateChf: 12,
      effectiveFrom: '2026-06-01',
      isPremium: false,
    });
    expect(revised.startTime).toBe('18:30');

    const active = (await repo.listShiftTemplates('mock-crans-dinner')).filter((t) => t.isActive && t.weekday === 0);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(revised.id);
  });

  it('a template for a different weekday never conflicts, even with an identical date range', async () => {
    const created = await repo.createShiftTemplateVersion({
      shiftTypeId: 'mock-crans-dinner',
      resortId: 'mock-crans',
      weekday: 1, // Tuesday -- distinct from the baseline Monday fixture
      startTime: '18:00',
      endTime: '21:30',
      requiredDrivers: 1,
      basePayChf: 30,
      deliveryRateChf: 12,
      effectiveFrom: '2024-01-01',
      isPremium: false,
    });
    expect(created.weekday).toBe(1);
  });
});
