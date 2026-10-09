import type { ResortRepository } from '../types';
import type { ResortRecord } from '../domain';
import { RepositoryError } from '../errors';
import { mockDrivers, mockResorts, mockShiftTypes, nextMockResortId } from './fixtures';

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'resort';
}

/** Mirrors create_resort's own server-side slug generation (auto-suffix on collision) closely enough for mock/demo use -- never asks the manager for a slug, never rejects a duplicate name. */
function generateMockResortSlug(name: string): string {
  const base = slugify(name);
  const existing = new Set(mockResorts.map((r) => r.slug));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export class MockResortRepository implements ResortRepository {
  async listResorts(): Promise<ResortRecord[]> {
    // Shallow copies of each element, not the live fixture objects --
    // deactivateResort/reactivateResort mutate mockResorts entries in
    // place (see below), and a consumer relying on TanStack Query's
    // structural sharing needs genuinely new objects to detect a change
    // between fetches (see the identical note on
    // MockShiftConfigurationRepository.listShiftTypes/MockDriverRepository.
    // listDrivers) -- `[...mockResorts]` alone only copies the array
    // container, not its elements, which silently defeats that.
    return mockResorts.map((r) => ({ ...r }));
  }

  async getResortById(resortId: string): Promise<ResortRecord | null> {
    const resort = mockResorts.find((r) => r.id === resortId);
    return resort ? { ...resort } : null;
  }

  async createResort(name: string): Promise<{ resortId: string; slug: string }> {
    if (!name.trim()) {
      throw new RepositoryError('A resort needs a name.', { operation: 'resorts.create', code: '23514' });
    }
    const slug = generateMockResortSlug(name);
    const resortId = nextMockResortId();
    // timezone/isActive mirror create_resort's own defaults (Europe/Zurich, active) -- never asked of the caller.
    mockResorts.push({ id: resortId, slug, name: name.trim(), timezone: 'Europe/Zurich', isActive: true });
    return { resortId, slug };
  }

  async deactivateResort(resortId: string): Promise<{ resortId: string }> {
    const resort = mockResorts.find((r) => r.id === resortId && r.isActive);
    if (!resort) {
      throw new RepositoryError('Resort not found or already inactive.', { operation: 'resorts.deactivate', code: 'P0002' });
    }
    // Mirrors deactivate_resort's own dependency checks -- never cascades,
    // never silently deactivates/moves the dependents itself.
    const reasons: string[] = [];
    const activeDrivers = mockDrivers.filter((d) => d.resortId === resortId && d.isActive).length;
    if (activeDrivers > 0) reasons.push(`${activeDrivers} active driver${activeDrivers === 1 ? '' : 's'}`);
    const activeShifts = mockShiftTypes.filter((t) => t.resortId === resortId && t.isActive).length;
    if (activeShifts > 0) reasons.push(`${activeShifts} active shift${activeShifts === 1 ? '' : 's'}`);
    // Upcoming generated shift instances / published weeks are Supabase-
    // only concerns (mock mode has no materialisation/publication data at
    // all -- see MockShiftConfigurationRepository) so there is nothing
    // further to check here; a real deployment's deactivate_resort RPC
    // checks both.
    if (reasons.length > 0) {
      throw new RepositoryError(`This resort still has ${reasons.join(', ')}. Retire these first, then try again.`, {
        operation: 'resorts.deactivate',
        code: '55006',
      });
    }
    resort.isActive = false;
    return { resortId };
  }

  async reactivateResort(resortId: string): Promise<{ resortId: string }> {
    const resort = mockResorts.find((r) => r.id === resortId && !r.isActive);
    if (!resort) {
      throw new RepositoryError('Resort not found or already active.', { operation: 'resorts.reactivate', code: 'P0002' });
    }
    resort.isActive = true;
    return { resortId };
  }
}
