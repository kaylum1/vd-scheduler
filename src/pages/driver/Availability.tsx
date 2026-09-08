import React, { useMemo, useState } from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { WeekAvailabilityGrid } from '../../components/availability/WeekAvailabilityGrid';
import { WeekNav } from '../../components/rota/WeekNav';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { StatusPill } from '../../components/ui/StatusPill';
import { IconCheck, IconLock } from '../../components/ui/icons';
import { addWeeks, formatWeekRangeLabel, parseISODate, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import {
  buildAvailabilityEntries,
  getAvailabilityWindowInstances,
  mockConfirmedWeekOffsets,
} from '../../mock-data/availability';
import { driverById } from '../../mock-data/drivers';
import { useAuth } from '../../auth/AuthContext';
import type { AvailabilityStatus, ShiftInstance } from '../../types';

type WeekStatus = 'locked' | 'submitted' | 'open';

function isWeekPublished(weekShifts: ShiftInstance[]): boolean {
  return weekShifts.length > 0 && weekShifts.every((s) => s.isPublished);
}

export function AvailabilityPage() {
  // See MyRota.tsx for why this comes from useAuth() rather than
  // useAppState().activeDriverId directly.
  const { currentUser } = useAuth();
  const activeDriverId = currentUser?.role === 'driver' ? currentUser.driverId : '';
  const driver = driverById(activeDriverId);
  // The current/next actionable week is operational (Europe/Zurich) data —
  // see src/lib/operationalTime.ts — not the viewer's browser timezone.
  const currentWeekStart = startOfWeek(getOperationalToday());
  const currentWeekKey = toISODate(currentWeekStart);

  const instances = useMemo(
    () => (driver ? getAvailabilityWindowInstances(driver.resortId) : []),
    [driver?.resortId]
  );

  // Group shifts into Monday-anchored weeks, oldest first.
  const weeks = useMemo(() => {
    const map = new Map<string, ShiftInstance[]>();
    for (const shift of instances) {
      const key = toISODate(startOfWeek(parseISODate(shift.date)));
      const list = map.get(key) ?? [];
      list.push(shift);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [instances]);

  const initialStatusMap = useMemo(() => {
    if (!driver) return {};
    const entries = buildAvailabilityEntries(driver.id, driver.resortId);
    return Object.fromEntries(entries.map((e) => [e.shiftInstanceId, e.status])) as Record<
      string,
      AvailabilityStatus
    >;
  }, [driver?.id, driver?.resortId]);
  const [statusMap, setStatusMap] = useState<Record<string, AvailabilityStatus>>(initialStatusMap);

  const initialConfirmed = useMemo(() => {
    const set = new Set<string>();
    for (const offset of mockConfirmedWeekOffsets) {
      set.add(toISODate(addWeeks(currentWeekStart, offset)));
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [confirmedWeeks, setConfirmedWeeks] = useState<Set<string>>(initialConfirmed);

  function weekStatusFor(weekKey: string, weekShifts: ShiftInstance[]): WeekStatus {
    if (isWeekPublished(weekShifts)) return 'locked';
    return confirmedWeeks.has(weekKey) ? 'submitted' : 'open';
  }

  // Default to the first actionable week: current week if it's still open,
  // otherwise the next open week going forward.
  const [selectedWeekKey, setSelectedWeekKey] = useState<string>(() => {
    const firstOpen = weeks.find(([key, shiftsForWeek]) => key >= currentWeekKey && !isWeekPublished(shiftsForWeek));
    if (firstOpen) return firstOpen[0];
    return weeks.length > 0 ? weeks[weeks.length - 1][0] : currentWeekKey;
  });

  const selectedIndex = weeks.findIndex(([key]) => key === selectedWeekKey);
  const [selectedKey, selectedShifts] = weeks[selectedIndex] ?? [selectedWeekKey, [] as ShiftInstance[]];
  const selectedWeekStart = parseISODate(selectedKey);
  const status = weekStatusFor(selectedKey, selectedShifts);
  const editable = status === 'open';
  const locked = status === 'locked';

  const setShiftStatus = (shift: ShiftInstance, next: AvailabilityStatus) => {
    if (!editable) return;
    setStatusMap((prev) => ({ ...prev, [shift.id]: prev[shift.id] === next ? 'not-submitted' : next }));
  };

  const confirmWeek = () => setConfirmedWeeks((prev) => new Set(prev).add(selectedKey));
  const reopenWeek = () =>
    setConfirmedWeeks((prev) => {
      const next = new Set(prev);
      next.delete(selectedKey);
      return next;
    });

  const goToWeek = (key: string) => setSelectedWeekKey(key);
  const goPrev = () => selectedIndex > 0 && goToWeek(weeks[selectedIndex - 1][0]);
  const goNext = () => selectedIndex < weeks.length - 1 && goToWeek(weeks[selectedIndex + 1][0]);

  const archiveWeeks = weeks.filter(([key]) => key < currentWeekKey);

  if (!driver) {
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
        subtitle="One week at a time. Mark each shift, confirm the week, and reopen it any time before the rota is published."
        actions={
          <WeekNav
            weekStart={selectedWeekStart}
            onPrev={goPrev}
            onNext={goNext}
            onThisWeek={() => goToWeek(currentWeekKey)}
            disablePrev={selectedIndex <= 0}
            disableNext={selectedIndex >= weeks.length - 1}
            statusChip={
              <StatusPill tone={locked ? 'grey' : status === 'submitted' ? 'green' : 'amber'}>
                {locked ? 'Locked' : status === 'submitted' ? 'Submitted' : 'Open'}
              </StatusPill>
            }
          />
        }
      />

      <Card>
        <div className="avail-week-header">
          <div>
            <strong style={{ fontSize: 14 }}>{formatWeekRangeLabel(selectedWeekStart)}</strong>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
              {locked
                ? 'This week has been published — availability can no longer be changed.'
                : status === 'submitted'
                ? 'Submitted. You can reopen and edit it any time before the rota is published.'
                : 'Mark each shift below, then confirm your availability for the week.'}
            </div>
          </div>

          {locked ? (
            <span className="avail-week-header__status avail-week-header__status--locked">
              <IconLock style={{ width: 13, height: 13 }} />
              Published · locked
            </span>
          ) : status === 'submitted' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="avail-week-header__status avail-week-header__status--submitted">
                <IconCheck style={{ width: 13, height: 13 }} />
                Submitted
              </span>
              <Button variant="secondary" size="sm" onClick={reopenWeek}>
                Edit submission
              </Button>
            </div>
          ) : (
            <Button variant="primary" onClick={confirmWeek}>
              Confirm Week
            </Button>
          )}
        </div>

        <WeekAvailabilityGrid
          weekStart={selectedWeekStart}
          shifts={selectedShifts}
          statusMap={statusMap}
          editable={editable}
          locked={locked}
          onSetStatus={setShiftStatus}
        />
      </Card>

      {archiveWeeks.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-tertiary)', marginBottom: 7 }}>
            History
          </div>
          <div className="avail-archive-strip">
            {archiveWeeks.map(([key]) => (
              <button key={key} className="avail-archive-strip__item" onClick={() => goToWeek(key)}>
                {formatWeekRangeLabel(parseISODate(key))}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
