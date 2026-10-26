import React from 'react';
import { Button } from '../ui/Button';
import type { DriverRotaShift } from '../../repositories/domain';
import {
  CHECK_IN_CLOSED_TEXT,
  CHECK_IN_SUCCESS_TEXT,
  describeCheckInOpens,
  describeCheckedIn,
  getDriverCheckInState,
} from './driverCheckInUi';
import type { ShiftCheckInStatus } from './useDriverCheckIn';

/**
 * The Check in area of ONE shift on Driver My Rota. It shows only the driver's own state: no
 * Attendance, no other drivers, no location claim, no lateness, no pay. The check-in time is the
 * server's. Wording stays "Check in" / "Checked in" -- never "arrived", "present" or "on time".
 */
export function DriverShiftCheckIn({
  shift,
  now,
  status,
  onCheckIn,
}: {
  shift: DriverRotaShift;
  now: Date;
  status: ShiftCheckInStatus;
  onCheckIn: (assignmentId: string) => void;
}) {
  // The server's instant from this session's tap wins over the (possibly not yet refetched) week data.
  const effective = status.checkedInAt && !shift.checkedInAt ? { ...shift, checkedInAt: status.checkedInAt } : shift;
  const state = getDriverCheckInState(effective, now, status.hint);
  const statusId = `check-in-status-${shift.assignmentId}`;
  const errorId = `check-in-error-${shift.assignmentId}`;

  return (
    <div className="driver-rota__check-in" data-check-in-state={state.kind}>
      {state.kind === 'opens_later' && <p className="driver-rota__check-in-text">{describeCheckInOpens(state.opensAt)}</p>}
      {state.kind === 'closed' && <p className="driver-rota__check-in-text">{CHECK_IN_CLOSED_TEXT}</p>}
      {state.kind === 'checked_in' && (
        <p className="driver-rota__check-in-text driver-rota__check-in-text--done">{describeCheckedIn(state.checkedInAt)}</p>
      )}
      {state.kind === 'open' && (
        <Button
          variant="primary"
          size="sm"
          className="driver-rota__check-in-button"
          disabled={status.pending}
          aria-busy={status.pending}
          aria-label={`Check in to ${shift.shiftName}`}
          aria-describedby={status.error ? errorId : undefined}
          onClick={() => onCheckIn(shift.assignmentId)}
        >
          {status.pending ? 'Checking in…' : 'Check in'}
        </Button>
      )}
      <div id={statusId} className="visually-hidden" role="status">
        {status.justCheckedIn && state.kind === 'checked_in' ? CHECK_IN_SUCCESS_TEXT : ''}
      </div>
      {status.error && (
        <p id={errorId} className="driver-rota__check-in-error" role="alert">
          {status.error}
        </p>
      )}
    </div>
  );
}
