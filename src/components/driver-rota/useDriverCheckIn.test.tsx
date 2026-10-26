// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resetRepositoriesForTesting } from '../../repositories';
import { MockRotaRepository } from '../../repositories/mock/rota';
import { DriverCheckInError } from '../../repositories/errors';
import { resetMockFixturesForTesting } from '../../repositories/mock/fixtures';
import { useDriverCheckIn } from './useDriverCheckIn';

const RESULT = (assignmentId: string) => ({
  checkIn: { checkInId: 'c1', assignmentId, shiftInstanceId: 's1', checkedInAt: '2030-01-07T17:05:00.000Z' },
  created: true,
});

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
const setup = (initial: { driverId: string | null; week: string } = { driverId: 'mock-gianni', week: '2030-01-07' }) =>
  renderHook(({ driverId, week }) => useDriverCheckIn(driverId, week), { wrapper, initialProps: { driverId: initial.driverId, week: initial.week } });

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
});
afterEach(() => vi.restoreAllMocks());

describe('useDriverCheckIn', () => {
  it('two taps in the SAME tick make exactly one repository call (a ref guard, not just a disabled button)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(MockRotaRepository.prototype, 'checkInToShift').mockImplementation(async (p) => {
      await gate;
      return RESULT(p.assignmentId);
    });
    const { result } = setup();
    await act(async () => {
      void result.current.checkIn('a1');
      void result.current.checkIn('a1');
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.statusOf('a1').pending).toBe(true);
    await act(async () => release());
    expect(result.current.statusOf('a1')).toMatchObject({ pending: false, checkedInAt: '2030-01-07T17:05:00.000Z', justCheckedIn: true });
    // Once settled, a fresh tap on the same assignment is allowed again (e.g. after an error).
    await act(async () => result.current.checkIn('a1'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('different assignments are independent (their pending states and calls do not block each other)', async () => {
    const gate = new Promise<void>(() => {});
    const spy = vi.spyOn(MockRotaRepository.prototype, 'checkInToShift').mockImplementation(async () => {
      await gate;
      return RESULT('x');
    });
    const { result } = setup();
    await act(async () => {
      void result.current.checkIn('lunch');
      void result.current.checkIn('dinner');
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.statusOf('lunch').pending).toBe(true);
    expect(result.current.statusOf('dinner').pending).toBe(true);
    expect(result.current.statusOf('other').pending).toBe(false);
  });

  it('a result that lands after the week changed is dropped from the UI (but that week is still refreshed)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(MockRotaRepository.prototype, 'checkInToShift').mockImplementation(async (p) => {
      await gate;
      return RESULT(p.assignmentId);
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result, rerender } = setup();
    await act(async () => {
      void result.current.checkIn('a1');
    });
    rerender({ driverId: 'mock-gianni', week: '2030-01-14' });
    expect(result.current.statusOf('a1').pending).toBe(false);
    await act(async () => release());
    expect(result.current.statusOf('a1')).toMatchObject({ pending: false, checkedInAt: null, justCheckedIn: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['driver-rota', 'mock-gianni', '2030-01-07'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['driver-rota', 'mock-gianni', '2030-01-14'] });
  });

  it('a late FAILURE for a previous week does not surface an alert in the new week', async () => {
    let fail!: () => void;
    const gate = new Promise<void>((_, rej) => (fail = () => rej(new DriverCheckInError('check_in_closed', { operation: 'x' }))));
    vi.spyOn(MockRotaRepository.prototype, 'checkInToShift').mockImplementation(async () => {
      await gate;
      return RESULT('a1');
    });
    const { result, rerender } = setup();
    await act(async () => {
      void result.current.checkIn('a1');
    });
    rerender({ driverId: 'mock-gianni', week: '2030-01-14' });
    await act(async () => fail());
    expect(result.current.statusOf('a1')).toMatchObject({ error: null, hint: null });
  });

  it('state is discarded when the week or driver changes', async () => {
    vi.spyOn(MockRotaRepository.prototype, 'checkInToShift').mockRejectedValue(new DriverCheckInError('unknown', { operation: 'x' }));
    const { result, rerender } = setup();
    await act(async () => result.current.checkIn('a1'));
    expect(result.current.statusOf('a1').error).toBe('Couldn’t check in. Please try again.');
    rerender({ driverId: 'mock-gianni', week: '2030-01-14' });
    await waitFor(() => expect(result.current.statusOf('a1').error).toBeNull());
    await act(async () => result.current.checkIn('a1'));
    rerender({ driverId: 'mock-alex', week: '2030-01-14' });
    await waitFor(() => expect(result.current.statusOf('a1').error).toBeNull());
  });

  it('a "too early" hint is temporary; a "closed" hint stays', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(MockRotaRepository.prototype, 'checkInToShift');
      spy.mockRejectedValueOnce(new DriverCheckInError('check_in_too_early', { operation: 'x' }));
      spy.mockRejectedValueOnce(new DriverCheckInError('check_in_closed', { operation: 'x' }));
      const { result } = setup();
      await act(async () => result.current.checkIn('early'));
      await act(async () => result.current.checkIn('late'));
      expect(result.current.statusOf('early').hint).toBe('too_early');
      expect(result.current.statusOf('late').hint).toBe('closed');
      await act(async () => vi.advanceTimersByTime(31_000));
      expect(result.current.statusOf('early').hint).toBeNull();
      expect(result.current.statusOf('late').hint).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no driver identity it never calls the repository', async () => {
    const spy = vi.spyOn(MockRotaRepository.prototype, 'checkInToShift');
    const { result } = setup({ driverId: null, week: '2030-01-07' });
    await act(async () => result.current.checkIn('a1'));
    expect(spy).not.toHaveBeenCalled();
  });
});
