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
        requiredDrivers: template.requiredDrivers,
        basePayChf: template.basePayChf,
        deliveryRateChf: template.deliveryRateChf,
        isPremium: template.isPremium,
        status: 'active',
        origin: 'template',
      });
    }
  }

  return instances;
}
