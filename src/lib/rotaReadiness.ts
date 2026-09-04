import { buildAvailabilityEntries } from '../mock-data/availability';
import { driversByResort } from '../mock-data/drivers';
import { generateWeekShiftInstances } from '../mock-data/shifts';
import type { Resort, ShiftInstance } from '../types';

export interface DriverMissingAvailability {
  driverId: string;
  driverName: string;
  missingShiftCount: number;
}

export interface ResortWeekReadiness {
  resort: Resort;
  driverCount: number;
  shifts: ShiftInstance[];
  isPublished: boolean;
  uncoveredShifts: ShiftInstance[];
  missingAvailability: DriverMissingAvailability[];
  availabilityComplete: boolean;
  readyToGenerate: boolean;
}

/**
 * Scheduling-readiness snapshot for one resort/week, built entirely from
 * mock data. This is presentation logic only — the real readiness rules
 * (what "ready to generate" actually requires) belong to the scheduling
 * service in a later stage.
 */
export function getResortWeekReadiness(
  resort: Resort,
  weekStart: Date,
  isPublished: boolean
): ResortWeekReadiness {
  const shifts = generateWeekShiftInstances(weekStart, isPublished).filter((s) => s.resortId === resort.id);
  const uncoveredShifts = shifts.filter((s) => s.assignedDriverIds.length === 0);
  const drivers = driversByResort(resort.id);

  const missingAvailability: DriverMissingAvailability[] = [];
  for (const driver of drivers) {
    const entries = buildAvailabilityEntries(driver.id, resort.id);
    const shiftIds = new Set(shifts.map((s) => s.id));
    const missingCount = entries.filter(
      (e) => shiftIds.has(e.shiftInstanceId) && e.status === 'not-submitted'
    ).length;
    if (missingCount > 0) {
      missingAvailability.push({ driverId: driver.id, driverName: driver.name, missingShiftCount: missingCount });
    }
  }

  const availabilityComplete = drivers.length > 0 && missingAvailability.length === 0;

  return {
    resort,
    driverCount: drivers.length,
    shifts,
    isPublished,
    uncoveredShifts,
    missingAvailability,
    availabilityComplete,
    readyToGenerate: availabilityComplete && !isPublished,
  };
}
