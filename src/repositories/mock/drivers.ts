import type { DriverRepository } from '../types';
import type { DriverRecord } from '../domain';
import { RepositoryError } from '../errors';
import { mockDrivers, nextMockDriverId } from './fixtures';

export class MockDriverRepository implements DriverRepository {
  async listDrivers(params?: { resortId?: string }): Promise<DriverRecord[]> {
    if (params?.resortId) {
      return mockDrivers.filter((d) => d.resortId === params.resortId);
    }
    return [...mockDrivers];
  }

  async getDriverById(driverId: string): Promise<DriverRecord | null> {
    return mockDrivers.find((d) => d.id === driverId) ?? null;
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
    return driver;
  }

  async deactivateDriver(driverId: string): Promise<DriverRecord> {
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) {
      throw new RepositoryError(`driver ${driverId} not found`, { operation: 'drivers.deactivate' });
    }
    driver.isActive = false;
    return driver;
  }
}
