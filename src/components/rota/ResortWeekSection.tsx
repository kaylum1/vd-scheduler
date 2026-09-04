import React, { useState } from 'react';
import { driversByResort } from '../../mock-data/drivers';
import { generateWeekShiftInstances } from '../../mock-data/shifts';
import type { Resort, ShiftInstance } from '../../types';
import { Card } from '../ui/Card';
import { IconChevronDown } from '../ui/icons';
import { WeekGrid } from './WeekGrid';

export function ResortWeekSection({
  resort,
  weekStart,
  isPublished,
  onManageShift,
  defaultOpen = true,
}: {
  resort: Resort;
  weekStart: Date;
  isPublished: boolean;
  onManageShift?: (shift: ShiftInstance) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shifts = generateWeekShiftInstances(weekStart, isPublished).filter(
    (s) => s.resortId === resort.id
  );
  const driverCount = driversByResort(resort.id).length;
  const fullyCovered = shifts.filter((s) => s.assignedDriverIds.length >= s.requiredDrivers).length;
  const uncovered = shifts.filter((s) => s.assignedDriverIds.length === 0).length;

  return (
    <Card className="resort-section">
      <div className="resort-section__header">
        <div className="resort-section__title">
          <span className={`resort-dot resort-dot--${resort.id}`} />
          <h2 id={`resort-${resort.id}`}>{resort.name}</h2>
        </div>
        <div className="resort-section__summary">
          <span>{driverCount === 0 ? 'No drivers yet' : `${driverCount} driver${driverCount === 1 ? '' : 's'}`}</span>
          <span>·</span>
          <span>
            {fullyCovered}/{shifts.length} shifts fully covered
          </span>
          {uncovered > 0 && (
            <>
              <span>·</span>
              <span style={{ color: 'var(--red-600)', fontWeight: 600 }}>
                {uncovered} uncovered
              </span>
            </>
          )}
          <button
            className="resort-section__collapse-btn"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? `Collapse ${resort.name}` : `Expand ${resort.name}`}
            style={{ transform: open ? 'rotate(180deg)' : 'none' }}
          >
            <IconChevronDown />
          </button>
        </div>
      </div>
      {open && <WeekGrid weekStart={weekStart} shifts={shifts} onManageShift={onManageShift} />}
    </Card>
  );
}
