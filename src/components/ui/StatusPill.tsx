import React from 'react';

export type StatusTone = 'green' | 'amber' | 'red' | 'grey' | 'blue';

export function StatusPill({
  tone,
  children,
}: {
  tone: StatusTone;
  children: React.ReactNode;
}) {
  return (
    <span className={`status-pill status-pill--${tone}`}>
      <span className="status-pill__dot" />
      {children}
    </span>
  );
}

/**
 * Derives the fill status tone/label for a shift from filled vs required
 * counts.
 *
 * PRODUCT RULE (see docs/business-rules.md §A): "no shift scheduled" is not
 * the same thing as "uncovered". These two functions render coverage for a
 * shift that already exists — call them only when a real shift_instance
 * (required_drivers > 0 by DB constraint) is in hand. A day/cell with no
 * shift at all must render as a neutral/empty state instead (see
 * EmptyShiftCell in components/rota/ShiftCard.tsx, and the "No shifts
 * scheduled" branch in components/dashboard/TodayTomorrowPanel.tsx) —
 * never by calling coverageTone(0, 0), which would misreport it as 'red'.
 */
export function coverageTone(filled: number, required: number): StatusTone {
  if (filled <= 0) return 'red';
  if (filled < required) return 'amber';
  return 'green';
}

/** See coverageTone's doc comment — same "a real shift already exists" precondition applies. */
export function coverageLabel(filled: number, required: number): string {
  if (filled <= 0) return 'No coverage';
  return `${filled}/${required} filled`;
}
