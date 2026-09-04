import React from 'react';
import type { AvailabilityStatus, ShiftInstance } from '../../types';
import { IconLock } from '../ui/icons';

/**
 * One shift's availability cell. No premium/high-earning indicator is ever
 * rendered here — that status stays internal to the manager-facing views.
 */
export function AvailabilityShiftCell({
  shift,
  status,
  editable,
  locked,
  onSetStatus,
}: {
  shift: ShiftInstance;
  status: AvailabilityStatus;
  editable: boolean;
  locked: boolean;
  onSetStatus: (status: AvailabilityStatus) => void;
}) {
  return (
    <div className="avail-cell">
      <div className="avail-cell__name">{shift.name}</div>
      <div className="avail-cell__time">
        {shift.startTime}–{shift.endTime}
      </div>

      {editable ? (
        <div className="availability-toggle availability-toggle--compact">
          <button
            className={`is-available${status === 'available' ? ' is-selected' : ''}`}
            onClick={() => onSetStatus('available')}
          >
            Available
          </button>
          <button
            className={`is-unavailable${status === 'unavailable' ? ' is-selected' : ''}`}
            onClick={() => onSetStatus('unavailable')}
          >
            Unavailable
          </button>
        </div>
      ) : (
        <div className={`avail-cell__status avail-cell__status--${status}`}>
          {locked && <IconLock style={{ width: 10, height: 10 }} />}
          {status === 'available' ? 'Available' : status === 'unavailable' ? 'Unavailable' : 'Not submitted'}
        </div>
      )}
    </div>
  );
}
