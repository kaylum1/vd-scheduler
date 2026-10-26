import { describe, expect, it } from 'vitest';
import { buildAutoRotaPlan, compareShiftsCanonical, openSlotsOf, summarizeOpenCoverage } from './autoRotaPlanner';
import { weeklyTieBreakKey } from './autoRotaHash';
import type { AutoRotaPlan, ManagerRotaShift, ManagerWeekRota, RotaAvailabilityState } from '../repositories/domain';

// ---------------------------------------------------------------------------
// Fixtures. Week of Monday 2030-01-07. Mon-Thu are the WEEKDAY bucket,
// Fri-Sun the WEEKEND bucket. "driver-a" beats "driver-b" on an equal-count tie
// in this week (see autoRotaHash.test.ts: that is what the FNV tie-break says).
// ---------------------------------------------------------------------------
const WEEK = '2030-01-07';
const D = { mon: '2030-01-07', tue: '2030-01-08', wed: '2030-01-09', thu: '2030-01-10', fri: '2030-01-11', sat: '2030-01-12', sun: '2030-01-13' };
const LONG_AGO = '2030-01-01'; // "today" for tests where nothing is historical
const A = 'driver-a';
const B = 'driver-b';
const C = 'driver-c';

interface ShiftSpec {
  id: string;
  date: string;
  required?: number;
  name?: string;
  sortOrder?: number;
  start?: string;
  /** driverId -> state; omitted drivers are Not Submitted. */
  avail?: Record<string, RotaAvailabilityState>;
  /** Existing assignments. `active: false` = an inactive assignee (who is not a candidate). */
  assigned?: Array<{ driver: string; active?: boolean; source?: 'manual' | 'auto' }>;
}

function shift(spec: ShiftSpec, candidates: string[]): ManagerRotaShift {
  return {
    shiftInstanceId: spec.id,
    shiftTypeId: `type-${spec.id}`,
    date: spec.date,
    name: spec.name ?? 'Dinner',
    sortOrder: spec.sortOrder ?? 1,
    startTime: spec.start ?? '18:00',
    endTime: '21:30',
    requiredDrivers: spec.required ?? 1,
    assignments: (spec.assigned ?? []).map((a, i) => ({
      assignmentId: `${spec.id}-a${i}`,
      driverId: a.driver,
      driverName: a.driver,
      isDriverActive: a.active ?? true,
      source: a.source ?? 'manual',
      assignedAt: `2030-01-01T10:00:0${i}.000Z`,
      attendance: null,
      checkIn: null,
    })),
    availabilityByDriver: Object.fromEntries(candidates.map((d) => [d, spec.avail?.[d] ?? 'not_submitted'])),
  };
}

function week(candidates: string[], specs: ShiftSpec[], weekStart = WEEK): ManagerWeekRota {
  return {
    resortId: 'resort-1',
    weekStart,
    isPublished: false,
    candidateDrivers: candidates.map((id) => ({ driverId: id, fullName: id })),
    shifts: specs.map((s) => shift(s, candidates)),
  };
}

const plan = (w: ManagerWeekRota, today = LONG_AGO) => buildAutoRotaPlan({ week: w, operationalToday: today });
const pairs = (p: AutoRotaPlan) => p.assignments.map((a) => `${a.shiftInstanceId}:${a.driverId}`);
const drivers = (p: AutoRotaPlan, shiftId: string) => p.assignments.filter((a) => a.shiftInstanceId === shiftId).map((a) => a.driverId);

/** What the database would hold after a successful apply -- the input to a re-run. */
function applied(w: ManagerWeekRota, p: AutoRotaPlan): ManagerWeekRota {
  return {
    ...w,
    shifts: w.shifts.map((s) => ({
      ...s,
      assignments: [
        ...s.assignments,
        ...p.assignments
          .filter((a) => a.shiftInstanceId === s.shiftInstanceId)
          .map((a, i) => ({ assignmentId: `new-${s.shiftInstanceId}-${i}`, driverId: a.driverId, driverName: a.driverId, isDriverActive: true, source: 'auto' as const, assignedAt: '2030-01-02T00:00:00.000Z', attendance: null, checkIn: null })),
      ],
    })),
  };
}

const all = { [A]: 'available', [B]: 'available', [C]: 'available' } as Record<string, RotaAvailabilityState>;

describe('buildAutoRotaPlan: eligibility', () => {
  it('1. proposes an Available driver', () => {
    expect(pairs(plan(week([A], [{ id: 's', date: D.fri, avail: { [A]: 'available' } }])))).toEqual(['s:driver-a']);
  });

  it('2. never proposes an Unavailable driver (no override exists)', () => {
    const p = plan(week([A, B], [{ id: 's', date: D.fri, avail: { [A]: 'unavailable', [B]: 'available' } }]));
    expect(pairs(p)).toEqual(['s:driver-b']);
    expect(pairs(plan(week([A], [{ id: 's', date: D.fri, avail: { [A]: 'unavailable' } }])))).toEqual([]);
  });

  it('3. never proposes a Not Submitted driver', () => {
    const p = plan(week([A, B], [{ id: 's', date: D.fri, avail: { [B]: 'available' } }])); // A has no answer
    expect(pairs(p)).toEqual(['s:driver-b']);
    expect(pairs(plan(week([A], [{ id: 's', date: D.fri }])))).toEqual([]);
  });

  it('4. never proposes an inactive driver: only the resort\'s ACTIVE candidates are considered, whatever the availability map holds', () => {
    const w = week([A], [{ id: 's', date: D.fri, required: 2, avail: { [A]: 'available' }, assigned: [{ driver: 'driver-inactive', active: false }] }]);
    w.shifts[0].availabilityByDriver['driver-inactive'] = 'available';
    expect(pairs(plan(w))).toEqual(['s:driver-a']);
  });

  it('5. a driver already assigned to a shift is never proposed for it again (active or inactive)', () => {
    const w = week([A, B, C], [{ id: 's', date: D.fri, required: 3, avail: all, assigned: [{ driver: A }] }]); // open: 2
    expect(drivers(plan(w), 's').sort()).toEqual([B, C]);
    const inactiveDuplicate = week([A, B], [{ id: 's', date: D.fri, required: 2, avail: all, assigned: [{ driver: A, active: false }] }]);
    expect(drivers(plan(inactiveDuplicate), 's')).toEqual([B]); // A is inactive here, so not a candidate again, and never twice
  });

  it('28. availability is per EXACT shift -- never inferred from another shift on the same day', () => {
    const w = week([A, B], [
      { id: 'lunch', date: D.sat, name: 'Lunch', sortOrder: 0, start: '12:00', avail: { [A]: 'available' } },
      { id: 'dinner', date: D.sat, name: 'Dinner', sortOrder: 1, start: '18:00', avail: { [B]: 'available' } },
    ]);
    const p = plan(w);
    expect(drivers(p, 'lunch')).toEqual([A]);
    expect(drivers(p, 'dinner')).toEqual([B]);
  });
});

describe('buildAutoRotaPlan: buckets and fairness', () => {
  it('6/7. the WEEKEND bucket is planned before the WEEKDAY bucket', () => {
    const w = week([A, B], [
      { id: 'mon', date: D.mon, avail: { [A]: 'available', [B]: 'available' } },
      { id: 'sat', date: D.sat, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    expect(plan(w).assignments.map((a) => a.shiftInstanceId)).toEqual(['sat', 'mon']);
  });

  it('only Fri/Sat/Sun are weekend; Mon-Thu are weekday', () => {
    const shifts = [D.thu, D.fri].map((date, i) => ({ id: `s${i}`, date, avail: { [A]: 'available' } as Record<string, RotaAvailabilityState> }));
    expect(plan(week([A], shifts)).assignments.map((a) => a.shiftInstanceId)).toEqual(['s1', 's0']); // Fri (weekend) first, Thu (weekday) after
  });

  it('15. simple fairness: two weekend shifts, two drivers -> one each, the Friday winner is the weekly tie-break', () => {
    const w = week([A, B], [
      { id: 'fri', date: D.fri, avail: { [A]: 'available', [B]: 'available' } },
      { id: 'sat', date: D.sat, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    const p = plan(w);
    expect(drivers(p, 'fri')).toEqual([A]); // equal counts -> FNV(week:driver-a) < FNV(week:driver-b)
    expect(drivers(p, 'sat')).toEqual([B]);
  });

  it('8. weekend fairness: fewest WEEKEND assignments wins', () => {
    const w = week([A, B], [
      { id: 'fri', date: D.fri, avail: all, assigned: [{ driver: A }] },
      { id: 'sat', date: D.sat, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    expect(drivers(plan(w), 'sat')).toEqual([B]);
  });

  it('9. weekday fairness: fewest WEEKDAY assignments wins', () => {
    const w = week([A, B], [
      { id: 'mon', date: D.mon, avail: all, assigned: [{ driver: A }] },
      { id: 'tue', date: D.tue, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    expect(drivers(plan(w), 'tue')).toEqual([B]);
  });

  it('10. the weekday bucket is judged by WEEKDAY count first -- a heavy weekend load does not primarily compensate', () => {
    // A: 1 weekday, 0 weekend (total 1).  B: 0 weekday, 3 weekend (total 3).
    const w = week([A, B], [
      { id: 'mon', date: D.mon, avail: all, assigned: [{ driver: A }] },
      { id: 'fri', date: D.fri, avail: all, assigned: [{ driver: B }] },
      { id: 'sat', date: D.sat, avail: all, assigned: [{ driver: B }] },
      { id: 'sun', date: D.sun, avail: all, assigned: [{ driver: B }] },
      { id: 'tue', date: D.tue, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    // If TOTAL were the primary key A (total 1) would win; the approved rule says weekday count (B: 0 < A: 1).
    expect(drivers(plan(w), 'tue')).toEqual([B]);
  });

  it('10. ...and only when the bucket counts TIE does the total count break the tie', () => {
    // Both have 0 weekday assignments. A has a weekend assignment, B none -> B on Tuesday via total.
    const w = week([A, B], [
      { id: 'fri', date: D.fri, avail: all, assigned: [{ driver: A }] },
      { id: 'tue', date: D.tue, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    expect(drivers(plan(w), 'tue')).toEqual([B]);
    // The same imbalance does NOT outweigh a bucket difference in the other direction:
    const w2 = week([A, B], [
      { id: 'fri', date: D.fri, avail: all, assigned: [{ driver: A }] },
      { id: 'mon', date: D.mon, avail: all, assigned: [{ driver: B }] },
      { id: 'tue', date: D.tue, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    expect(drivers(plan(w2), 'tue')).toEqual([A]); // weekday: A 0 < B 1, although totals are equal
  });

  it('11/16. SCARCITY FIRST: Friday {A,B} and Saturday {A only} -> Saturday is planned first, A takes it, B takes Friday: 1 and 1', () => {
    const w = week([A, B], [
      { id: 'fri', date: D.fri, avail: { [A]: 'available', [B]: 'available' } },
      { id: 'sat', date: D.sat, avail: { [A]: 'available' } },
    ]);
    const p = plan(w);
    expect(pairs(p)).toEqual(['sat:driver-a', 'fri:driver-b']); // most constrained shift first
    const perDriver = (id: string) => p.assignments.filter((a) => a.driverId === id).length;
    expect([perDriver(A), perDriver(B)]).toEqual([1, 1]);
  });

  it('16. ...and plain chronological processing would have FAILED that case (A wins the Friday tie, then is the only option on Saturday: 2 / 0)', () => {
    // Precondition: A beats B on an equal-count tie this week, so a Friday-first greedy hands Friday to A.
    expect(weeklyTieBreakKey(WEEK, A)).toBeLessThan(weeklyTieBreakKey(WEEK, B));
    const counts: Record<string, number> = { [A]: 0, [B]: 0 };
    const chronological = [
      { eligible: [A, B] }, // Friday
      { eligible: [A] }, // Saturday
    ];
    for (const slot of chronological) {
      const pick = [...slot.eligible].sort((x, y) => counts[x] - counts[y] || weeklyTieBreakKey(WEEK, x) - weeklyTieBreakKey(WEEK, y))[0];
      counts[pick] += 1;
    }
    expect([counts[A], counts[B]]).toEqual([2, 0]);
  });

  it('12. coverage beats fairness: a lone eligible driver is used even when they already carry the most work', () => {
    const w = week([A, B], [
      { id: 'fri', date: D.fri, avail: all, assigned: [{ driver: A }] },
      { id: 'sat', date: D.sat, avail: all, assigned: [{ driver: A }] },
      { id: 'sun', date: D.sun, avail: { [A]: 'available' } }, // only A can cover Sunday
    ]);
    expect(pairs(plan(w))).toEqual(['sun:driver-a']);
  });

  it('13. equal-count ties follow the weekly FNV tie-break, which ROTATES by week', () => {
    const spec = (weekStart: string, date: string) => week([A, B], [{ id: 's', date, avail: { [A]: 'available', [B]: 'available' } }], weekStart);
    expect(drivers(plan(spec('2030-01-07', D.fri)), 's')).toEqual([A]);
    expect(drivers(plan(spec('2030-01-28', '2030-02-01')), 's')).toEqual([B]); // 2030-01-28: B's key is now lower
  });

  it('17. a shift needing two drivers gets two DISTINCT drivers, updating counts between picks', () => {
    const p = plan(week([A, B, C], [{ id: 's', date: D.fri, required: 2, avail: all }]));
    const picked = drivers(p, 's');
    expect(picked).toHaveLength(2);
    expect(new Set(picked).size).toBe(2);
  });

  it('multi-slot fairness: with two slots the second pick sees the first pick\'s counter (the loser of the first pick is not chosen twice)', () => {
    const w = week([A, B], [{ id: 's', date: D.fri, required: 2, avail: { [A]: 'available', [B]: 'available' } }]);
    expect(drivers(plan(w), 's').sort()).toEqual([A, B]);
  });
});

describe('buildAutoRotaPlan: existing assignments', () => {
  it('18. never over-assigns: a full shift, and an already over-staffed one, get nothing; nothing is ever removed', () => {
    const full = week([A, B, C], [{ id: 's', date: D.fri, required: 2, avail: all, assigned: [{ driver: A }, { driver: B }] }]);
    expect(pairs(plan(full))).toEqual([]);
    const over = week([A, B, C], [{ id: 's', date: D.fri, required: 2, avail: all, assigned: [{ driver: A }, { driver: B }, { driver: C }] }]);
    const p = plan(over);
    expect(pairs(p)).toEqual([]);
    expect(p.remainingOpenSlots).toBe(0);
    // The plan type has no removal concept: every proposed pair is a NEW (shift, driver).
    const partial = week([A, B], [{ id: 's', date: D.fri, required: 2, avail: all, assigned: [{ driver: A }] }]);
    for (const a of plan(partial).assignments) expect(a.driverId).not.toBe(A);
  });

  it('19. an active MANUAL assignment is preserved and counts toward the fairness bucket (B preferred next)', () => {
    const w = week([A, B], [
      { id: 'fri', date: D.fri, avail: all, assigned: [{ driver: A, source: 'manual' }] },
      { id: 'sat', date: D.sat, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    expect(pairs(plan(w))).toEqual(['sat:driver-b']);
  });

  it('20. an active AUTO assignment counts exactly the same -- the source never affects fairness', () => {
    const w = week([A, B], [
      { id: 'fri', date: D.fri, avail: all, assigned: [{ driver: A, source: 'auto' }] },
      { id: 'sat', date: D.sat, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    expect(pairs(plan(w))).toEqual(['sat:driver-b']);
  });

  it('21. an INACTIVE assignee counts for neither coverage nor fairness: required 2 with one inactive assignee still needs two', () => {
    const w = week([A, B], [{ id: 's', date: D.fri, required: 2, avail: { [A]: 'available', [B]: 'available' }, assigned: [{ driver: 'driver-c', active: false }] }]);
    const p = plan(w);
    expect(drivers(p, 's').sort()).toEqual([A, B]);
    expect(p.remainingOpenSlots).toBe(0);
    expect(openSlotsOf(w.shifts[0])).toBe(2);
  });

  it('22. a manual assignment made over an Unavailable answer counts as coverage and as weekend/total work for an ACTIVE driver', () => {
    const w = week([A, B], [
      { id: 'fri', date: D.fri, avail: { [A]: 'unavailable', [B]: 'available' }, assigned: [{ driver: A }] }, // the override
      { id: 'sat', date: D.sat, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    const p = plan(w);
    expect(drivers(p, 'fri')).toEqual([]); // covered by the override
    expect(drivers(p, 'sat')).toEqual([B]); // ...and A's weekend count is 1
  });

  it('23. ...but the override grants NO eligibility elsewhere: Unavailable / Not Submitted on another shift stays excluded', () => {
    const w = week([A, B], [
      { id: 'fri', date: D.fri, avail: { [A]: 'unavailable' }, assigned: [{ driver: A }] },
      { id: 'sat', date: D.sat, avail: { [A]: 'unavailable' } },
      { id: 'sun', date: D.sun, avail: {} },
    ]);
    const p = plan(w);
    expect(pairs(p)).toEqual([]);
    expect(p.uncoveredShiftIds).toEqual(['sat', 'sun']);
  });
});

describe('buildAutoRotaPlan: partial coverage and results', () => {
  it('24. partial coverage: required 2, one eligible -> one proposal, one open slot, the shift is reported uncovered', () => {
    const p = plan(week([A, B], [{ id: 's', date: D.fri, required: 2, avail: { [A]: 'available' } }]));
    expect(pairs(p)).toEqual(['s:driver-a']);
    expect(p.remainingOpenSlots).toBe(1);
    expect(p.uncoveredShiftIds).toEqual(['s']);
  });

  it('25. zero eligible drivers: nothing proposed, every slot reported open', () => {
    const p = plan(week([A, B], [{ id: 's', date: D.fri, required: 2, avail: { [A]: 'unavailable' } }]));
    expect(p.assignments).toEqual([]);
    expect(p.plannedAssignmentCount).toBe(0);
    expect(p.remainingOpenSlots).toBe(2);
    expect(p.uncoveredShiftIds).toEqual(['s']);
  });

  it('26. several shifts on the same day are planned independently (and fairly: one each)', () => {
    const w = week([A, B], [
      { id: 'lunch', date: D.sat, name: 'Lunch', sortOrder: 0, start: '12:00', avail: { [A]: 'available', [B]: 'available' } },
      { id: 'dinner', date: D.sat, name: 'Dinner', sortOrder: 1, start: '18:00', avail: { [A]: 'available', [B]: 'available' } },
    ]);
    const p = plan(w);
    expect(drivers(p, 'lunch')).toHaveLength(1);
    expect(drivers(p, 'dinner')).toHaveLength(1);
    expect(drivers(p, 'lunch')[0]).not.toBe(drivers(p, 'dinner')[0]);
  });

  it('27. overlapping shifts are permitted: a lone Available driver takes both shifts at the same time', () => {
    const w = week([A], [
      { id: 'x', date: D.sat, name: 'Dinner (1P)', start: '18:00', avail: { [A]: 'available' } },
      { id: 'y', date: D.sat, name: 'Dinner (2P)', start: '18:00', avail: { [A]: 'available' } },
    ]);
    expect(pairs(plan(w)).sort()).toEqual(['x:driver-a', 'y:driver-a']);
  });

  it('32. an already covered week produces no plan and no gaps', () => {
    const p = plan(week([A, B], [{ id: 's', date: D.fri, required: 1, avail: all, assigned: [{ driver: C }] }]));
    expect(p.assignments).toEqual([]);
    expect(p.remainingOpenSlots).toBe(0);
    expect(p.uncoveredShiftIds).toEqual([]);
  });

  it('33. re-run: planning from the state AFTER the first plan was applied proposes nothing more (V1 idempotency)', () => {
    const w = week([A, B, C], [
      { id: 'fri', date: D.fri, required: 2, avail: all },
      { id: 'sat', date: D.sat, required: 1, avail: { [A]: 'available' } },
      { id: 'mon', date: D.mon, required: 2, avail: { [B]: 'available' } }, // partial: only one eligible
    ]);
    const first = plan(w);
    expect(first.plannedAssignmentCount).toBe(4);
    const second = plan(applied(w, first));
    expect(second.assignments).toEqual([]);
    expect(second.remainingOpenSlots).toBe(first.remainingOpenSlots); // the unfillable Monday slot is still open, nothing else
    expect(second.uncoveredShiftIds).toEqual(first.uncoveredShiftIds);
  });

  it('34/35. uncoveredShiftIds and remainingOpenSlots are exact, with ids in canonical shift order (not processing order)', () => {
    const w = week([A], [
      { id: 'mon', date: D.mon, required: 2, avail: { [A]: 'available' } }, // needs 2, one eligible -> 1 open
      { id: 'tue', date: D.tue, required: 1, avail: {} }, // 1 open
      { id: 'sat', date: D.sat, required: 3, avail: { [A]: 'available' } }, // 2 open
      { id: 'sun', date: D.sun, required: 1, avail: { [A]: 'available' } }, // covered
    ]);
    const p = plan(w);
    expect(p.remainingOpenSlots).toBe(4);
    expect(p.uncoveredShiftIds).toEqual(['mon', 'tue', 'sat']);
    expect(p.plannedAssignmentCount).toBe(3);
  });
});

describe('buildAutoRotaPlan: history', () => {
  const histWeek = () =>
    week([A, B], [
      { id: 'mon', date: D.mon, avail: all },
      { id: 'tue', date: D.tue, avail: all },
      { id: 'wed', date: D.wed, avail: all },
      { id: 'sat', date: D.sat, avail: all },
    ]);

  it('29/36. shifts before the operational today are skipped, not planned, not reported as gaps; skippedPastShiftCount counts them', () => {
    const p = plan(histWeek(), D.wed);
    expect(p.assignments.map((a) => a.shiftInstanceId).sort()).toEqual(['sat', 'wed']);
    expect(p.skippedPastShiftCount).toBe(2);
    expect(p.uncoveredShiftIds).toEqual([]);
    expect(p.remainingOpenSlots).toBe(0);
    expect(p.weekIsHistorical).toBe(false);
  });

  it('31. TODAY is eligible', () => {
    expect(pairs(plan(week([A], [{ id: 's', date: D.wed, avail: { [A]: 'available' } }]), D.wed))).toEqual(['s:driver-a']);
    expect(pairs(plan(week([A], [{ id: 's', date: D.wed, avail: { [A]: 'available' } }]), D.thu))).toEqual([]);
  });

  it('30. a PAST assignment still counts toward the week\'s fairness (here: Friday has passed, so A already has a weekend shift)', () => {
    const w = week([A, B], [
      { id: 'fri', date: D.fri, avail: all, assigned: [{ driver: A }] },
      { id: 'sat', date: D.sat, avail: { [A]: 'available', [B]: 'available' } },
    ]);
    const p = plan(w, D.sat);
    expect(pairs(p)).toEqual(['sat:driver-b']);
    expect(p.skippedPastShiftCount).toBe(1);
  });

  it('a past shift that is uncovered is NOT a gap; an entirely historical week proposes nothing and says so', () => {
    const w = histWeek();
    const p = plan(w, '2030-01-14');
    expect(p.assignments).toEqual([]);
    expect(p.remainingOpenSlots).toBe(0);
    expect(p.uncoveredShiftIds).toEqual([]);
    expect(p.skippedPastShiftCount).toBe(4);
    expect(p.weekIsHistorical).toBe(true);
    expect(plan(w, D.sun).weekIsHistorical).toBe(false); // the last day of the week is still "today"
  });
});

describe('buildAutoRotaPlan: determinism', () => {
  const scenario = () =>
    week([A, B, C], [
      { id: 'fri', date: D.fri, required: 2, avail: all, assigned: [{ driver: C }] },
      { id: 'sat', date: D.sat, avail: { [A]: 'available', [B]: 'available' } },
      { id: 'sun', date: D.sun, avail: { [A]: 'available' } },
      { id: 'mon', date: D.mon, required: 2, avail: all },
      { id: 'tue', date: D.tue, avail: { [B]: 'available', [C]: 'available' } },
      { id: 'thu', date: D.thu, name: 'Lunch', sortOrder: 0, avail: all },
    ]);

  it('15. identical input -> a byte-for-byte identical plan, every time', () => {
    const first = JSON.stringify(plan(scenario()));
    for (let i = 0; i < 5; i += 1) expect(JSON.stringify(plan(scenario()))).toBe(first);
  });

  it('16. the SAME data in a different array order (shifts, candidates, availability keys, assignments) yields the same plan', () => {
    const original = scenario();
    const expected = JSON.stringify(plan(original));

    const reversed: ManagerWeekRota = {
      ...original,
      candidateDrivers: [...original.candidateDrivers].reverse(),
      shifts: [...original.shifts].reverse().map((s) => ({
        ...s,
        assignments: [...s.assignments].reverse(),
        availabilityByDriver: Object.fromEntries(Object.entries(s.availabilityByDriver).reverse()),
      })),
    };
    expect(JSON.stringify(plan(reversed))).toBe(expected);

    const rotated: ManagerWeekRota = { ...original, candidateDrivers: [...original.candidateDrivers.slice(1), original.candidateDrivers[0]], shifts: [...original.shifts.slice(2), ...original.shifts.slice(0, 2)] };
    expect(JSON.stringify(plan(rotated))).toBe(expected);
  });

  it('does not mutate its input', () => {
    const w = scenario();
    const before = JSON.stringify(w);
    plan(w);
    expect(JSON.stringify(w)).toBe(before);
  });

  it('within a bucket, shifts with the same number of eligible drivers go in canonical order: date, sortOrder, startTime, name, id', () => {
    const w = week([A], [
      { id: 'z', date: D.sat, name: 'B', sortOrder: 2, start: '12:00', avail: { [A]: 'available' } },
      { id: 'y', date: D.sat, name: 'A', sortOrder: 1, start: '20:00', avail: { [A]: 'available' } },
      { id: 'x', date: D.fri, name: 'Z', sortOrder: 9, start: '23:00', avail: { [A]: 'available' } },
      { id: 'w2', date: D.sat, name: 'A', sortOrder: 1, start: '20:00', avail: { [A]: 'available' } },
    ]);
    expect(plan(w).assignments.map((a) => a.shiftInstanceId)).toEqual(['x', 'w2', 'y', 'z']);
    expect(w.shifts.map((s) => s).sort(compareShiftsCanonical).map((s) => s.shiftInstanceId)).toEqual(['x', 'w2', 'y', 'z']);
  });

  it('the plan carries the resort and week, and plannedAssignmentCount matches the assignments', () => {
    const p = plan(scenario());
    expect(p.resortId).toBe('resort-1');
    expect(p.weekStart).toBe(WEEK);
    expect(p.plannedAssignmentCount).toBe(p.assignments.length);
    expect(Object.keys(p).sort()).toEqual(['assignments', 'remainingOpenSlots', 'resortId', 'skippedPastShiftCount', 'plannedAssignmentCount', 'uncoveredShiftIds', 'weekIsHistorical', 'weekStart'].sort());
    for (const a of p.assignments) expect(Object.keys(a).sort()).toEqual(['driverId', 'shiftInstanceId']);
  });
});

describe('summarizeOpenCoverage', () => {
  it('reports only today/future gaps (active assignees only) and counts the skipped past shifts', () => {
    const w = week([A, B], [
      { id: 'past', date: D.mon, required: 2 },
      { id: 'gap', date: D.fri, required: 2, assigned: [{ driver: A }] },
      { id: 'inactiveOnly', date: D.sat, required: 1, assigned: [{ driver: 'driver-x', active: false }] },
      { id: 'full', date: D.sun, required: 1, assigned: [{ driver: B }] },
    ]);
    expect(summarizeOpenCoverage(w, D.wed)).toEqual({ remainingOpenSlots: 2, uncoveredShiftIds: ['gap', 'inactiveOnly'], skippedPastShiftCount: 1 });
  });
});
