import React, { useMemo, useState } from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { WeekNav, getWeekRelation } from '../../components/rota/WeekNav';
import { DriverRotaDay } from '../../components/driver-rota/DriverRotaDay';
import { useDriverWeekRota } from '../../components/driver-rota/useDriverWeekRota';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { StatusPill } from '../../components/ui/StatusPill';
import { IconCalendar } from '../../components/ui/icons';
import { addWeeks, parseISODate, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import { useDriverRepositoryIdentity } from './useDriverRepositoryIdentity';
import type { DriverRotaShift } from '../../repositories/domain';

/**
 * Live Driver My Rota: the signed-in driver's OWN published shifts for one
 * operational (Monday-Sunday, Europe/Zurich) week, read through the repository
 * layer only. Read-only -- there is nothing a driver can change here, and no
 * availability or pay information is shown (Availability is its own page).
 *
 * It tells three situations apart, because they mean different things to a
 * driver: the week is not published yet / no rota was published, the week is
 * published but the driver has nothing, and the week is published with shifts.
 * A manager may still edit a published week; the query refetches (see
 * useDriverWeekRota), so those edits appear without any re-publishing.
 */
export function MyRotaPage() {
  const { driverId } = useDriverRepositoryIdentity();
  // The current week is operational (Europe/Zurich) data -- see
  // src/lib/operationalTime.ts -- not the viewer's browser timezone.
  const [weekStartIso, setWeekStartIso] = useState(() => toISODate(startOfWeek(getOperationalToday())));
  const weekStart = parseISODate(weekStartIso);
  const goToWeek = (date: Date) => setWeekStartIso(toISODate(date));

  const rotaQuery = useDriverWeekRota(driverId, weekStartIso);
  const rota = rotaQuery.data;
  const isPastWeek = getWeekRelation(weekStart) === 'archive';

  const days = useMemo(() => {
    const byDate = new Map<string, DriverRotaShift[]>();
    for (const shift of rota?.shifts ?? []) {
      const list = byDate.get(shift.date) ?? [];
      list.push(shift);
      byDate.set(shift.date, list);
    }
    // The repository already returns shifts ordered by date; Map preserves that.
    return [...byDate.entries()];
  }, [rota]);

  const today = toISODate(getOperationalToday());

  return (
    <div className="page">
      <PageHeader
        title="My Rota"
        actions={
          <WeekNav
            weekStart={weekStart}
            onPrev={() => goToWeek(addWeeks(weekStart, -1))}
            onNext={() => goToWeek(addWeeks(weekStart, 1))}
            onThisWeek={() => goToWeek(startOfWeek(getOperationalToday()))}
            statusChip={rota ? <StatusPill tone={rota.isPublished ? 'green' : 'grey'}>{rota.isPublished ? 'Published' : 'Not published'}</StatusPill> : undefined}
          />
        }
      />

      {rota && rota.shifts.length > 0 && (
        <div className="driver-week-summary">
          <Badge>
            {rota.shifts.length} shift{rota.shifts.length === 1 ? '' : 's'}
          </Badge>
        </div>
      )}

      <Card>
        {rotaQuery.isLoading ? (
          <div className="config-loading" role="status">
            Loading your rota…
          </div>
        ) : rotaQuery.isError || !rota ? (
          <div className="config-error" role="alert">
            <p>Couldn’t load your rota</p>
            <Button variant="secondary" size="sm" onClick={() => rotaQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : !rota.isPublished ? (
          <EmptyState
            icon={<IconCalendar />}
            title={isPastWeek ? 'No rota was published for this week.' : 'Your rota for this week hasn’t been published yet.'}
          />
        ) : rota.shifts.length === 0 ? (
          <EmptyState icon={<IconCalendar />} title="You don’t have any shifts assigned this week." />
        ) : (
          <div className="driver-rota">
            {days.map(([date, shifts]) => (
              <DriverRotaDay key={date} date={date} shifts={shifts} isToday={date === today} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
