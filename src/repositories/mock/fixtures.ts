/**
 * Small, self-contained fixture dataset for the repository-layer mock
 * implementations. Deliberately independent from `src/mock-data/*` (the
 * Stage 1.1 UI's own mock data, which stays untouched and keeps powering
 * the existing pages directly) — this is a separate, forward-looking
 * dataset that exists only to prove the repository interfaces work end to
 * end with `VITE_DATA_PROVIDER=mock`, using the same familiar demo
 * narrative (Gianni/Crans, Alex+Tomas/Zermatt, an empty Verbier) for
 * continuity, but shaped like real database rows (see repositories/domain).
 *
 * In-memory only; mutations reset on page reload.
 */

import type {
  AvailabilityAnswer,
  DriverOnfleetMappingRecord,
  DriverRecord,
  ResortRecord,
  ShiftTemplateRecord,
  ShiftTypeRecord,
  SupportedLanguageRecord,
} from '../domain';

export const mockResorts: ResortRecord[] = [
  { id: 'mock-crans', slug: 'crans-montana', name: 'Crans-Montana', timezone: 'Europe/Zurich', isActive: true },
  { id: 'mock-zermatt', slug: 'zermatt', name: 'Zermatt', timezone: 'Europe/Zurich', isActive: true },
  { id: 'mock-verbier', slug: 'verbier', name: 'Verbier', timezone: 'Europe/Zurich', isActive: true },
];

export const mockDrivers: DriverRecord[] = [
  { id: 'mock-gianni', resortId: 'mock-crans', fullName: 'Gianni', isActive: true, preferredLanguage: 'en' },
  { id: 'mock-alex', resortId: 'mock-zermatt', fullName: 'Alex', isActive: true, preferredLanguage: 'fr' },
  { id: 'mock-tomas', resortId: 'mock-zermatt', fullName: 'Tomas', isActive: true, preferredLanguage: 'en' },
];

/**
 * Driver IDs with a linked login (mirrors app_users.driver_id in the real
 * schema), for the Configuration "Login linked" / "No login" badge — see
 * DriverRepository.listDriverIdsWithLogin. Gianni and Alex have logins,
 * Tomas doesn't, matching scripts/seed-local-test-users.mjs's local Supabase
 * fixtures so both providers tell the same demo story.
 */
export const mockDriverIdsWithLogin = new Set<string>(['mock-gianni', 'mock-alex']);

/** Mirrors supported_languages — the reference list Configuration's language picker reads from. */
export const mockSupportedLanguages: SupportedLanguageRecord[] = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'French' },
];

/**
 * Mirrors driver_onfleet_mappings — Gianni has an active mapping, Alex and
 * Tomas don't, giving the Configuration "Onfleet linked"/"not linked" badge
 * both cases in mock mode too.
 */
export const mockDriverOnfleetMappings: DriverOnfleetMappingRecord[] = [
  { id: 'mock-onfleet-gianni', driverId: 'mock-gianni', resortId: 'mock-crans', onfleetWorkerId: 'Gianni Rossi', isActive: true },
];

export const mockShiftTypes: ShiftTypeRecord[] = [
  { id: 'mock-crans-dinner', resortId: 'mock-crans', key: 'dinner', name: 'Dinner', sortOrder: 1, isActive: true },
  { id: 'mock-zermatt-dinner', resortId: 'mock-zermatt', key: 'dinner', name: 'Dinner', sortOrder: 1, isActive: true },
];

export const mockShiftTemplates: ShiftTemplateRecord[] = [
  {
    id: 'mock-crans-dinner-tpl',
    resortId: 'mock-crans',
    shiftTypeId: 'mock-crans-dinner',
    weekday: 0,
    startTime: '18:00',
    endTime: '21:30',
    requiredDrivers: 2,
    basePayChf: 80,
    deliveryRateChf: 4.5,
    isPremium: false,
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
    isActive: true,
  },
  {
    id: 'mock-zermatt-dinner-tpl',
    resortId: 'mock-zermatt',
    shiftTypeId: 'mock-zermatt-dinner',
    weekday: 0,
    startTime: '18:00',
    endTime: '21:30',
    requiredDrivers: 2,
    basePayChf: 80,
    deliveryRateChf: 4.5,
    isPremium: false,
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
    isActive: true,
  },
];

/** In-memory availability answers, mutated by setAvailability(). */
export const mockAvailability: AvailabilityAnswer[] = [];

let mockAvailabilitySeq = 0;
export function nextMockAvailabilityId(): string {
  mockAvailabilitySeq += 1;
  return `mock-availability-${mockAvailabilitySeq}`;
}

let mockDriverSeq = 0;
export function nextMockDriverId(): string {
  mockDriverSeq += 1;
  return `mock-driver-${mockDriverSeq}`;
}

let mockShiftTypeSeq = 0;
export function nextMockShiftTypeId(): string {
  mockShiftTypeSeq += 1;
  return `mock-shift-type-${mockShiftTypeSeq}`;
}

let mockShiftTemplateSeq = 0;
export function nextMockShiftTemplateId(): string {
  mockShiftTemplateSeq += 1;
  return `mock-shift-template-${mockShiftTemplateSeq}`;
}

let mockOnfleetMappingSeq = 0;
export function nextMockOnfleetMappingId(): string {
  mockOnfleetMappingSeq += 1;
  return `mock-onfleet-mapping-${mockOnfleetMappingSeq}`;
}

// ---------------------------------------------------------------------
// Test-only reset: mockDrivers/mockShiftTypes/mockShiftTemplates/
// mockAvailability are shared, mutable module state, so a test that
// creates/edits/deactivates something leaks into the next test in the same
// file unless reset. Deep-cloned once at module load, before anything can
// have mutated them.
// ---------------------------------------------------------------------
const BASELINE_DRIVERS: DriverRecord[] = mockDrivers.map((d) => ({ ...d }));
const BASELINE_SHIFT_TYPES: ShiftTypeRecord[] = mockShiftTypes.map((t) => ({ ...t }));
const BASELINE_SHIFT_TEMPLATES: ShiftTemplateRecord[] = mockShiftTemplates.map((t) => ({ ...t }));
const BASELINE_ONFLEET_MAPPINGS: DriverOnfleetMappingRecord[] = mockDriverOnfleetMappings.map((m) => ({ ...m }));

/** Test-only: restores every mutable fixture array to its module-load baseline. Call from `beforeEach`. */
export function resetMockFixturesForTesting(): void {
  mockDrivers.length = 0;
  mockDrivers.push(...BASELINE_DRIVERS.map((d) => ({ ...d })));
  mockShiftTypes.length = 0;
  mockShiftTypes.push(...BASELINE_SHIFT_TYPES.map((t) => ({ ...t })));
  mockShiftTemplates.length = 0;
  mockShiftTemplates.push(...BASELINE_SHIFT_TEMPLATES.map((t) => ({ ...t })));
  mockDriverOnfleetMappings.length = 0;
  mockDriverOnfleetMappings.push(...BASELINE_ONFLEET_MAPPINGS.map((m) => ({ ...m })));
  mockAvailability.length = 0;
}
