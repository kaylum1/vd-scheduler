import React from 'react';
import { formatWeekRangeLabel, getWeekOffset, startOfWeek } from '../../mock-data/date-utils';
import { IconChevronLeft, IconChevronRight } from '../ui/icons';

export type WeekRelation = 'archive' | 'current' | 'next' | 'future';

export function getWeekRelation(weekStart: Date, today = new Date()): WeekRelation {
  const offset = getWeekOffset(weekStart, startOfWeek(today));
  if (offset < 0) return 'archive';
  if (offset === 0) return 'current';
  if (offset === 1) return 'next';
  return 'future';
}

const RELATION_LABEL: Record<WeekRelation, string> = {
  archive: 'Archive',
  current: 'This Week',
  next: 'Next Week',
  future: 'Upcoming',
};

/**
 * Shared week navigator used by Manager Rota, My Rota and Driver
 * Availability. Gives "this week" the strongest visual identity, "next
 * week" a clear but secondary identity, and mutes past/archived weeks —
 * per Stage 1.1's week-navigation requirement — while leaving each page
 * free to attach its own status chip (Published/Draft, Locked/Submitted/Open).
 */
export function WeekNav({
  weekStart,
  onPrev,
  onNext,
  onThisWeek,
  disablePrev,
  disableNext,
  statusChip,
}: {
  weekStart: Date;
  onPrev: () => void;
  onNext: () => void;
  onThisWeek?: () => void;
  disablePrev?: boolean;
  disableNext?: boolean;
  statusChip?: React.ReactNode;
}) {
  const relation = getWeekRelation(weekStart);

  return (
    <div className={`week-nav week-nav--${relation}`}>
      <button
        className="week-nav__arrow"
        onClick={onPrev}
        disabled={disablePrev}
        aria-label="Previous week"
      >
        <IconChevronLeft />
      </button>

      <div className="week-nav__center">
        <div className="week-nav__top">
          <span className="week-nav__relation">{RELATION_LABEL[relation]}</span>
          {statusChip}
        </div>
        <span className="week-nav__range">{formatWeekRangeLabel(weekStart)}</span>
      </div>

      <button
        className="week-nav__arrow"
        onClick={onNext}
        disabled={disableNext}
        aria-label="Next week"
      >
        <IconChevronRight />
      </button>

      {relation !== 'current' && onThisWeek && (
        <button className="btn btn--ghost btn--sm week-nav__today-btn" onClick={onThisWeek}>
          This week
        </button>
      )}
    </div>
  );
}
