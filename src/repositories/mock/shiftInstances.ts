/**
 * Shared shift-instance materialisation for the mock provider, used by
 * both MockShiftConfigurationRepository (manager-side reads) and
 * MockAvailabilityRepository (driver-side reads + readiness) so the
 * "what shifts exist this week" rule lives in exactly one place.
 */

import { addDays, parseISODate, toISODate } from '../../mock-data/date-utils';
import type { ShiftInstanceRecord } from '../domain';
import { mockShiftTemplates, mockShiftTypes } from './fixtures';

export function generateMockShiftInstancesForWeek(resortId: string, weekStart: string): ShiftInstanceRecord[] {
  const templates = mockShiftTemplates.filter((t) => t.resortId === resortId && t.isActive);
  const weekStartDate = parseISODate(weekStart);
  const instances: ShiftInstanceRecord[] = [];

  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const date = toISODate(addDays(weekStartDate, weekday));
    for (const template of templates) {
      // Mirrors materialise_shift_instances' own governing-template
      // predicate: this weekday's row only, and only within its effective
      // period -- a template must never appear on a day it doesn't
      // actually run (Stage 3: driver Availability depends on this being
      // accurate, not just "some shift exists somewhere this week").
      if (template.weekday !== weekday) continue;
      if (template.effectiveFrom > date) continue;
      if (template.effectiveTo !== null && template.effectiveTo < date) continue;

      const shiftType = mockShiftTypes.find((t) => t.id === template.shiftTypeId);
      instances.push({
        id: `${template.id}-${date}`,
        resortId: template.resortId,
        date,
        weekStart,
        shiftTypeId: template.shiftTypeId,
        templateId: template.id,
        shiftKey: shiftType?.key ?? template.shiftTypeId,
        name: shiftType?.name ?? 'Shift',
        sortOrder: shiftType?.sortOrder ?? 0,
        startTime: template.startTime,
        endTime: template.endTime,
        // requiredDrivers is mandatory on every row written since the Stage
        // 2D staffing simplification -- the `?? 1` only guards legacy mock
        // fixtures predating that (never a silently-guessed value for a
        // template created through today's repository methods).
        requiredDrivers: template.requiredDrivers ?? 1,
        isPremium: template.isPremium,
        status: 'active',
        origin: 'template',
      });
    }
  }

  return instances;
}
