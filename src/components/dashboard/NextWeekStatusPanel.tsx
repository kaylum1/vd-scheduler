import React from 'react';
import { getResortWeekReadiness } from '../../lib/rotaReadiness';
import { addWeeks, formatWeekRangeLabel, startOfWeek } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import { resorts } from '../../mock-data/resorts';
import { StatusPill, type StatusTone } from '../ui/StatusPill';
import { IconAlert, IconCheck, IconTruck } from '../ui/icons';

/**
 * Scheduling-readiness at a glance for the coming week: is availability in,
 * is the rota ready to generate, has it been published, and is anything
 * still uncovered.
 */
export function NextWeekStatusPanel() {
  // Week boundaries are operational (Europe/Zurich) — see src/lib/operationalTime.ts.
  const nextWeekStart = addWeeks(startOfWeek(getOperationalToday()), 1);

  return (
    <div className="card">
      <div className="card__header">
        <h3>Next Week Status — {formatWeekRangeLabel(nextWeekStart)}</h3>
      </div>
      <div className="readiness-grid">
        {resorts.map((resort) => {
          const readiness = getResortWeekReadiness(resort, nextWeekStart, false);
          let tone: StatusTone = 'grey';
          let label = 'No drivers yet';
          if (readiness.driverCount === 0) {
            tone = 'grey';
            label = 'No drivers — cannot generate';
          } else if (readiness.isPublished) {
            tone = 'blue';
            label = 'Published';
          } else if (readiness.readyToGenerate) {
            tone = 'green';
            label = 'Ready to generate';
          } else {
            tone = 'amber';
            label = 'Missing availability';
          }

          return (
            <div className="readiness-card" key={resort.id}>
              <div className="readiness-card__header">
                <span className={`resort-dot resort-dot--${resort.id}`} />
                <strong>{resort.name}</strong>
                <StatusPill tone={tone}>{label}</StatusPill>
              </div>

              <ul className="readiness-card__list">
                {readiness.driverCount === 0 ? (
                  <li className="readiness-card__item readiness-card__item--muted">
                    <IconTruck style={{ width: 13, height: 13 }} />
                    Add drivers to this resort to start scheduling
                  </li>
                ) : (
                  <>
                    <li
                      className={`readiness-card__item${
                        readiness.availabilityComplete ? ' readiness-card__item--ok' : ' readiness-card__item--warning'
                      }`}
                    >
                      {readiness.availabilityComplete ? (
                        <IconCheck style={{ width: 13, height: 13 }} />
                      ) : (
                        <IconAlert style={{ width: 13, height: 13 }} />
                      )}
                      {readiness.availabilityComplete
                        ? 'Availability complete'
                        : `${readiness.missingAvailability.length} driver${
                            readiness.missingAvailability.length === 1 ? '' : 's'
                          } missing availability`}
                    </li>
                    {!readiness.availabilityComplete &&
                      readiness.missingAvailability.map((m) => (
                        <li className="readiness-card__sub-item" key={m.driverId}>
                          {m.driverName} — {m.missingShiftCount} shift{m.missingShiftCount === 1 ? '' : 's'} not submitted
                        </li>
                      ))}
                    <li
                      className={`readiness-card__item${
                        readiness.uncoveredShifts.length > 0 ? ' readiness-card__item--danger' : ' readiness-card__item--ok'
                      }`}
                    >
                      {readiness.uncoveredShifts.length > 0 ? (
                        <>
                          <IconAlert style={{ width: 13, height: 13 }} />
                          {readiness.uncoveredShifts.length} shift{readiness.uncoveredShifts.length === 1 ? '' : 's'} with no coverage
                        </>
                      ) : (
                        <>
                          <IconCheck style={{ width: 13, height: 13 }} />
                          All shifts covered
                        </>
                      )}
                    </li>
                  </>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
