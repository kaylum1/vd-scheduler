import { parseISODate, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import type { AvailabilityRepository } from '../types';
import type {
  AvailabilityAnswer,
  AvailabilitySubmissionRecord,
  AvailabilitySubmissionSummary,
  AvailabilityStatus,
  ConfirmWeekOutcome,
  DriverShiftAvailability,
  DriverVisibleShift,
  DriverWeekAvailabilityState,
  ReopenWeekOutcome,
  WeekAvailabilityStatus,
} from '../domain';
import { RepositoryError } from '../errors';
import {
  mockAvailability,
  mockAvailabilitySubmissions,
  mockDrivers,
  mockRotaPublications,
  nextMockAvailabilityId,
  nextMockAvailabilitySubmissionId,
  type MockAvailabilitySubmission,
} from './fixtures';
import { generateMockShiftInstancesForWeek } from './shiftInstances';

/**
 * Mock-only stand-in for the database RPCs. This intentionally
 * reimplements a simplified version of the readiness/confirm/reopen rules
 * — the "don't reimplement Confirm Week logic" instruction is about the
 * Supabase provider, which must always defer to the real RPC; the mock
 * provider has no database to defer to; it needs *some* working behaviour
 * to satisfy the interface. Publication/confirmation state is real (mutable
 * fixture-backed) as of Stage 3, but the automatic stale-invalidation
 * trigger is NOT simulated (mock shift instances are generated fresh from
 * templates on every read, never persisted, so there is no stored "before"
 * state for a trigger to compare against) -- a test that needs a stale
 * week pushes directly into `mockAvailabilitySubmissions`, the same way
 * other mock tests fabricate a specific data state directly.
 */
function isMockWeekPublished(resortId: string, weekStart: string): boolean {
  return mockRotaPublications.some(
    (p) => p.resortId === resortId && p.weekStart === weekStart && p.publishedAt !== null && p.unpublishedAt === null
  );
}

function deriveMockWeekState(params: {
  isPublished: boolean;
  answeredCount: number;
  submission: MockAvailabilitySubmission | undefined;
}): DriverWeekAvailabilityState {
  if (params.isPublished) return 'locked';
  if (params.submission?.submittedAt) return 'confirmed';
  if (params.submission?.reopenedReason && params.submission.reopenedReason !== 'driver_reopened') {
    return 'needs_reconfirmation';
  }
  if (params.answeredCount > 0) return 'in_progress';
  return 'not_started';
}

export class MockAvailabilityRepository implements AvailabilityRepository {
  async listDriverVisibleShifts(resortId: string): Promise<DriverVisibleShift[]> {
    // Mock mode generates instances on the fly from templates rather than
    // persisting them, so there is no fixed materialisation horizon to
    // browse -- a reasonable, generous window (13 weeks back/forward) lets
    // the driver page's week navigation behave the same as it would
    // against a real, already-materialised Supabase horizon.
    const today = startOfWeek(getOperationalToday());
    const weeks: string[] = [];
    for (let offset = -13; offset <= 13; offset += 1) {
      const d = new Date(today);
      d.setDate(d.getDate() + offset * 7);
      weeks.push(toISODate(d));
    }
    return weeks.flatMap((weekStart) =>
      generateMockShiftInstancesForWeek(resortId, weekStart).map((instance) => ({
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
      }))
    );
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
    // Mirrors the DB's RLS-enforced publication lock (availability_driver_
    // update/insert_own_unpublished -- see 10_availability_publication.sql
    // for the real, authoritative enforcement). Mock shiftInstanceIds are
    // `${templateId}-${date}` (see generateMockShiftInstancesForWeek), so
    // the trailing "YYYY-MM-DD" segment gives the shift's own date without
    // needing a lookup table.
    const shiftDateIso = params.shiftInstanceId.split('-').slice(-3).join('-');
    const shiftWeekStart = toISODate(startOfWeek(parseISODate(shiftDateIso)));
    if (isMockWeekPublished(params.resortId, shiftWeekStart)) {
      throw new RepositoryError('This week has been published — availability can no longer be changed.', {
        operation: 'availability.set',
        code: '42501',
      });
    }
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
    const published = isMockWeekPublished(driver.resortId, weekStart);

    const state: WeekAvailabilityStatus['state'] = published
      ? 'locked'
      : shifts.length === 0
      ? 'no_shifts'
      : missingShiftIds.length === 0
      ? 'complete'
      : 'incomplete';

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
    if (status.state === 'locked') {
      return {
        result: 'locked',
        resortId: status.resortId,
        weekStart: status.weekStart,
        totalShifts: status.totalShifts,
        answeredCount: status.answeredCount,
        missingShiftIds: status.missingShiftIds,
        submittedAt: null,
      };
    }
    if (status.missingCount > 0) {
      return {
        result: 'incomplete',
        resortId: status.resortId,
        weekStart: status.weekStart,
        totalShifts: status.totalShifts,
        answeredCount: status.answeredCount,
        missingShiftIds: status.missingShiftIds,
        submittedAt: null,
      };
    }

    const submittedAt = new Date().toISOString();
    const existing = mockAvailabilitySubmissions.find((s) => s.driverId === driverId && s.weekStart === weekStart);
    if (existing) {
      existing.submittedAt = submittedAt;
      existing.reopenedAt = null;
      existing.reopenedReason = null;
    } else {
      mockAvailabilitySubmissions.push({
        id: nextMockAvailabilitySubmissionId(),
        driverId,
        resortId: status.resortId,
        weekStart,
        submittedAt,
        reopenedAt: null,
        reopenedReason: null,
      });
    }

    return {
      result: 'confirmed',
      resortId: status.resortId,
      weekStart: status.weekStart,
      totalShifts: status.totalShifts,
      answeredCount: status.answeredCount,
      missingShiftIds: status.missingShiftIds,
      submittedAt,
    };
  }

  async reopenAvailabilityWeek(driverId: string, weekStart: string): Promise<ReopenWeekOutcome> {
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) {
      throw new RepositoryError(`driver ${driverId} not found`, { operation: 'availability.reopenWeek' });
    }
    if (isMockWeekPublished(driver.resortId, weekStart)) {
      return { result: 'locked', resortId: driver.resortId, weekStart, reopenedAt: null, reopenedReason: null };
    }

    const existing = mockAvailabilitySubmissions.find((s) => s.driverId === driverId && s.weekStart === weekStart);
    if (!existing || existing.submittedAt === null) {
      return { result: 'not_submitted', resortId: driver.resortId, weekStart, reopenedAt: null, reopenedReason: null };
    }

    const reopenedAt = new Date().toISOString();
    existing.submittedAt = null;
    existing.reopenedAt = reopenedAt;
    existing.reopenedReason = 'driver_reopened';

    return { result: 'reopened', resortId: driver.resortId, weekStart, reopenedAt, reopenedReason: 'driver_reopened' };
  }

  async getAvailabilitySubmission(driverId: string, weekStart: string): Promise<AvailabilitySubmissionRecord | null> {
    const existing = mockAvailabilitySubmissions.find((s) => s.driverId === driverId && s.weekStart === weekStart);
    return existing
      ? {
          driverId: existing.driverId,
          resortId: existing.resortId,
          weekStart: existing.weekStart,
          submittedAt: existing.submittedAt,
          reopenedAt: existing.reopenedAt,
          reopenedReason: existing.reopenedReason,
        }
      : null;
  }

  async listAvailabilitySubmissionStatus(resortId: string, weekStart: string): Promise<AvailabilitySubmissionSummary[]> {
    const shifts = generateMockShiftInstancesForWeek(resortId, weekStart);
    const totalShifts = shifts.length;
    const shiftIds = new Set(shifts.map((s) => s.id));
    const published = isMockWeekPublished(resortId, weekStart);
    const driversAtResort = mockDrivers.filter((d) => d.resortId === resortId && d.isActive);

    return driversAtResort.map((driver) => {
      const answeredCount = mockAvailability.filter((a) => a.driverId === driver.id && shiftIds.has(a.shiftInstanceId)).length;
      const submission = mockAvailabilitySubmissions.find((s) => s.driverId === driver.id && s.weekStart === weekStart);
      return {
        driverId: driver.id,
        driverFullName: driver.fullName,
        totalShifts,
        answeredCount,
        state: deriveMockWeekState({ isPublished: published, answeredCount, submission }),
      };
    });
  }

  async getResortWeekAvailability(driverId: string, weekStart: string): Promise<DriverShiftAvailability[]> {
    const driver = mockDrivers.find((d) => d.id === driverId);
    if (!driver) {
      throw new RepositoryError(`driver ${driverId} not found`, { operation: 'availability.resortWeek' });
    }
    const shifts = generateMockShiftInstancesForWeek(driver.resortId, weekStart);
    const answersByShift = new Map(
      mockAvailability.filter((a) => a.driverId === driverId).map((a) => [a.shiftInstanceId, a.status])
    );
    return shifts.map((shift) => ({
      shiftInstanceId: shift.id,
      date: shift.date,
      name: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      status: answersByShift.get(shift.id) ?? null,
    }));
  }
}
