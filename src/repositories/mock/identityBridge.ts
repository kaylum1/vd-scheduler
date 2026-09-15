/**
 * Mock-mode-only bridge from the Stage 1.1 driver switcher's id space
 * (`mock-data/drivers.ts`, e.g. "gianni") to the repository-layer mock
 * fixtures' id space (`repositories/mock/fixtures.ts`'s `mockDrivers`, e.g.
 * "mock-gianni") that the repository layer actually expects.
 *
 * These are two deliberately separate datasets (see fixtures.ts's own doc
 * comment: kept in sync only by sharing the same demo driver/resort NAMES,
 * "Gianni/Crans, Alex+Tomas/Zermatt, an empty Verbier" -- Stage 1.1's own
 * pages, e.g. MyRota.tsx, still read `useAuth().currentUser.driverId`
 * expecting the Stage 1.1 id, so `AuthContext` itself cannot switch that
 * value over to the repository id space without breaking them. A live page
 * built against the repository layer (e.g. driver Availability -- Stage 3)
 * needs the *other* id space instead -- this bridge is exactly that
 * translation, used only by such pages, in mock mode only.
 *
 * Supabase mode never needs this: `resolveCurrentUser()` already resolves
 * `driverId`/`resortId` as real database ids, which is what the repository
 * layer expects directly.
 */
import { driverById } from '../../mock-data/drivers';
import { mockDrivers } from './fixtures';

export function resolveMockDriverIdentity(stage1DriverId: string): { driverId: string; resortId: string } {
  const stage1Driver = driverById(stage1DriverId);
  const repoDriver = mockDrivers.find((d) => d.fullName === stage1Driver?.name);
  return { driverId: repoDriver?.id ?? stage1DriverId, resortId: repoDriver?.resortId ?? '' };
}
