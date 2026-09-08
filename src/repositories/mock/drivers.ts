import type { DriverRepository } from '../types';
import type { DriverRecord } from '../domain';
import { RepositoryError } from '../errors';
import { mockDriverIdsWithLogin, mockDrivers, nextMockDriverId } from './fixtures';

export class MockDriverRepository implements DriverRepository {
  async listDrivers(params?: { resortId?: string }): Promise<DriverRecord[]> {
    // Shallow-copy each row rather than returning the live fixture objects.
    // update/deactivate mutate mockDrivers entries in place; a consumer
    // using TanStack Query relies on structural sharing to detect a change
    // between one fetch and the next, which requires genuinely distinct
    // objects — returning the same mutable references defeats that (a
    // background refetch would compare a mutated object against itself and
    // see "no change"), exactly like a real API response never hands back
    // the same JS object twice.
    const drivers = params?.resortId ? mockDrivers.filter((d) => d.resortId === params.resortId) : mockDrivers;
    return drivers.map((d) => ({ ...d }));
  }

  async getDriverById(driverId: string): Promise<DriverRecord | null> {
    const driver = mockDrivers.find((d) => d.id === driverId);
    return driver ? { ...driver } : null;
  }

  async createDriver(input: { resortId: string; fullName: string }): Promise<DriverRecord> {
    const record: DriverRecord = { id: nextMockDriverId(), resortId: input.resortId, fullName: input.fullName, isActive: true };
    mockDrivers.push(record);
    return record;
  }

  async updateDriverName(driverId: string, fullName: string): Promise<DriverRecord> {
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) {
      throw new RepositoryError(`driver ${driverId} not found`, { operation: 'drivers.updateName' });
    }
    driver.fullName = fullName;
    return { ...driver };
  }

  async deactivateDriver(driverId: string): Promise<DriverRecord> {
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) {
      throw new RepositoryError(`driver ${driverId} not found`, { operation: 'drivers.deactivate' });
    }
    driver.isActive = false;
    return { ...driver };
  }

  async listDriverIdsWithLogin(driverIds?: string[]): Promise<Set<string>> {
    if (!driverIds) return new Set(mockDriverIdsWithLogin);
    return new Set(driverIds.filter((id) => mockDriverIdsWithLogin.has(id)));
  }
}
