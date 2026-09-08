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

describe('MockDriverRepository: Stage 2D Checkpoint 1.1 (language + Onfleet)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockDriverRepository();

  it('LANG 1: a new driver defaults to en when no language is given', async () => {
    const created = await repo.createDriver({ resortId: 'mock-crans', fullName: 'No Language Given' });
    expect(created.preferredLanguage).toBe('en');
  });

  it('LANG 2: a driver can be created with fr', async () => {
    const created = await repo.createDriver({ resortId: 'mock-crans', fullName: 'French Speaker', preferredLanguage: 'fr' });
    expect(created.preferredLanguage).toBe('fr');
  });

  it('LANG 3: a driver\'s language can be changed en -> fr', async () => {
    expect((await repo.getDriverById('mock-gianni'))?.preferredLanguage).toBe('en');
    const updated = await repo.updateDriverLanguage('mock-gianni', 'fr');
    expect(updated.preferredLanguage).toBe('fr');
  });

  it('LANG 4: an unsupported language is rejected on create and on update', async () => {
    await expect(repo.createDriver({ resortId: 'mock-crans', fullName: 'X', preferredLanguage: 'de' })).rejects.toBeInstanceOf(
      RepositoryError
    );
    await expect(repo.updateDriverLanguage('mock-gianni', 'de')).rejects.toBeInstanceOf(RepositoryError);
  });

  it('LANG 5: the language is preserved across a fresh read (simulated reload)', async () => {
    await repo.updateDriverLanguage('mock-gianni', 'fr');
    const reread = await repo.getDriverById('mock-gianni');
    expect(reread?.preferredLanguage).toBe('fr');
  });

  it('listSupportedLanguages returns en and fr', async () => {
    const languages = await repo.listSupportedLanguages();
    expect(languages.map((l) => l.code).sort()).toEqual(['en', 'fr']);
  });

  it('ONFLEET 6: driver creation works without any Onfleet mapping', async () => {
    const created = await repo.createDriver({ resortId: 'mock-verbier', fullName: 'No Onfleet Yet' });
    const mappings = await repo.listActiveOnfleetMappings([created.id]);
    expect(mappings.size).toBe(0);
  });

  it('ONFLEET 7: an exact Onfleet worker name can be added', async () => {
    const mapping = await repo.setOnfleetMapping('mock-alex', 'Alex Dupont');
    expect(mapping).toMatchObject({ driverId: 'mock-alex', onfleetWorkerId: 'Alex Dupont', isActive: true });
  });

  it('ONFLEET 8: a linked driver appears in listActiveOnfleetMappings', async () => {
    const mappings = await repo.listActiveOnfleetMappings();
    expect(mappings.get('mock-gianni')).toMatchObject({ onfleetWorkerId: 'Gianni Rossi' });
  });

  it('ONFLEET 9: an unmapped driver is absent from listActiveOnfleetMappings', async () => {
    const mappings = await repo.listActiveOnfleetMappings(['mock-alex']);
    expect(mappings.has('mock-alex')).toBe(false);
  });

  it('ONFLEET 10: replacing a mapping deactivates the old one and activates exactly one new one', async () => {
    const replaced = await repo.setOnfleetMapping('mock-gianni', 'Gianni Rossi Jr');
    expect(replaced.onfleetWorkerId).toBe('Gianni Rossi Jr');

    const active = await repo.listActiveOnfleetMappings(['mock-gianni']);
    expect(active.get('mock-gianni')?.onfleetWorkerId).toBe('Gianni Rossi Jr');

    // The old identity is retained as inactive history, not overwritten.
    const { mockDriverOnfleetMappings } = await import('./fixtures');
    const historical = mockDriverOnfleetMappings.filter((m) => m.driverId === 'mock-gianni');
    expect(historical).toHaveLength(2);
    expect(historical.find((m) => m.onfleetWorkerId === 'Gianni Rossi')?.isActive).toBe(false);
  });

  it('ONFLEET 12a: the same Onfleet identity cannot be actively claimed by two drivers at the same resort', async () => {
    // Gianni (mock-crans) already has "Gianni Rossi" active; try to give it
    // to a different Crans driver.
    const other = await repo.createDriver({ resortId: 'mock-crans', fullName: 'Rival Driver' });
    await expect(repo.setOnfleetMapping(other.id, 'Gianni Rossi')).rejects.toBeInstanceOf(RepositoryError);
  });

  it('ONFLEET 12b: a blank Onfleet worker name is rejected cleanly', async () => {
    await expect(repo.setOnfleetMapping('mock-alex', '   ')).rejects.toBeInstanceOf(RepositoryError);
  });
});
