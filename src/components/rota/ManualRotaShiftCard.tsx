import React, { useId, useState } from 'react';
import { Button } from '../ui/Button';
import { StatusPill } from '../ui/StatusPill';
import { IconCheck, IconChevronDown, IconClock } from '../ui/icons';
import { AvailabilityBadge } from './AvailabilityBadge';
import { getShiftCoverage } from '../../lib/rotaCoverage';
import type { ManagerRotaAssignment, ManagerRotaDriver, ManagerRotaShift, RotaAvailabilityState } from '../../repositories/domain';

/** Offer the people most likely to say yes first: Available, then Not Submitted, then Unavailable. */
const AVAILABILITY_ORDER: Record<RotaAvailabilityState, number> = { available: 0, not_submitted: 1, unavailable: 2 };

export const assignKey = (shiftInstanceId: string, driverId: string) => `assign:${shiftInstanceId}:${driverId}`;
export const removeKey = (shiftInstanceId: string, driverId: string) => `remove:${shiftInstanceId}:${driverId}`;

/**
 * One real shift instance in the manager's weekly rota. Purely presentational:
 * coverage is derived from the repository's read model via the shared helper,
 * and every action is a callback -- this component knows nothing about
 * repositories, queries, or the database.
 *
 * `readOnly` is a historical (past-dated) shift: shown for reference, with no
 * Assign/Remove controls, because the database refuses edits to those anyway.
 */
export function ManualRotaShiftCard({
  shift,
  candidates,
  readOnly,
  inFlight,
  onAssign,
  onRemove,
}: {
  shift: ManagerRotaShift;
  /** Active resort drivers (the model's candidateDrivers). Those already assigned here are filtered out below. */
  candidates: ManagerRotaDriver[];
  readOnly: boolean;
  /** Keys (assignKey/removeKey) of actions currently running, so only THOSE buttons are disabled. */
  inFlight: ReadonlySet<string>;
  onAssign: (shift: ManagerRotaShift, driver: ManagerRotaDriver) => void;
  onRemove: (shift: ManagerRotaShift, assignment: ManagerRotaAssignment) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerId = useId();
  const coverage = getShiftCoverage(shift);

  const assignedIds = new Set(shift.assignments.map((a) => a.driverId));
  const options = candidates
    .filter((c) => !assignedIds.has(c.driverId))
    .map((c) => ({ driver: c, availability: shift.availabilityByDriver[c.driverId] ?? ('not_submitted' as const) }))
    .sort((a, b) => AVAILABILITY_ORDER[a.availability] - AVAILABILITY_ORDER[b.availability] || a.driver.fullName.localeCompare(b.driver.fullName));
  const availableCount = options.filter((o) => o.availability === 'available').length;

  return (
    <article
      className={`manual-shift manual-shift--${coverage.isCovered ? 'covered' : 'uncovered'}${readOnly ? ' manual-shift--historical' : ''}`}
      aria-label={`${shift.name}, ${shift.startTime}–${shift.endTime}`}
    >
      <header className="manual-shift__header">
        <div className="manual-shift__title">
          <h4 className="manual-shift__name">{shift.name}</h4>
          <div className="manual-shift__time">
            <IconClock style={{ width: 12, height: 12 }} aria-hidden="true" />
            {shift.startTime}–{shift.endTime}
          </div>
        </div>
        <div className="manual-shift__coverage">
          <span className="manual-shift__count">
            {coverage.activeAssigned} / {coverage.required} active assigned
          </span>
          <StatusPill tone={coverage.isCovered ? 'green' : 'red'}>{coverage.isCovered ? 'Covered' : 'Uncovered'}</StatusPill>
          {readOnly && <StatusPill tone="grey">Historical</StatusPill>}
        </div>
      </header>

      {coverage.inactiveAssigned > 0 && (
        <p className="manual-shift__note">
          {coverage.inactiveAssigned} inactive {coverage.inactiveAssigned === 1 ? 'driver is' : 'drivers are'} assigned but not counted toward coverage.
        </p>
      )}

      {shift.assignments.length === 0 ? (
        <p className="manual-shift__empty">No drivers assigned.</p>
      ) : (
        <ul className="driver-rows" aria-label={`Drivers assigned to ${shift.name}`}>
          {shift.assignments.map((assignment) => {
            const removing = inFlight.has(removeKey(shift.shiftInstanceId, assignment.driverId));
            return (
              <li key={assignment.assignmentId} className={`driver-row${assignment.isDriverActive ? '' : ' driver-row--inactive'}`}>
                <span className="driver-row__name">{assignment.driverName}</span>
                {assignment.isDriverActive ? (
                  <AvailabilityBadge state={shift.availabilityByDriver[assignment.driverId] ?? 'not_submitted'} />
                ) : (
                  <StatusPill tone="grey">Inactive</StatusPill>
                )}
                <span className="assignment-tag">
                  <IconCheck style={{ width: 12, height: 12 }} aria-hidden="true" />
                  Assigned
                </span>
                {!readOnly && (
                  <Button
                    variant="danger-outline"
                    size="sm"
                    className="driver-row__action"
                    aria-label={`Remove ${assignment.driverName} from ${shift.name}`}
                    disabled={removing}
                    onClick={() => onRemove(shift, assignment)}
                  >
                    {removing ? 'Removing…' : 'Remove'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && (
        <div className="manual-shift__assign">
          {options.length === 0 ? (
            <p className="manual-shift__empty">No other active drivers to assign.</p>
          ) : (
            <>
              <button type="button" className="assign-toggle" aria-expanded={pickerOpen} aria-controls={pickerId} onClick={() => setPickerOpen((open) => !open)}>
                <span>{pickerOpen ? 'Hide drivers' : 'Assign a driver'}</span>
                <span className="assign-toggle__hint">{availableCount} available</span>
                <IconChevronDown className="assign-toggle__chevron" style={{ width: 14, height: 14 }} aria-hidden="true" />
              </button>
              {pickerOpen && (
                <ul id={pickerId} className="driver-rows" aria-label={`Drivers who can be assigned to ${shift.name}`}>
                  {options.map(({ driver, availability }) => {
                    const assigning = inFlight.has(assignKey(shift.shiftInstanceId, driver.driverId));
                    return (
                      <li key={driver.driverId} className="driver-row">
                        <span className="driver-row__name">{driver.fullName}</span>
                        <AvailabilityBadge state={availability} />
                        <Button
                          variant="secondary"
                          size="sm"
                          className="driver-row__action"
                          aria-label={`Assign ${driver.fullName} to ${shift.name}`}
                          disabled={assigning}
                          onClick={() => onAssign(shift, driver)}
                        >
                          {assigning ? 'Assigning…' : 'Assign'}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}
