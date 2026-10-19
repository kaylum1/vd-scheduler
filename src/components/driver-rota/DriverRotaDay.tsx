import React from 'react';
import { StatusPill } from '../ui/StatusPill';
import { IconClock } from '../ui/icons';
import { formatDayLabel, parseISODate, WEEKDAY_LABELS_FULL } from '../../mock-data/date-utils';
import type { DriverRotaShift } from '../../repositories/domain';

/**
 * One day of the driver's rota and the shifts they are assigned to that day.
 * Purely presentational and read-only: the driver sees what, when -- nothing
 * about colleagues, headcount or pay exists on DriverRotaShift to show.
 */
export function DriverRotaDay({ date, shifts, isToday }: { date: string; shifts: DriverRotaShift[]; isToday: boolean }) {
  const day = parseISODate(date);
  const headingId = `driver-rota-day-${date}`;
  return (
    <section className="driver-rota__day" aria-labelledby={headingId}>
      <h3 id={headingId} className="driver-rota__day-title">
        {WEEKDAY_LABELS_FULL[(day.getDay() + 6) % 7]} <span>{formatDayLabel(day)}</span>
        {isToday && <StatusPill tone="blue">Today</StatusPill>}
      </h3>
      <ul className="driver-rota__shifts" aria-label={`Shifts on ${WEEKDAY_LABELS_FULL[(day.getDay() + 6) % 7]} ${formatDayLabel(day)}`}>
        {shifts.map((shift) => (
          <li key={shift.shiftInstanceId} className="driver-rota__shift">
            <span className="driver-rota__shift-name">{shift.shiftName}</span>
            <span className="driver-rota__shift-time">
              <IconClock style={{ width: 12, height: 12 }} aria-hidden="true" />
              {shift.startTime}–{shift.endTime}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
