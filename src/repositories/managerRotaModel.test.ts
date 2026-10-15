import { describe, expect, it } from 'vitest';
import { buildManagerWeekRota, type ManagerRotaBuildInput } from './managerRotaModel';
import type { ShiftInstanceRecord } from './domain';

function shift(overrides: Partial<ShiftInstanceRecord> & { id: string }): ShiftInstanceRecord {
  return {
    resortId: 'r1',
    date: '2030-01-07',
    weekStart: '2030-01-07',
    shiftTypeId: 'type-dinner',
    templateId: 'tpl',
    shiftKey: 'dinner',
    name: 'Dinner',
    sortOrder: 1,
    startTime: '18:00:00',
    endTime: '21:30:00',
    requiredDrivers: 2,
    isPremium: null,
    status: 'active',
    origin: 'template',
    ...overrides,
  };
}

function input(overrides: Partial<ManagerRotaBuildInput> = {}): ManagerRotaBuildInput {
  return {
    resortId: 'r1',
    weekStart: '2030-01-07',
    isPublished: false,
    shifts: [],
    drivers: [],
    assignments: [],
    availability: [],
    ...overrides,
  };
}

describe('buildManagerWeekRota', () => {
  it('a week with no shifts is a valid, empty model -- still listing the candidate drivers', () => {
    const rota = buildManagerWeekRota(input({ drivers: [{ id: 'd1', fullName: 'Gianni', isActive: true }] }));
    expect(rota).toEqual({
      resortId: 'r1',
      weekStart: '2030-01-07',
      isPublished: false,
      candidateDrivers: [{ driverId: 'd1', fullName: 'Gianni' }],
      shifts: [],
    });
  });

  it('carries publication state through unchanged', () => {
    expect(buildManagerWeekRota(input({ isPublished: true })).isPublished).toBe(true);
  });

  it('preserves required_drivers, identity (shift_instance_id), and strips seconds from clock times', () => {
    const rota = buildManagerWeekRota(input({ shifts: [shift({ id: 'si-1', requiredDrivers: 3, name: 'Dinner (2P)' })] }));
    expect(rota.shifts[0]).toMatchObject({
      shiftInstanceId: 'si-1',
      shiftTypeId: 'type-dinner',
      requiredDrivers: 3,
      name: 'Dinner (2P)',
      startTime: '18:00',
      endTime: '21:30',
    });
  });

  it('never parses (1P)/(2P) out of a name to decide staffing -- requiredDrivers is the only source', () => {
    const rota = buildManagerWeekRota(input({ shifts: [shift({ id: 'si-1', name: 'Dinner (2P)', requiredDrivers: 1 })] }));
    expect(rota.shifts[0].requiredDrivers).toBe(1);
  });

  it('orders shifts deterministically: date, then sort order, then start time, then name, then id -- regardless of input order', () => {
    const shifts = [
      shift({ id: 'e', date: '2030-01-09', sortOrder: 1 }),
      shift({ id: 'c', date: '2030-01-07', sortOrder: 2, startTime: '12:00:00' }),
      shift({ id: 'b', date: '2030-01-07', sortOrder: 1, startTime: '19:00:00' }),
      shift({ id: 'a', date: '2030-01-07', sortOrder: 1, startTime: '18:00:00', name: 'B' }),
      shift({ id: 'a2', date: '2030-01-07', sortOrder: 1, startTime: '18:00:00', name: 'A' }),
      shift({ id: 'd', date: '2030-01-08', sortOrder: 1 }),
    ];
    const expected = ['a2', 'a', 'b', 'c', 'd', 'e'];
    expect(buildManagerWeekRota(input({ shifts })).shifts.map((s) => s.shiftInstanceId)).toEqual(expected);
    expect(buildManagerWeekRota(input({ shifts: [...shifts].reverse() })).shifts.map((s) => s.shiftInstanceId)).toEqual(expected);
  });

  it('groups assignments under the correct shift and never leaks one shift\'s assignment onto another', () => {
    const rota = buildManagerWeekRota(
      input({
        shifts: [shift({ id: 'si-1' }), shift({ id: 'si-2', date: '2030-01-08' })],
        drivers: [
          { id: 'd1', fullName: 'Alex', isActive: true },
          { id: 'd2', fullName: 'Tomas', isActive: true },
        ],
        assignments: [
          { id: 'a1', shiftInstanceId: 'si-1', driverId: 'd1', source: 'manual', assignedAt: '2030-01-01T10:00:00Z' },
          { id: 'a2', shiftInstanceId: 'si-2', driverId: 'd2', source: 'manual', assignedAt: '2030-01-01T10:00:00Z' },
          { id: 'a3', shiftInstanceId: 'si-2', driverId: 'd1', source: 'manual', assignedAt: '2030-01-01T11:00:00Z' },
        ],
      })
    );
    expect(rota.shifts[0].assignments.map((a) => a.driverId)).toEqual(['d1']);
    expect(rota.shifts[1].assignments.map((a) => a.driverId)).toEqual(['d2', 'd1']);
  });

  it('orders a shift\'s assignments by assignedAt, ties broken by driver name', () => {
    const rota = buildManagerWeekRota(
      input({
        shifts: [shift({ id: 'si-1' })],
        drivers: [
          { id: 'd1', fullName: 'Zed', isActive: true },
          { id: 'd2', fullName: 'Amy', isActive: true },
          { id: 'd3', fullName: 'Bob', isActive: true },
        ],
        assignments: [
          { id: 'a1', shiftInstanceId: 'si-1', driverId: 'd1', source: 'manual', assignedAt: '2030-01-01T10:00:00Z' },
          { id: 'a2', shiftInstanceId: 'si-1', driverId: 'd2', source: 'manual', assignedAt: '2030-01-01T10:00:00Z' },
          { id: 'a3', shiftInstanceId: 'si-1', driverId: 'd3', source: 'manual', assignedAt: '2030-01-01T09:00:00Z' },
        ],
      })
    );
    expect(rota.shifts[0].assignments.map((a) => a.driverName)).toEqual(['Bob', 'Amy', 'Zed']);
  });

  it('candidate drivers are ACTIVE only, sorted by name', () => {
    const rota = buildManagerWeekRota(
      input({
        drivers: [
          { id: 'd3', fullName: 'Tomas', isActive: true },
          { id: 'd1', fullName: 'Alex', isActive: true },
          { id: 'd2', fullName: 'Gone', isActive: false },
        ],
      })
    );
    expect(rota.candidateDrivers.map((d) => d.fullName)).toEqual(['Alex', 'Tomas']);
  });

  it('an existing assignment to a now-INACTIVE driver is kept, with that driver\'s name and isDriverActive=false -- but they are not a candidate', () => {
    const rota = buildManagerWeekRota(
      input({
        shifts: [shift({ id: 'si-1' })],
        drivers: [
          { id: 'd1', fullName: 'Alex', isActive: true },
          { id: 'd2', fullName: 'Gone', isActive: false },
        ],
        assignments: [
          { id: 'a1', shiftInstanceId: 'si-1', driverId: 'd1', source: 'manual', assignedAt: '2030-01-01T10:00:00Z' },
          { id: 'a2', shiftInstanceId: 'si-1', driverId: 'd2', source: 'manual', assignedAt: '2030-01-01T11:00:00Z' },
        ],
      })
    );
    expect(rota.shifts[0].assignments).toEqual([
      { assignmentId: 'a1', driverId: 'd1', driverName: 'Alex', isDriverActive: true, source: 'manual', assignedAt: '2030-01-01T10:00:00Z' },
      { assignmentId: 'a2', driverId: 'd2', driverName: 'Gone', isDriverActive: false, source: 'manual', assignedAt: '2030-01-01T11:00:00Z' },
    ]);
    expect(rota.candidateDrivers.map((d) => d.driverId)).toEqual(['d1']);
    // The inactive assignee has no availability entry -- their state lives on the assignment.
    expect(Object.keys(rota.shifts[0].availabilityByDriver)).toEqual(['d1']);
  });

  it('an assignment whose driver row is missing is treated as inactive and unnamed, never as an active driver', () => {
    const rota = buildManagerWeekRota(
      input({
        shifts: [shift({ id: 'si-1' })],
        assignments: [{ id: 'a1', shiftInstanceId: 'si-1', driverId: 'ghost', source: 'manual', assignedAt: '2030-01-01T10:00:00Z' }],
      })
    );
    expect(rota.shifts[0].assignments[0]).toMatchObject({ driverName: 'Unknown driver', isDriverActive: false });
  });

  it('derives availability: row available -> available, row unavailable -> unavailable, NO row -> not_submitted', () => {
    const rota = buildManagerWeekRota(
      input({
        shifts: [shift({ id: 'si-1' })],
        drivers: [
          { id: 'd1', fullName: 'A', isActive: true },
          { id: 'd2', fullName: 'B', isActive: true },
          { id: 'd3', fullName: 'C', isActive: true },
        ],
        availability: [
          { shiftInstanceId: 'si-1', driverId: 'd1', status: 'available' },
          { shiftInstanceId: 'si-1', driverId: 'd2', status: 'unavailable' },
        ],
      })
    );
    expect(rota.shifts[0].availabilityByDriver).toEqual({ d1: 'available', d2: 'unavailable', d3: 'not_submitted' });
  });

  it('availability is per exact shift_instance -- an answer for one shift never answers another', () => {
    const rota = buildManagerWeekRota(
      input({
        shifts: [shift({ id: 'si-1' }), shift({ id: 'si-2', date: '2030-01-08' })],
        drivers: [{ id: 'd1', fullName: 'A', isActive: true }],
        availability: [{ shiftInstanceId: 'si-1', driverId: 'd1', status: 'available' }],
      })
    );
    expect(rota.shifts[0].availabilityByDriver.d1).toBe('available');
    expect(rota.shifts[1].availabilityByDriver.d1).toBe('not_submitted');
  });

  it('ignores assignment and availability rows that belong to no listed shift', () => {
    const rota = buildManagerWeekRota(
      input({
        shifts: [shift({ id: 'si-1' })],
        drivers: [{ id: 'd1', fullName: 'A', isActive: true }],
        assignments: [{ id: 'a9', shiftInstanceId: 'other-week-shift', driverId: 'd1', source: 'manual', assignedAt: '2030-01-01T10:00:00Z' }],
        availability: [{ shiftInstanceId: 'other-week-shift', driverId: 'd1', status: 'available' }],
      })
    );
    expect(rota.shifts[0].assignments).toEqual([]);
    expect(rota.shifts[0].availabilityByDriver.d1).toBe('not_submitted');
  });

  it('exposes no audit context or override reason anywhere on the model', () => {
    const rota = buildManagerWeekRota(
      input({
        shifts: [shift({ id: 'si-1' })],
        drivers: [{ id: 'd1', fullName: 'A', isActive: true }],
        assignments: [{ id: 'a1', shiftInstanceId: 'si-1', driverId: 'd1', source: 'manual', assignedAt: '2030-01-01T10:00:00Z' }],
      })
    );
    expect(JSON.stringify(rota)).not.toMatch(/reason|context|override/i);
  });

  it('does not mutate its input', () => {
    const i = input({ shifts: [shift({ id: 'b', date: '2030-01-08' }), shift({ id: 'a' })], drivers: [{ id: 'd1', fullName: 'A', isActive: true }] });
    const snapshot = JSON.stringify(i);
    buildManagerWeekRota(i);
    expect(JSON.stringify(i)).toBe(snapshot);
  });
});
