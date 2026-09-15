import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../../components/layout/PageHeader';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { InlineNotice } from '../../components/ui/InlineNotice';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconCalendar, IconCheck, IconClock, IconLock } from '../../components/ui/icons';
import { WeekNav } from '../../components/rota/WeekNav';
import {
  addDays,
  formatDayLabel,
  formatWeekRangeLabel,
  parseISODate,
  startOfWeek,
  toISODate,
  WEEKDAY_LABELS_FULL,
} from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import { getDataProvider } from '../../lib/env';
import { getRepositories } from '../../repositories';
import { resolveMockDriverIdentity } from '../../repositories/mock/identityBridge';
import { useAuth } from '../../auth/AuthContext';
import type { AvailabilityStatus, DriverVisibleShift } from '../../repositories/domain';

/**
 * Resolves the current driver's identity in the id space the repository
 * layer expects. In Supabase mode `currentUser.driverId`/`resortId` already
 * are real database ids -- used directly. In mock mode they are Stage 1.1's
 * own driver-switcher ids instead (see repositories/mock/identityBridge.ts
 * for why `AuthContext` itself can't just switch this over), so this page
 * bridges them before calling into the repository layer.
 */
function useDriverRepositoryIdentity(): { driverId: string | null; resortId: string | null } {
  const { currentUser } = useAuth();
  if (!currentUser || currentUser.role !== 'driver') return { driverId: null, resortId: null };
  if (getDataProvider() === 'mock') {
    const identity = resolveMockDriverIdentity(currentUser.driverId);
    return { driverId: identity.driverId, resortId: identity.resortId };
  }
  return { driverId: currentUser.driverId, resortId: currentUser.resortId };
}

/**
 * Stage 3: the live Driver Availability page -- replaces the Stage 1.1
 * mock-data version entirely. Renders real shift_instances for the
 * driver's own resort, dynamically (no hard-coded shift names), and reads/
 * writes through the repository layer only (mock or Supabase, depending on
 * VITE_DATA_PROVIDER) -- never a direct Supabase client call.
 *
 * Answering a shift is exactly two questions in sequence: (1) can you work
 * it (Available/Unavailable, saved immediately, one shift at a time), and
 * separately (2) once every shift this week has an answer, an explicit
 * "Confirm availability" action. The driver never sees required_drivers,
 * pay, or any other driver's answers -- see DriverVisibleShift/
 * AvailabilityAnswer in repositories/domain.ts and docs/business-rules.md.
 */
export function AvailabilityPage() {
  const { currentUser } = useAuth();
  const queryClient = useQueryClient();
  const { driverId, resortId } = useDriverRepositoryIdentity();

  const todayWeekStartIso = toISODate(startOfWeek(getOperationalToday()));
  const [weekStartIso, setWeekStartIso] = useState(todayWeekStartIso);
  const weekStartDate = parseISODate(weekStartIso);

  const shiftsQuery = useQuery({
    queryKey: ['availability', 'driverShifts', resortId],
    queryFn: () => getRepositories().availability.listDriverVisibleShifts(resortId as string),
    enabled: !!resortId,
  });
  const statusQuery = useQuery({
    queryKey: ['availability', 'weekStatus', driverId, weekStartIso],
    queryFn: () => getRepositories().availability.getWeekAvailabilityStatus(driverId as string, weekStartIso),
    enabled: !!driverId,
  });
  const answersQuery = useQuery({
    queryKey: ['availability', 'answers', driverId, weekStartIso],
    queryFn: () =>
      getRepositories().availability.listAvailability({
        driverId: driverId as string,
        resortId: resortId as string,
        weekStart: weekStartIso,
      }),
    enabled: !!driverId && !!resortId,
  });
  const submissionQuery = useQuery({
    queryKey: ['availability', 'submission', driverId, weekStartIso],
    queryFn: () => getRepositories().availability.getAvailabilitySubmission(driverId as string, weekStartIso),
    enabled: !!driverId,
  });

  const invalidateWeek = () => {
    queryClient.invalidateQueries({ queryKey: ['availability', 'weekStatus', driverId, weekStartIso] });
    queryClient.invalidateQueries({ queryKey: ['availability', 'answers', driverId, weekStartIso] });
    queryClient.invalidateQueries({ queryKey: ['availability', 'submission', driverId, weekStartIso] });
  };

  const setStatusMutation = useMutation({
    mutationFn: (params: { shiftInstanceId: string; status: AvailabilityStatus }) =>
      getRepositories().availability.setAvailability({
        driverId: driverId as string,
        resortId: resortId as string,
        shiftInstanceId: params.shiftInstanceId,
        status: params.status,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['availability', 'weekStatus', driverId, weekStartIso] });
      queryClient.invalidateQueries({ queryKey: ['availability', 'answers', driverId, weekStartIso] });
    },
  });
  const confirmMutation = useMutation({
    mutationFn: () => getRepositories().availability.confirmAvailabilityWeek(driverId as string, weekStartIso),
    onSuccess: invalidateWeek,
  });
  const reopenMutation = useMutation({
    mutationFn: () => getRepositories().availability.reopenAvailabilityWeek(driverId as string, weekStartIso),
    onSuccess: invalidateWeek,
  });

  const weekShifts = useMemo(
    () => (shiftsQuery.data ?? []).filter((s) => s.weekStart === weekStartIso),
    [shiftsQuery.data, weekStartIso]
  );
  const answerByShift = useMemo(() => {
    const map = new Map<string, AvailabilityStatus>();
    for (const a of answersQuery.data ?? []) map.set(a.shiftInstanceId, a.status);
    return map;
  }, [answersQuery.data]);
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const date = toISODate(addDays(weekStartDate, i));
      const dayShifts = weekShifts
        .filter((s) => s.date === date)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      return { index: i, date, shifts: dayShifts };
    });
  }, [weekShifts, weekStartDate]);

  const status = statusQuery.data;
  const submission = submissionQuery.data;

  const locked = status?.state === 'locked';
  const confirmed = !locked && !!submission?.submittedAt;
  const stale = !locked && !confirmed && !!submission?.reopenedReason && submission.reopenedReason !== 'driver_reopened';
  const editable = !locked && !confirmed;
  const noShifts = !!status && status.state === 'no_shifts';
  const canConfirm = !!status && !locked && !confirmed && status.totalShifts > 0 && status.missingCount === 0;

  const isLoading = shiftsQuery.isLoading || statusQuery.isLoading;
  const loadError = shiftsQuery.error ?? statusQuery.error ?? answersQuery.error ?? submissionQuery.error;

  if (!currentUser || currentUser.role !== 'driver') {
    return (
      <div className="page">
        <PageHeader title="Availability" />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Availability"
        subtitle="One week at a time. Mark each shift, then confirm your availability for the week."
        actions={
          <WeekNav
            weekStart={weekStartDate}
            onPrev={() => setWeekStartIso(toISODate(addDays(weekStartDate, -7)))}
            onNext={() => setWeekStartIso(toISODate(addDays(weekStartDate, 7)))}
            onThisWeek={() => setWeekStartIso(todayWeekStartIso)}
          />
        }
      />

      <Card>
        {loadError && (
          <div style={{ padding: '14px 18px 0' }}>
            <InlineNotice tone="error">Couldn't load your availability. Please try again.</InlineNotice>
          </div>
        )}
        {(setStatusMutation.isError || confirmMutation.isError || reopenMutation.isError) && (
          <div style={{ padding: '14px 18px 0' }}>
            <InlineNotice tone="error">
              {(setStatusMutation.error ?? confirmMutation.error ?? reopenMutation.error) instanceof Error
                ? ((setStatusMutation.error ?? confirmMutation.error ?? reopenMutation.error) as Error).message
                : 'Something went wrong. Please try again.'}
            </InlineNotice>
          </div>
        )}

        <div className="avail-week-header">
          <div>
            <strong style={{ fontSize: 14 }}>{formatWeekRangeLabel(weekStartDate)}</strong>
            {!isLoading && status && !noShifts && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
                {locked
                  ? 'Your rota for this week has been published.'
                  : confirmed
                  ? 'Confirmed. You can reopen and edit it any time before the rota is published.'
                  : stale
                  ? 'Your scheduled shifts have changed.'
                  : `${status.answeredCount} of ${status.totalShifts} answered`}
              </div>
            )}
          </div>

          {!isLoading && status && !noShifts && (
            <>
              {locked ? (
                <span className="availability-locked">
                  <IconLock style={{ width: 13, height: 13 }} />
                  Availability locked
                </span>
              ) : confirmed ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="avail-week-header__status avail-week-header__status--submitted">
                    <IconCheck style={{ width: 13, height: 13 }} />
                    Availability confirmed
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => reopenMutation.mutate()} disabled={reopenMutation.isPending}>
                    {reopenMutation.isPending ? 'Reopening…' : 'Reopen availability'}
                  </Button>
                </div>
              ) : (
                <Button variant="primary" onClick={() => confirmMutation.mutate()} disabled={!canConfirm || confirmMutation.isPending}>
                  {confirmMutation.isPending ? 'Confirming…' : 'Confirm availability'}
                </Button>
              )}
            </>
          )}
        </div>

        {stale && (
          <div style={{ padding: '0 18px 14px' }}>
            <InlineNotice tone="warning">Availability needs reconfirmation — answer any new or changed shifts, then confirm again.</InlineNotice>
          </div>
        )}
        {!locked && !confirmed && !noShifts && status && status.missingCount > 0 && (
          <div style={{ padding: '0 18px 14px' }}>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Answer all shifts before confirming your availability.</span>
          </div>
        )}

        {isLoading ? (
          <div className="config-loading">Loading your shifts…</div>
        ) : noShifts ? (
          <EmptyState icon={<IconCalendar />} title="No shifts are scheduled for this week." />
        ) : (
          <div className="avail-day-list">
            {days
              .filter((day) => day.shifts.length > 0)
              .map((day) => (
                <div key={day.date} className="avail-day-list__day">
                  <div className="avail-day-list__heading">
                    {WEEKDAY_LABELS_FULL[day.index]} {formatDayLabel(parseISODate(day.date))}
                  </div>
                  {day.shifts.map((shift) => (
                    <ShiftAnswerRow
                      key={shift.id}
                      shift={shift}
                      status={answerByShift.get(shift.id) ?? null}
                      editable={editable}
                      onSetStatus={(next) => setStatusMutation.mutate({ shiftInstanceId: shift.id, status: next })}
                    />
                  ))}
                </div>
              ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ShiftAnswerRow({
  shift,
  status,
  editable,
  onSetStatus,
}: {
  shift: DriverVisibleShift;
  status: AvailabilityStatus | null;
  editable: boolean;
  onSetStatus: (status: AvailabilityStatus) => void;
}) {
  return (
    <div className="avail-cell avail-cell--row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="avail-cell__name">{shift.name}</div>
        <div className="avail-cell__time">
          <IconClock style={{ width: 10, height: 10, marginRight: 3, verticalAlign: -1 }} />
          {shift.startTime.slice(0, 5)}–{shift.endTime.slice(0, 5)}
        </div>
      </div>

      {editable ? (
        <div className="availability-toggle" style={{ maxWidth: 240 }}>
          <button
            type="button"
            aria-pressed={status === 'available'}
            className={`is-available${status === 'available' ? ' is-selected' : ''}`}
            onClick={() => onSetStatus('available')}
          >
            {status === 'available' ? '✓ ' : ''}Available
          </button>
          <button
            type="button"
            aria-pressed={status === 'unavailable'}
            className={`is-unavailable${status === 'unavailable' ? ' is-selected' : ''}`}
            onClick={() => onSetStatus('unavailable')}
          >
            {status === 'unavailable' ? '✓ ' : ''}Unavailable
          </button>
        </div>
      ) : (
        <div className={`avail-cell__status avail-cell__status--${status ?? 'not-submitted'}`}>
          {status === 'available' ? 'Available' : status === 'unavailable' ? 'Unavailable' : 'Not answered'}
        </div>
      )}
    </div>
  );
}
