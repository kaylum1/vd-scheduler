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
 * PRODUCT RULE (see docs/business-rules.md §A): a shift's coverage state is
 * one of two in normal operation, never conflated:
 *   - NO SERVICE: no shift_instance exists at all for that date — not this
 *     function's concern. Render a neutral/empty state instead (see
 *     EmptyShiftCell in components/rota/ShiftCard.tsx, and the "No shifts
 *     scheduled" branch in components/dashboard/TodayTomorrowPanel.tsx) —
 *     never by calling coverageTone(0, 0), which would misreport it as red.
 *   - UNCOVERED / COVERED: a real shift_instance with a required count
 *     (mandatory since the Stage 2D staffing simplification -- always a
 *     real positive number, never missing). Call these only once a real
 *     shift_instance is in hand.
 *
 * `required === null` (amber, "Staffing not configured") is a defensive
 * fallback for legacy pre-simplification data only -- required_drivers is
 * mandatory at Shift-creation time now, so a normal materialised instance
 * can never actually be null. Never expect a manager to see this on data
 * created since.
 */
export function coverageTone(filled: number, required: number | null): StatusTone {
  if (required === null) return 'amber';
  if (filled <= 0) return 'red';
  if (filled < required) return 'amber';
  return 'green';
}

/** See coverageTone's doc comment — same preconditions apply. */
export function coverageLabel(filled: number, required: number | null): string {
  if (required === null) return 'Staffing not configured';
  if (filled <= 0) return 'No coverage';
  return `${filled}/${required} filled`;
}
