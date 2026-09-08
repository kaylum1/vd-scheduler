import { beforeEach, describe, expect, it } from 'vitest';
import { MockDriverRepository } from './drivers';
import { mockDriverIdsWithLogin, resetMockFixturesForTesting } from './fixtures';
import { RepositoryError } from '../errors';

describe('MockDriverRepository: Stage 2D Checkpoint 1', () => {
  beforeEach(resetMockFixturesForTesting);

  const repo = new MockDriverRepository();

  it('listDrivers with no filter returns every driver', async () => {
    const drivers = await repo.listDrivers();
    expect(drivers).toHaveLength(3);
  });

  it('listDrivers({ resortId }) narrows to that resort only', async () => {
    const drivers = await repo.listDrivers({ resortId: 'mock-zermatt' });
    expect(drivers.map((d) => d.fullName).sort()).toEqual(['Alex', 'Tomas']);
  });

  it('createDriver adds a new, active driver assigned to exactly the given resort', async () => {
    const created = await repo.createDriver({ resortId: 'mock-verbier', fullName: 'New Driver' });
    expect(created.resortId).toBe('mock-verbier');
    expect(created.isActive).toBe(true);
    expect(await repo.listDrivers({ resortId: 'mock-verbier' })).toHaveLength(1);
  });

  it('updateDriverName changes only the name — there is no way to change resortId through this interface', async () => {
    const updated = await repo.updateDriverName('mock-gianni', 'Gianni Renamed');
    expect(updated.fullName).toBe('Gianni Renamed');
    expect(updated.resortId).toBe('mock-crans');
  });

  it('deactivateDriver sets isActive=false rather than removing the record', async () => {
    const deactivated = await repo.deactivateDriver('mock-tomas');
    expect(deactivated.isActive).toBe(false);
  });

  it('a deactivated driver is still retrievable via listDrivers (historical-safe, not hard-deleted)', async () => {
    await repo.deactivateDriver('mock-tomas');
    const all = await repo.listDrivers({ resortId: 'mock-zermatt' });
    const tomas = all.find((d) => d.id === 'mock-tomas');
    expect(tomas).toBeDefined();
    expect(tomas?.isActive).toBe(false);
  });

  it('deactivateDriver on an unknown id throws a RepositoryError', async () => {
    await expect(repo.deactivateDriver('does-not-exist')).rejects.toBeInstanceOf(RepositoryError);
  });

  it('listDriverIdsWithLogin() with no args returns every linked driver id', async () => {
    const linked = await repo.listDriverIdsWithLogin();
    expect(linked).toEqual(new Set(mockDriverIdsWithLogin));
    expect(linked.has('mock-gianni')).toBe(true);
    expect(linked.has('mock-alex')).toBe(true);
    expect(linked.has('mock-tomas')).toBe(false); // driver-only fixture, no login
  });

  it('listDriverIdsWithLogin(ids) filters to just the requested ids', async () => {
    const linked = await repo.listDriverIdsWithLogin(['mock-tomas', 'mock-alex']);
    expect(linked).toEqual(new Set(['mock-alex']));
  });
});
