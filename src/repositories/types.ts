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
  DriverDeliveryRateRecord,
  DriverOnfleetMappingRecord,
  DriverRecord,
  DriverVisibleAssignment,
  DriverVisibleShift,
  MaterialiseShiftsResult,
  ReopenWeekOutcome,
  ResortRecord,
  ShiftBasePayRuleRecord,
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
 * schedule input. requiredDrivers is mandatory (Stage 2D staffing
 * simplification) -- staffing lives directly on the Shift, exactly like
 * start/end time. Still deliberately excludes pay/high-value/key/timezone
 * -- those belong elsewhere or stay internal, never asked of the manager in
 * Shift Setup.
 */
export interface ShiftScheduleInput {
  name: string;
  startTime: string;
  endTime: string;
  /** Monday=0..Sunday=6. At least one required -- enforced by the RPC itself, not just client-side validation. */
  weekdays: number[];
  /** Mandatory, >= 1 -- enforced by the RPC itself, not just client-side validation. No default; never silently coalesced. */
  requiredDrivers: number;
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
  /** Manager-side, full-fidelity read (staffing/premium included; pay is never a shift_instances field -- see docs/business-rules.md). */
  listShiftInstances(params: { resortId: string; weekStart: string }): Promise<ShiftInstanceRecord[]>;

  /**
   * Atomic (create_shift): one new stable shift + its whole weekday
   * schedule + required staffing count, in a single transaction. No pay/
   * high-value inputs -- pay belongs to Payroll, configured separately;
   * high-value is not part of the V1 product model. The internal `key` is
   * generated server-side; the manager never sees or supplies it, and a
   * name that collides with an existing key is silently disambiguated,
   * never rejected.
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

  /** Insert-only: creates missing shift_instances from active templates. Default horizon: today through end of next month. required_drivers is snapshotted directly from the governing Shift -- never missing/guessed (Stage 2D staffing simplification). */
  materialiseShifts(resortId: string, fromDate?: string, toDate?: string): Promise<MaterialiseShiftsResult>;
  /** Read-only: what apply_template_refresh would change for the currently-safe (v_refreshable_instances) set. Schedule fields (name/sort_order/start_time/end_time) plus required_drivers (Stage 2D staffing simplification) -- pay/high-value are still never schedule-refresh concerns. */
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

/**
 * Stage 2D Payroll Checkpoint B: rate configuration only. Never calculates
 * payroll, never resolves a rate onto a shift_instance, never touches
 * attendance/Onfleet/adjustments -- see docs/business-rules.md section G.
 *
 * Both `list*` methods return every row for the resort (or driver), active
 * and historical alike, flat and unfiltered by date -- callers derive
 * Current (the row covering "today")/Scheduled (effective_from in the
 * future)/History (effective_to in the past) themselves via one shared
 * categorisation, exactly the same three-way split for both rate types
 * (see `categorizeRatePeriods` in `pages/manager/configuration/PayrollRulesPanel.tsx`)
 * -- this repository layer deliberately does not duplicate that resolution
 * logic per rate type, and does not expose a bespoke "current rate" RPC,
 * since the flat list is already small (one row per configured period) and
 * the categorisation is pure/date-only.
 */
export interface PayrollRulesRepository {
  /** Every shift_base_pay_rules row for shift types at this resort, current and historical alike. */
  listShiftBasePayRules(resortId: string): Promise<ShiftBasePayRuleRecord[]>;
  /**
   * Atomic (set_shift_base_pay_rate). Creates the Shift's first rate, or
   * schedules a future change -- never overwrites an already-real
   * historical/in-effect period's own values; a genuine future change
   * closes the current open-ended row (effective_to = the day before the
   * new one starts) and inserts a fresh row, while correcting a not-yet-
   * started future plan updates it in place instead of piling up redundant
   * rows. Rejects a backdate attempt on/before an already-in-effect rule's
   * own start, and rejects any other overlap -- the manager never sees a
   * raw constraint violation, only a mapped, manager-facing message.
   */
  setShiftBasePayRate(shiftTypeId: string, resortId: string, basePayChf: number, effectiveFrom?: string): Promise<ShiftBasePayRuleRecord>;

  /** Every driver_delivery_rates row for drivers at this resort, current and historical alike -- grouped by driverId by the caller. Manager-only -- never exposed to any driver-facing path. */
  listDriverDeliveryRates(resortId: string): Promise<DriverDeliveryRateRecord[]>;
  /**
   * Atomic (set_driver_delivery_rate). Same historical-safety shape as
   * setShiftBasePayRate, keyed by driver instead of Shift. resort_id is
   * always resolved server-side from the driver's own record, never
   * client-supplied.
   */
  setDriverDeliveryRate(driverId: string, rateChf: number, effectiveFrom?: string): Promise<DriverDeliveryRateRecord>;

  /**
   * Atomic (correct_shift_base_pay_rate), Stage 2D Payroll Checkpoint B.1.
   * A deliberate, distinct action from setShiftBasePayRate: fixes a
   * data-entry MISTAKE on an existing, still-open (current or scheduled)
   * rule -- updates its amount only, never its effective_from/effective_to,
   * so it can never fabricate a fake historical period. `ruleId` is the
   * target row's own id (already known from listShiftBasePayRules, never
   * manager-typed). Rejects correcting an already-closed historical period.
   */
  correctShiftBasePayRate(shiftTypeId: string, resortId: string, ruleId: string, newBasePayChf: number): Promise<ShiftBasePayRuleRecord>;
  /** Atomic (correct_driver_delivery_rate). Same shape as correctShiftBasePayRate, keyed by driver instead of Shift. */
  correctDriverDeliveryRate(driverId: string, ruleId: string, newRateChf: number): Promise<DriverDeliveryRateRecord>;
}
