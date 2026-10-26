import { useEffect, useMemo, useState } from 'react';
import { nextCheckInBoundary, type CheckInWindowFields } from './driverCheckInUi';

const MAX_TICK_MS = 60 * 1000;
const SLACK_MS = 2;

/**
 * The device clock for the check-in display: ONE lightweight timer for the whole page (never one per
 * shift). It wakes at the next display change (a window opening, or just after one closing) and at
 * least once a minute, and it re-reads the clock when the driver returns to the app. Presentation
 * only -- the server decides what a tap is allowed to do.
 */
export function useCheckInClock(shifts: CheckInWindowFields[]): Date {
  const [now, setNow] = useState(() => new Date());
  const hasShifts = shifts.length > 0;
  const boundary = useMemo(() => nextCheckInBoundary(shifts, now), [shifts, now]);

  useEffect(() => {
    if (!hasShifts) return undefined;
    const untilBoundary = boundary === null ? MAX_TICK_MS : boundary - Date.now() + SLACK_MS;
    const timer = setTimeout(() => setNow(new Date()), Math.max(1, Math.min(MAX_TICK_MS, untilBoundary)));
    return () => clearTimeout(timer);
  }, [boundary, hasShifts, now]);

  useEffect(() => {
    const refresh = () => setNow(new Date());
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return now;
}
