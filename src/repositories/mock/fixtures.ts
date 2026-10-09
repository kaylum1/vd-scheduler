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
  DriverDeliveryRateRecord,
  DriverOnfleetMappingRecord,
  DriverRecord,
  ResortRecord,
  ShiftBasePayRuleRecord,
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
    updatedAt: '2024-01-01T00:00:00.000Z',
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
    updatedAt: '2024-01-01T00:00:00.000Z',
  },
];

/**
 * Mirrors shift_base_pay_rules (Stage 2D Payroll Checkpoint B) -- the two
 * real Dinner shifts already have the "current real operational value"
 * (CHF 30) configured, open-ended, matching the product's own stated
 * starting point. No entry here at all is itself the "Not configured"
 * state -- never fabricated as CHF 0.
 */
export const mockShiftBasePayRules: ShiftBasePayRuleRecord[] = [
  { id: 'mock-base-pay-crans-dinner', resortId: 'mock-crans', shiftTypeId: 'mock-crans-dinner', basePayChf: 30, effectiveFrom: '2024-01-01', effectiveTo: null },
  { id: 'mock-base-pay-zermatt-dinner', resortId: 'mock-zermatt', shiftTypeId: 'mock-zermatt-dinner', basePayChf: 30, effectiveFrom: '2024-01-01', effectiveTo: null },
];

/**
 * Mirrors driver_delivery_rates -- Gianni and Alex have the current CHF 12
 * rate configured; Tomas deliberately doesn't, giving the "Not configured"
 * state a real, natural case in mock mode too (same idiom as
 * mockDriverOnfleetMappings above).
 */
export const mockDriverDeliveryRates: DriverDeliveryRateRecord[] = [
  { id: 'mock-rate-gianni', resortId: 'mock-crans', driverId: 'mock-gianni', rateChf: 12, effectiveFrom: '2024-01-01', effectiveTo: null },
  { id: 'mock-rate-alex', resortId: 'mock-zermatt', driverId: 'mock-alex', rateChf: 12, effectiveFrom: '2024-01-01', effectiveTo: null },
];

/** In-memory availability answers, mutated by setAvailability(). */
export const mockAvailability: AvailabilityAnswer[] = [];

let mockAvailabilitySeq = 0;
export function nextMockAvailabilityId(): string {
  mockAvailabilitySeq += 1;
  return `mock-availability-${mockAvailabilitySeq}`;
}

/**
 * Stage 3: mirrors availability_submissions -- mutated by
 * confirmAvailabilityWeek()/reopenAvailabilityWeek(). At most one row per
 * (driverId, weekStart), matching the real table's unique constraint.
 * `reopenedReason` is 'driver_reopened' when the driver themselves clicked
 * Reopen, or one of 'shift_added'/'shift_reinstated'/'shift_time_changed'
 * to simulate the DB's automatic stale-invalidation trigger for a test --
 * mock mode has no real trigger (shift instances are generated on the fly
 * from templates, never persisted), so a test that needs to exercise the
 * "needs reconfirmation" UI state sets this directly, the same way other
 * mock tests push directly into `mockShiftTemplates` to fabricate a
 * specific data state.
 */
export interface MockAvailabilitySubmission {
  id: string;
  driverId: string;
  resortId: string;
  weekStart: string;
  submittedAt: string | null;
  reopenedAt: string | null;
  reopenedReason: string | null;
}
export const mockAvailabilitySubmissions: MockAvailabilitySubmission[] = [];

let mockAvailabilitySubmissionSeq = 0;
export function nextMockAvailabilitySubmissionId(): string {
  mockAvailabilitySubmissionSeq += 1;
  return `mock-availability-submission-${mockAvailabilitySubmissionSeq}`;
}

/**
 * Stage 3: mirrors rota_publications -- empty by default (mock mode has no
 * live manager Publish action yet, matching the real product's own
 * checkpoint sequencing). Tests that need to exercise the driver-facing
 * "published/locked" state push a row directly, the same idiom as
 * mockAvailabilitySubmissions above.
 */
export interface MockRotaPublication {
  resortId: string;
  weekStart: string;
  publishedAt: string | null;
  unpublishedAt: string | null;
}
export const mockRotaPublications: MockRotaPublication[] = [];

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

let mockResortSeq = 0;
export function nextMockResortId(): string {
  mockResortSeq += 1;
  return `mock-resort-${mockResortSeq}`;
}

let mockShiftBasePayRuleSeq = 0;
export function nextMockShiftBasePayRuleId(): string {
  mockShiftBasePayRuleSeq += 1;
  return `mock-base-pay-rule-${mockShiftBasePayRuleSeq}`;
}

let mockDriverDeliveryRateSeq = 0;
export function nextMockDriverDeliveryRateId(): string {
  mockDriverDeliveryRateSeq += 1;
  return `mock-delivery-rate-${mockDriverDeliveryRateSeq}`;
}

// ---------------------------------------------------------------------
// Test-only reset: mockResorts/mockDrivers/mockShiftTypes/
// mockShiftTemplates/mockAvailability are shared, mutable module state, so
// a test that creates/edits/deactivates something leaks into the next test
// in the same file unless reset. Deep-cloned once at module load, before
// anything can have mutated them.
// ---------------------------------------------------------------------
const BASELINE_RESORTS: ResortRecord[] = mockResorts.map((r) => ({ ...r }));
const BASELINE_DRIVERS: DriverRecord[] = mockDrivers.map((d) => ({ ...d }));
const BASELINE_SHIFT_TYPES: ShiftTypeRecord[] = mockShiftTypes.map((t) => ({ ...t }));
const BASELINE_SHIFT_TEMPLATES: ShiftTemplateRecord[] = mockShiftTemplates.map((t) => ({ ...t }));
const BASELINE_ONFLEET_MAPPINGS: DriverOnfleetMappingRecord[] = mockDriverOnfleetMappings.map((m) => ({ ...m }));
const BASELINE_SHIFT_BASE_PAY_RULES: ShiftBasePayRuleRecord[] = mockShiftBasePayRules.map((r) => ({ ...r }));
const BASELINE_DRIVER_DELIVERY_RATES: DriverDeliveryRateRecord[] = mockDriverDeliveryRates.map((r) => ({ ...r }));

/** Test-only: restores every mutable fixture array to its module-load baseline. Call from `beforeEach`. */
export function resetMockFixturesForTesting(): void {
  mockResorts.length = 0;
  mockResorts.push(...BASELINE_RESORTS.map((r) => ({ ...r })));
  mockDrivers.length = 0;
  mockDrivers.push(...BASELINE_DRIVERS.map((d) => ({ ...d })));
  mockShiftTypes.length = 0;
  mockShiftTypes.push(...BASELINE_SHIFT_TYPES.map((t) => ({ ...t })));
  mockShiftTemplates.length = 0;
  mockShiftTemplates.push(...BASELINE_SHIFT_TEMPLATES.map((t) => ({ ...t })));
  mockDriverOnfleetMappings.length = 0;
  mockDriverOnfleetMappings.push(...BASELINE_ONFLEET_MAPPINGS.map((m) => ({ ...m })));
  mockShiftBasePayRules.length = 0;
  mockShiftBasePayRules.push(...BASELINE_SHIFT_BASE_PAY_RULES.map((r) => ({ ...r })));
  mockDriverDeliveryRates.length = 0;
  mockDriverDeliveryRates.push(...BASELINE_DRIVER_DELIVERY_RATES.map((r) => ({ ...r })));
  mockAvailability.length = 0;
  mockAvailabilitySubmissions.length = 0;
  mockRotaPublications.length = 0;
}
