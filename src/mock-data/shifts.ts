import type { ShiftDefinition, ShiftInstance, WeekdayIndex } from '../types';
import { addDays, toISODate } from './date-utils';

const WEEKDAYS_ALL: WeekdayIndex[] = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS_MON_THU_SUN: WeekdayIndex[] = [0, 1, 2, 3, 6];
const WEEKDAYS_FRI_SAT: WeekdayIndex[] = [4, 5];
const SATURDAY: WeekdayIndex[] = [5];

/**
 * Shift templates ("configuration") per resort. Multiple templates can
 * apply to the same day (e.g. Crans-Montana + Zermatt get an extra Saturday
 * lunch shift) — the UI never assumes a fixed Lunch/Dinner row set.
 */
export const shiftDefinitions: ShiftDefinition[] = [
  // Crans-Montana
  {
    id: 'cm-dinner-standard',
    resortId: 'crans-montana',
    name: 'Dinner',
    startTime: '18:00',
    endTime: '21:30',
    requiredDrivers: 2,
    isPremium: false,
    weekdays: WEEKDAYS_MON_THU_SUN,
  },
  {
    id: 'cm-dinner-weekend',
    resortId: 'crans-montana',
    name: 'Dinner',
    startTime: '18:00',
    endTime: '21:30',
    requiredDrivers: 3,
    isPremium: true,
    weekdays: WEEKDAYS_FRI_SAT,
  },
  {
    id: 'cm-lunch-saturday',
    resortId: 'crans-montana',
    name: 'Lunch',
    startTime: '12:00',
    endTime: '14:30',
    requiredDrivers: 1,
    isPremium: false,
    weekdays: SATURDAY,
  },
  // Zermatt
  {
    id: 'ze-dinner-standard',
    resortId: 'zermatt',
    name: 'Dinner',
    startTime: '18:00',
    endTime: '21:30',
    requiredDrivers: 2,
    isPremium: false,
    weekdays: WEEKDAYS_MON_THU_SUN,
  },
  {
    id: 'ze-dinner-weekend',
    resortId: 'zermatt',
    name: 'Dinner',
    startTime: '18:00',
    endTime: '21:30',
    requiredDrivers: 2,
    isPremium: true,
    weekdays: WEEKDAYS_FRI_SAT,
  },
  {
    id: 'ze-lunch-saturday',
    resortId: 'zermatt',
    name: 'Lunch',
    startTime: '12:00',
    endTime: '14:30',
    requiredDrivers: 1,
    isPremium: false,
    weekdays: SATURDAY,
  },
  // Verbier — configured, but currently no drivers to fill it (see mock-data/drivers.ts)
  {
    id: 'vb-dinner-standard',
    resortId: 'verbier',
    name: 'Dinner',
    startTime: '18:00',
    endTime: '21:30',
    requiredDrivers: 2,
    isPremium: false,
    weekdays: WEEKDAYS_ALL,
  },
];

/**
 * Hand-authored assignment pattern for the demo week, keyed by
 * "<shiftDefinitionId>:<weekdayIndex>" -> driver ids. Deliberately mixes
 * fully-filled, partially-filled and uncovered shifts so the rota view can
 * be checked against every visual state at once.
 */
const ASSIGNMENT_PATTERN: Record<string, string[]> = {
  // Crans-Montana — Gianni is the only driver, so most shifts are short.
  'cm-dinner-standard:0': ['gianni'], // Mon 1/2
  'cm-dinner-standard:1': [], // Tue 0/2
  'cm-dinner-standard:2': ['gianni'], // Wed 1/2
  'cm-dinner-standard:3': [], // Thu 0/2
  'cm-dinner-weekend:4': ['gianni'], // Fri 1/3
  'cm-dinner-weekend:5': ['gianni'], // Sat 1/3
  'cm-lunch-saturday:5': [], // Sat lunch 0/1
  'cm-dinner-standard:6': ['gianni'], // Sun 1/2

  // Zermatt — Alex + Tomas.
  'ze-dinner-standard:0': ['alex', 'tomas'], // Mon 2/2
  'ze-dinner-standard:1': ['alex'], // Tue 1/2
  'ze-dinner-standard:2': ['alex', 'tomas'], // Wed 2/2
  'ze-dinner-standard:3': ['tomas'], // Thu 1/2
  'ze-dinner-weekend:4': ['alex', 'tomas'], // Fri 2/2
  'ze-dinner-weekend:5': ['alex', 'tomas'], // Sat 2/2
  'ze-lunch-saturday:5': ['alex'], // Sat lunch 1/1
  'ze-dinner-standard:6': [], // Sun 0/2

  // Verbier — no drivers exist yet, every shift is uncovered.
};

function assignmentsFor(shiftDefId: string, weekday: WeekdayIndex): string[] {
  return ASSIGNMENT_PATTERN[`${shiftDefId}:${weekday}`] ?? [];
}

/**
 * Builds concrete ShiftInstances for a given Monday-anchored week.
 * `publishedWeekStartISO` marks which week(s) are "published" — the same
 * flag the driver Availability page uses to lock past submissions.
 */
export function generateWeekShiftInstances(
  weekStart: Date,
  isPublished: boolean
): ShiftInstance[] {
  const instances: ShiftInstance[] = [];

  for (let weekday = 0 as WeekdayIndex; weekday <= 6; weekday++) {
    const date = addDays(weekStart, weekday);
    const isoDate = toISODate(date);

    for (const def of shiftDefinitions) {
      if (!def.weekdays.includes(weekday)) continue;

      instances.push({
        id: `${def.id}-${isoDate}`,
        shiftDefinitionId: def.id,
        resortId: def.resortId,
        date: isoDate,
        name: def.name,
        startTime: def.startTime,
        endTime: def.endTime,
        requiredDrivers: def.requiredDrivers,
        isPremium: def.isPremium,
        assignedDriverIds: assignmentsFor(def.id, weekday),
        isPublished,
      });
    }
  }

  return instances.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
}
