/**
 * Manual Rota coverage -- pure, deterministic, provider-independent.
 *
 * Coverage is DERIVED, never stored or fetched (docs/business-rules.md §A):
 *
 *   active assignments <  required_drivers  -> uncovered
 *   active assignments >= required_drivers  -> covered   (above-required stays "covered")
 *
 * Only assignments whose driver is currently ACTIVE count. An inactive
 * assignee stays on the shift (never silently deleted) but does not satisfy
 * the staffing requirement, so the manager can see the gap and replace them.
 * `required_drivers` is a minimum, not a capacity: 3 active of 2 is covered.
 */

interface CoverageAssignment {
  isDriverActive: boolean;
}

interface CoverageShift {
  requiredDrivers: number;
  assignments: readonly CoverageAssignment[];
}

export interface ShiftCoverage {
  required: number;
  /** Assignments whose driver is active -- the only ones that count toward `required`. */
  activeAssigned: number;
  /** Assignments whose driver has since been deactivated. Shown, never counted. */
  inactiveAssigned: number;
  isCovered: boolean;
}

export function countActiveAssignments(shift: Pick<CoverageShift, 'assignments'>): number {
  return shift.assignments.filter((a) => a.isDriverActive).length;
}

export function getShiftCoverage(shift: CoverageShift): ShiftCoverage {
  const activeAssigned = countActiveAssignments(shift);
  return {
    required: shift.requiredDrivers,
    activeAssigned,
    inactiveAssigned: shift.assignments.length - activeAssigned,
    isCovered: activeAssigned >= shift.requiredDrivers,
  };
}

export function isShiftCovered(shift: CoverageShift): boolean {
  return getShiftCoverage(shift).isCovered;
}
