/**
 * The Auto-Rota PLANNER: a pure, deterministic function that proposes who fills
 * each open position of one resort + one Monday-Sunday week. It decides what is
 * FAIR; the database (apply_auto_rota, AR-A) independently decides whether each
 * proposal is still SAFE. The fairness algorithm exists only here -- SQL does
 * not reproduce it, so the two can never silently disagree about fairness.
 *
 * No I/O, no clock, no randomness: the operational "today" is an input, and
 * every comparison is a total order, so identical input -- including the same
 * data in a different array order -- always yields the identical plan.
 *
 * RULES (docs/business-rules.md section P)
 *  - Eligible for a NEW proposal: an active candidate driver whose availability
 *    for that exact shift is 'available' (Unavailable and Not Submitted never
 *    qualify; there is no override), who is not already assigned to that shift.
 *  - Existing assignments are preserved, never removed. ACTIVE ones (manual or
 *    auto, even a manual override of an Unavailable answer) count toward
 *    coverage and the driver's fairness counters; INACTIVE ones count toward
 *    neither and never make anyone eligible. Past shifts still seed the counters.
 *  - openSlots = max(required - active assignments, 0); never over-assign; one
 *    driver at most once per shift.
 *  - Two independent buckets, weekend (Fri Sat Sun) first, then weekday
 *    (Mon-Thu). Per slot the winner is the eligible driver with the fewest
 *    assignments IN THAT BUCKET, then the fewest in total, then the weekly
 *    tie-break (FNV-1a of `${weekStart}:${driverId}`, ascending), then driverId.
 *    Counters are updated after every pick. Fairness only chooses among the
 *    eligible: if only one driver can cover a slot, that driver gets it.
 *  - Within a bucket the most constrained shift goes first (fewest eligible
 *    drivers), then the canonical order: date, sortOrder, startTime, name, id.
 *    (Chronological order can strand a scarce driver's only shift behind an
 *    earlier one and give a lopsided result; scarcity-first avoids that.)
 *  - Shifts before the operational today are skipped (today and later are
 *    planned); their assignments still seed the counters.
 *  - No overlap, daily-maximum, rest-period or weekly-maximum rule: a driver may
 *    take several shifts a day if explicitly Available for each.
 */

import type { AutoRotaPlan, AutoRotaPlannedAssignment, ManagerRotaShift, ManagerWeekRota } from '../repositories/domain';
import { weeklyTieBreakKey } from './autoRotaHash';

export interface AutoRotaPlannerInput {
  week: ManagerWeekRota;
  /** The resort's operational date, ISO YYYY-MM-DD (see lib/operationalTime.ts). */
  operationalToday: string;
}

type Bucket = 'weekend' | 'weekday';

interface Counters {
  weekend: number;
  weekday: number;
  total: number;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Monday = 0 ... Sunday = 6, from an ISO date, with no timezone involved. */
function weekdayIndex(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function bucketOf(iso: string): Bucket {
  return weekdayIndex(iso) >= 4 ? 'weekend' : 'weekday';
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** The canonical shift order: date, sortOrder, startTime, name, id. */
export function compareShiftsCanonical(a: ManagerRotaShift, b: ManagerRotaShift): number {
  return (
    byString(a.date, b.date) ||
    a.sortOrder - b.sortOrder ||
    byString(a.startTime, b.startTime) ||
    byString(a.name, b.name) ||
    byString(a.shiftInstanceId, b.shiftInstanceId)
  );
}

function activeAssignmentCount(shift: ManagerRotaShift): number {
  return shift.assignments.filter((a) => a.isDriverActive).length;
}

/** The positions still open on a shift, counting only ACTIVE assignees. */
export function openSlotsOf(shift: ManagerRotaShift): number {
  return Math.max(shift.requiredDrivers - activeAssignmentCount(shift), 0);
}

export interface CoverageSummary {
  remainingOpenSlots: number;
  uncoveredShiftIds: string[];
  skippedPastShiftCount: number;
}

/** What a week still needs, from its CURRENT assignments: today/future shifts only (past gaps are not reported). */
export function summarizeOpenCoverage(week: ManagerWeekRota, operationalToday: string): CoverageSummary {
  let remainingOpenSlots = 0;
  let skippedPastShiftCount = 0;
  const uncovered: ManagerRotaShift[] = [];
  for (const shift of week.shifts) {
    if (shift.date < operationalToday) {
      skippedPastShiftCount += 1;
      continue;
    }
    const open = openSlotsOf(shift);
    if (open > 0) {
      remainingOpenSlots += open;
      uncovered.push(shift);
    }
  }
  return {
    remainingOpenSlots,
    uncoveredShiftIds: uncovered.sort(compareShiftsCanonical).map((s) => s.shiftInstanceId),
    skippedPastShiftCount,
  };
}

interface OpenShift {
  shift: ManagerRotaShift;
  bucket: Bucket;
  open: number;
  /** Candidate driver ids eligible for a NEW assignment on this exact shift. */
  eligible: string[];
}

export function buildAutoRotaPlan({ week, operationalToday }: AutoRotaPlannerInput): AutoRotaPlan {
  const { resortId, weekStart } = week;

  // Fairness counters for every ACTIVE candidate, seeded from ACTIVE existing assignments (any source, any day of the week).
  const counters = new Map<string, Counters>(week.candidateDrivers.map((d) => [d.driverId, { weekend: 0, weekday: 0, total: 0 }]));
  for (const shift of week.shifts) {
    const bucket = bucketOf(shift.date);
    for (const assignment of shift.assignments) {
      if (!assignment.isDriverActive) continue;
      const counter = counters.get(assignment.driverId);
      if (!counter) continue;
      counter[bucket] += 1;
      counter.total += 1;
    }
  }

  const tieKeys = new Map(week.candidateDrivers.map((d) => [d.driverId, weeklyTieBreakKey(weekStart, d.driverId)]));

  // The positions that need filling: today/future shifts with an open slot.
  const openShifts: OpenShift[] = [];
  for (const shift of week.shifts) {
    if (shift.date < operationalToday) continue;
    const open = openSlotsOf(shift);
    if (open === 0) continue;
    const alreadyAssigned = new Set(shift.assignments.map((a) => a.driverId)); // active AND inactive: never assign the same driver twice
    const eligible = week.candidateDrivers
      .filter((d) => shift.availabilityByDriver[d.driverId] === 'available' && !alreadyAssigned.has(d.driverId))
      .map((d) => d.driverId);
    openShifts.push({ shift, bucket: bucketOf(shift.date), open, eligible });
  }

  const assignments: AutoRotaPlannedAssignment[] = [];
  const underCovered: ManagerRotaShift[] = [];
  let remainingOpenSlots = 0;

  for (const bucket of ['weekend', 'weekday'] as const) {
    const ordered = openShifts
      .filter((s) => s.bucket === bucket)
      .sort((a, b) => a.eligible.length - b.eligible.length || compareShiftsCanonical(a.shift, b.shift));

    for (const work of ordered) {
      const chosen = new Set<string>();
      for (let slot = 0; slot < work.open; slot += 1) {
        let best: string | null = null;
        for (const driverId of work.eligible) {
          if (chosen.has(driverId)) continue;
          if (best === null || compareDrivers(driverId, best, bucket, counters, tieKeys) < 0) best = driverId;
        }
        if (best === null) break; // nobody left who is eligible: the slot stays open, which is a normal outcome
        chosen.add(best);
        const counter = counters.get(best) as Counters;
        counter[bucket] += 1;
        counter.total += 1;
        assignments.push({ shiftInstanceId: work.shift.shiftInstanceId, driverId: best });
      }
      const unfilled = work.open - chosen.size;
      if (unfilled > 0) {
        remainingOpenSlots += unfilled;
        underCovered.push(work.shift);
      }
    }
  }

  return {
    resortId,
    weekStart,
    assignments,
    plannedAssignmentCount: assignments.length,
    remainingOpenSlots,
    uncoveredShiftIds: underCovered.sort(compareShiftsCanonical).map((s) => s.shiftInstanceId),
    skippedPastShiftCount: week.shifts.filter((s) => s.date < operationalToday).length,
    weekIsHistorical: addDaysIso(weekStart, 6) < operationalToday,
  };
}

/** Negative when `a` should be chosen before `b`: bucket count, then total, then the weekly tie-break, then driverId. */
function compareDrivers(a: string, b: string, bucket: Bucket, counters: Map<string, Counters>, tieKeys: Map<string, number>): number {
  const ca = counters.get(a) as Counters;
  const cb = counters.get(b) as Counters;
  return (
    ca[bucket] - cb[bucket] ||
    ca.total - cb.total ||
    (tieKeys.get(a) as number) - (tieKeys.get(b) as number) ||
    byString(a, b)
  );
}
