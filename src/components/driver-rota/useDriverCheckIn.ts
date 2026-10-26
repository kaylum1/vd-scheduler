import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getRepositories } from '../../repositories';
import { driverRotaKeys } from '../../repositories/queryKeys';
import { describeCheckInError, TOO_EARLY_HINT_MS, type ServerCheckInHint } from './driverCheckInUi';

export interface ShiftCheckInStatus {
  pending: boolean;
  /** The server's own check-in instant from a tap in this session (the week refetch then confirms it). */
  checkedInAt: string | null;
  /** Driver-safe copy for the last failed tap on THIS shift. */
  error: string | null;
  hint: ServerCheckInHint | null;
  /** True after a first-time success in this session (a repeat is silent: it is just "Checked in at"). */
  justCheckedIn: boolean;
}

const IDLE: ShiftCheckInStatus = { pending: false, checkedInAt: null, error: null, hint: null, justCheckedIn: false };

/**
 * Per-shift Check in controller for Driver My Rota. The only repository call is
 * checkInToShift({ assignmentId }): no driver id, no time -- the server derives both and the success
 * time shown is the server's. State is keyed by assignment so Lunch and Dinner are independent, and it
 * is discarded when the week or driver changes; a late result for a previous week is dropped from the
 * UI (the server-side check-in is real, so that week's query is still refreshed).
 */
export function useDriverCheckIn(driverId: string | null, weekStart: string) {
  const queryClient = useQueryClient();
  const [statuses, setStatuses] = useState<Record<string, ShiftCheckInStatus>>({});
  const inFlight = useRef(new Set<string>());
  const scope = `${driverId ?? ''}|${weekStart}`;
  const scopeRef = useRef(scope);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    scopeRef.current = scope;
    setStatuses({});
  }, [scope]);

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live) clearTimeout(t);
      live.clear();
    };
  }, []);

  const patch = useCallback((assignmentId: string, change: Partial<ShiftCheckInStatus>) => {
    setStatuses((prev) => ({ ...prev, [assignmentId]: { ...(prev[assignmentId] ?? IDLE), ...change } }));
  }, []);

  const checkIn = useCallback(
    async (assignmentId: string) => {
      // A ref (not state) guards double submit: two taps in one render both see the same state.
      if (inFlight.current.has(assignmentId) || !driverId) return;
      inFlight.current.add(assignmentId);
      const startedIn = scopeRef.current;
      const weekKey = driverRotaKeys.week(driverId, weekStart);
      patch(assignmentId, { pending: true, error: null });
      try {
        const result = await getRepositories().rota.checkInToShift({ assignmentId });
        if (scopeRef.current === startedIn) {
          patch(assignmentId, { pending: false, checkedInAt: result.checkIn.checkedInAt, error: null, hint: null, justCheckedIn: result.created });
        }
        await queryClient.invalidateQueries({ queryKey: weekKey });
      } catch (error) {
        const described = describeCheckInError(error);
        if (scopeRef.current === startedIn) {
          patch(assignmentId, { pending: false, error: described.message, hint: described.hint });
          if (described.hint === 'too_early') {
            const timer = setTimeout(() => {
              timers.current.delete(timer);
              if (scopeRef.current === startedIn) patch(assignmentId, { hint: null });
            }, TOO_EARLY_HINT_MS);
            timers.current.add(timer);
          }
        }
        // A server rejection means this screen may be stale: re-read the week (best effort).
        if (described.shouldRefresh) void queryClient.invalidateQueries({ queryKey: weekKey });
      } finally {
        inFlight.current.delete(assignmentId);
      }
    },
    [driverId, weekStart, queryClient, patch],
  );

  const statusOf = useCallback((assignmentId: string): ShiftCheckInStatus => statuses[assignmentId] ?? IDLE, [statuses]);
  return { checkIn, statusOf };
}
