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

/** Derives the fill status tone/label for a shift from filled vs required counts. */
export function coverageTone(filled: number, required: number): StatusTone {
  if (filled <= 0) return 'red';
  if (filled < required) return 'amber';
  return 'green';
}

export function coverageLabel(filled: number, required: number): string {
  if (filled <= 0) return 'No coverage';
  return `${filled}/${required} filled`;
}
