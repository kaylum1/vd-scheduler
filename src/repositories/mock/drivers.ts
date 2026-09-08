import type { DriverRepository } from '../types';
import type { DriverOnfleetMappingRecord, DriverRecord, SupportedLanguageRecord } from '../domain';
import { RepositoryError } from '../errors';
import {
  mockDriverIdsWithLogin,
  mockDriverOnfleetMappings,
  mockDrivers,
  mockSupportedLanguages,
  nextMockDriverId,
  nextMockOnfleetMappingId,
} from './fixtures';

const DEFAULT_LANGUAGE = 'en';

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

  async createDriver(input: { resortId: string; fullName: string; preferredLanguage?: string }): Promise<DriverRecord> {
    // Mirrors drivers.preferred_language's NOT NULL DEFAULT 'en' plus its FK
    // to supported_languages: an unsupported code is rejected here exactly
    // as the real database would reject it.
    const preferredLanguage = input.preferredLanguage ?? DEFAULT_LANGUAGE;
    if (!mockSupportedLanguages.some((l) => l.code === preferredLanguage)) {
      throw new RepositoryError(`unsupported language "${preferredLanguage}"`, {
        operation: 'drivers.create',
        code: '23503',
      });
    }
    const record: DriverRecord = {
      id: nextMockDriverId(),
      resortId: input.resortId,
      fullName: input.fullName,
      isActive: true,
      preferredLanguage,
    };
    mockDrivers.push(record);
    return { ...record };
  }

  async updateDriverName(driverId: string, fullName: string): Promise<DriverRecord> {
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) {
      throw new RepositoryError(`driver ${driverId} not found`, { operation: 'drivers.updateName' });
    }
    driver.fullName = fullName;
    return { ...driver };
  }

  async updateDriverLanguage(driverId: string, preferredLanguage: string): Promise<DriverRecord> {
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) {
      throw new RepositoryError(`driver ${driverId} not found`, { operation: 'drivers.updateLanguage' });
    }
    if (!mockSupportedLanguages.some((l) => l.code === preferredLanguage)) {
      throw new RepositoryError(`unsupported language "${preferredLanguage}"`, {
        operation: 'drivers.updateLanguage',
        code: '23503',
      });
    }
    driver.preferredLanguage = preferredLanguage;
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

  async listSupportedLanguages(): Promise<SupportedLanguageRecord[]> {
    return mockSupportedLanguages.map((l) => ({ ...l }));
  }

  async listActiveOnfleetMappings(driverIds?: string[]): Promise<Map<string, DriverOnfleetMappingRecord>> {
    const mappings = mockDriverOnfleetMappings.filter(
      (m) => m.isActive && (!driverIds || driverIds.includes(m.driverId))
    );
    return new Map(mappings.map((m) => [m.driverId, { ...m }]));
  }

  async setOnfleetMapping(driverId: string, onfleetWorkerId: string): Promise<DriverOnfleetMappingRecord> {
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) {
      throw new RepositoryError(`driver ${driverId} not found`, { operation: 'drivers.setOnfleetMapping' });
    }
    const trimmed = onfleetWorkerId.trim();
    if (!trimmed) {
      throw new RepositoryError('onfleet worker name/id must not be blank', {
        operation: 'drivers.setOnfleetMapping',
        code: '23514',
      });
    }
    // Mirrors driver_onfleet_mappings_active_identity_unique: the same
    // identity can't be actively claimed by a different driver at once.
    const claimedByOther = mockDriverOnfleetMappings.some(
      (m) => m.isActive && m.driverId !== driverId && m.resortId === driver.resortId && m.onfleetWorkerId === trimmed
    );
    if (claimedByOther) {
      throw new RepositoryError(`"${trimmed}" is already linked to another driver at this resort`, {
        operation: 'drivers.setOnfleetMapping',
        code: '23505',
      });
    }

    // Mirrors set_driver_onfleet_mapping(): deactivate whatever was active
    // for this driver, then create the new one — old identity retained as
    // inactive history, never overwritten in place.
    for (const m of mockDriverOnfleetMappings) {
      if (m.driverId === driverId && m.isActive) m.isActive = false;
    }
    const record: DriverOnfleetMappingRecord = {
      id: nextMockOnfleetMappingId(),
      driverId,
      resortId: driver.resortId,
      onfleetWorkerId: trimmed,
      isActive: true,
    };
    mockDriverOnfleetMappings.push(record);
    return { ...record };
  }
}
