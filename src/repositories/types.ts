/**
 * Repository interfaces: the boundary between UI code and data access.
 * Components should depend only on these — never on `supabase.from(...)`
 * or on `src/mock-data/*` directly. Both a mock and a Supabase
 * implementation satisfy the same interface (see repositories/mock and
 * repositories/supabase), selected by the factory in repositories/index.ts.
 *
 * Only the minimum operations needed now/next checkpoint are defined here
 * — not every method a fully-built Configuration UI will eventually want.
 * Methods express valid business operations (`deactivateDriver(id)`), not
 * raw partial updates (`updateDriver(id, Record<string, unknown>)`), so a
 * caller can't accidentally mutate a protected identity/history field.
 *
 * Note on driverId/resortId parameters for driver-safe reads: the
 * Supabase implementation gets the calling driver's identity from the
 * authenticated session (RLS / the driver-safe views resolve it
 * server-side via current_app_user() — see Checkpoint 4), so it mostly
 * ignores these; the mock implementation has no session concept, so it
 * needs them to know who's "asking". They stay in the interface for that
 * reason and for a consistent shape across both providers.
 */

import type {
  ApplyTemplateCancellationResult,
  ApplyTemplateRefreshResult,
  AvailabilityAnswer,
  AvailabilityStatus,
  ConfirmWeekOutcome,
  DriverOnfleetMappingRecord,
  DriverRecord,
  DriverVisibleAssignment,
  DriverVisibleShift,
  MaterialiseShiftsResult,
  ReopenWeekOutcome,
  ResortRecord,
  ShiftInstanceRecord,
  ShiftRecord,
  SupportedLanguageRecord,
  TemplateCancellationPreviewRow,
  TemplateRefreshPreviewRow,
  WeekAvailabilityStatus,
} from './domain';

export interface ResortRepository {
  /** Every resort, active and inactive alike -- callers decide what to show where (Stage 2D Checkpoint 4.1 §5: operational selectors filter to active themselves; management/reporting views want everything). */
  listResorts(): Promise<ResortRecord[]>;
  getResortById(resortId: string): Promise<ResortRecord | null>;

  /**
   * Atomic (create_resort). The internal `slug` is generated server-side
   * from the name (disambiguated on collision) -- the manager never sees
   * or supplies it. No timezone input: the column's own default
   * (Europe/Zurich) applies untouched.
   */
  createResort(name: string): Promise<{ resortId: string; slug: string }>;
  /**
   * Atomic (deactivate_resort). Never deletes the row and never cascades
   * to its drivers/shifts/instances/publications -- rejected if the
   * resort still has any operationally-active dependent (active drivers,
   * active shifts, upcoming generated shift instances, a published week),
   * surfaced as a manager-facing error naming what's blocking it.
   */
  deactivateResort(resortId: string): Promise<{ resortId: string }>;
  /** Atomic (reactivate_resort). Restores the same row -- same id, same slug, same historical relationships. Never creates a replacement resort. */
  reactivateResort(resortId: string): Promise<{ resortId: string }>;
}

export interface DriverRepository {
  listDrivers(params?: { resortId?: string }): Promise<DriverRecord[]>;
  getDriverById(driverId: string): Promise<DriverRecord | null>;

  /** preferredLanguage defaults to 'en' (drivers.preferred_language's own DB default) when omitted. */
  createDriver(input: { resortId: string; fullName: string; preferredLanguage?: string }): Promise<DriverRecord>;
  updateDriverName(driverId: string, fullName: string): Promise<DriverRecord>;
  /** Must be a supported_languages.code (e.g. 'en', 'fr') — an unsupported value is rejected by the DB FK, not silently coerced. */
  updateDriverLanguage(driverId: string, preferredLanguage: string): Promise<DriverRecord>;
  /** Historical-safe: deactivates rather than deletes (Checkpoint 1 invariant). */
  deactivateDriver(driverId: string): Promise<DriverRecord>;

  // Deliberately no "moveDriverResort"-style method: drivers.resort_id is
  // immutable once set (Stage 2D Checkpoint 1 guard). Moving a driver to a
  // different resort is "deactivate the old record, create a new one at the
  // new resort" — never an update, so there is no business operation to name.

  /**
   * IDs (from `driverIds`, or every driver if omitted) that have a linked
   * app_users login. Manager-only read (app_users), used only for the
   * Configuration UI's "Login linked" / "No login" badge — never for
   * provisioning (see Stage 2B: account creation stays out of the browser).
   */
  listDriverIdsWithLogin(driverIds?: string[]): Promise<Set<string>>;

  /** V1: 'en' and 'fr'. Read from the DB rather than hard-coded so a later-added language needs no frontend change. */
  listSupportedLanguages(): Promise<SupportedLanguageRecord[]>;

  /**
   * Active Onfleet mappings (from `driverIds`, or every driver if omitted),
   * keyed by driverId — manager-only (driver_onfleet_mappings has no driver
   * RLS policy at all). Used for the Configuration "Onfleet linked" /
   * "Onfleet not linked" badge.
   */
  listActiveOnfleetMappings(driverIds?: string[]): Promise<Map<string, DriverOnfleetMappingRecord>>;
  /**
   * Creates or replaces a driver's active Onfleet mapping in one atomic
   * operation (deactivates whatever was active, if anything, then creates
   * the new one) — never a raw update of onfleet_worker_id in place, so the
   * old identity stays in history rather than being overwritten.
   */
  setOnfleetMapping(driverId: string, onfleetWorkerId: string): Promise<DriverOnfleetMappingRecord>;
}

/**
 * Fields for create_shift/revise_shift/reactivate_shift's manager-facing
 * schedule input -- deliberately excludes pay/required drivers/high-value/
 * key/timezone (Stage 2D Checkpoint 4: those belong elsewhere or stay
 * internal, never asked of the manager in Shift Setup).
 */
export interface ShiftScheduleInput {
  name: string;
  startTime: string;
  endTime: string;
  /** Monday=0..Sunday=6. At least one required -- enforced by the RPC itself, not just client-side validation. */
  weekdays: number[];
  /** Defaults to "today" in the resort's own timezone (resolved server-side) when omitted. */
  effectiveFrom?: string;
  /** Open-ended ("continues until changed") when omitted. */
  effectiveTo?: string;
}

export interface ShiftConfigurationRepository {
  /**
   * The manager-facing "Shift" list (Stage 2D Checkpoint 4) -- one entry
   * per shift type, its current (or last-known) schedule assembled via
   * `assembleShifts`. This is what Shift Setup renders; components should
   * never need `listShiftTypes`/`listShiftTemplates` directly any more.
   */
  listShifts(resortId: string): Promise<ShiftRecord[]>;
  /** Manager-side, full-fidelity read (pay/premium/headcount included). */
  listShiftInstances(params: { resortId: string; weekStart: string }): Promise<ShiftInstanceRecord[]>;

  /**
   * Atomic (create_shift): one new stable shift + its whole weekday
   * schedule in a single transaction. No pay/required-drivers/high-value
   * inputs -- those belong to Payroll/Rota Rules, configured separately.
   * The internal `key` is generated server-side; the manager never sees or
   * supplies it, and a name that collides with an existing key is silently
   * disambiguated, never rejected.
   */
  createShift(resortId: string, input: ShiftScheduleInput): Promise<{ shiftTypeId: string }>;
  /**
   * Atomic (revise_shift): renames/retimes/reschedules an ACTIVE shift in
   * one transaction, diffing the current weekday set against the new one
   * server-side. Never rewrites history -- a weekday version that already
   * governs real dates is retired, not overwritten in place.
   */
  reviseShift(shiftTypeId: string, resortId: string, input: ShiftScheduleInput): Promise<{ shiftTypeId: string }>;
  /**
   * Atomic (deactivate_shift): ends every active weekday and marks the
   * shift inactive, in one transaction. Never deletes the underlying
   * shift_type, and never touches already-materialised future
   * shift_instances -- use preview/applyTemplateCancellation separately
   * for those.
   */
  deactivateShift(shiftTypeId: string, resortId: string, effectiveTo?: string): Promise<{ shiftTypeId: string }>;
  /**
   * Atomic (reactivate_shift): brings an inactive shift back under the
   * SAME stable shift_type_id, with brand-new schedule rows from
   * `input.effectiveFrom` -- never resurrects/reopens old historical rows.
   */
  reactivateShift(shiftTypeId: string, resortId: string, input: ShiftScheduleInput): Promise<{ shiftTypeId: string }>;

  // Deliberately no "moveShiftInstanceDate"-style method: shift_instances.date
  // is immutable. Moving a shift is cancel + create new, which belongs to a
  // future rota-management checkpoint, not here.

  // Stage 2C: materialisation + template refresh/cancellation. Thin RPC
  // wrappers only — the database functions remain authoritative; nothing
  // here reimplements their logic.

  /** Insert-only: creates missing shift_instances from active templates. Default horizon: today through end of next month. Result includes missing-payroll/rota-rule counts (Stage 2D Checkpoint 3) -- informational, never a failure. */
  materialiseShifts(resortId: string, fromDate?: string, toDate?: string): Promise<MaterialiseShiftsResult>;
  /** Read-only: what apply_template_refresh would change for the currently-safe (v_refreshable_instances) set. Schedule fields only (name/sort_order/start_time/end_time) since Stage 2D Checkpoint 3 -- pay/staffing/high-value are no longer schedule-refresh concerns. */
  previewTemplateRefresh(resortId: string, fromDate?: string): Promise<TemplateRefreshPreviewRow[]>;
  /** Updates exactly the previewed safe set from their current governing template. Never removes assignments. */
  applyTemplateRefresh(resortId: string, fromDate?: string): Promise<ApplyTemplateRefreshResult>;
  /** Read-only: future template-origin instances that lost their governing template, and whether each is safe to cancel. */
  previewTemplateCancellation(resortId: string, shiftTypeId?: string): Promise<TemplateCancellationPreviewRow[]>;
  /** Cancels (never deletes) exactly the safe subset preview_template_cancellation reports. */
  applyTemplateCancellation(resortId: string, shiftTypeId?: string, reason?: string): Promise<ApplyTemplateCancellationResult>;
}

export interface AvailabilityRepository {
  /** Driver-safe shift list for answering availability against. */
  listDriverVisibleShifts(resortId: string): Promise<DriverVisibleShift[]>;
  listAvailability(params: { driverId: string; resortId: string; weekStart: string }): Promise<AvailabilityAnswer[]>;
  setAvailability(params: {
    driverId: string;
    resortId: string;
    shiftInstanceId: string;
    status: AvailabilityStatus;
  }): Promise<AvailabilityAnswer>;

  // RPC wrappers. The database function is authoritative for all three —
  // these only translate args/results, never reimplement the logic.
  getWeekAvailabilityStatus(driverId: string, weekStart: string): Promise<WeekAvailabilityStatus>;
  confirmAvailabilityWeek(driverId: string, weekStart: string): Promise<ConfirmWeekOutcome>;
  reopenAvailabilityWeek(driverId: string, weekStart: string): Promise<ReopenWeekOutcome>;
}

export interface RotaRepository {
  /** Driver-safe "My Rota": own published assignments only, no colleague identities. */
  listDriverVisibleAssignments(driverId: string): Promise<DriverVisibleAssignment[]>;
}
