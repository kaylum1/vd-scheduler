import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader } from '../ui/Card';
import { StatusPill, type StatusTone } from '../ui/StatusPill';
import { EmptyState } from '../ui/EmptyState';
import { WeekNav } from '../rota/WeekNav';
import { IconCalendar, IconClock, IconLock } from '../ui/icons';
import { addDays, formatDayLabel, parseISODate, startOfWeek, toISODate, WEEKDAY_LABELS_FULL } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import { getRepositories } from '../../repositories';
import type { AvailabilitySubmissionSummary, DriverWeekAvailabilityState } from '../../repositories/domain';

const STATE_LABEL: Record<DriverWeekAvailabilityState, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  confirmed: 'Confirmed',
  needs_reconfirmation: 'Needs reconfirmation',
  locked: 'Locked',
};

const STATE_TONE: Record<DriverWeekAvailabilityState, StatusTone> = {
  not_started: 'grey',
  in_progress: 'amber',
  confirmed: 'green',
  needs_reconfirmation: 'red',
  locked: 'grey',
};

/**
 * Stage 3: manager-facing driver availability visibility -- whether each
 * driver at the chosen resort has submitted availability for the chosen
 * week, and (on request) their actual per-shift answers. Read-only: no
 * assignment/Auto-Rota/Publish functionality lives here (that is a later
 * checkpoint) -- see docs/business-rules.md.
 */
export function ManagerAvailabilityPanel() {
  const todayWeekStartIso = toISODate(startOfWeek(getOperationalToday()));
  const [selectedResortId, setSelectedResortId] = useState<string | null>(null);
  const [weekStartIso, setWeekStartIso] = useState(todayWeekStartIso);
  const [expandedDriverId, setExpandedDriverId] = useState<string | null>(null);
  const weekStartDate = parseISODate(weekStartIso);

  const resortsQuery = useQuery({
    queryKey: ['config', 'resorts'],
    queryFn: () => getRepositories().resorts.listResorts(),
  });
  const activeResorts = useMemo(() => (resortsQuery.data ?? []).filter((r) => r.isActive), [resortsQuery.data]);

  useEffect(() => {
    if (!resortsQuery.data) return;
    const stillValid = selectedResortId !== null && activeResorts.some((r) => r.id === selectedResortId);
    if (!stillValid) setSelectedResortId(activeResorts[0]?.id ?? null);
  }, [resortsQuery.data, activeResorts, selectedResortId]);

  const selectedResort = useMemo(() => activeResorts.find((r) => r.id === selectedResortId) ?? null, [activeResorts, selectedResortId]);

  const summaryQuery = useQuery({
    queryKey: ['availability', 'managerSummary', selectedResortId, weekStartIso],
    queryFn: () => getRepositories().availability.listAvailabilitySubmissionStatus(selectedResortId as string, weekStartIso),
    enabled: !!selectedResortId,
  });

  const detailQuery = useQuery({
    queryKey: ['availability', 'managerDetail', expandedDriverId, weekStartIso],
    queryFn: () => getRepositories().availability.getResortWeekAvailability(expandedDriverId as string, weekStartIso),
    enabled: !!expandedDriverId,
  });

  const drivers = summaryQuery.data ?? [];

  return (
    <>
      {activeResorts.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <CardHeader title="Choose resort" />
          <div className="resort-chooser segmented" role="tablist" aria-label="Choose resort">
            {activeResorts.map((resort) => (
              <button
                key={resort.id}
                role="tab"
                aria-selected={resort.id === selectedResortId}
                className={`segmented__item${resort.id === selectedResortId ? ' is-active' : ''}`}
                onClick={() => {
                  setSelectedResortId(resort.id);
                  setExpandedDriverId(null);
                }}
              >
                {resort.name}
              </button>
            ))}
          </div>
        </Card>
      )}

      <Card style={{ marginBottom: 16 }}>
        <CardHeader
          title={`Availability${selectedResort ? ` — ${selectedResort.name}` : ''}`}
          action={
            <WeekNav
              weekStart={weekStartDate}
              onPrev={() => {
                setWeekStartIso(toISODate(addDays(weekStartDate, -7)));
                setExpandedDriverId(null);
              }}
              onNext={() => {
                setWeekStartIso(toISODate(addDays(weekStartDate, 7)));
                setExpandedDriverId(null);
              }}
              onThisWeek={() => {
                setWeekStartIso(todayWeekStartIso);
                setExpandedDriverId(null);
              }}
            />
          }
        />

        {!selectedResortId ? (
          <EmptyState icon={<IconCalendar />} title="Choose a resort to see driver availability." />
        ) : summaryQuery.isLoading ? (
          <div className="config-loading">Loading availability…</div>
        ) : summaryQuery.isError ? (
          <div className="config-error">Couldn't load availability. Please try again.</div>
        ) : drivers.length === 0 ? (
          <EmptyState icon={<IconCalendar />} title="No active drivers at this resort." />
        ) : (
          <div className="shift-setup-list">
            {drivers.map((driver) => (
              <DriverAvailabilityRow
                key={driver.driverId}
                driver={driver}
                expanded={expandedDriverId === driver.driverId}
                onToggle={() => setExpandedDriverId((prev) => (prev === driver.driverId ? null : driver.driverId))}
                detail={expandedDriverId === driver.driverId ? detailQuery : null}
              />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function DriverAvailabilityRow({
  driver,
  expanded,
  onToggle,
  detail,
}: {
  driver: AvailabilitySubmissionSummary;
  expanded: boolean;
  onToggle: () => void;
  detail: ReturnType<typeof useQuery<import('../../repositories/domain').DriverShiftAvailability[]>> | null;
}) {
  return (
    <div className="config-list-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          textAlign: 'left',
        }}
      >
        <div className="config-list-item__main">
          <div>
            <div className="config-list-item__title">{driver.driverFullName}</div>
            <div className="config-list-item__subtitle">
              {driver.state === 'locked' ? (
                <>
                  <IconLock style={{ width: 10, height: 10, marginRight: 3, verticalAlign: -1 }} />
                  Rota published
                </>
              ) : (
                `${driver.answeredCount} of ${driver.totalShifts} answered`
              )}
            </div>
          </div>
        </div>
        <StatusPill tone={STATE_TONE[driver.state]}>{STATE_LABEL[driver.state]}</StatusPill>
      </button>

      {expanded && detail && (
        <div style={{ marginTop: 12, paddingLeft: 4 }}>
          {detail.isLoading ? (
            <div className="config-loading">Loading answers…</div>
          ) : detail.isError ? (
            <div className="config-error">Couldn't load this driver's answers.</div>
          ) : (detail.data ?? []).length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No shifts scheduled this week.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(detail.data ?? []).map((row) => {
                const date = parseISODate(row.date);
                const dayIndex = (date.getDay() + 6) % 7;
                return (
                  <div
                    key={row.shiftInstanceId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      fontSize: 12,
                      padding: '6px 10px',
                      border: '1px solid var(--border-default)',
                      borderRadius: 'var(--radius-sm)',
                    }}
                  >
                    <span>
                      <strong>
                        {WEEKDAY_LABELS_FULL[dayIndex].slice(0, 3)} {formatDayLabel(date)}
                      </strong>{' '}
                      · {row.name}{' '}
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        <IconClock style={{ width: 9, height: 9, marginRight: 2, verticalAlign: -1 }} />
                        {row.startTime.slice(0, 5)}–{row.endTime.slice(0, 5)}
                      </span>
                    </span>
                    <StatusPill tone={row.status === 'available' ? 'green' : row.status === 'unavailable' ? 'red' : 'grey'}>
                      {row.status === 'available' ? 'Available' : row.status === 'unavailable' ? 'Unavailable' : 'Not answered'}
                    </StatusPill>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
