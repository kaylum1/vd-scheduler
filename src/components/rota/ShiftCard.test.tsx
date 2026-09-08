// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyShiftCell, ShiftCard } from './ShiftCard';
import type { ShiftInstance } from '../../types';

const baseShift: ShiftInstance = {
  id: 's1',
  shiftDefinitionId: 'sd1',
  resortId: 'crans-montana',
  date: '2026-09-08',
  name: 'Dinner',
  startTime: '18:00',
  endTime: '21:30',
  requiredDrivers: 1,
  isPremium: false,
  assignedDriverIds: [],
  isPublished: false,
};

/**
 * Stage 2D Checkpoint 1.1, product rule (docs/business-rules.md §A):
 * "no shift scheduled" (EmptyShiftCell) must never look or read like
 * "uncovered" (ShiftCard with zero assigned drivers) — they are visually
 * and semantically distinct code paths, not two branches of one component.
 */
describe('EmptyShiftCell vs ShiftCard: no-shift is distinct from uncovered', () => {
  it('18: EmptyShiftCell renders a neutral cell with no coverage/warning text at all', () => {
    render(<EmptyShiftCell />);
    expect(screen.queryByText(/no coverage/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/uncovered/i)).not.toBeInTheDocument();
    expect(document.querySelector('.shift-cell-empty')).toBeInTheDocument();
    expect(document.querySelector('.shift-card')).not.toBeInTheDocument();
  });

  it('19: uncovered ("No coverage") styling only appears for a real shift with zero assigned drivers', () => {
    render(<ShiftCard shift={baseShift} assignedDrivers={[]} />);
    expect(screen.getByText('No coverage')).toBeInTheDocument();
    expect(document.querySelector('.shift-card--no-coverage')).toBeInTheDocument();
  });

  it('a real, fully-covered shift shows neither "No coverage" nor the empty-cell markup', () => {
    render(<ShiftCard shift={{ ...baseShift, assignedDriverIds: ['d1'] }} assignedDrivers={[{ id: 'd1', name: 'Gianni', resortId: 'crans-montana', initials: 'GI' }]} />);
    expect(screen.queryByText('No coverage')).not.toBeInTheDocument();
    expect(document.querySelector('.shift-card--no-coverage')).not.toBeInTheDocument();
    expect(document.querySelector('.shift-cell-empty')).not.toBeInTheDocument();
  });
});
