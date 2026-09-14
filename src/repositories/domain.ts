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
 * requiredDrivers/basePayChf/deliveryRateChf/isPremium are DEPRECATED
 * (Stage 2D Checkpoint 3): staffing now belongs to rota_rules_*, pay to
 * payroll_rules. Nullable here purely because the DB columns are nullable
 * -- the current Shift Setup form (Checkpoint 4 will remove this) still
 * writes real values to them, but materialise_shift_instances no longer
 * reads them off this table at all.
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
}

/**
 * Manager-side, full-fidelity shift instance (includes pay/premium/
 * headcount). Never expose this shape to a driver session — that's what
 * DriverVisibleShift is for.
 *
 * requiredDrivers/basePayChf/deliveryRateChf/isPremium are nullable as of
 * Stage 2D Checkpoint 3: NULL means "not configured" (no applicable
 * payroll_rules/rota_rules_* row at materialisation time) — a distinct
 * "Needs Attention" state, never coalesced to 0/false. See
 * coverageTone/coverageLabel in components/ui/StatusPill.tsx and
 * docs/business-rules.md.
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
  requiredDrivers: number | null;
  basePayChf: number | null;
  deliveryRateChf: number | null;
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

// ---------------------------------------------------------------------
// Stage 2C: shift materialisation + template refresh/cancellation.
// Manager-only. Maps 1:1 onto the corresponding RPC row shapes.
// ---------------------------------------------------------------------

/**
 * Maps 1:1 onto materialise_shift_instances()'s row shape. The two missing-
 * rule counts (Stage 2D Checkpoint 3) count shifts materialised over the
 * requested range with no applicable payroll_rules/rota_rules_* row --
 * never a failure, always a "Needs Attention" signal.
 */
export interface MaterialiseShiftsResult {
  createdCount: number;
  skippedExistingCount: number;
  fromDate: string;
  toDate: string;
  missingPayrollRuleCount: number;
  missingRotaRuleCount: number;
}

/** One field that would change if a template refresh were applied. */
export interface TemplateRefreshFieldChange {
  old: unknown;
  new: unknown;
}

/**
 * Maps 1:1 onto one row of preview_template_refresh(). Schedule fields only
 * as of Stage 2D Checkpoint 3 -- required_drivers/pay/is_premium are no
 * longer schedule-template concerns (they belong to payroll_rules/
 * rota_rules_*), so there is no more current/new-required-drivers or
 * over-assignment projection here at all.
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
