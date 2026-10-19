import React, { useState } from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { ManualRotaPanel } from '../../components/rota/ManualRotaPanel';
import { ManagerAvailabilityPanel } from '../../components/availability/ManagerAvailabilityPanel';
import { WeekNav } from '../../components/rota/WeekNav';
import { useManagerWeekRota } from '../../components/rota/useManagerWeekRota';
import { ResortSelector, useActiveResortSelection } from '../../components/ui/ResortSelector';
import { StatusPill } from '../../components/ui/StatusPill';
import { addWeeks, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';

/**
 * Rota & Availability: the manager's weekly assignment screen.
 *
 * This page owns the ONE resort and ONE week for everything on it -- a single
 * ResortSelector and a single WeekNav -- and passes both down. Neither panel
 * keeps selection state of its own, so changing either control always updates
 * Manual Rota and Availability together. Plain React state: nothing global.
 *
 * Draft/Published below is the REAL publication state of the selected
 * resort + week (display only -- there is deliberately no Publish control
 * yet; a published week stays editable by the manager).
 */
export function RotaAvailabilityPage() {
  // Rota week boundaries are operational (Europe/Zurich) data — see
  // src/lib/operationalTime.ts — not the viewer's browser timezone.
  const [weekStart, setWeekStart] = useState(() => startOfWeek(getOperationalToday()));
  const weekStartIso = toISODate(weekStart);

  const { activeResorts, selectedResortId, setSelectedResortId, selectedResort } = useActiveResortSelection();

  // Same hook + key as the Manual Rota panel, so this is one cache entry, not a second fetch.
  const rotaQuery = useManagerWeekRota(selectedResortId, weekStartIso);
  const publication = rotaQuery.data ? (rotaQuery.data.isPublished ? 'Published' : 'Draft') : null;

  return (
    <div className="page">
      <PageHeader title="Rota & Availability" subtitle="Assign drivers to shifts and see who is available, for one resort and week at a time." />

      <ResortSelector resorts={activeResorts} selectedResortId={selectedResortId} onSelect={setSelectedResortId} />

      <div className="rota-toolbar">
        <WeekNav
          weekStart={weekStart}
          onPrev={() => setWeekStart((d) => addWeeks(d, -1))}
          onNext={() => setWeekStart((d) => addWeeks(d, 1))}
          onThisWeek={() => setWeekStart(startOfWeek(getOperationalToday()))}
          statusChip={publication ? <StatusPill tone={publication === 'Published' ? 'green' : 'grey'}>{publication}</StatusPill> : undefined}
        />
      </div>

      <ManualRotaPanel resortId={selectedResortId} weekStart={weekStartIso} resortName={selectedResort?.name} />

      <ManagerAvailabilityPanel resortId={selectedResortId} weekStart={weekStartIso} />
    </div>
  );
}
