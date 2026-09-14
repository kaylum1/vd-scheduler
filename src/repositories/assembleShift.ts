/**
 * Collapses one shift type's raw weekday template rows into the single
 * manager-facing `ShiftRecord` shape (Stage 2D Checkpoint 4). Pure and
 * provider-agnostic -- used by both the mock and Supabase
 * ShiftConfigurationRepository implementations so the "one shift, one
 * time" assembly logic exists exactly once.
 *
 * WHICH ROWS ARE "CURRENT":
 *   - active shift type -> its active (is_active) templates.
 *   - inactive shift type -> the most recently retired batch, i.e. every
 *     template sharing the latest `updatedAt` among all of that shift
 *     type's templates. create_shift/revise_shift/deactivate_shift always
 *     retire a whole weekday selection together, in one transaction, so
 *     they share one `updated_at` (this is the specific reason
 *     `ShiftTemplateRecord` carries it) -- reliably reconstructing "the
 *     schedule as it was right before deactivation" for Reactivate's
 *     pre-filled defaults in `ShiftSetupPanel`, and never a mix of
 *     different historical periods.
 *
 *     `effective_to` alone cannot be used for this grouping: two distinct
 *     retirement events (e.g. a weekday removed by revise_shift, then the
 *     whole shift deactivated later the same day) can share the same
 *     effective_to *calendar date* while being genuinely different
 *     batches -- exactly the bug a real manual test surfaced during Stage
 *     2D Checkpoint 4 (see ShiftSetupPanel.test.tsx's regression test for
 *     it). `updated_at` (a timestamptz) disambiguates them.
 *
 * CONSISTENCY: those "current" rows must all share the same start/end
 * time AND the same effective period for `schedule` to be populated.
 * Under the simplified UI's own atomic RPCs this always holds (every
 * weekday in a create/revise/reactivate call is written with the same
 * time and effective_from in one transaction) -- inconsistency can only
 * happen from data that predates Checkpoint 4 (the old per-weekday manual
 * UI never enforced it). Rather than guess which row is authoritative,
 * `schedule` is left null and `inconsistentWeekdays` is populated instead
 * -- see docs/business-rules.md and ShiftSetupPanel's review-required
 * notice.
 */

import type { ShiftRecord, ShiftScheduleRecord, ShiftTemplateRecord, ShiftTypeRecord } from './domain';

function currentTemplates(templates: ShiftTemplateRecord[]): ShiftTemplateRecord[] {
  const active = templates.filter((t) => t.isActive);
  if (active.length > 0) return active;
  if (templates.length === 0) return [];

  const latestUpdatedAt = templates.reduce((latest, t) => (t.updatedAt > latest ? t.updatedAt : latest), templates[0].updatedAt);
  return templates.filter((t) => t.updatedAt === latestUpdatedAt);
}

export function assembleShift(shiftType: ShiftTypeRecord, templates: ShiftTemplateRecord[]): ShiftRecord {
  const base = {
    shiftTypeId: shiftType.id,
    resortId: shiftType.resortId,
    name: shiftType.name,
    sortOrder: shiftType.sortOrder,
    isActive: shiftType.isActive,
  };

  const relevant = currentTemplates(templates);
  if (relevant.length === 0) {
    // No schedule rows at all yet (e.g. a shift type created outside this
    // checkpoint's atomic RPCs with no templates) -- nothing to show as a
    // schedule, but not the "inconsistent" review-required state either.
    return { ...base, schedule: null };
  }

  const distinctShapes = new Set(relevant.map((t) => `${t.startTime}|${t.endTime}|${t.effectiveFrom}|${t.effectiveTo ?? ''}`));
  if (distinctShapes.size > 1) {
    return {
      ...base,
      schedule: null,
      inconsistentWeekdays: [...new Set(relevant.map((t) => t.weekday))].sort((a, b) => a - b),
    };
  }

  const schedule: ShiftScheduleRecord = {
    startTime: relevant[0].startTime,
    endTime: relevant[0].endTime,
    weekdays: [...new Set(relevant.map((t) => t.weekday))].sort((a, b) => a - b),
    effectiveFrom: relevant[0].effectiveFrom,
    effectiveTo: relevant[0].effectiveTo,
  };
  return { ...base, schedule };
}

export function assembleShifts(shiftTypes: ShiftTypeRecord[], templatesByShiftType: Map<string, ShiftTemplateRecord[]>): ShiftRecord[] {
  return shiftTypes
    .map((t) => assembleShift(t, templatesByShiftType.get(t.id) ?? []))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
