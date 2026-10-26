import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getRepositories } from '../../repositories';
import { isPublishRotaConfirmationRequired } from '../../repositories/errors';
import { availabilityKeys, managerRotaKeys } from '../../repositories/queryKeys';
import type { PublishRotaParams } from '../../repositories/domain';
import { describePublishError, describePublishResult } from './publishRotaUi';

export interface PublishNotice {
  tone: 'success' | 'info' | 'warning' | 'error';
  text: string;
}

/**
 * The Publish Rota lifecycle for ONE resort + week: dialog open/closed, the
 * confirm -> uncovered stage, the running call, and the result / error notice.
 * It only ever calls RotaRepository.publishRota; every rule, count and error
 * classification comes back from the repository as typed values (no SQLSTATEs,
 * no RPC names, no table knowledge here).
 *
 * A result or error belongs to the resort + week it was produced for: changing
 * either closes the dialog and clears the notice, and a call that finishes after
 * the manager moved on is never shown against the new selection (its data is
 * still refreshed).
 */
export function usePublishRota(resortId: string | null, weekStart: string) {
  const queryClient = useQueryClient();
  const selectionKey = `${resortId ?? ''}|${weekStart}`;
  const selectionRef = useRef(selectionKey);
  selectionRef.current = selectionKey;

  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<'confirm' | 'uncovered'>('confirm');
  const [uncoveredSlots, setUncoveredSlots] = useState(0);
  const [notice, setNotice] = useState<PublishNotice | null>(null);
  const [publishingKey, setPublishingKey] = useState<string | null>(null);
  const publishing = publishingKey === selectionKey;
  // Synchronous guard: state flushes after the click handler, a ref does not -- so a second click in the
  // same tick can never start a second call.
  const runningRef = useRef(false);

  const mutation = useMutation({ mutationFn: (params: PublishRotaParams) => getRepositories().rota.publishRota(params) });

  useEffect(() => {
    setOpen(false);
    setStage('confirm');
    setUncoveredSlots(0);
    setNotice(null);
  }, [resortId, weekStart]);

  const openDialog = useCallback(() => {
    setNotice(null);
    setStage('confirm');
    setUncoveredSlots(0);
    setOpen(true);
  }, []);

  // Stable identity (the Modal re-focuses its panel whenever onClose changes); ignored while a call is running.
  const cancel = useCallback(() => {
    if (!runningRef.current) setOpen(false);
  }, []);

  const refresh = useCallback(
    async (rid: string, week: string) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: managerRotaKeys.week(rid, week) }),
        queryClient.invalidateQueries({ queryKey: availabilityKeys.managerSummary(rid, week) }),
        queryClient.invalidateQueries({ predicate: (query) => availabilityKeys.isManagerDetailForWeek(query.queryKey, week) }),
      ]);
    },
    [queryClient]
  );

  const confirm = useCallback(async () => {
    if (!resortId || runningRef.current) return;
    runningRef.current = true;
    const key = selectionKey;
    const rid = resortId;
    const week = weekStart;
    // The first call never acknowledges anything; only the explicit "Publish anyway" does.
    const confirmUncovered = stage === 'uncovered';
    setPublishingKey(key);
    setNotice(null);
    try {
      const result = await mutation.mutateAsync({ resortId: rid, weekStart: week, confirmUncovered });
      // The server/read model stays authoritative: refetch, never fabricate state here.
      await refresh(rid, week);
      if (selectionRef.current === key) {
        setOpen(false);
        setStage('confirm');
        setNotice(describePublishResult(result));
      }
    } catch (error) {
      if (isPublishRotaConfirmationRequired(error)) {
        // The SERVER's count, shown as-is; the same dialog switches to the warning.
        if (selectionRef.current === key) {
          setUncoveredSlots(error.uncoveredSlots);
          setStage('uncovered');
        }
      } else {
        const described = describePublishError(error);
        if (described.shouldRefresh) await refresh(rid, week);
        if (selectionRef.current === key) {
          setOpen(false);
          setStage('confirm');
          setNotice({ tone: 'error', text: described.message });
        }
      }
    } finally {
      runningRef.current = false;
      setPublishingKey((current) => (current === key ? null : current));
    }
  }, [mutation, refresh, resortId, selectionKey, stage, weekStart]);

  return {
    open,
    stage,
    uncoveredSlots,
    notice,
    publishing,
    openDialog,
    cancel,
    confirm,
    dismissNotice: useCallback(() => setNotice(null), []),
  };
}
