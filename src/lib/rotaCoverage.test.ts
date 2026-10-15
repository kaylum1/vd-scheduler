import { describe, expect, it } from 'vitest';
import { countActiveAssignments, getShiftCoverage, isShiftCovered } from './rotaCoverage';

const active = { isDriverActive: true };
const inactive = { isDriverActive: false };

describe('rotaCoverage (derived, never stored)', () => {
  it('required 1 / 0 active assigned -> uncovered', () => {
    expect(isShiftCovered({ requiredDrivers: 1, assignments: [] })).toBe(false);
  });

  it('required 1 / 1 active assigned -> covered', () => {
    expect(isShiftCovered({ requiredDrivers: 1, assignments: [active] })).toBe(true);
  });

  it('required 1 / 2 active assigned -> still covered (a minimum, never a capacity)', () => {
    const shift = { requiredDrivers: 1, assignments: [active, active] };
    expect(isShiftCovered(shift)).toBe(true);
    expect(getShiftCoverage(shift)).toMatchObject({ required: 1, activeAssigned: 2, isCovered: true });
  });

  it('required 2 / one active + one INACTIVE -> uncovered (an inactive assignee does not satisfy the requirement)', () => {
    const shift = { requiredDrivers: 2, assignments: [active, inactive] };
    expect(isShiftCovered(shift)).toBe(false);
    expect(getShiftCoverage(shift)).toEqual({ required: 2, activeAssigned: 1, inactiveAssigned: 1, isCovered: false });
  });

  it('required 2 / two active + one inactive -> covered', () => {
    const shift = { requiredDrivers: 2, assignments: [active, active, inactive] };
    expect(isShiftCovered(shift)).toBe(true);
    expect(getShiftCoverage(shift)).toEqual({ required: 2, activeAssigned: 2, inactiveAssigned: 1, isCovered: true });
  });

  it('only inactive assignees -> uncovered, however many there are', () => {
    expect(isShiftCovered({ requiredDrivers: 1, assignments: [inactive, inactive, inactive] })).toBe(false);
  });

  it('countActiveAssignments counts only active drivers', () => {
    expect(countActiveAssignments({ assignments: [active, inactive, active, inactive] })).toBe(2);
    expect(countActiveAssignments({ assignments: [] })).toBe(0);
  });

  it('is deterministic -- the same input always gives the same answer, and never mutates it', () => {
    const shift = { requiredDrivers: 2, assignments: [active, inactive] };
    const snapshot = JSON.stringify(shift);
    expect(getShiftCoverage(shift)).toEqual(getShiftCoverage(shift));
    expect(JSON.stringify(shift)).toBe(snapshot);
  });
});
