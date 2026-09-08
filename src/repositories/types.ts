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
  AvailabilityAnswer,
  AvailabilityStatus,
  ConfirmWeekOutcome,
  DriverRecord,
  DriverVisibleAssignment,
  DriverVisibleShift,
  ReopenWeekOutcome,
  ResortRecord,
  ShiftInstanceRecord,
  ShiftTemplateRecord,
  ShiftTypeRecord,
  WeekAvailabilityStatus,
} from './domain';

export interface ResortRepository {
  listResorts(): Promise<ResortRecord[]>;
  getResortById(resortId: string): Promise<ResortRecord | null>;
}

export interface DriverRepository {
  listDrivers(params?: { resortId?: string }): Promise<DriverRecord[]>;
  getDriverById(driverId: string): Promise<DriverRecord | null>;

  createDriver(input: { resortId: string; fullName: string }): Promise<DriverRecord>;
  updateDriverName(driverId: string, fullName: string): Promise<DriverRecord>;
  /** Historical-safe: deactivates rather than deletes (Checkpoint 1 invariant). */
  deactivateDriver(driverId: string): Promise<DriverRecord>;
}

export interface ShiftConfigurationRepository {
  listShiftTypes(resortId: string): Promise<ShiftTypeRecord[]>;
  listShiftTemplates(shiftTypeId: string): Promise<ShiftTemplateRecord[]>;
  /** Manager-side, full-fidelity read (pay/premium/headcount included). */
  listShiftInstances(params: { resortId: string; weekStart: string }): Promise<ShiftInstanceRecord[]>;

  createShiftType(input: { resortId: string; key: string; name: string; sortOrder: number }): Promise<ShiftTypeRecord>;
  renameShiftType(shiftTypeId: string, name: string): Promise<ShiftTypeRecord>;
  deactivateShiftType(shiftTypeId: string): Promise<ShiftTypeRecord>;

  createShiftTemplateVersion(input: {
    shiftTypeId: string;
    resortId: string;
    weekday: number;
    startTime: string;
    endTime: string;
    requiredDrivers: number;
    basePayChf: number;
    deliveryRateChf: number;
    isPremium: boolean;
    effectiveFrom: string;
  }): Promise<ShiftTemplateRecord>;
  /** Closes a template version through the effective-dated model (sets effective_to + is_active=false) — never a raw field update. */
  deactivateShiftTemplate(templateId: string, effectiveTo: string): Promise<ShiftTemplateRecord>;

  // Deliberately no "moveShiftInstanceDate"-style method: shift_instances.date
  // is immutable (Checkpoint 4). Moving a shift is cancel + create new,
  // which belongs to a future rota-management checkpoint, not here.
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
