import type { RotaRepository } from '../types';
import type { DriverVisibleAssignment } from '../domain';

/**
 * No published-rota concept exists in the mock fixtures yet (Stage 1.1's
 * own mock data models "published" per-shift-instance, which this
 * repository layer deliberately does not copy — see mock/fixtures.ts).
 * Returns an empty list until that's needed by a real page conversion.
 */
export class MockRotaRepository implements RotaRepository {
  async listDriverVisibleAssignments(_driverId: string): Promise<DriverVisibleAssignment[]> {
    return [];
  }
}
