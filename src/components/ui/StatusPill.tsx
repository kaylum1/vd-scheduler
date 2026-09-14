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
 * one of three, never conflated:
 *   - NO SERVICE: no shift_instance exists at all for that date — not this
 *     function's concern. Render a neutral/empty state instead (see
 *     EmptyShiftCell in components/rota/ShiftCard.tsx, and the "No shifts
 *     scheduled" branch in components/dashboard/TodayTomorrowPanel.tsx) —
 *     never by calling coverageTone(0, 0), which would misreport it as red.
 *   - STAFFING NOT CONFIGURED (Stage 2D Checkpoint 3): a real shift_instance
 *     exists but required is NULL — no rota_rules_* row applied at
 *     materialisation time. Amber/"Needs Attention", distinct from a real
 *     under-staffed shift — call these with required === null.
 *   - UNCOVERED / COVERED: a real shift_instance with a configured (non-
 *     null) required count. Call these only once a real shift_instance is
 *     in hand.
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
