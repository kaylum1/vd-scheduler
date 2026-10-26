import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import { SupabaseRotaRepository } from './rota';
import {
  AttendanceError,
  DriverCheckInError,
  RepositoryError,
  isAttendanceError,
  isDriverCheckInError,
  type AttendanceErrorKind,
  type DriverCheckInErrorKind,
} from '../errors';
// Raw source -- used only by the architecture checks proving the adapter never writes these tables directly.
import rotaAdapterSource from './rota.ts?raw';

type RpcResult = { data: unknown; error: unknown };

/** A minimal fake of the bit of supabase-js these three methods use: rpc(), plus a from() that records any use and throws on writes. */
function createFakeClient(rpcResults: Record<string, RpcResult | ((n: number) => RpcResult)>) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const tablesTouched: string[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      const responder = rpcResults[fn];
      return Promise.resolve(typeof responder === 'function' ? responder(rpcCalls.filter((c) => c.fn === fn).length) : (responder ?? { data: [], error: null }));
    },
    from(table: string) {
      tablesTouched.push(table);
      throw new Error(`unexpected table access: ${table}`);
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, rpcCalls, tablesTouched };
}

const ok = (row: Record<string, unknown>): RpcResult => ({ data: [row], error: null });
const fail = (code: string, details: string | null, message = 'raw database text'): RpcResult => ({ data: null, error: { code, details, hint: null, message } });

const attRow = (over: Record<string, unknown> = {}) => ({
  attendance_id: 'att-1',
  assignment_id: 'asg-1',
  shift_instance_id: 'si-1',
  driver_id: 'd-1',
  status: 'worked',
  recorded_at: '2030-01-07T17:00:00+00:00',
  updated_at: '2030-01-07T17:00:00+00:00',
  created: true,
  changed: true,
  ...over,
});
const clearRow = (over: Record<string, unknown> = {}) => ({ assignment_id: 'asg-1', previous_status: 'worked', changed: true, ...over });
const checkInRow = (over: Record<string, unknown> = {}) => ({
  check_in_id: 'ci-1',
  assignment_id: 'asg-1',
  shift_instance_id: 'si-1',
  checked_in_at: '2030-01-07T17:42:10+00:00',
  created: true,
  ...over,
});

describe('SupabaseRotaRepository.recordAttendance', () => {
  const record = (fake: ReturnType<typeof createFakeClient>, params: { status?: 'worked' | 'no_show' | 'excused' | 'cancelled'; reason?: string | null } = {}) =>
    new SupabaseRotaRepository(fake.client).recordAttendance({ assignmentId: 'asg-1', status: params.status ?? 'worked', reason: params.reason });

  it('1-3. calls record_attendance with the assignment id and the status', async () => {
    const fake = createFakeClient({ record_attendance: ok(attRow()) });
    await record(fake, { status: 'no_show' });
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0].fn).toBe('record_attendance');
    expect(fake.rpcCalls[0].args).toMatchObject({ p_assignment_id: 'asg-1', p_status: 'no_show' });
  });

  it('4-5. an optional reason is passed through; omitted and null both send no reason', async () => {
    const withReason = createFakeClient({ record_attendance: ok(attRow()) });
    await record(withReason, { reason: 'Covered, rota never published' });
    expect(withReason.rpcCalls[0].args.p_reason).toBe('Covered, rota never published');

    for (const reason of [undefined, null]) {
      const fake = createFakeClient({ record_attendance: ok(attRow()) });
      await record(fake, { reason });
      expect(fake.rpcCalls[0].args.p_reason).toBeUndefined();
    }
  });

  it('sends only the three documented arguments -- no driver, shift, resort, week, date or time', async () => {
    const fake = createFakeClient({ record_attendance: ok(attRow()) });
    await record(fake, { reason: 'x' });
    expect(Object.keys(fake.rpcCalls[0].args).sort()).toEqual(['p_assignment_id', 'p_reason', 'p_status']);
  });

  it('6-9. maps the first record, a correction and a same-state resubmit, and the record carries only domain fields', async () => {
    const created = await record(createFakeClient({ record_attendance: ok(attRow()) }));
    expect(created).toEqual({
      record: {
        attendanceId: 'att-1',
        assignmentId: 'asg-1',
        shiftInstanceId: 'si-1',
        driverId: 'd-1',
        status: 'worked',
        recordedAt: '2030-01-07T17:00:00+00:00',
        updatedAt: '2030-01-07T17:00:00+00:00',
      },
      created: true,
      changed: true,
    });
    expect(Object.keys(created.record).sort()).toEqual(['assignmentId', 'attendanceId', 'driverId', 'recordedAt', 'shiftInstanceId', 'status', 'updatedAt']);

    const corrected = await record(createFakeClient({ record_attendance: ok(attRow({ status: 'excused', created: false, changed: true })) }), { status: 'excused' });
    expect(corrected).toMatchObject({ created: false, changed: true, record: { status: 'excused' } });

    const same = await record(createFakeClient({ record_attendance: ok(attRow({ created: false, changed: false })) }));
    expect(same).toMatchObject({ created: false, changed: false });
  });

  it.each(['worked', 'no_show', 'excused', 'cancelled'] as const)('maps status %s', async (status) => {
    expect((await record(createFakeClient({ record_attendance: ok(attRow({ status })) }), { status })).record.status).toBe(status);
  });

  it.each([
    ['no rows', { data: [], error: null }],
    ['null data', { data: null, error: null }],
    ['a missing field', ok(attRow({ recorded_at: undefined }))],
    ['an unknown status', ok(attRow({ status: 'late' }))],
    ['a non-boolean created', ok(attRow({ created: 'yes' }))],
    ['a missing changed', ok(attRow({ changed: undefined }))],
  ])('10. a malformed result (%s) is a contract break, not a half-valid result', async (_name, response) => {
    const error = await record(createFakeClient({ record_attendance: response })).catch((e) => e);
    expect(error).toBeInstanceOf(RepositoryError);
    expect(isAttendanceError(error)).toBe(false);
  });

  it.each([
    ['11', '42501', null, 'permission_denied'],
    ['12', 'P0002', null, 'assignment_not_found'],
    ['13', '55006', 'week_not_published', 'week_not_published'],
    ['14', '55006', 'future_shift', 'future_shift'],
    ['15', '55006', 'shift_cancelled', 'shift_cancelled'],
    ['16', '22023', 'invalid_status', 'invalid_status'],
    ['17', '22023', null, 'invalid_request'],
    ['18', '23514', 'historical_backfill_reason_required', 'historical_backfill_reason_required'],
    ['19', '23514', 'reason_required', 'reason_required'],
    ['20', '23514', 'reason_too_long', 'reason_too_long'],
  ])('%s. %s / %j -> AttendanceError(%s) through the real wrapper', async (_n, code, details, kind) => {
    const fake = createFakeClient({ record_attendance: fail(code, details) });
    const error = await record(fake).catch((e) => e);
    expect(isAttendanceError(error, kind as AttendanceErrorKind)).toBe(true);
    expect(fake.rpcCalls).toHaveLength(1);
  });

  it('21. an unknown SQLSTATE or an unexpected DETAIL falls back to unknown', async () => {
    for (const [code, details] of [['XX000', null], ['55006', 'check_in_closed'], ['23514', 'surprise'], ['22023', 'surprise']] as const) {
      expect(isAttendanceError(await record(createFakeClient({ record_attendance: fail(code, details) })).catch((e) => e), 'unknown')).toBe(true);
    }
  });

  it('22-23. exactly ONE record_attendance call, no table read, and the adapter never writes attendance directly', async () => {
    const fake = createFakeClient({ record_attendance: ok(attRow()) });
    await record(fake);
    await record(fake, { status: 'no_show' });
    expect(fake.rpcCalls.map((c) => c.fn)).toEqual(['record_attendance', 'record_attendance']);
    expect(fake.tablesTouched).toEqual([]);
    expect(rotaAdapterSource.match(/rpc\(\s*'record_attendance'/g)).toHaveLength(1);
    expect(rotaAdapterSource).not.toMatch(/from\(\s*'attendance'\s*\)\s*\.(insert|update|upsert|delete)/);
  });

  it('does not retry on an error and never leaks database text through userMessage', async () => {
    const fake = createFakeClient({ record_attendance: fail('55006', 'future_shift', 'violates constraint attendance_assignment_fk 55006') });
    const error = (await record(fake).catch((e) => e)) as AttendanceError;
    expect(fake.rpcCalls).toHaveLength(1);
    expect(error.userMessage).toBe('Attendance can’t be recorded before the shift date.');
    expect(error.userMessage).not.toMatch(/55006|constraint|attendance_assignment_fk|future_shift/);
  });
});

describe('SupabaseRotaRepository.clearAttendance', () => {
  const clear = (fake: ReturnType<typeof createFakeClient>, reason = 'Marked the wrong driver') =>
    new SupabaseRotaRepository(fake.client).clearAttendance({ assignmentId: 'asg-1', reason });

  it('1-3. calls clear_attendance with the assignment id and the reason, and nothing else', async () => {
    const fake = createFakeClient({ clear_attendance: ok(clearRow()) });
    await clear(fake, 'recorded in error');
    expect(fake.rpcCalls).toEqual([{ fn: 'clear_attendance', args: { p_assignment_id: 'asg-1', p_reason: 'recorded in error' } }]);
  });

  it('4-6. maps changed = true with the previous status, and changed = false with no previous status', async () => {
    expect(await clear(createFakeClient({ clear_attendance: ok(clearRow({ previous_status: 'no_show' })) }))).toEqual({ assignmentId: 'asg-1', previousStatus: 'no_show', changed: true });
    expect(await clear(createFakeClient({ clear_attendance: ok(clearRow({ previous_status: null, changed: false })) }))).toEqual({ assignmentId: 'asg-1', previousStatus: null, changed: false });
  });

  it('never invents an attendance row for the cleared assignment', async () => {
    const result = await clear(createFakeClient({ clear_attendance: ok(clearRow()) }));
    expect(Object.keys(result).sort()).toEqual(['assignmentId', 'changed', 'previousStatus']);
  });

  it.each([
    ['no rows', { data: [], error: null }],
    ['changed with no previous status', ok(clearRow({ previous_status: null, changed: true }))],
    ['unchanged but with a previous status', ok(clearRow({ previous_status: 'worked', changed: false }))],
    ['an unknown previous status', ok(clearRow({ previous_status: 'late' }))],
    ['a non-boolean changed', ok(clearRow({ changed: 1 }))],
  ])('a malformed or self-contradictory result (%s) fails safely', async (_name, response) => {
    const error = await clear(createFakeClient({ clear_attendance: response })).catch((e) => e);
    expect(error).toBeInstanceOf(RepositoryError);
    expect(isAttendanceError(error)).toBe(false);
  });

  it.each([
    ['42501', null, 'permission_denied'],
    ['P0002', null, 'assignment_not_found'],
    ['23514', 'reason_required', 'reason_required'],
    ['23514', 'reason_too_long', 'reason_too_long'],
    ['22023', null, 'invalid_request'],
    ['XX000', null, 'unknown'],
  ])('7. %s / %j -> AttendanceError(%s)', async (code, details, kind) => {
    const fake = createFakeClient({ clear_attendance: fail(code, details) });
    expect(isAttendanceError(await clear(fake).catch((e) => e), kind as AttendanceErrorKind)).toBe(true);
    expect(fake.rpcCalls).toHaveLength(1);
  });

  it('8-9. exactly ONE clear_attendance call and no direct DELETE (or any table access)', async () => {
    const fake = createFakeClient({ clear_attendance: ok(clearRow()) });
    await clear(fake);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.tablesTouched).toEqual([]);
    expect(rotaAdapterSource.match(/rpc\(\s*'clear_attendance'/g)).toHaveLength(1);
    expect(rotaAdapterSource).not.toMatch(/\.delete\(/);
  });
});

describe('SupabaseRotaRepository.checkInToShift', () => {
  const checkIn = (fake: ReturnType<typeof createFakeClient>) => new SupabaseRotaRepository(fake.client).checkInToShift({ assignmentId: 'asg-1' });

  it('1-3. calls check_in_to_shift with ONLY the assignment id -- no driver, no timestamp, nothing else', async () => {
    const fake = createFakeClient({ check_in_to_shift: ok(checkInRow()) });
    await checkIn(fake);
    expect(fake.rpcCalls).toEqual([{ fn: 'check_in_to_shift', args: { p_assignment_id: 'asg-1' } }]);
  });

  it('4-6. maps a new check-in (created) and a repeat (not created) with the ORIGINAL id and timestamp', async () => {
    const first = await checkIn(createFakeClient({ check_in_to_shift: ok(checkInRow()) }));
    expect(first).toEqual({
      checkIn: { checkInId: 'ci-1', assignmentId: 'asg-1', shiftInstanceId: 'si-1', checkedInAt: '2030-01-07T17:42:10+00:00' },
      created: true,
    });
    const repeat = await checkIn(createFakeClient({ check_in_to_shift: ok(checkInRow({ created: false })) }));
    expect(repeat).toMatchObject({ created: false, checkIn: { checkInId: 'ci-1', checkedInAt: '2030-01-07T17:42:10+00:00' } });
  });

  it('is evidence only: no attendance status, pay or lateness field exists on the result', async () => {
    const result = await checkIn(createFakeClient({ check_in_to_shift: ok(checkInRow()) }));
    expect(Object.keys(result).sort()).toEqual(['checkIn', 'created']);
    expect(Object.keys(result.checkIn).sort()).toEqual(['assignmentId', 'checkInId', 'checkedInAt', 'shiftInstanceId']);
    expect(JSON.stringify(result)).not.toMatch(/status|late|pay|attendance/i);
  });

  it.each([
    ['no rows', { data: [], error: null }],
    ['null data', { data: null, error: null }],
    ['a missing timestamp', ok(checkInRow({ checked_in_at: undefined }))],
    ['a missing id', ok(checkInRow({ check_in_id: null }))],
    ['a non-boolean created', ok(checkInRow({ created: 'true' }))],
  ])('7. a malformed result (%s) fails safely as a repository contract error', async (_name, response) => {
    const error = await checkIn(createFakeClient({ check_in_to_shift: response })).catch((e) => e);
    expect(error).toBeInstanceOf(RepositoryError);
    expect(isDriverCheckInError(error)).toBe(false);
  });

  it.each([
    ['8', '42501', null, 'permission_denied'],
    ['9', 'P0002', null, 'assignment_not_found'],
    ['10', '55006', 'week_not_published', 'week_not_published'],
    ['11', '55006', 'shift_cancelled', 'shift_cancelled'],
    ['12', '55006', 'check_in_too_early', 'check_in_too_early'],
    ['13', '55006', 'check_in_closed', 'check_in_closed'],
    ['14', '55006', 'attendance_already_recorded', 'attendance_already_recorded'],
    ['15', '22023', null, 'invalid_request'],
  ])('%s. %s / %j -> DriverCheckInError(%s)', async (_n, code, details, kind) => {
    const fake = createFakeClient({ check_in_to_shift: fail(code, details) });
    const error = await checkIn(fake).catch((e) => e);
    expect(isDriverCheckInError(error, kind as DriverCheckInErrorKind)).toBe(true);
    expect(fake.rpcCalls).toHaveLength(1);
  });

  it('16. an unknown SQLSTATE or unexpected DETAIL is unknown', async () => {
    for (const [code, details] of [['XX000', null], ['55006', 'future_shift'], ['55006', 'check_in_recorded'], ['22023', 'surprise']] as const) {
      expect(isDriverCheckInError(await checkIn(createFakeClient({ check_in_to_shift: fail(code, details) })).catch((e) => e), 'unknown')).toBe(true);
    }
  });

  it('17-18. exactly ONE check_in_to_shift call, no table access, and no direct driver_check_ins write or time/driver argument in the adapter', async () => {
    const fake = createFakeClient({ check_in_to_shift: ok(checkInRow()) });
    await checkIn(fake);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.tablesTouched).toEqual([]);
    expect(rotaAdapterSource.match(/rpc\(\s*'check_in_to_shift'/g)).toHaveLength(1);
    expect(rotaAdapterSource).not.toMatch(/from\(\s*'driver_check_ins'\s*\)\s*\.(insert|update|upsert|delete)/);
    // The check-in call itself carries exactly one argument: the assignment id.
    const callArgs = /rpc\(\s*'check_in_to_shift',\s*\{([^}]*)\}/.exec(rotaAdapterSource)?.[1] ?? '';
    expect(callArgs.replace(/\s+/g, '')).toBe('p_assignment_id:params.assignmentId');
  });

  it('there is no "not your assignment" outcome: the database hides ownership, so it reads as assignment_not_found', async () => {
    const error = (await checkIn(createFakeClient({ check_in_to_shift: fail('P0002', null) })).catch((e) => e)) as DriverCheckInError;
    expect(error.kind).toBe('assignment_not_found');
    expect(error.userMessage).toBe('Check-in isn’t available for this shift.');
  });

  it('driver copy never reveals final attendance, a draft week or a cancelled shift', async () => {
    for (const detail of ['attendance_already_recorded', 'week_not_published', 'shift_cancelled'] as const) {
      const error = (await checkIn(createFakeClient({ check_in_to_shift: fail('55006', detail) })).catch((e) => e)) as DriverCheckInError;
      expect(error.userMessage).toBe('Check-in isn’t available for this shift.');
      expect(error.userMessage).not.toMatch(/attendance|record|publish|cancel/i);
    }
  });
});
