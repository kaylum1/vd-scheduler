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
