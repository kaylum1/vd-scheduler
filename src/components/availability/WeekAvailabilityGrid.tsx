import React, { useRef } from 'react';
import { buildWeekRows } from '../../lib/weekRows';
import { formatDayLabel, getWeekDates, isToday, toISODate, WEEKDAY_LABELS } from '../../mock-data/date-utils';
import type { AvailabilityStatus, ShiftInstance } from '../../types';
import { EmptyShiftCell } from '../rota/ShiftCard';
import { AvailabilityShiftCell } from './AvailabilityShiftCell';

/**
 * One week, Monday through Sunday, laid out horizontally with every day
 * given the same number of shift slots (via buildWeekRows) so a Saturday
 * with Lunch + Dinner sits in a two-row grid alongside single-shift days.
 */
export function WeekAvailabilityGrid({
  weekStart,
  shifts,
  statusMap,
  editable,
  locked,
  onSetStatus,
}: {
  weekStart: Date;
  shifts: ShiftInstance[];
  statusMap: Record<string, AvailabilityStatus>;
  editable: boolean;
  locked: boolean;
  onSetStatus: (shift: ShiftInstance, status: AvailabilityStatus) => void;
}) {
  const dates = getWeekDates(weekStart);
  const rows = buildWeekRows(weekStart, shifts);
  const dayRefs = useRef<(HTMLDivElement | null)[]>([]);

  const scrollToDay = (index: number) => {
    dayRefs.current[index]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };

  if (rows.length === 0) {
    return <div className="day-column__empty" style={{ margin: '18px' }}>No shifts scheduled this week</div>;
  }

  return (
    <div>
      {/* ---- Desktop: aligned grid ---- */}
      <div className="avail-grid-wrap">
        <div className="avail-grid" style={{ gridTemplateRows: `auto repeat(${rows.length}, minmax(0, 1fr))` }}>
          {dates.map((date, i) => (
            <div key={`h-${i}`} className={`rota-grid__day-header${isToday(date) ? ' is-today' : ''}`}>
              <span className="rota-grid__weekday">{WEEKDAY_LABELS[i]}</span>
              <span className="rota-grid__date">{formatDayLabel(date)}</span>
            </div>
          ))}
          {rows.map((row) =>
            row.cells.map((shift, i) => (
              <div className="avail-grid__cell" key={`${row.name}-${i}`}>
                {shift ? (
                  <AvailabilityShiftCell
                    shift={shift}
                    status={statusMap[shift.id] ?? 'not-submitted'}
                    editable={editable}
                    locked={locked}
                    onSetStatus={(s) => onSetStatus(shift, s)}
                  />
                ) : (
                  <EmptyShiftCell />
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ---- Mobile: horizontal day scroll ---- */}
      <div className="avail-grid-mobile">
        <div className="week-day-nav">
          {dates.map((date, i) => (
            <button
              key={i}
              className={`week-day-nav__btn${isToday(date) ? ' is-today' : ''}`}
              onClick={() => scrollToDay(i)}
            >
              {WEEKDAY_LABELS[i]} {date.getDate()}
            </button>
          ))}
        </div>
        <div className="avail-mobile-row">
          {dates.map((date, i) => {
            const iso = toISODate(date);
            const dayShifts = shifts.filter((s) => s.date === iso).sort((a, b) => a.startTime.localeCompare(b.startTime));
            return (
              <div
                className="avail-day-card"
                key={iso}
                ref={(el) => {
                  dayRefs.current[i] = el;
                }}
              >
                <div className="day-column__header">
                  <span className="day-column__weekday">{WEEKDAY_LABELS[i]}</span>
                  <span className="day-column__date">{formatDayLabel(date)}</span>
                </div>
                {dayShifts.length === 0 ? (
                  <div className="day-column__empty">No shifts</div>
                ) : (
                  dayShifts.map((shift) => (
                    <AvailabilityShiftCell
                      key={shift.id}
                      shift={shift}
                      status={statusMap[shift.id] ?? 'not-submitted'}
                      editable={editable}
                      locked={locked}
                      onSetStatus={(s) => onSetStatus(shift, s)}
                    />
                  ))
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
