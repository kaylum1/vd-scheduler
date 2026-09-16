import React from 'react';

/**
 * Weekday convention throughout Shift Setup: Monday = 0 .. Sunday = 6,
 * matching the database (app_weekday) — this is the only place the UI
 * translates that integer to something a manager reads. Deliberately not
 * imported from mock-data/date-utils — Configuration never depends on the
 * Stage 1.1 mock-data module (see Configuration.test.tsx's architecture
 * check).
 */
export const WEEKDAYS = [
  { index: 0, label: 'Mon', full: 'Monday' },
  { index: 1, label: 'Tue', full: 'Tuesday' },
  { index: 2, label: 'Wed', full: 'Wednesday' },
  { index: 3, label: 'Thu', full: 'Thursday' },
  { index: 4, label: 'Fri', full: 'Friday' },
  { index: 5, label: 'Sat', full: 'Saturday' },
  { index: 6, label: 'Sun', full: 'Sunday' },
] as const;

/** Compact "Mon Tue Wed" / "Sat Sun" -style label for a set of weekdays, e.g. a shift card's subtitle. */
export function weekdaysLabel(weekdays: number[]): string {
  return [...weekdays]
    .sort((a, b) => a - b)
    .map((w) => WEEKDAYS[w]?.label ?? '?')
    .join(' ');
}

/** Read-only weekday chip row — the scannable "Mon Tue Wed Thu Fri Sat Sun" strip on a Shift card. */
export function WeekdayChipsDisplay({ weekdays, prefix }: { weekdays: number[]; prefix?: string }) {
  const active = new Set(weekdays);
  return (
    <span className="shift-template-row__days" aria-label={`${prefix ?? ''}${weekdaysLabel(weekdays)}`.trim()}>
      {WEEKDAYS.map((w) => (
        <span key={w.index} className={`shift-template-row__day${active.has(w.index) ? ' is-active' : ''}`} aria-hidden="true">
          {w.label[0]}
        </span>
      ))}
    </span>
  );
}

/** Interactive multi-select weekday toggle row for the Add/Edit/Reactivate forms. */
export function WeekdayToggleGroup({
  selected,
  onChange,
  idPrefix,
}: {
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
  idPrefix: string;
}) {
  return (
    <div className="weekday-toggle-group" role="group" aria-label="Repeats">
      {WEEKDAYS.map((w) => {
        const isActive = selected.has(w.index);
        return (
          <button
            key={w.index}
            type="button"
            id={`${idPrefix}-weekday-${w.index}`}
            className={`weekday-toggle-group__day${isActive ? ' is-active' : ''}`}
            aria-pressed={isActive}
            onClick={() => {
              const next = new Set(selected);
              if (isActive) next.delete(w.index);
              else next.add(w.index);
              onChange(next);
            }}
          >
            {w.label}
          </button>
        );
      })}
    </div>
  );
}
