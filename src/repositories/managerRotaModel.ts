/**
 * Pure assembly of the manager weekly rota read model from flat, already-
 * fetched rows. Both providers feed this the same ingredients (the Supabase
 * adapter from five small authorised reads, the mock from its fixtures), so
 * grouping, ordering, availability derivation and inactive-assignee handling
 * are identical by construction -- not by two implementations agreeing.
 *
 * No I/O and no presentation logic here. Coverage is derived separately
 * (lib/rotaCoverage.ts).
 */

import type {
  AvailabilityStatus,
  ManagerRotaAssignment,
  ManagerRotaDriver,
  ManagerRotaShift,
  ManagerWeekRota,
  RotaAssignmentSource,
  RotaAvailabilityState,
  ManagerRotaAttendance,
  ManagerRotaCheckIn,
  ShiftInstanceRecord,
} from './domain';

export interface RotaBuildDriver {
  id: string;
  fullName: string;
  isActive: boolean;
}

export interface RotaBuildAssignment {
  id: string;
  shiftInstanceId: string;
  driverId: string;
  source: RotaAssignmentSource;
  assignedAt: string;
  /** Final attendance for this assignment; absent / null = Not recorded. */
  attendance?: ManagerRotaAttendance | null;
  /** The driver's check-in evidence; absent / null = Not checked in. */
  checkIn?: ManagerRotaCheckIn | null;
}

export interface RotaBuildAvailability {
  shiftInstanceId: string;
  driverId: string;
  status: AvailabilityStatus;
}

export interface ManagerRotaBuildInput {
  resortId: string;
  weekStart: string;
  isPublished: boolean;
  /** The active shift instances for this resort/week. Row order is irrelevant -- the builder sorts. */
  shifts: ShiftInstanceRecord[];
  /** EVERY driver at the resort, active and inactive -- inactive ones are needed to resolve existing assignees. */
  drivers: RotaBuildDriver[];
  assignments: RotaBuildAssignment[];
  availability: RotaBuildAvailability[];
}

/** 'HH:MM:SS' (Postgres time) and 'HH:MM' (mock) both become 'HH:MM'. */
function clock(time: string): string {
  return time.slice(0, 5);
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildManagerWeekRota(input: ManagerRotaBuildInput): ManagerWeekRota {
  const driversById = new Map(input.drivers.map((d) => [d.id, d]));

  const candidateDrivers: ManagerRotaDriver[] = input.drivers
    .filter((d) => d.isActive)
    .map((d) => ({ driverId: d.id, fullName: d.fullName }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName) || byString(a.driverId, b.driverId));

  // Group once, then index -- never a scan per shift.
  const assignmentsByShift = new Map<string, RotaBuildAssignment[]>();
  for (const assignment of input.assignments) {
    const list = assignmentsByShift.get(assignment.shiftInstanceId) ?? [];
    list.push(assignment);
    assignmentsByShift.set(assignment.shiftInstanceId, list);
  }

  const statusByShiftAndDriver = new Map<string, AvailabilityStatus>();
  for (const row of input.availability) {
    statusByShiftAndDriver.set(`${row.shiftInstanceId}:${row.driverId}`, row.status);
  }

  const orderedShifts = [...input.shifts].sort(
    (a, b) =>
      byString(a.date, b.date) ||
      a.sortOrder - b.sortOrder ||
      byString(clock(a.startTime), clock(b.startTime)) ||
      byString(a.name, b.name) ||
      byString(a.id, b.id)
  );

  const shifts: ManagerRotaShift[] = orderedShifts.map((shift) => {
    const seenDrivers = new Set<string>();
    const assignments: ManagerRotaAssignment[] = [];
    for (const row of assignmentsByShift.get(shift.id) ?? []) {
      if (seenDrivers.has(row.driverId)) continue; // unique(shift_instance_id, driver_id) makes this unreachable; defensive only
      seenDrivers.add(row.driverId);
      const driver = driversById.get(row.driverId);
      assignments.push({
        assignmentId: row.id,
        driverId: row.driverId,
        // A driver row is guaranteed by the composite FK. If it is somehow
        // missing, the safe reading is "cannot be counted" -- never a
        // fabricated name or an active driver.
        driverName: driver?.fullName ?? 'Unknown driver',
        isDriverActive: driver?.isActive ?? false,
        source: row.source,
        assignedAt: row.assignedAt,
        attendance: row.attendance ?? null,
        checkIn: row.checkIn ?? null,
      });
    }
    assignments.sort(
      (a, b) => byString(a.assignedAt, b.assignedAt) || a.driverName.localeCompare(b.driverName) || byString(a.assignmentId, b.assignmentId)
    );

    const availabilityByDriver: Record<string, RotaAvailabilityState> = {};
    for (const candidate of candidateDrivers) {
      // Absence of a row IS "not submitted" -- it is never a stored status.
      availabilityByDriver[candidate.driverId] = statusByShiftAndDriver.get(`${shift.id}:${candidate.driverId}`) ?? 'not_submitted';
    }

    return {
      shiftInstanceId: shift.id,
      shiftTypeId: shift.shiftTypeId,
      date: shift.date,
      name: shift.name,
      sortOrder: shift.sortOrder,
      startTime: clock(shift.startTime),
      endTime: clock(shift.endTime),
      requiredDrivers: shift.requiredDrivers,
      assignments,
      availabilityByDriver,
    };
  });

  return {
    resortId: input.resortId,
    weekStart: input.weekStart,
    isPublished: input.isPublished,
    candidateDrivers,
    shifts,
  };
}
