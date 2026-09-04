import React from 'react';
import { driverById } from '../../mock-data/drivers';
import { formatDayLabel, isToday, WEEKDAY_LABELS } from '../../mock-data/date-utils';
import type { ShiftInstance, WeekdayIndex } from '../../types';
import { ShiftCard } from './ShiftCard';

export function DayColumn({
  date,
  weekdayIndex,
  shifts,
  onManageShift,
  dayRef,
}: {
  date: Date;
  weekdayIndex: WeekdayIndex;
  shifts: ShiftInstance[];
  onManageShift?: (shift: ShiftInstance) => void;
  dayRef?: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div className={`day-column${isToday(date) ? ' is-today' : ''}`} ref={dayRef}>
      <div className="day-column__header">
        <span className="day-column__weekday">{WEEKDAY_LABELS[weekdayIndex]}</span>
        <span className="day-column__date">{formatDayLabel(date)}</span>
      </div>
      <div className="day-column__shifts">
        {shifts.length === 0 ? (
          <div className="day-column__empty">No shifts scheduled</div>
        ) : (
          shifts.map((shift) => (
            <ShiftCard
              key={shift.id}
              shift={shift}
              assignedDrivers={shift.assignedDriverIds
                .map((id) => driverById(id))
                .filter((d): d is NonNullable<typeof d> => Boolean(d))}
              onManage={onManageShift}
            />
          ))
        )}
      </div>
    </div>
  );
}
