import { describe, expect, it } from 'vitest';
import { describeAutoRotaError, describeAutoRotaResult, getGenerateAvailability, hasPastShifts } from './autoRotaUi';
import { AutoRotaError, RepositoryError, type AutoRotaErrorKind } from '../../repositories/errors';
import type { ManagerRotaShift, ManagerWeekRota } from '../../repositories/domain';

const shift = (date: string): ManagerRotaShift => ({
  shiftInstanceId: `s-${date}`, shiftTypeId: 't', date, name: 'Dinner', sortOrder: 1, startTime: '18:00', endTime: '21:30',
  requiredDrivers: 1, assignments: [], availabilityByDriver: {},
});
const week = (dates: string[], isPublished = false): ManagerWeekRota => ({
  resortId: 'r', weekStart: '2030-01-07', isPublished, candidateDrivers: [], shifts: dates.map(shift),
});
const TODAY = '2030-01-09';

describe('getGenerateAvailability', () => {
  it('is disabled with no reason while the week is still loading', () => {
    expect(getGenerateAvailability(undefined, TODAY)).toEqual({ enabled: false, reason: null });
  });
  it('is enabled for a draft week with a shift today or later (today is NOT historical)', () => {
    expect(getGenerateAvailability(week(['2030-01-09']), TODAY).enabled).toBe(true);
    expect(getGenerateAvailability(week(['2030-01-13']), TODAY).enabled).toBe(true);
  });
  it('stays enabled for a partially historical week', () => {
    expect(getGenerateAvailability(week(['2030-01-07', '2030-01-11']), TODAY).enabled).toBe(true);
  });
  it('is disabled for a published week, with a reason', () => {
    expect(getGenerateAvailability(week(['2030-01-11'], true), TODAY)).toEqual({ enabled: false, reason: 'Auto-Rota can’t run after this rota has been published.' });
  });
  it('is disabled when every shift is before today', () => {
    expect(getGenerateAvailability(week(['2030-01-07', '2030-01-08']), TODAY)).toEqual({ enabled: false, reason: 'Auto-Rota can’t generate a historical rota.' });
  });
  it('is disabled for a week with no shifts', () => {
    expect(getGenerateAvailability(week([]), TODAY)).toEqual({ enabled: false, reason: 'There are no shifts to fill this week.' });
  });
});

describe('hasPastShifts', () => {
  it('is true only when some shift is before today', () => {
    expect(hasPastShifts(week(['2030-01-07', '2030-01-11']), TODAY)).toBe(true);
    expect(hasPastShifts(week(['2030-01-09', '2030-01-11']), TODAY)).toBe(false);
    expect(hasPastShifts(undefined, TODAY)).toBe(false);
  });
});

describe('describeAutoRotaResult', () => {
  it.each([
    [8, 0, 'success', '8 assignments added. All scheduled positions are covered.'],
    [1, 0, 'success', '1 assignment added. All scheduled positions are covered.'],
    [8, 2, 'success', '8 assignments added. 2 positions remain uncovered.'],
    [8, 1, 'success', '8 assignments added. 1 position remains uncovered.'],
    [0, 0, 'info', 'No new assignments were needed. The rota is fully covered.'],
    [0, 2, 'info', 'No assignments could be added. 2 positions remain uncovered.'],
    [0, 1, 'info', 'No assignments could be added. 1 position remains uncovered.'],
  ] as const)('%i added, %i remaining -> %s', (assignedCount, remainingOpenSlots, tone, text) => {
    expect(describeAutoRotaResult({ assignedCount, remainingOpenSlots })).toEqual({ tone, text });
  });
});

describe('describeAutoRotaError', () => {
  const kinds: AutoRotaErrorKind[] = ['published_week', 'historical_week', 'historical_shift', 'stale_plan', 'permission_denied', 'resort_not_found', 'invalid_week', 'invalid_plan', 'unknown'];

  it.each(kinds)('%s uses the repository\'s manager-facing message', (kind) => {
    const error = new AutoRotaError(kind, { operation: 'x', code: 'VD002', cause: { details: 'stale_plan' } });
    expect(describeAutoRotaError(error).message).toBe(error.userMessage);
  });

  it('asks for a refetch exactly when the screen may be stale (published, historical, stale plan)', () => {
    const refresh = (kind: AutoRotaErrorKind) => describeAutoRotaError(new AutoRotaError(kind, { operation: 'x' })).shouldRefresh;
    expect(kinds.filter(refresh).sort()).toEqual(['historical_shift', 'historical_week', 'published_week', 'stale_plan']);
  });

  it('a generic RepositoryError keeps its safe userMessage; anything else gets the generic text', () => {
    const repoError = new RepositoryError('rota.x failed: boom', { operation: 'rota.x', code: '42501' });
    expect(describeAutoRotaError(repoError)).toEqual({ message: 'You do not have permission to do that.', shouldRefresh: false });
    expect(describeAutoRotaError(new Error('network'))).toEqual({ message: 'Something went wrong. Please try again.', shouldRefresh: false });
    expect(describeAutoRotaError('weird')).toEqual({ message: 'Something went wrong. Please try again.', shouldRefresh: false });
  });
});
