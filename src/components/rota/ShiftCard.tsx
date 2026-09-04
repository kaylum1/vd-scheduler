import React from 'react';
import type { Driver, ShiftInstance } from '../../types';
import { coverageLabel, coverageTone, StatusPill } from '../ui/StatusPill';
import { IconClock } from '../ui/icons';

/**
 * Manager-facing shift card. Premium/high-earning status is shown only as a
 * small subtle dot (never a text badge) — this component is never used on
 * a driver-facing page, but keeping it subtle here too avoids it reading as
 * a promoted "perk" callout even to managers.
 */
export function ShiftCard({
  shift,
  assignedDrivers,
  onManage,
  dense = false,
}: {
  shift: ShiftInstance;
  assignedDrivers: Driver[];
  onManage?: (shift: ShiftInstance) => void;
  dense?: boolean;
}) {
  const filled = shift.assignedDriverIds.length;
  const tone = coverageTone(filled, shift.requiredDrivers);
  const noCoverage = filled <= 0;

  return (
    <div
      className={`shift-card${dense ? ' shift-card--dense' : ''}${
        noCoverage ? ' shift-card--no-coverage' : ''
      }`}
      onClick={dense && onManage ? () => onManage(shift) : undefined}
      role={dense && onManage ? 'button' : undefined}
      tabIndex={dense && onManage ? 0 : undefined}
    >
      <div className="shift-card__top">
        <div>
          <div className="shift-card__name-row">
            {shift.isPremium && <span className="premium-dot" title="Premium / high-earning shift" />}
            <span className="shift-card__name">{shift.name}</span>
          </div>
          <div className="shift-card__time">
            <IconClock style={{ width: 11, height: 11, verticalAlign: -1, marginRight: 3 }} />
            {shift.startTime}–{shift.endTime}
          </div>
        </div>
        <StatusPill tone={tone}>{coverageLabel(filled, shift.requiredDrivers)}</StatusPill>
      </div>

      <div className="shift-card__drivers">
        {assignedDrivers.length > 0 ? (
          <div className="shift-card__driver-list">
            {assignedDrivers.map((d) => (
              <span key={d.id} className="shift-card__driver">
                <span className="avatar avatar--sm">{d.initials}</span>
                {d.name}
              </span>
            ))}
          </div>
        ) : (
          <span className="shift-card__no-drivers">No drivers assigned</span>
        )}
      </div>

      {onManage && !dense && (
        <div className="shift-card__footer">
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {shift.isPublished ? 'Published' : 'Draft'}
          </span>
          <button
            className="shift-card__manage-btn"
            onClick={(e) => {
              e.stopPropagation();
              onManage(shift);
            }}
          >
            Manage
          </button>
        </div>
      )}
    </div>
  );
}

export function EmptyShiftCell() {
  return <div className="shift-cell-empty" aria-hidden="true" />;
}
