import { describe, expect, it, vi } from 'vitest';
import { runAutoRota } from './autoRotaOrchestration';
import { AutoRotaError, type AutoRotaErrorKind } from './errors';
import type { AutoRotaPlan, AutoRotaResult, ManagerWeekRota } from './domain';

const week = (availableFor: string): ManagerWeekRota => ({
  resortId: 'r',
  weekStart: '2030-01-07',
  isPublished: false,
  candidateDrivers: [{ driverId: 'a', fullName: 'A' }, { driverId: 'b', fullName: 'B' }],
  shifts: [
    {
      shiftInstanceId: 's', shiftTypeId: 't', date: '2030-01-11', name: 'Dinner', sortOrder: 1, startTime: '18:00', endTime: '21:30',
      requiredDrivers: 1, assignments: [], availabilityByDriver: { a: availableFor === 'a' ? 'available' : 'unavailable', b: availableFor === 'b' ? 'available' : 'unavailable' },
    },
  ],
});
const result: AutoRotaResult = { resortId: 'r', weekStart: '2030-01-07', assignedCount: 1, remainingOpenSlots: 0, uncoveredShiftIds: [], skippedPastShiftCount: 0, runId: 'run' };
const err = (kind: AutoRotaErrorKind) => new AutoRotaError(kind, { operation: 'test' });

describe('runAutoRota (one attempt, one retry)', () => {
  it('succeeds on the first attempt with ONE read and ONE apply', async () => {
    const readWeek = vi.fn(async () => week('a'));
    const applyPlan = vi.fn(async (_plan: AutoRotaPlan) => result);
    await expect(runAutoRota({ readWeek, applyPlan, operationalToday: () => '2030-01-01' })).resolves.toEqual(result);
    expect(readWeek).toHaveBeenCalledTimes(1);
    expect(applyPlan).toHaveBeenCalledTimes(1);
    expect(applyPlan.mock.calls[0][0].assignments).toEqual([{ shiftInstanceId: 's', driverId: 'a' }]);
  });

  it.each(['stale_plan', 'historical_shift'] as const)('%s: re-reads and re-plans from scratch exactly once', async (kind) => {
    let reads = 0;
    const readWeek = vi.fn(async () => week(++reads === 1 ? 'a' : 'b')); // the world changed between attempts
    const applyPlan = vi.fn(async (plan: AutoRotaPlan) => {
      if (applyPlan.mock.calls.length === 1) throw err(kind);
      return { ...result, assignedCount: plan.plannedAssignmentCount };
    });
    await runAutoRota({ readWeek, applyPlan, operationalToday: () => '2030-01-01' });
    expect(readWeek).toHaveBeenCalledTimes(2);
    expect(applyPlan).toHaveBeenCalledTimes(2);
    expect(applyPlan.mock.calls[0][0].assignments).toEqual([{ shiftInstanceId: 's', driverId: 'a' }]);
    expect(applyPlan.mock.calls[1][0].assignments).toEqual([{ shiftInstanceId: 's', driverId: 'b' }]); // fresh plan
  });

  it('evaluates the operational date PER ATTEMPT, so a midnight crossing is seen by the re-plan (the past shift is then skipped)', async () => {
    const today = vi.fn().mockReturnValueOnce('2030-01-11').mockReturnValue('2030-01-12'); // Friday, then Saturday
    const applyPlan = vi.fn(async (plan: AutoRotaPlan) => {
      if (applyPlan.mock.calls.length === 1) throw err('historical_shift');
      return { ...result, assignedCount: plan.plannedAssignmentCount };
    });
    await runAutoRota({ readWeek: async () => week('a'), applyPlan, operationalToday: today });
    expect(applyPlan.mock.calls[0][0].assignments).toHaveLength(1); // Friday: planned
    expect(applyPlan.mock.calls[1][0].assignments).toHaveLength(0); // Saturday: Friday's shift is now past -> skipped
    expect(applyPlan.mock.calls[1][0].skippedPastShiftCount).toBe(1);
  });

  it.each(['stale_plan', 'historical_shift'] as const)('a second %s surfaces the typed error: two applies at most, no loop', async (kind) => {
    const applyPlan = vi.fn(async () => {
      throw err(kind);
    });
    const error = await runAutoRota({ readWeek: async () => week('a'), applyPlan, operationalToday: () => '2030-01-01' }).catch((e) => e);
    expect(error).toBeInstanceOf(AutoRotaError);
    expect((error as AutoRotaError).kind).toBe(kind);
    expect(applyPlan).toHaveBeenCalledTimes(2);
  });

  it.each(['published_week', 'historical_week', 'permission_denied', 'resort_not_found', 'invalid_week', 'invalid_plan', 'unknown'] as const)(
    '%s is never retried',
    async (kind) => {
      const readWeek = vi.fn(async () => week('a'));
      const applyPlan = vi.fn(async () => {
        throw err(kind);
      });
      const error = await runAutoRota({ readWeek, applyPlan, operationalToday: () => '2030-01-01' }).catch((e) => e);
      expect((error as AutoRotaError).kind).toBe(kind);
      expect(readWeek).toHaveBeenCalledTimes(1);
      expect(applyPlan).toHaveBeenCalledTimes(1);
    }
  );

  it('a non-Auto-Rota error (e.g. a network failure) is not retried either', async () => {
    const applyPlan = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(runAutoRota({ readWeek: async () => week('a'), applyPlan, operationalToday: () => '2030-01-01' })).rejects.toThrow('network down');
    expect(applyPlan).toHaveBeenCalledTimes(1);
  });

  it('an error while RE-READING the week on the retry propagates (it is not swallowed)', async () => {
    let reads = 0;
    const readWeek = vi.fn(async () => {
      if (++reads === 2) throw new Error('read failed');
      return week('a');
    });
    const applyPlan = vi.fn(async () => {
      throw err('stale_plan');
    });
    await expect(runAutoRota({ readWeek, applyPlan, operationalToday: () => '2030-01-01' })).rejects.toThrow('read failed');
  });
});
