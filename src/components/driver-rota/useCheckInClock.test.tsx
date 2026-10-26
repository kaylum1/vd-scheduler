// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useCheckInClock } from './useCheckInClock';
import type { CheckInWindowFields } from './driverCheckInUi';
import hookSource from './useCheckInClock.ts?raw';

const T0 = Date.parse('2030-01-07T16:00:00.000Z');
const OPENS = '2030-01-07T16:30:00.000Z';
const CLOSES = '2030-01-07T20:30:00.000Z';
const shifts: CheckInWindowFields[] = [{ checkedInAt: null, checkInOpensAt: OPENS, checkInClosesAt: CLOSES }];

let seen: Date;
function Probe({ list }: { list: CheckInWindowFields[] }) {
  seen = useCheckInClock(list);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCheckInClock', () => {
  it('wakes exactly at the next window opening and passes the instant', () => {
    render(<Probe list={shifts} />);
    expect(seen.getTime()).toBe(T0);
    act(() => vi.advanceTimersByTime(29 * 60_000));
    // The wake-ups are capped at a minute, so it has ticked but is still before the opening.
    expect(seen.getTime()).toBeLessThan(Date.parse(OPENS));
    act(() => vi.advanceTimersByTime(60_000 + 10));
    expect(seen.getTime()).toBeGreaterThanOrEqual(Date.parse(OPENS));
  });

  it('keeps ONE pending timer, not one per shift', () => {
    const many = Array.from({ length: 6 }, () => shifts[0]);
    render(<Probe list={many} />);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('runs no timer when there are no shifts, and clears it on unmount', () => {
    const { unmount, rerender } = render(<Probe list={[]} />);
    expect(vi.getTimerCount()).toBe(0);
    rerender(<Probe list={shifts} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-reads the clock when the window regains focus and when the tab becomes visible', () => {
    render(<Probe list={shifts} />);
    vi.setSystemTime(T0 + 3_600_000);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(seen.getTime()).toBe(T0 + 3_600_000);
    vi.setSystemTime(T0 + 7_200_000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(seen.getTime()).toBe(T0 + 7_200_000);
  });

  it('is presentation only: never polls the server', () => {
    expect(hookSource).not.toMatch(/getRepositories|fetch\(|useQuery|setInterval|invalidate/);
  });
});
