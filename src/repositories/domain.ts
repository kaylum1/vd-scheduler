/**
 * Repository-layer domain models.
 *
 * These are deliberately NOT the same as `src/types/index.ts` (the Stage
 * 1.1 UI/mock-data shapes — untouched by this checkpoint, still consumed
 * directly by the existing pages) and NOT the raw generated database rows
 * in `src/types/database.generated.ts`. They sit in between: a stable
 * shape repositories promise to return regardless of which provider
 * (mock or Supabase) is answering, using real identifiers (UUIDs) rather
 * than the Stage 1.1 mock's hard-coded resort-slug union.
 *
 * Mapping database row -> domain model happens once, in the Supabase
 * repository implementations, wherever naming/shape differ (snake_case ->
 * camelCase, mostly). Where a database row is already the right shape,
 * repositories return it directly rather than mapping for its own sake.
 */

export interface ResortRecord {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  isActive: boolean;
}

export interface DriverRecord {
  id: string;
  resortId: string;
  fullName: string;
  isActive: boolean;
  /** References supported_languages.code. Authoritative for driver-UI localisation from Stage 3 onward. */
  preferredLanguage: string;
}

/** Maps 1:1 onto a supported_languages row — the reference list Configuration's language picker reads from. */
export interface SupportedLanguageRecord {
  code: string;
  name: string;
}

/**
 * Maps 1:1 onto a driver_onfleet_mappings row. At most one active mapping
 * per driver (Stage 2D Checkpoint 1.1 guard) — "replacing" a mapping means
 * the old row becomes inactive and a new one is created, never an update of
 * onfleet_worker_id in place, so history is retained.
 */
export interface DriverOnfleetMappingRecord {
  id: string;
  driverId: string;
  resortId: string;
  onfleetWorkerId: string;
  isActive: boolean;
}

export interface ShiftTypeRecord {
  id: string;
  resortId: string;
  key: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * requiredDrivers is authoritative again (Stage 2D staffing simplification)
 * -- mandatory (>= 1) on every row written through the atomic RPCs.
 * basePayChf/deliveryRateChf/isPremium remain DEPRECATED/inert: pay belongs
 * to shift_base_pay_rules/driver_delivery_rates, and high-value/fairness is
 * not part of the V1 product model. Nullable here purely because the DB
 * columns are nullable.
 *
 * INTERNAL AS OF CHECKPOINT 4: this is the raw per-weekday database row --
 * `listShiftTemplates` still returns it (used internally to assemble
 * ShiftRecord, and kept for any future internal/migration tooling), but no
 * manager-facing UI component should consume it directly any more. The
 * Shift Setup UI works with `ShiftRecord` instead, which collapses a shift
 * type's active (or last-known) templates into the single "one Shift, one
 * time, several weekdays" shape managers actually think in.
 */
export interface ShiftTemplateRecord {
  id: string;
  resortId: string;
  shiftTypeId: string;
  /** Monday = 0 .. Sunday = 6, matching the DB-wide convention. */
  weekday: number;
  startTime: string;
  endTime: string;
  requiredDrivers: number | null;
  basePayChf: number | null;
  deliveryRateChf: number | null;
  isPremium: boolean | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  /**
   * Used by assembleShift to identify "the batch of rows one atomic RPC
   * call touched together" for an inactive shift type, when more than one
   * retirement event happens to share the same effective_to calendar date
   * (e.g. a weekday removed by revise_shift earlier the same day the shift
   * is later deactivated) -- effective_to alone can't distinguish those
   * two events, but they get different updated_at values since each is a
   * separate transaction. See assembleShift.ts.
   */
  updatedAt: string;
}

/**
 * The manager-facing "Shift" (Stage 2D Checkpoint 4) -- one stable
 * shift_type collapsed together with its current (or, once inactive, its
 * last-known) set of weekday schedule rows into the single shape the
 * simplified Shift Setup UI renders and edits. Internal concepts (the
 * stable `key`, per-weekday template rows, the Monday=0..Sunday=6 weekday
 * integer are still used to build this, but never surfaced beyond it.
 *
 * `schedule` is null when the underlying rows are inconsistent (different
 * start/end times and/or different effective periods across the relevant
 * weekdays) -- a legacy data state Checkpoint 4's "one shift, one time"
 * rule doesn't allow going forward, but which the UI must never silently
 * flatten by guessing a time. See `assembleShifts` in
 * `repositories/assembleShift.ts` and docs/business-rules.md.
 */
export interface ShiftRecord {
  shiftTypeId: string;
  resortId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  schedule: ShiftScheduleRecord | null;
  /** Populated only when schedule is null, to drive a useful review-required message. Monday=0..Sunday=6, ascending. */
  inconsistentWeekdays?: number[];
}

export interface ShiftScheduleRecord {
  startTime: string;
  endTime: string;
  /** Monday=0..Sunday=6, ascending, deduplicated. */
  weekdays: number[];
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Authoritative staffing requirement for this Shift (Stage 2D staffing simplification). Always >= 1 -- mandatory at Shift-creation time, never null on an assembled schedule. */
  requiredDrivers: number;
}

/**
 * Manager-side, full-fidelity shift instance -- a purely operational
 * schedule/staffing record. Never expose this shape to a driver session --
 * that's what DriverVisibleShift is for.
 *
 * requiredDrivers is mandatory as of the Stage 2D staffing simplification:
 * it is snapshotted directly from the governing Shift's required_drivers at
 * materialisation time, and can never be null (required_drivers has been
 * mandatory on shift_templates since Shift-creation time). isPremium is an
 * inert legacy column -- no longer resolved or populated; high-value/
 * fairness is not part of the V1 product model. See coverageTone/
 * coverageLabel in components/ui/StatusPill.tsx and docs/business-rules.md.
 *
 * No basePayChf/deliveryRateChf here (removed Stage 2D Payroll Checkpoint
 * A): a shift instance never snapshots pay. Base pay and driver delivery
 * rate are resolved later, at actual payroll-calculation time, against
 * shift_base_pay_rules/driver_delivery_rates -- see docs/business-rules.md.
 */
export interface ShiftInstanceRecord {
  id: string;
  resortId: string;
  date: string;
  weekStart: string;
  shiftTypeId: string;
  templateId: string | null;
  shiftKey: string;
  name: string;
  sortOrder: number;
  startTime: string;
  endTime: string;
  requiredDrivers: number;
  isPremium: boolean | null;
  status: 'active' | 'cancelled';
  origin: 'template' | 'adhoc';
}

/** Driver-safe projection — mirrors the driver_visible_shifts view exactly. */
export interface DriverVisibleShift {
  id: string;
  resortId: string;
  date: string;
  weekStart: string;
  shiftTypeId: string;
  shiftKey: string;
  name: string;
  sortOrder: number;
  startTime: string;
  endTime: string;
  status: string;
}

/** Driver-safe projection — mirrors the driver_visible_assignments view. No driver identity, pay, premium, or headcount. */
export interface DriverVisibleAssignment {
  assignmentId: string;
  shiftInstanceId: string;
  resortId: string;
  date: string;
  weekStart: string;
  shiftKey: string;
  name: string;
  startTime: string;
  endTime: string;
}

/**
 * One shift on a driver's own published rota (Live Driver My Rota). Deliberately
 * the bare minimum a driver needs to turn up: which shift, when. No co-drivers,
 * headcount, assignment source, manager identity, availability, pay or audit
 * data exists on this type, and ManagerWeekRota is never reused for drivers.
 * `startTime` / `endTime` are 'HH:MM'.
 */
export interface DriverRotaShift {
  shiftInstanceId: string;
  date: string;
  shiftName: string;
  startTime: string;
  endTime: string;
}

/**
 * The authenticated driver's rota for one operational (Monday-Sunday) week.
 * `isPublished` is the resort's real publication state for that week, so a
 * driver can tell "not published yet" from "published, nothing for me":
 * unpublished is ALWAYS `shifts: []`. Sorted by date, start time, name.
 */
export interface DriverWeekRota {
  weekStart: string;
  isPublished: boolean;
  shifts: DriverRotaShift[];
}

export type AvailabilityStatus = 'available' | 'unavailable';

export interface AvailabilityAnswer {
  id: string;
  driverId: string;
  resortId: string;
  shiftInstanceId: string;
  status: AvailabilityStatus;
  answeredAt: string;
}

export type WeekAvailabilityState = 'locked' | 'no_shifts' | 'complete' | 'incomplete';

/** Maps 1:1 onto week_availability_status()'s row shape. */
export interface WeekAvailabilityStatus {
  state: WeekAvailabilityState;
  resortId: string;
  weekStart: string;
  totalShifts: number;
  answeredCount: number;
  missingCount: number;
  missingShiftIds: string[];
}

export type ConfirmWeekResult = 'confirmed' | 'incomplete' | 'locked';

/** Maps 1:1 onto confirm_availability_week()'s row shape. */
export interface ConfirmWeekOutcome {
  result: ConfirmWeekResult;
  resortId: string;
  weekStart: string;
  totalShifts: number;
  answeredCount: number;
  missingShiftIds: string[];
  submittedAt: string | null;
}

export type ReopenWeekResult = 'reopened' | 'locked' | 'not_submitted';

/** Maps 1:1 onto reopen_availability_week()'s row shape. */
export interface ReopenWeekOutcome {
  result: ReopenWeekResult;
  resortId: string;
  weekStart: string;
  reopenedAt: string | null;
  reopenedReason: string | null;
}

/**
 * Stage 3: a direct, read-only projection of the driver's own
 * availability_submissions row for one week (or null if no row exists yet
 * -- the driver has never confirmed this week). Distinct from
 * WeekAvailabilityStatus: that RPC always recomputes pure answer
 * *completeness* fresh from the current active shift set and never trusts
 * this table, whereas the driver-facing UI also needs the actual
 * confirmation state itself (has the driver clicked "Confirm", and if a
 * confirmation was reopened, was it the driver's own choice or an
 * automatic stale-invalidation?) -- that state lives only here.
 * `reopenedReason` is one of 'driver_reopened' (the driver chose to edit
 * a confirmed week) or 'shift_added'/'shift_reinstated'/'shift_time_changed'
 * (an automatic, service-driven staleness event -- see
 * docs/business-rules.md). A row with `submittedAt` non-null is currently
 * confirmed and valid -- the DB trigger that would make it stale already
 * cleared `submittedAt` the moment a staleness-triggering change happened,
 * so this field is never read as "confirmed as of some past moment risk of
 * being outdated".
 */
export interface AvailabilitySubmissionRecord {
  driverId: string;
  resortId: string;
  weekStart: string;
  submittedAt: string | null;
  reopenedAt: string | null;
  reopenedReason: string | null;
}

/**
 * Manager-facing weekly submission state for one driver (Stage 3). Derived
 * client-side from the same primitives the driver-facing page uses
 * (answered/total shift counts, the driver's own availability_submissions
 * row, and the resort/week's publication state) -- never a separately
 * stored status column. See docs/business-rules.md for the exact mapping.
 */
export type DriverWeekAvailabilityState = 'not_started' | 'in_progress' | 'confirmed' | 'needs_reconfirmation' | 'locked';

/** One row per active driver at a resort, for one week -- what the manager's availability list renders. */
export interface AvailabilitySubmissionSummary {
  driverId: string;
  driverFullName: string;
  totalShifts: number;
  answeredCount: number;
  state: DriverWeekAvailabilityState;
}

/**
 * One driver's answer (or lack of one) for one active shift_instance that
 * week -- manager-only (drivers use `listAvailability` instead, scoped to
 * their own session). `status: null` means the driver has not answered
 * that shift yet ("Not Submitted") -- never a stored third status.
 */
export interface DriverShiftAvailability {
  shiftInstanceId: string;
  date: string;
  name: string;
  startTime: string;
  endTime: string;
  status: AvailabilityStatus | null;
}

// ---------------------------------------------------------------------
// Stage 2C: shift materialisation + template refresh/cancellation.
// Manager-only. Maps 1:1 onto the corresponding RPC row shapes.
// ---------------------------------------------------------------------

/**
 * Maps 1:1 onto materialise_shift_instances()'s row shape. There is no
 * missing-staffing or missing-payroll count of any kind: required_drivers
 * is mandatory at Shift-creation time (Stage 2D staffing simplification),
 * so a materialised instance can never be missing it, and pay is resolved
 * later, at actual payroll-calculation time, against shift_base_pay_rules/
 * driver_delivery_rates, never here (Stage 2D Payroll Checkpoint A).
 */
export interface MaterialiseShiftsResult {
  createdCount: number;
  skippedExistingCount: number;
  fromDate: string;
  toDate: string;
}

/** One field that would change if a template refresh were applied. */
export interface TemplateRefreshFieldChange {
  old: unknown;
  new: unknown;
}

/**
 * Maps 1:1 onto one row of preview_template_refresh(). Covers schedule
 * fields (name/sort_order/start_time/end_time) plus required_drivers
 * (Stage 2D staffing simplification) -- surfaced generically through
 * `changedFields`, not a dedicated output column. Pay/is_premium are still
 * never schedule-refresh concerns (they belong to shift_base_pay_rules/
 * driver_delivery_rates, or are inert), so there is no over-assignment
 * projection here.
 */
export interface TemplateRefreshPreviewRow {
  shiftInstanceId: string;
  date: string;
  shiftTypeId: string;
  shiftKey: string;
  name: string;
  currentTemplateId: string | null;
  newTemplateId: string;
  willChange: boolean;
  changedFields: Record<string, TemplateRefreshFieldChange>;
  assignmentCount: number;
  timeWouldChange: boolean;
}

/**
 * Maps 1:1 onto apply_template_refresh()'s row shape. No more over-assigned
 * tracking as of Stage 2D Checkpoint 3 -- this action never changes
 * required_drivers any more, so it can no longer make an instance
 * over-assigned.
 */
export interface ApplyTemplateRefreshResult {
  updatedCount: number;
  reopenedSubmissionCount: number;
}

/** Maps 1:1 onto one row of preview_template_cancellation(). */
export interface TemplateCancellationPreviewRow {
  shiftInstanceId: string;
  date: string;
  shiftTypeId: string;
  shiftKey: string;
  name: string;
  isPublished: boolean;
  assignmentCount: number;
  hasAvailabilityAnswers: boolean;
  hasAttendance: boolean;
  isSafeToCancel: boolean;
}

/** Maps 1:1 onto apply_template_cancellation()'s row shape. */
export interface ApplyTemplateCancellationResult {
  cancelledCount: number;
  cancelledShiftInstanceIds: string[];
}

// ---------------------------------------------------------------------
// Stage 2D Payroll Checkpoint B: rate configuration. See
// docs/business-rules.md section G for the full formula/ownership model.
// Both are manager-only, effective-dated, and NEVER resolved onto
// shift_instances -- see repositories/types.ts's PayrollRulesRepository
// doc comment for how a caller is expected to derive Current/Scheduled/
// History from the flat list each `list*` method returns.
// ---------------------------------------------------------------------

/** Maps 1:1 onto a shift_base_pay_rules row. `effectiveTo: null` = open-ended (still the current or most-recently-set version for this Shift). */
export interface ShiftBasePayRuleRecord {
  id: string;
  resortId: string;
  shiftTypeId: string;
  basePayChf: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Maps 1:1 onto a driver_delivery_rates row. `effectiveTo: null` = open-ended. Manager-only -- a driver must never be able to fetch their own rate through any driver-facing path. */
export interface DriverDeliveryRateRecord {
  id: string;
  resortId: string;
  driverId: string;
  rateChf: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

// ---------------------------------------------------------------------
// Manual Rota (MR-B): the MANAGER weekly rota read model and assignment
// operations. Manager-only by construction -- it carries required_drivers,
// every resort driver's identity, and every driver's availability, none of
// which a driver session may ever see. Never reuse these shapes for driver
// pages: Driver My Rota / Driver Availability keep their own safe
// repositories/views (DriverVisibleAssignment / DriverVisibleShift).
// ---------------------------------------------------------------------

/**
 * A driver's availability for one exact shift_instance, as the product sees
 * it. 'not_submitted' is NEVER a stored status -- it is simply the absence of
 * an availability row. Never inferred from week-level confirmation state.
 */
export type RotaAvailabilityState = 'available' | 'unavailable' | 'not_submitted';

/** Mirrors rota_assignments.assignment_source. Manual Rota only ever writes 'manual'; 'auto' is reserved for future Auto-Rota. */
export type RotaAssignmentSource = 'manual' | 'auto';

/** A driver who may be offered as a NEW assignment: active, at the selected resort. */
export interface ManagerRotaDriver {
  driverId: string;
  fullName: string;
}

/**
 * One existing assignment, with its driver already resolved -- including a
 * driver who has since become inactive (their assignment is never silently
 * dropped). An inactive assignee does NOT count toward required_drivers
 * (see lib/rotaCoverage.ts) but stays visible so the manager can replace or
 * remove them. Deliberately carries NO audit context / override reason: that
 * is audit data (audit_log.context), never part of the rota read model.
 */
export interface ManagerRotaAssignment {
  assignmentId: string;
  driverId: string;
  driverName: string;
  isDriverActive: boolean;
  source: RotaAssignmentSource;
  assignedAt: string;
}

export interface ManagerRotaShift {
  /** Identity. Never use the display name (or a "(1P)"/"(2P)" suffix) to identify or staff a shift. */
  shiftInstanceId: string;
  /** The stable Shift (shift_type) this instance belongs to. */
  shiftTypeId: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  name: string;
  /** The Shift's display order within a day. Part of the canonical shift order (date, sortOrder, startTime, name, id) the Auto-Rota planner uses for ties. */
  sortOrder: number;
  /** Wall-clock 'HH:MM' (seconds stripped so both providers agree). Never round-trip through a Date -- see lib/operationalTime.ts. */
  startTime: string;
  endTime: string;
  /** A coverage MINIMUM, not a capacity. */
  requiredDrivers: number;
  /** Every assignment on this shift, active and inactive drivers alike, ordered by assignedAt. */
  assignments: ManagerRotaAssignment[];
  /** One entry per ACTIVE candidate driver (assigned or not). Inactive assignees have no entry -- their name/status live on the assignment itself. */
  availabilityByDriver: Record<string, RotaAvailabilityState>;
}

/**
 * Everything the future Manual Rota screen needs for one resort + one
 * Monday-Sunday week. Coverage is deliberately NOT stored or fetched: derive
 * it with lib/rotaCoverage.ts.
 */
export interface ManagerWeekRota {
  resortId: string;
  /** The operational Monday, ISO YYYY-MM-DD. */
  weekStart: string;
  /** Whether this resort/week currently has an active publication. Read-only information: managers may still edit a published current/future week. */
  isPublished: boolean;
  /** Active drivers at the resort -- the ONLY people to offer as new assignments. Sorted by name. */
  candidateDrivers: ManagerRotaDriver[];
  /** Active shift instances for the week, ordered by date, then sort order, then start time. Empty for a week with no service. */
  shifts: ManagerRotaShift[];
}

export interface AssignDriverParams {
  shiftInstanceId: string;
  driverId: string;
  /**
   * Acknowledges an Unavailable / Not Submitted driver. Leave false/omitted on
   * the first attempt: the server decides the CURRENT availability itself and,
   * if an override is needed, rejects with AvailabilityOverrideRequiredError
   * (carrying that state). Retry with true only after the manager confirms.
   * The caller never supplies an availability state -- there is no such parameter.
   */
  confirmAvailabilityOverride?: boolean;
  /** Optional manager note (trimmed; empty = none; max 500 chars). Recorded in the audit trail only. */
  reason?: string | null;
}

export interface AssignDriverResult {
  assignmentId: string;
  /** The availability state the server actually used when it made the assignment. */
  availabilityState: RotaAvailabilityState;
}

export interface UnassignDriverParams {
  shiftInstanceId: string;
  driverId: string;
}

export interface UnassignDriverResult {
  assignmentId: string;
}

// ---------------------------------------------------------------------
// Auto-Rota (AR-B). The planner (lib/autoRotaPlanner.ts) PROPOSES; the
// database (apply_auto_rota, AR-A) decides whether every proposal is still
// safe. React only ever sees AutoRotaResult and AutoRotaError.
// ---------------------------------------------------------------------

/** One proposed assignment. The only thing ever sent to the database for a plan. */
export interface AutoRotaPlannedAssignment {
  shiftInstanceId: string;
  driverId: string;
}

/**
 * The pure planner's output: PLANNING numbers only (what the planner would do
 * given the week it was shown). Never shown to the manager as the outcome --
 * the authoritative AutoRotaResult comes from the database after the apply.
 */
export interface AutoRotaPlan {
  resortId: string;
  weekStart: string;
  /** Deterministic order: weekend bucket then weekday bucket, scarcity-first within a bucket, slot by slot. */
  assignments: AutoRotaPlannedAssignment[];
  plannedAssignmentCount: number;
  /** Open slots (today/future shifts) the plan could not fill. */
  remainingOpenSlots: number;
  /** Today/future shifts that stay under-covered after the plan, in canonical shift order. */
  uncoveredShiftIds: string[];
  /** Active shifts dated before the operational today: skipped, never planned, never reported as gaps. */
  skippedPastShiftCount: number;
  /** True when the entire Monday-Sunday week is before the operational today (nothing can be generated; the database reports historical_week). */
  weekIsHistorical: boolean;
}

export interface GenerateAutoRotaParams {
  resortId: string;
  weekStart: string;
}

/** The AUTHORITATIVE outcome of one generation, computed by the database after the apply. Partial coverage is a normal success. */
export interface AutoRotaResult {
  resortId: string;
  weekStart: string;
  /** Rows actually created by this run. */
  assignedCount: number;
  /** Positions still open on today/future shifts after the run (> 0 is not a failure). */
  remainingOpenSlots: number;
  uncoveredShiftIds: string[];
  skippedPastShiftCount: number;
  /** Groups this run's audit rows. */
  runId: string;
}
