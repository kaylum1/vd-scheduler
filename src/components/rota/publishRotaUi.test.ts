import { describe, expect, it } from 'vitest';
import { describePublishError, describePublishResult, describeUncoveredWarning, getPublishAvailability, hasNoActiveAssignments } from './publishRotaUi';
import { PublishRotaError, RepositoryError, type PublishRotaErrorKind } from '../../repositories/errors';
import type { ManagerRotaShift, ManagerWeekRota } from '../../repositories/domain';

const shift = (date: string, activeAssigned = 0, inactiveAssigned = 0): ManagerRotaShift => ({
  shiftInstanceId: `s-${date}`, shiftTypeId: 't', date, name: 'Dinner', sortOrder: 1, startTime: '18:00', endTime: '21:30',
  requiredDrivers: 2,
  assignments: [
    ...Array.from({ length: activeAssigned }, (_, i) => ({ assignmentId: `a${i}`, driverId: `d${i}`, driverName: 'D', isDriverActive: true, source: 'manual' as const, assignedAt: 'x', attendance: null, checkIn: null })),
    ...Array.from({ length: inactiveAssigned }, (_, i) => ({ assignmentId: `i${i}`, driverId: `x${i}`, driverName: 'X', isDriverActive: false, source: 'manual' as const, assignedAt: 'x', attendance: null, checkIn: null })),
  ],
  availabilityByDriver: {},
});
const week = (shifts: ManagerRotaShift[], isPublished = false): ManagerWeekRota => ({ resortId: 'r', weekStart: '2030-01-07', isPublished, candidateDrivers: [], shifts });
const TODAY = '2030-01-09';

describe('getPublishAvailability', () => {
  it('is disabled with no reason while the week is still loading', () => {
    expect(getPublishAvailability(undefined, TODAY)).toEqual({ enabled: false, label: 'Publish Rota', reason: null });
  });
  it('is enabled for a draft week with a shift today or later (today is NOT historical)', () => {
    expect(getPublishAvailability(week([shift('2030-01-09')]), TODAY)).toEqual({ enabled: true, label: 'Publish Rota', reason: null });
    expect(getPublishAvailability(week([shift('2030-01-13')]), TODAY).enabled).toBe(true);
  });
  it('stays enabled for a partially historical week', () => {
    expect(getPublishAvailability(week([shift('2030-01-07'), shift('2030-01-11')]), TODAY).enabled).toBe(true);
  });
  it('is enabled whether or not anything is assigned or covered (the server asks for acknowledgement, the UI does not pre-judge)', () => {
    expect(getPublishAvailability(week([shift('2030-01-11', 0)]), TODAY).enabled).toBe(true);
    expect(getPublishAvailability(week([shift('2030-01-11', 2)]), TODAY).enabled).toBe(true);
  });
  it('is disabled and labelled "Published" for a published week, with the reason', () => {
    expect(getPublishAvailability(week([shift('2030-01-11')], true), TODAY)).toEqual({
      enabled: false, label: 'Published', reason: 'This rota has already been published.',
    });
  });
  it('a published week reads Published even with no shifts', () => {
    expect(getPublishAvailability(week([], true), TODAY).label).toBe('Published');
  });
  it('is disabled for a week with no shifts', () => {
    expect(getPublishAvailability(week([]), TODAY)).toEqual({ enabled: false, label: 'Publish Rota', reason: 'There are no shifts to publish this week.' });
  });
  it('is disabled when every shift is before today', () => {
    expect(getPublishAvailability(week([shift('2030-01-07'), shift('2030-01-08')]), TODAY)).toEqual({
      enabled: false, label: 'Publish Rota', reason: 'This rota can’t be published because the week is in the past.',
    });
  });
});

describe('hasNoActiveAssignments', () => {
  it('is true only when no ACTIVE driver is assigned to any shift', () => {
    expect(hasNoActiveAssignments(week([shift('2030-01-11'), shift('2030-01-12')]))).toBe(true);
    expect(hasNoActiveAssignments(week([shift('2030-01-11', 0, 1)]))).toBe(true); // an inactive assignee does not count
    expect(hasNoActiveAssignments(week([shift('2030-01-11'), shift('2030-01-12', 1)]))).toBe(false);
    expect(hasNoActiveAssignments(undefined)).toBe(false);
  });
});

describe('describeUncoveredWarning', () => {
  it('uses correct singular / plural grammar', () => {
    expect(describeUncoveredWarning(1)).toBe('1 position is still uncovered.');
    expect(describeUncoveredWarning(2)).toBe('2 positions are still uncovered.');
    expect(describeUncoveredWarning(17)).toBe('17 positions are still uncovered.');
  });
});

describe('describePublishResult', () => {
  it('a fully covered publish is a plain success', () => {
    expect(describePublishResult({ uncoveredSlots: 0, alreadyPublished: false })).toEqual({
      tone: 'success', text: 'Rota published. Drivers can now see their assigned shifts.',
    });
  });
  it('an uncovered publish is warning-toned (never an error) and never implies full coverage', () => {
    const one = describePublishResult({ uncoveredSlots: 1, alreadyPublished: false });
    expect(one).toEqual({ tone: 'warning', text: 'Rota published. 1 position is still uncovered. Drivers can now see their assigned shifts.' });
    expect(describePublishResult({ uncoveredSlots: 2, alreadyPublished: false }).text).toContain('2 positions are still uncovered.');
    expect(one.text).not.toMatch(/fully covered|all (scheduled )?positions are covered/i);
  });
  it('already published is a plain, info-toned success', () => {
    expect(describePublishResult({ uncoveredSlots: 0, alreadyPublished: true })).toEqual({ tone: 'info', text: 'This rota is already published.' });
    expect(describePublishResult({ uncoveredSlots: 3, alreadyPublished: true }).tone).toBe('info');
  });
});

describe('describePublishError', () => {
  const kinds: PublishRotaErrorKind[] = ['historical_week', 'no_shifts', 'resort_inactive', 'resort_not_found', 'invalid_week', 'permission_denied', 'unknown'];
  it.each(kinds)('shows the repository\'s first-party copy for %s, never DB text', (kind) => {
    const error = new PublishRotaError(kind, { operation: 'rota.publishRota', code: '55006', cause: { details: 'secret' } });
    const described = describePublishError(error);
    expect(described.message).toBe(error.userMessage);
    expect(described.message).not.toMatch(/55006|secret|VD003|SQLSTATE/);
  });
  it('refetches when the screen may be stale (week passed / emptied / resort changed), not for permission or unknown errors', () => {
    const refresh = (kind: PublishRotaErrorKind) => describePublishError(new PublishRotaError(kind, { operation: 'x' })).shouldRefresh;
    expect(refresh('historical_week')).toBe(true);
    expect(refresh('no_shifts')).toBe(true);
    expect(refresh('resort_inactive')).toBe(true);
    expect(refresh('permission_denied')).toBe(false);
    expect(refresh('unknown')).toBe(false);
  });
  it('a non-repository error (network, bug) gets the generic publish message', () => {
    expect(describePublishError(new Error('fetch failed: ECONNRESET'))).toEqual({ message: 'Couldn’t publish the rota. Please try again.', shouldRefresh: false });
  });
  it('a plain RepositoryError uses its own safe message', () => {
    expect(describePublishError(new RepositoryError('boom', { operation: 'x', code: '42501' })).message).toBe('You do not have permission to do that.');
  });
});
