import React from 'react';
import { driverById } from '../../mock-data/drivers';
import { resorts } from '../../mock-data/resorts';
import { generateWeekShiftInstances } from '../../mock-data/shifts';
import { startOfWeek, toISODate } from '../../mock-data/date-utils';
import type { ShiftInstance } from '../../types';
import { IconAlert, IconClock } from '../ui/icons';

function shiftsForDate(date: Date): ShiftInstance[] {
  const iso = toISODate(date);
  return generateWeekShiftInstances(startOfWeek(date), true).filter((s) => s.date === iso);
}

function DayCard({ label, date }: { label: string; date: Date }) {
  const dayShifts = shiftsForDate(date);
  const dateLabel = date.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });

  return (
    <div className="op-day-card">
      <div className="op-day-card__header">
        <span className="op-day-card__label">{label}</span>
        <span className="op-day-card__date">{dateLabel}</span>
      </div>
      <div className="op-day-card__body">
        {resorts.map((resort) => {
          const resortShifts = dayShifts
            .filter((s) => s.resortId === resort.id)
            .sort((a, b) => a.startTime.localeCompare(b.startTime));
          return (
            <div className="op-resort-row" key={resort.id}>
              <div className="op-resort-row__name">
                <span className={`resort-dot resort-dot--${resort.id}`} />
                {resort.name}
              </div>
              <div className="op-resort-row__shifts">
                {resortShifts.length === 0 ? (
                  <span className="op-shift-chip op-shift-chip--muted">No shifts scheduled</span>
                ) : (
                  resortShifts.map((shift) => {
                    const drivers = shift.assignedDriverIds
                      .map((id) => driverById(id))
                      .filter((d): d is NonNullable<typeof d> => Boolean(d));
                    const uncovered = drivers.length === 0;
                    return (
                      <div
                        key={shift.id}
                        className={`op-shift-chip${uncovered ? ' op-shift-chip--warning' : ''}`}
                      >
                        <span className="op-shift-chip__name">
                          <IconClock style={{ width: 10, height: 10, marginRight: 3 }} />
                          {shift.name} {shift.startTime}–{shift.endTime}
                        </span>
                        {uncovered ? (
                          <span className="op-shift-chip__warning">
                            <IconAlert style={{ width: 12, height: 12 }} />
                            No coverage
                          </span>
                        ) : (
                          <span className="op-shift-chip__drivers">
                            {drivers.map((d) => d.name).join(', ')}
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Compact operational snapshot for Today and Tomorrow across every resort —
 * the first thing a manager should see, ahead of any stats.
 */
export function TodayTomorrowPanel() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return (
    <div className="op-panel">
      <DayCard label="Today" date={today} />
      <DayCard label="Tomorrow" date={tomorrow} />
    </div>
  );
}
