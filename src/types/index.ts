/**
 * Domain types for VD Scheduler & Payroll.
 *
 * Stage 1 note: these types describe the shapes the UI renders. They are
 * intentionally decoupled from any storage/API implementation so a real
 * backend (database + services) can be introduced later without changing
 * component code — components only ever consume these shapes as props.
 */

export type ResortId = 'crans-montana' | 'zermatt' | 'verbier';

export interface Resort {
  id: ResortId;
  name: string;
  /** Short label used in compact UI (badges, mobile chips). */
  shortName: string;
}

export interface Driver {
  id: string;
  name: string;
  resortId: ResortId;
  /** Placeholder for later Onfleet-name verification (Stage 3+). */
  onfleetNameMatched?: boolean;
  initials: string;
}

/** Day of week, ISO-ish, Monday first to match the weekly rota view. */
export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Monday ... 6 = Sunday

export interface ShiftDefinition {
  id: string;
  resortId: ResortId;
  /** e.g. "Dinner", "Lunch" — never hard-coded per row, purely data-driven. */
  name: string;
  startTime: string; // "18:00"
  endTime: string; // "21:30"
  requiredDrivers: number;
  isPremium: boolean;
  /** Which weekdays this template applies to (0 = Monday ... 6 = Sunday). */
  weekdays: WeekdayIndex[];
}

export type AvailabilityStatus = 'available' | 'unavailable' | 'not-submitted';

export interface AvailabilityEntry {
  driverId: string;
  shiftInstanceId: string;
  status: AvailabilityStatus;
}

/** A concrete occurrence of a ShiftDefinition on a specific calendar date. */
export interface ShiftInstance {
  id: string;
  shiftDefinitionId: string;
  resortId: ResortId;
  date: string; // ISO date, "2026-09-05"
  name: string;
  startTime: string;
  endTime: string;
  requiredDrivers: number;
  isPremium: boolean;
  assignedDriverIds: string[];
  /** Whether this week's rota has been published (locks driver availability edits). */
  isPublished: boolean;
}

export type UserRole = 'manager' | 'driver';

export interface DashboardStat {
  id: string;
  label: string;
  value: string;
  trend?: string;
  tone?: 'neutral' | 'positive' | 'warning';
}

export interface ActivityItem {
  id: string;
  message: string;
  timestamp: string;
  resortId?: ResortId;
}

export interface PayrollRow {
  id: string;
  driverId: string;
  resortId: ResortId;
  shiftsWorked: number;
  hoursWorked: number;
  basePay: number;
  extras: number;
  deductions: number;
  total: number;
  onfleetMatchStatus: 'matched' | 'unmatched' | 'pending';
}
