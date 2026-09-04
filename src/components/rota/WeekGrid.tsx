import React, { useRef } from 'react';
import { buildWeekRows } from '../../lib/weekRows';
import { driverById } from '../../mock-data/drivers';
import { formatDayLabel, getWeekDates, isToday, toISODate, WEEKDAY_LABELS } from '../../mock-data/date-utils';
import type { ShiftInstance, WeekdayIndex } from '../../types';
import { DayColumn } from './DayColumn';
import { EmptyShiftCell, ShiftCard } from './ShiftCard';

function resolveDrivers(shift: ShiftInstance) {
  return shift.assignedDriverIds
    .map((id) => driverById(id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));
}

/**
 * Clean Monday–Sunday grid, per resort: one column per day, one row per
 * distinct shift name active that week (via buildWeekRows), so "Dinner"
 * lines up across every day and a Saturday-only "Lunch" gets its own row
 * with disabled empty cells elsewhere. Falls back to a horizontal
 * day-by-day scroll on narrow screens.
 */
export function WeekGrid({
  weekStart,
  shifts,
  onManageShift,
}: {
  weekStart: Date;
  shifts: ShiftInstance[];
  onManageShift?: (shift: ShiftInstance) => void;
}) {
  const dates = getWeekDates(weekStart);
  const rows = buildWeekRows(weekStart, shifts);
  const dayRefs = useRef<(HTMLDivElement | null)[]>([]);

  const shiftsByDate = new Map<string, ShiftInstance[]>();
  for (const shift of shifts) {
    const list = shiftsByDate.get(shift.date) ?? [];
    list.push(shift);
    shiftsByDate.set(shift.date, list);
  }

  const scrollToDay = (index: number) => {
    dayRefs.current[index]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };

  return (
    <div>
      {/* ---- Desktop: aligned grid ---- */}
      <div className="rota-grid-wrap">
        {rows.length === 0 ? (
          <div className="day-column__empty" style={{ margin: '14px 18px' }}>
            No shifts configured for this week
          </div>
        ) : (
          <div
            className="rota-grid"
            style={{ gridTemplateRows: `auto repeat(${rows.length}, minmax(0, 1fr))` }}
          >
            {dates.map((date, i) => (
              <div key={`h-${i}`} className={`rota-grid__day-header${isToday(date) ? ' is-today' : ''}`}>
                <span className="rota-grid__weekday">{WEEKDAY_LABELS[i]}</span>
                <span className="rota-grid__date">{formatDayLabel(date)}</span>
              </div>
            ))}
            {rows.map((row) =>
              row.cells.map((shift, i) => (
                <div className="rota-grid__cell" key={`${row.name}-${i}`}>
                  {shift ? (
                    <ShiftCard shift={shift} assignedDrivers={resolveDrivers(shift)} onManage={onManageShift} dense />
                  ) : (
                    <EmptyShiftCell />
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ---- Mobile: horizontal day scroll ---- */}
      <div className="rota-grid-mobile">
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
        <div className="week-grid">
          {dates.map((date, i) => (
            <DayColumn
              key={toISODate(date)}
              date={date}
              weekdayIndex={i as WeekdayIndex}
              shifts={shiftsByDate.get(toISODate(date)) ?? []}
              onManageShift={onManageShift}
              dayRef={(el) => {
                dayRefs.current[i] = el;
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
