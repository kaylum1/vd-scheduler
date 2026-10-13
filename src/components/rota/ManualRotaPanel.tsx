import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { InlineNotice } from '../ui/InlineNotice';
import { IconCalendar } from '../ui/icons';
import { AssignDriverDialog, type AssignDialogState } from './AssignDriverDialog';
import { ManualRotaShiftCard, assignKey, removeKey } from './ManualRotaShiftCard';
import { useManagerWeekRota } from './useManagerWeekRota';
import { describeRotaError } from './rotaErrorMessages';
import { formatDayLabel, parseISODate, toISODate, WEEKDAY_LABELS_FULL } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import { getShiftCoverage } from '../../lib/rotaCoverage';
import { getRepositories } from '../../repositories';
import { isAvailabilityOverrideRequired } from '../../repositories/errors';
import { managerRotaKeys } from '../../repositories/queryKeys';
import type { AssignDriverParams, ManagerRotaAssignment, ManagerRotaDriver, ManagerRotaShift, UnassignDriverParams } from '../../repositories/domain';

/**
 * The live Manual Rota: one resort + one operational week, rendered from the
 * manager repository (never Supabase directly), with assign / remove and
 * immediate Covered / Uncovered feedback.
 *
 * The database owns every rule (availability override acknowledgement, active
 * driver, same resort, past dates, attendance...). This component only decides
 * WHEN to ask the manager to confirm, and it never trusts what it last
 * displayed: even a driver shown as Available can come back as
 * "override required" from the server (they changed their answer since the
 * page loaded), which opens the matching warning instead of failing.
 *
 * Display-only for publication: it shows whether the week is published but has
 * no publish/unpublish controls, and a published week stays fully editable.
 */
export function ManualRotaPanel({ resortId, weekStart }: { resortId: string | null; weekStart: string }) {
  const queryClient = useQueryClient();
  const rotaQuery = useManagerWeekRota(resortId, weekStart);

  const [dialog, setDialog] = useState<AssignDialogState | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Keys of the actions currently running. Each action's button is `disabled` while its key is here
  // (React flushes this before another click can land), which is what prevents a duplicate submit.
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  const dialogCounter = useRef(0);

  const assignMutation = useMutation({ mutationFn: (params: AssignDriverParams) => getRepositories().rota.assignDriver(params) });
  const unassignMutation = useMutation({ mutationFn: (params: UnassignDriverParams) => getRepositories().rota.unassignDriver(params) });

  const refresh = useCallback(
    () => (resortId ? queryClient.invalidateQueries({ queryKey: managerRotaKeys.week(resortId, weekStart) }) : Promise.resolve()),
    [queryClient, resortId, weekStart]
  );

  const track = async (key: string, run: () => Promise<void>) => {
    setInFlight((current) => new Set(current).add(key));
    try {
      await run();
    } finally {
      setInFlight((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const showFailure = async (error: unknown, inDialog: boolean) => {
    const described = describeRotaError(error);
    if (inDialog) setDialogError(described.message);
    else setActionError(described.message);
    if (described.shouldRefresh) await refresh();
  };

  const runAssign = (target: AssignDialogState, confirmAvailabilityOverride: boolean, reason: string | null, inDialog: boolean) =>
    track(assignKey(target.shiftInstanceId, target.driverId), async () => {
      try {
        await assignMutation.mutateAsync({
          shiftInstanceId: target.shiftInstanceId,
          driverId: target.driverId,
          confirmAvailabilityOverride,
          reason,
        });
        setDialog(null);
        setDialogError(null);
        setActionError(null);
        await refresh();
      } catch (error) {
        if (isAvailabilityOverrideRequired(error)) {
          // The race-safe path: the SERVER says an override is needed, so show the
          // state IT reports -- not whatever this screen last displayed.
          setDialogError(null);
          setDialog({ ...target, availability: error.availabilityState });
        } else {
          await showFailure(error, inDialog);
        }
      }
    });

  const handleAssign = (shift: ManagerRotaShift, driver: ManagerRotaDriver) => {
    const availability = shift.availabilityByDriver[driver.driverId] ?? 'not_submitted';
    const coverage = getShiftCoverage(shift);
    const target: AssignDialogState = {
      key: (dialogCounter.current += 1),
      shiftInstanceId: shift.shiftInstanceId,
      driverId: driver.driverId,
      driverName: driver.fullName,
      shiftName: shift.name,
      availability: availability === 'available' ? null : availability,
      coverage: coverage.isCovered ? { active: coverage.activeAssigned, required: coverage.required } : null,
    };

    setActionError(null);
    if (target.availability === null && target.coverage === null) {
      // Looks Available and the shift needs staff: try it straight away. If the
      // server disagrees, runAssign opens the right dialog.
      void runAssign(target, false, null, false);
    } else {
      setDialogError(null);
      setDialog(target);
    }
  };

  const handleConfirm = (reason: string | null) => {
    if (!dialog) return;
    // An availability warning on screen means the manager is acknowledging it now.
    void runAssign(dialog, dialog.availability !== null, reason, true);
  };

  const handleRemove = (shift: ManagerRotaShift, assignment: ManagerRotaAssignment) => {
    setActionError(null);
    void track(removeKey(shift.shiftInstanceId, assignment.driverId), async () => {
      try {
        await unassignMutation.mutateAsync({ shiftInstanceId: shift.shiftInstanceId, driverId: assignment.driverId });
        await refresh();
      } catch (error) {
        await showFailure(error, false);
      }
    });
  };

  const closeDialog = useCallback(() => {
    setDialog(null);
    setDialogError(null);
  }, []);

  // "Today" is the resort's operational day (Europe/Zurich), never the browser's.
  const today = toISODate(getOperationalToday());

  const days = useMemo(() => {
    const byDate = new Map<string, ManagerRotaShift[]>();
    for (const shift of rotaQuery.data?.shifts ?? []) {
      const list = byDate.get(shift.date) ?? [];
      list.push(shift);
      byDate.set(shift.date, list);
    }
    // The repository already returns shifts ordered by date; Map preserves that.
    return [...byDate.entries()];
  }, [rotaQuery.data]);

  const rota = rotaQuery.data;
  const dialogBusy = dialog ? inFlight.has(assignKey(dialog.shiftInstanceId, dialog.driverId)) : false;

  return (
    <Card style={{ marginBottom: 16 }}>
      <CardHeader title="Manual Rota" />
      <div className="manual-rota">
        {!resortId ? (
          <EmptyState icon={<IconCalendar />} title="Choose a resort to see its rota." />
        ) : rotaQuery.isLoading ? (
          <div className="config-loading" role="status">
            Loading rota…
          </div>
        ) : rotaQuery.isError || !rota ? (
          <div className="config-error" role="alert">
            <p>Couldn’t load the rota. Please try again.</p>
            <Button variant="secondary" size="sm" onClick={() => rotaQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {rota.isPublished && (
              <InlineNotice tone="info">This rota is published. Manager assignment changes are visible immediately.</InlineNotice>
            )}
            {actionError && (
              <InlineNotice tone="error" onDismiss={() => setActionError(null)}>
                {actionError}
              </InlineNotice>
            )}

            {days.length === 0 ? (
              <EmptyState icon={<IconCalendar />} title="No shifts are scheduled for this week." />
            ) : (
              days.map(([date, shifts]) => {
                const day = parseISODate(date);
                const dayIndex = (day.getDay() + 6) % 7;
                const headingId = `manual-rota-day-${date}`;
                return (
                  <section key={date} className="manual-rota__day" aria-labelledby={headingId}>
                    <h3 id={headingId} className="manual-rota__day-title">
                      {WEEKDAY_LABELS_FULL[dayIndex]} <span>{formatDayLabel(day)}</span>
                    </h3>
                    {shifts.map((shift) => (
                      <ManualRotaShiftCard
                        key={shift.shiftInstanceId}
                        shift={shift}
                        candidates={rota.candidateDrivers}
                        readOnly={shift.date < today}
                        inFlight={inFlight}
                        onAssign={handleAssign}
                        onRemove={handleRemove}
                      />
                    ))}
                  </section>
                );
              })
            )}
          </>
        )}
      </div>

      {dialog && (
        <AssignDriverDialog key={dialog.key} dialog={dialog} busy={dialogBusy} error={dialogError} onConfirm={handleConfirm} onCancel={closeDialog} />
      )}
    </Card>
  );
}
