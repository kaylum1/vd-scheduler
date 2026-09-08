import React, { useState } from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { ResortWeekSection } from '../../components/rota/ResortWeekSection';
import { WeekNav } from '../../components/rota/WeekNav';
import { Button } from '../../components/ui/Button';
import { StatusPill } from '../../components/ui/StatusPill';
import { addWeeks, startOfWeek } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import { resorts } from '../../mock-data/resorts';
import type { ShiftInstance } from '../../types';

export function RotaAvailabilityPage() {
  // Rota week boundaries are operational (Europe/Zurich) data — see
  // src/lib/operationalTime.ts — not the viewer's browser timezone.
  const [weekStart, setWeekStart] = useState(() => startOfWeek(getOperationalToday()));
  const [lastAction, setLastAction] = useState<string | null>(null);

  // Demo rule: only the current week is treated as already published.
  const isCurrentWeek = weekStart.getTime() === startOfWeek(getOperationalToday()).getTime();

  const handleManageShift = (shift: ShiftInstance) => {
    setLastAction(
      `Opened "${shift.name}" (${shift.startTime}–${shift.endTime}) on ${shift.date} for editing — override flow is not implemented in Stage 1.`
    );
  };

  return (
    <div className="page">
      <PageHeader
        title="Rota & Availability"
        subtitle="Monday–Sunday view across all resorts. Shift cells reflect submitted availability and current assignments."
        actions={
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <WeekNav
              weekStart={weekStart}
              onPrev={() => setWeekStart((d) => addWeeks(d, -1))}
              onNext={() => setWeekStart((d) => addWeeks(d, 1))}
              onThisWeek={() => setWeekStart(startOfWeek(getOperationalToday()))}
              statusChip={
                <StatusPill tone={isCurrentWeek ? 'green' : 'grey'}>
                  {isCurrentWeek ? 'Published' : 'Draft'}
                </StatusPill>
              }
            />
            <Button variant="primary" disabled={isCurrentWeek}>
              {isCurrentWeek ? 'Published' : 'Publish rota'}
            </Button>
          </div>
        }
      />

      {lastAction && (
        <div
          className="badge"
          style={{ display: 'block', marginBottom: 14, padding: '8px 12px', fontSize: 12 }}
        >
          {lastAction}
        </div>
      )}

      {resorts.map((resort) => (
        <ResortWeekSection
          key={resort.id}
          resort={resort}
          weekStart={weekStart}
          isPublished={isCurrentWeek}
          onManageShift={handleManageShift}
        />
      ))}
    </div>
  );
}
