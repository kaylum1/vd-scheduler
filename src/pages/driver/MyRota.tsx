import React, { useState } from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { WeekNav } from '../../components/rota/WeekNav';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { StatusPill } from '../../components/ui/StatusPill';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconCalendar, IconClock } from '../../components/ui/icons';
import { addWeeks, getWeekDates, isToday, startOfWeek, toISODate, WEEKDAY_LABELS } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import { driverById } from '../../mock-data/drivers';
import { resortById } from '../../mock-data/resorts';
import { generateWeekShiftInstances } from '../../mock-data/shifts';
import { useAuth } from '../../auth/AuthContext';

export function MyRotaPage() {
  // Driver identity comes from useAuth() (real app_users-backed identity
  // in Supabase mode; the same value useAppState().activeDriverId would
  // give in mock mode) — not a client-side toggle, so one driver's
  // session can never coincidentally render another driver's mock rota.
  const { currentUser } = useAuth();
  const activeDriverId = currentUser?.role === 'driver' ? currentUser.driverId : '';
  // The current week is operational (Europe/Zurich) data — see
  // src/lib/operationalTime.ts — not the viewer's browser timezone.
  const [weekStart, setWeekStart] = useState(() => startOfWeek(getOperationalToday()));
  const driver = driverById(activeDriverId);

  const isCurrentWeek = weekStart.getTime() === startOfWeek(getOperationalToday()).getTime();
  const shifts = driver
    ? generateWeekShiftInstances(weekStart, isCurrentWeek).filter(
        (s) => s.resortId === driver.resortId && s.assignedDriverIds.includes(driver.id)
      )
    : [];

  const shiftsByDate = new Map<string, typeof shifts>();
  for (const shift of shifts) {
    const list = shiftsByDate.get(shift.date) ?? [];
    list.push(shift);
    shiftsByDate.set(shift.date, list);
  }

  const dates = getWeekDates(weekStart);
  const totalHoursThisWeek = shifts.reduce((sum, s) => {
    const [sh, sm] = s.startTime.split(':').map(Number);
    const [eh, em] = s.endTime.split(':').map(Number);
    return sum + (eh * 60 + em - (sh * 60 + sm)) / 60;
  }, 0);

  return (
    <div className="page">
      <PageHeader
        title="My Rota"
        subtitle={driver ? `${driver.name} · ${resortById(driver.resortId)?.name}` : undefined}
        actions={
          <WeekNav
            weekStart={weekStart}
            onPrev={() => setWeekStart((d) => addWeeks(d, -1))}
            onNext={() => setWeekStart((d) => addWeeks(d, 1))}
            onThisWeek={() => setWeekStart(startOfWeek(getOperationalToday()))}
          />
        }
      />

      <div className="driver-week-summary">
        <Badge>{shifts.length} shift{shifts.length === 1 ? '' : 's'} this week</Badge>
        <Badge>{totalHoursThisWeek.toFixed(1)} hours scheduled</Badge>
        {isCurrentWeek && <Badge tone="blue">Published</Badge>}
      </div>

      <Card>
        {shifts.length === 0 ? (
          <EmptyState
            icon={<IconCalendar />}
            title="No shifts scheduled this week"
            hint="Once the manager publishes the rota, your assigned shifts will appear here."
          />
        ) : (
          dates.map((date, i) => {
            const dayShifts = shiftsByDate.get(toISODate(date)) ?? [];
            if (dayShifts.length === 0) return null;
            return (
              <div key={toISODate(date)}>
                {dayShifts.map((shift) => (
                  <div className="driver-shift-item" key={shift.id}>
                    <div className="driver-shift-item__date">
                      <div className="driver-shift-item__date-day">{date.getDate()}</div>
                      <div className="driver-shift-item__date-weekday">{WEEKDAY_LABELS[i]}</div>
                    </div>
                    <div className="driver-shift-item__body">
                      <div className="driver-shift-item__title">{shift.name}</div>
                      <div className="driver-shift-item__meta">
                        <IconClock style={{ width: 11, height: 11, verticalAlign: -1, marginRight: 3 }} />
                        {shift.startTime}–{shift.endTime}
                        {isToday(date) && ' · Today'}
                      </div>
                    </div>
                    <StatusPill tone="green">Assigned</StatusPill>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
