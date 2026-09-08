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
}

export interface ShiftTypeRecord {
  id: string;
  resortId: string;
  key: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ShiftTemplateRecord {
  id: string;
  resortId: string;
  shiftTypeId: string;
  /** Monday = 0 .. Sunday = 6, matching the DB-wide convention. */
  weekday: number;
  startTime: string;
  endTime: string;
  requiredDrivers: number;
  basePayChf: number;
  deliveryRateChf: number;
  isPremium: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

/**
 * Manager-side, full-fidelity shift instance (includes pay/premium/
 * headcount). Never expose this shape to a driver session — that's what
 * DriverVisibleShift is for.
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
  basePayChf: number;
  deliveryRateChf: number;
  isPremium: boolean;
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
