/**
 * One generation attempt (read the week -> plan -> apply), plus the single
 * retry the approved contract allows. Shared by both providers so the retry
 * rule exists exactly once.
 *
 * The plan is built from a READ of the week; the database re-validates every
 * proposed assignment under a lock when it applies the plan. If the world moved
 * in between, that is expected and handled, not a failure:
 *   - stale_plan       the database says the plan no longer fits current state;
 *   - historical_shift the operational day crossed midnight between read and apply.
 * Either way the old plan is discarded and the week is re-read and re-planned
 * from scratch, EXACTLY ONCE. A second stale/historical_shift surfaces as the
 * typed error. Anything else -- published_week, historical_week, permission,
 * malformed -- is never retried.
 */

import { buildAutoRotaPlan } from '../lib/autoRotaPlanner';
import { isAutoRotaError } from './errors';
import type { AutoRotaPlan, AutoRotaResult, ManagerWeekRota } from './domain';

export interface AutoRotaRunDeps {
  readWeek: () => Promise<ManagerWeekRota>;
  /** Applies the plan authoritatively and returns the authoritative result. */
  applyPlan: (plan: AutoRotaPlan) => Promise<AutoRotaResult>;
  /** Evaluated per attempt, so a midnight crossing between attempts is seen. */
  operationalToday: () => string;
}

export async function runAutoRota(deps: AutoRotaRunDeps): Promise<AutoRotaResult> {
  const attempt = async () => deps.applyPlan(buildAutoRotaPlan({ week: await deps.readWeek(), operationalToday: deps.operationalToday() }));

  try {
    return await attempt();
  } catch (error) {
    if (!(isAutoRotaError(error, 'stale_plan') || isAutoRotaError(error, 'historical_shift'))) throw error;
  }
  // The one and only retry: a fresh read and a fresh plan. Its errors propagate.
  return attempt();
}
