import { startOfWeek, toISODate } from '../../mock-data/date-utils';
import type { AvailabilityRepository } from '../types';
import type {
  AvailabilityAnswer,
  AvailabilityStatus,
  ConfirmWeekOutcome,
  DriverVisibleShift,
  ReopenWeekOutcome,
  WeekAvailabilityStatus,
} from '../domain';
import { RepositoryError } from '../errors';
import { mockAvailability, mockDrivers, nextMockAvailabilityId } from './fixtures';
import { generateMockShiftInstancesForWeek } from './shiftInstances';

/**
 * Mock-only stand-in for the database RPCs. This intentionally
 * reimplements a simplified version of the readiness/confirm/reopen rules
 * — the "don't reimplement Confirm Week logic" instruction is about the
 * Supabase provider, which must always defer to the real RPC; the mock
 * provider has no database to defer to; it needs *some* working behaviour
 * to satisfy the interface. Not published state / lock support in mock
 * mode yet — good enough to prove the shape, not a parity implementation.
 */
export class MockAvailabilityRepository implements AvailabilityRepository {
  async listDriverVisibleShifts(resortId: string): Promise<DriverVisibleShift[]> {
    // Mock mode has no fixed "current" week; callers of this method get
    // shifts for the current calendar week by convention.
    const weekStart = toISODate(startOfWeek(new Date()));
    return generateMockShiftInstancesForWeek(resortId, weekStart).map((instance) => ({
      id: instance.id,
      resortId: instance.resortId,
      date: instance.date,
      weekStart: instance.weekStart,
      shiftTypeId: instance.shiftTypeId,
      shiftKey: instance.shiftKey,
      name: instance.name,
      sortOrder: instance.sortOrder,
      startTime: instance.startTime,
      endTime: instance.endTime,
      status: instance.status,
    }));
  }

  async listAvailability(params: { driverId: string; resortId: string; weekStart: string }): Promise<AvailabilityAnswer[]> {
    const shiftIds = new Set(generateMockShiftInstancesForWeek(params.resortId, params.weekStart).map((s) => s.id));
    return mockAvailability.filter((a) => a.driverId === params.driverId && shiftIds.has(a.shiftInstanceId));
  }

  async setAvailability(params: {
    driverId: string;
    resortId: string;
    shiftInstanceId: string;
    status: AvailabilityStatus;
  }): Promise<AvailabilityAnswer> {
    const existing = mockAvailability.find(
      (a) => a.driverId === params.driverId && a.shiftInstanceId === params.shiftInstanceId
    );
    if (existing) {
      existing.status = params.status;
      existing.answeredAt = new Date().toISOString();
      return existing;
    }
    const record: AvailabilityAnswer = {
      id: nextMockAvailabilityId(),
      driverId: params.driverId,
      resortId: params.resortId,
      shiftInstanceId: params.shiftInstanceId,
      status: params.status,
      answeredAt: new Date().toISOString(),
    };
    mockAvailability.push(record);
    return record;
  }

  async getWeekAvailabilityStatus(driverId: string, weekStart: string): Promise<WeekAvailabilityStatus> {
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) {
      throw new RepositoryError(`driver ${driverId} not found`, { operation: 'availability.getWeekStatus' });
    }
    const shifts = generateMockShiftInstancesForWeek(driver.resortId, weekStart);
    const answered = mockAvailability.filter(
      (a) => a.driverId === driverId && shifts.some((s) => s.id === a.shiftInstanceId)
    );
    const answeredIds = new Set(answered.map((a) => a.shiftInstanceId));
    const missingShiftIds = shifts.filter((s) => !answeredIds.has(s.id)).map((s) => s.id);

    const state: WeekAvailabilityStatus['state'] =
      shifts.length === 0 ? 'no_shifts' : missingShiftIds.length === 0 ? 'complete' : 'incomplete';

    return {
      state,
      resortId: driver.resortId,
      weekStart,
      totalShifts: shifts.length,
      answeredCount: shifts.length - missingShiftIds.length,
      missingCount: missingShiftIds.length,
      missingShiftIds,
    };
  }

  async confirmAvailabilityWeek(driverId: string, weekStart: string): Promise<ConfirmWeekOutcome> {
    const status = await this.getWeekAvailabilityStatus(driverId, weekStart);
    return {
      result: status.missingCount === 0 ? 'confirmed' : 'incomplete',
      resortId: status.resortId,
      weekStart: status.weekStart,
      totalShifts: status.totalShifts,
      answeredCount: status.answeredCount,
      missingShiftIds: status.missingShiftIds,
      submittedAt: status.missingCount === 0 ? new Date().toISOString() : null,
    };
  }

  async reopenAvailabilityWeek(driverId: string, weekStart: string): Promise<ReopenWeekOutcome> {
    const status = await this.getWeekAvailabilityStatus(driverId, weekStart);
    return {
      result: 'reopened',
      resortId: status.resortId,
      weekStart,
      reopenedAt: new Date().toISOString(),
      reopenedReason: 'driver_reopened',
    };
  }
}
