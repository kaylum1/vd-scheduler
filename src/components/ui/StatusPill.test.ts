import { describe, expect, it } from 'vitest';
import { coverageLabel, coverageTone } from './StatusPill';

/**
 * Stage 2D Checkpoint 1.1, product rule (docs/business-rules.md §A):
 * "no shift scheduled" is not the same thing as "uncovered". These tests
 * pin down what coverageTone/coverageLabel themselves guarantee: they
 * always describe a shift that already exists (required > 0, matching the
 * DB's shift_templates/shift_instances required_drivers > 0 constraint).
 * The "no shift at all" state is a *different* code path entirely
 * (EmptyShiftCell / "No shifts scheduled" — see ShiftCard.test.tsx), never
 * these functions called with filled=0, required=0.
 */
describe('coverageTone / coverageLabel: uncovered styling requires a real, existing shift', () => {
  it('a real shift with zero assigned drivers is red / "No coverage"', () => {
    expect(coverageTone(0, 1)).toBe('red');
    expect(coverageLabel(0, 1)).toBe('No coverage');
  });

  it('a real shift partially staffed is amber / "x/y filled"', () => {
    expect(coverageTone(1, 2)).toBe('amber');
    expect(coverageLabel(1, 2)).toBe('1/2 filled');
  });

  it('a real shift fully staffed is green / "x/y filled"', () => {
    expect(coverageTone(2, 2)).toBe('green');
    expect(coverageLabel(2, 2)).toBe('2/2 filled');
  });

  it('these are never the function a "no shift scheduled" cell should call — required is always > 0 for a real shift_instance (DB constraint)', () => {
    // Documents the precondition rather than testing new behaviour: calling
    // these with required=0 (as a "no shift" cell mistakenly might) would
    // misreport a genuinely empty day as 'red'/"No coverage" — which is
    // exactly the bug the product rule forbids. The fix is that callers
    // never do this (see EmptyShiftCell/"No shifts scheduled" instead), not
    // a defensive branch inside these pure functions.
    expect(coverageTone(0, 0)).toBe('red'); // would be wrong if ever used for "no shift" — callers must not do this
  });
});

/**
 * Legacy defensive fallback only (docs/business-rules.md §A): required_drivers
 * became mandatory at Shift-creation time in the Stage 2D staffing
 * simplification, so a normal materialised instance can never actually be
 * NULL any more. This branch exists only for any pre-simplification data
 * that predates that constraint -- never conflate it with "no service" (no
 * instance at all) or "uncovered" (a real, configured requirement that
 * isn't met).
 */
describe('coverageTone / coverageLabel: legacy "staffing not configured" fallback (required = null)', () => {
  it('is amber / "Staffing not configured", regardless of how many drivers happen to be assigned', () => {
    expect(coverageTone(0, null)).toBe('amber');
    expect(coverageLabel(0, null)).toBe('Staffing not configured');
  });

  it('stays amber/"Staffing not configured" even when drivers are already assigned', () => {
    expect(coverageTone(2, null)).toBe('amber');
    expect(coverageLabel(2, null)).toBe('Staffing not configured');
  });

  it('is never reported as "uncovered"/red the way an unmet real requirement would be', () => {
    expect(coverageTone(0, null)).not.toBe('red');
  });
});
