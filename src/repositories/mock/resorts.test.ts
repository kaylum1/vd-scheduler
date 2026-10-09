import { beforeEach, describe, expect, it } from 'vitest';
import { MockResortRepository } from './resorts';
import { RepositoryError } from '../errors';
import { mockDrivers, mockResorts, mockShiftTypes, resetMockFixturesForTesting } from './fixtures';

describe('MockResortRepository: listResorts / getResortById', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockResortRepository();

  it('lists every resort, active and inactive alike', async () => {
    const resorts = await repo.listResorts();
    expect(resorts.map((r) => r.slug).sort()).toEqual(['crans-montana', 'verbier', 'zermatt']);
  });

  it('getResortById resolves a real resort', async () => {
    const resort = await repo.getResortById('mock-crans');
    expect(resort?.name).toBe('Crans-Montana');
  });

  it('REGRESSION: returns genuinely new objects, not the live fixture rows -- a caller mutating the result must never affect mockResorts, and a TanStack Query consumer must see a changed reference after a later deactivate/reactivate', async () => {
    const resorts = await repo.listResorts();
    const verbier = resorts.find((r) => r.slug === 'verbier')!;
    verbier.isActive = false; // mutate the RETURNED object, not the fixture
    expect(mockResorts.find((r) => r.id === 'mock-verbier')?.isActive).toBe(true); // fixture itself untouched

    const one = await repo.getResortById('mock-verbier');
    const two = await repo.getResortById('mock-verbier');
    expect(one).not.toBe(two); // distinct object identity per call, even with identical content
  });
});

describe('MockResortRepository: createResort (Stage 2D Checkpoint 4.1)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockResortRepository();

  it('creates an active resort defaulting to the Europe/Zurich timezone, with an auto-generated slug', async () => {
    const { resortId, slug } = await repo.createResort('Val Thorens');
    expect(slug).toBe('val-thorens');
    const resort = await repo.getResortById(resortId);
    expect(resort).toMatchObject({ name: 'Val Thorens', timezone: 'Europe/Zurich', isActive: true });
  });

  it('never asks for or accepts an internal id/slug/timezone -- createResort takes only a name', async () => {
    // Structural: the method signature itself is (name: string) -- this
    // just documents/pins the contract rather than testing new behaviour.
    const result = await repo.createResort('Test Resort');
    expect(Object.keys(result).sort()).toEqual(['resortId', 'slug']);
  });

  it('a duplicate/conflicting name is disambiguated, never rejected', async () => {
    const first = await repo.createResort('Crans-Montana');
    const second = await repo.createResort('Crans-Montana');
    expect(first.slug).toBe('crans-montana-2'); // "crans-montana" itself is already taken by the baseline fixture
    expect(second.slug).toBe('crans-montana-3');
    expect(first.resortId).not.toBe(second.resortId);
  });

  it('rejects a blank name', async () => {
    await expect(repo.createResort('   ')).rejects.toMatchObject({ code: '23514' });
  });
});

describe('MockResortRepository: deactivateResort / reactivateResort (Stage 2D Checkpoint 4.1)', () => {
  beforeEach(resetMockFixturesForTesting);
  const repo = new MockResortRepository();

  it('deactivates an unused/safe resort (Verbier has no drivers/shifts in the baseline fixture)', async () => {
    await repo.deactivateResort('mock-verbier');
    const resort = await repo.getResortById('mock-verbier');
    expect(resort?.isActive).toBe(false);
  });

  it('deactivation preserves the same resort row -- same id, still resolvable', async () => {
    await repo.deactivateResort('mock-verbier');
    const resort = await repo.getResortById('mock-verbier');
    expect(resort?.id).toBe('mock-verbier');
    expect(resort?.slug).toBe('verbier'); // unchanged
  });

  it('is blocked by an active driver at the resort, and names it', async () => {
    await expect(repo.deactivateResort('mock-crans')).rejects.toMatchObject({ code: '55006' });
    await expect(repo.deactivateResort('mock-crans')).rejects.toThrow(/active driver/i);
    // Not silently deactivated, not mutated:
    expect((await repo.getResortById('mock-crans'))?.isActive).toBe(true);
  });

  it('is blocked by an active shift at the resort, and names it', async () => {
    // mock-crans's driver (Gianni) is active in the baseline fixture, and
    // so is its shift type -- deactivate the driver first to isolate the
    // shift-type block specifically.
    const gianni = mockDrivers.find((d) => d.id === 'mock-gianni')!;
    gianni.isActive = false;
    await expect(repo.deactivateResort('mock-crans')).rejects.toMatchObject({ code: '55006' });
    await expect(repo.deactivateResort('mock-crans')).rejects.toThrow(/active shift/i);
    expect(mockShiftTypes.find((t) => t.id === 'mock-crans-dinner')?.isActive).toBe(true); // never silently deactivated
  });

  it('reactivation preserves the same resort id -- never a replacement resort', async () => {
    await repo.deactivateResort('mock-verbier');
    const { resortId } = await repo.reactivateResort('mock-verbier');
    expect(resortId).toBe('mock-verbier');
    const resort = await repo.getResortById('mock-verbier');
    expect(resort).toMatchObject({ id: 'mock-verbier', slug: 'verbier', isActive: true });
  });

  it('rejects reactivating a resort that is not actually inactive', async () => {
    await expect(repo.reactivateResort('mock-verbier')).rejects.toMatchObject({ code: 'P0002' });
  });

  it('rejects deactivating a resort that is already inactive', async () => {
    await repo.deactivateResort('mock-verbier');
    await expect(repo.deactivateResort('mock-verbier')).rejects.toMatchObject({ code: 'P0002' });
  });
});
