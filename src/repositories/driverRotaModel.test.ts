import { describe, expect, it } from 'vitest';
import { buildDriverWeekRota } from './driverRotaModel';
import type { DriverVisibleAssignment } from './domain';

const WEEK = '2030-01-07';

const row = (id: string, over: Partial<DriverVisibleAssignment> = {}): DriverVisibleAssignment => ({
  assignmentId: `assignment-${id}`,
  shiftInstanceId: `shift-${id}`,
  resortId: 'resort-1',
  date: '2030-01-07',
  weekStart: WEEK,
  shiftKey: 'dinner',
  name: 'Dinner',
  startTime: '18:00:00',
  endTime: '21:30:00',
  ...over,
});

describe('buildDriverWeekRota', () => {
  it('1. trims database times (HH:MM:SS) to HH:MM, and leaves HH:MM alone', () => {
    const rota = buildDriverWeekRota({
      weekStart: WEEK,
      isPublished: true,
      assignments: [row('a'), row('b', { date: '2030-01-08', startTime: '07:05', endTime: '09:00' })],
    });
    expect(rota.shifts.map((s) => [s.startTime, s.endTime])).toEqual([
      ['18:00', '21:30'],
      ['07:05', '09:00'],
    ]);
  });

  it('2. sorts deterministically: date, then start time, then name, then id -- whatever order the rows arrive in', () => {
    const rows = [
      row('z-late', { date: '2030-01-11', startTime: '18:00:00', name: 'Dinner' }),
      row('b', { date: '2030-01-07', startTime: '18:00:00', name: 'Dinner (2P)' }),
      row('a', { date: '2030-01-07', startTime: '18:00:00', name: 'Dinner (1P)' }),
      row('lunch', { date: '2030-01-07', startTime: '12:00:00', endTime: '14:00:00', name: 'Lunch' }),
      row('tie-2', { date: '2030-01-09', name: 'Same' }),
      row('tie-1', { date: '2030-01-09', name: 'Same' }),
    ];
    const expected = ['shift-lunch', 'shift-a', 'shift-b', 'shift-tie-1', 'shift-tie-2', 'shift-z-late'];
    expect(buildDriverWeekRota({ weekStart: WEEK, isPublished: true, assignments: rows }).shifts.map((s) => s.shiftInstanceId)).toEqual(expected);
    expect(buildDriverWeekRota({ weekStart: WEEK, isPublished: true, assignments: [...rows].reverse() }).shifts.map((s) => s.shiftInstanceId)).toEqual(expected);
  });

  it('3. an unpublished week is ALWAYS empty -- even if assignment rows were somehow supplied', () => {
    const rota = buildDriverWeekRota({ weekStart: WEEK, isPublished: false, assignments: [row('a')] });
    expect(rota).toEqual({ weekStart: WEEK, isPublished: false, shifts: [] });
  });

  it('4. supports several shifts on the same day as separate entries', () => {
    const rota = buildDriverWeekRota({
      weekStart: WEEK,
      isPublished: true,
      assignments: [
        row('dinner', { date: '2030-01-11', name: 'Dinner', startTime: '18:00:00', endTime: '21:30:00' }),
        row('lunch', { date: '2030-01-11', name: 'Lunch', startTime: '12:00:00', endTime: '14:00:00' }),
      ],
    });
    expect(rota.shifts.map((s) => [s.date, s.shiftName])).toEqual([
      ['2030-01-11', 'Lunch'],
      ['2030-01-11', 'Dinner'],
    ]);
  });

  it('a published week with no assignments is published with no shifts', () => {
    expect(buildDriverWeekRota({ weekStart: WEEK, isPublished: true, assignments: [] })).toEqual({ weekStart: WEEK, isPublished: true, shifts: [] });
  });

  it('never lets a row from another week leak into this one', () => {
    const rota = buildDriverWeekRota({ weekStart: WEEK, isPublished: true, assignments: [row('a'), row('other', { weekStart: '2030-01-14', date: '2030-01-14' })] });
    expect(rota.shifts.map((s) => s.shiftInstanceId)).toEqual(['shift-a']);
  });

  it('5. the result carries exactly the driver-safe fields -- no manager, colleague, headcount, source, pay or audit data can exist on it', () => {
    const rota = buildDriverWeekRota({ weekStart: WEEK, isPublished: true, assignments: [row('a')] });
    expect(Object.keys(rota).sort()).toEqual(['isPublished', 'shifts', 'weekStart']);
    expect(Object.keys(rota.shifts[0]).sort()).toEqual(['date', 'endTime', 'shiftInstanceId', 'shiftName', 'startTime']);
    // Internal identifiers of the underlying assignment/resort are not forwarded either.
    expect(JSON.stringify(rota)).not.toMatch(/assignment-a|resort-1|dinner"/);
  });
});
