import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../types/database.generated';
import { SupabaseRotaRepository } from './rota';
import {
  AutoRotaError,
  PublishRotaConfirmationRequiredError,
  RepositoryError,
  isAutoRotaError,
  isAvailabilityOverrideRequired,
  isPublishRotaConfirmationRequired,
  isPublishRotaError,
  isRotaAssignmentError,
} from '../errors';
// Raw source text -- used only by the architecture check proving this adapter
// never writes rota_assignments directly.
import rotaAdapterSource from './rota.ts?raw';

type Row = Record<string, unknown>;

interface RecordedQuery {
  table: string;
  select: string | undefined;
  filters: Array<{ op: 'eq' | 'in'; column: string; value: unknown }>;
}

/**
 * A minimal fake of the bit of supabase-js the adapter uses: from().select()
 * .eq().in().order() as a thenable builder that APPLIES the filters and
 * PROJECTS the selected columns (so a mapper needing a column the query never
 * selected would fail here, as it would against PostgREST), plus rpc().
 * Records every call so tests can assert query counts, scoping, and -- most
 * importantly -- that nothing is ever written.
 */
type RpcResult = { data: unknown; error: unknown };
type RpcResponder = RpcResult | ((args: Record<string, unknown>, callNumber: number) => RpcResult);

function createFakeClient(tables: Record<string, Row[]>, rpcResults: Record<string, RpcResponder> = {}) {
  const queries: RecordedQuery[] = [];
  const writes: string[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const client = {
    from(table: string) {
      const rec: RecordedQuery = { table, select: undefined, filters: [] };
      queries.push(rec);
      const builder: Record<string, unknown> = {
        select(columns?: string) {
          rec.select = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          rec.filters.push({ op: 'eq', column, value });
          return builder;
        },
        in(column: string, value: unknown[]) {
          rec.filters.push({ op: 'in', column, value });
          return builder;
        },
        order() {
          return builder;
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          let rows = tables[table] ?? [];
          for (const f of rec.filters) {
            rows = rows.filter((r) => (f.op === 'eq' ? r[f.column] === f.value : (f.value as unknown[]).includes(r[f.column])));
          }
          const columns = rec.select && rec.select !== '*' ? rec.select.split(',').map((c) => c.trim()) : null;
          const projected = columns ? rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]]))) : rows;
          return Promise.resolve({ data: projected, error: null }).then(resolve);
        },
      };
      for (const write of ['insert', 'update', 'delete', 'upsert']) {
        builder[write] = () => {
          writes.push(`${write} ${table}`);
          throw new Error(`unexpected direct write: ${write} ${table}`);
        };
      }
      return builder;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      const responder = rpcResults[fn];
      const result = typeof responder === 'function' ? responder(args, rpcCalls.filter((c) => c.fn === fn).length) : responder;
      return Promise.resolve(result ?? { data: [], error: null });
    },
  };

  return { client: client as unknown as SupabaseClient<Database>, queries, writes, rpcCalls };
}

const RESORT = 'resort-1';
const WEEK = '2030-01-07';

const shiftRow = (id: string, overrides: Row = {}): Row => ({
  id,
  resort_id: RESORT,
  date: '2030-01-07',
  week_start: WEEK,
  shift_type_id: 'type-dinner',
  template_id: 'tpl',
  shift_key: 'dinner',
  name: 'Dinner',
  sort_order: 1,
  start_time: '18:00:00',
  end_time: '21:30:00',
  required_drivers: 2,
  is_premium: null,
  status: 'active',
  origin: 'template',
  ...overrides,
});

const driverRow = (id: string, full_name: string, is_active = true): Row => ({ id, resort_id: RESORT, full_name, is_active });

function standardTables(): Record<string, Row[]> {
  return {
    shift_instances: [
      shiftRow('si-fri', { date: '2030-01-11', name: 'Dinner (2P)', required_drivers: 2 }),
      shiftRow('si-mon', { date: '2030-01-07', name: 'Dinner (1P)', required_drivers: 1 }),
      shiftRow('si-cancelled', { date: '2030-01-08', status: 'cancelled' }),
      shiftRow('si-other-week', { date: '2030-01-15', week_start: '2030-01-14' }),
      shiftRow('si-other-resort', { resort_id: 'resort-2' }),
    ],
    drivers: [
      driverRow('d-alex', 'Alex'),
      driverRow('d-tomas', 'Tomas'),
      driverRow('d-gianni', 'Gianni'),
      driverRow('d-gone', 'Gone Driver', false),
      { id: 'd-elsewhere', resort_id: 'resort-2', full_name: 'Elsewhere', is_active: true },
    ],
    rota_publications: [],
    rota_assignments: [
      { id: 'a-1', shift_instance_id: 'si-fri', driver_id: 'd-alex', resort_id: RESORT, assignment_source: 'manual', assigned_at: '2030-01-01T10:00:00Z', assigned_by: 'secret-manager-id' },
      { id: 'a-2', shift_instance_id: 'si-fri', driver_id: 'd-gone', resort_id: RESORT, assignment_source: 'manual', assigned_at: '2030-01-01T11:00:00Z', assigned_by: 'secret-manager-id' },
      { id: 'a-3', shift_instance_id: 'si-mon', driver_id: 'd-tomas', resort_id: RESORT, assignment_source: 'manual', assigned_at: '2030-01-01T10:00:00Z', assigned_by: 'secret-manager-id' },
    ],
    availability: [
      { shift_instance_id: 'si-fri', driver_id: 'd-alex', resort_id: RESORT, status: 'available' },
      { shift_instance_id: 'si-fri', driver_id: 'd-tomas', resort_id: RESORT, status: 'unavailable' },
      { shift_instance_id: 'si-mon', driver_id: 'd-gianni', resort_id: RESORT, status: 'available' },
    ],
  };
}

describe('SupabaseRotaRepository.getManagerWeekRota', () => {
  it('returns the real active shifts for the resort + week only, with required_drivers preserved, in deterministic order', async () => {
    const { client } = createFakeClient(standardTables());
    const rota = await new SupabaseRotaRepository(client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });

    // si-cancelled (inactive), si-other-week and si-other-resort are excluded by the query's own filters.
    expect(rota.shifts.map((s) => s.shiftInstanceId)).toEqual(['si-mon', 'si-fri']);
    expect(rota.shifts.map((s) => s.requiredDrivers)).toEqual([1, 2]);
    expect(rota.shifts[1]).toMatchObject({ name: 'Dinner (2P)', startTime: '18:00', endTime: '21:30', date: '2030-01-11' });
    expect(rota.resortId).toBe(RESORT);
    expect(rota.weekStart).toBe(WEEK);
  });

  it('groups assignments under the correct shift', async () => {
    const { client } = createFakeClient(standardTables());
    const rota = await new SupabaseRotaRepository(client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });

    const mon = rota.shifts.find((s) => s.shiftInstanceId === 'si-mon')!;
    const fri = rota.shifts.find((s) => s.shiftInstanceId === 'si-fri')!;
    expect(mon.assignments.map((a) => a.driverName)).toEqual(['Tomas']);
    expect(fri.assignments.map((a) => a.driverName)).toEqual(['Alex', 'Gone Driver']);
  });

  it('lists ACTIVE resort drivers as candidates (sorted), excluding inactive and other-resort drivers', async () => {
    const { client } = createFakeClient(standardTables());
    const rota = await new SupabaseRotaRepository(client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });
    expect(rota.candidateDrivers.map((d) => d.fullName)).toEqual(['Alex', 'Gianni', 'Tomas']);
  });

  it('resolves an existing assignee who is now INACTIVE: kept, named, flagged inactive -- and not a candidate', async () => {
    const { client } = createFakeClient(standardTables());
    const rota = await new SupabaseRotaRepository(client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });
    const fri = rota.shifts.find((s) => s.shiftInstanceId === 'si-fri')!;
    expect(fri.assignments.find((a) => a.driverId === 'd-gone')).toMatchObject({ driverName: 'Gone Driver', isDriverActive: false, source: 'manual' });
    expect(rota.candidateDrivers.some((d) => d.driverId === 'd-gone')).toBe(false);
  });

  it('maps availability: available / unavailable / not_submitted (no row)', async () => {
    const { client } = createFakeClient(standardTables());
    const rota = await new SupabaseRotaRepository(client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });
    const fri = rota.shifts.find((s) => s.shiftInstanceId === 'si-fri')!;
    expect(fri.availabilityByDriver).toEqual({ 'd-alex': 'available', 'd-gianni': 'not_submitted', 'd-tomas': 'unavailable' });
    const mon = rota.shifts.find((s) => s.shiftInstanceId === 'si-mon')!;
    expect(mon.availabilityByDriver).toEqual({ 'd-alex': 'not_submitted', 'd-gianni': 'available', 'd-tomas': 'not_submitted' });
  });

  it('maps publication state: no row -> false; active publication -> true; unpublished -> false', async () => {
    const read = async (publications: Row[]) => {
      const { client } = createFakeClient({ ...standardTables(), rota_publications: publications });
      return (await new SupabaseRotaRepository(client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK })).isPublished;
    };
    const base = { resort_id: RESORT, week_start: WEEK };
    expect(await read([])).toBe(false);
    expect(await read([{ ...base, published_at: '2030-01-01T00:00:00Z', unpublished_at: null }])).toBe(true);
    expect(await read([{ ...base, published_at: '2030-01-01T00:00:00Z', unpublished_at: '2030-01-02T00:00:00Z' }])).toBe(false);
    // A publication for a DIFFERENT week or resort must not leak in.
    expect(await read([{ resort_id: RESORT, week_start: '2030-01-14', published_at: '2030-01-01T00:00:00Z', unpublished_at: null }])).toBe(false);
    expect(await read([{ resort_id: 'resort-2', week_start: WEEK, published_at: '2030-01-01T00:00:00Z', unpublished_at: null }])).toBe(false);
  });

  it('a week with NO shifts is a valid empty model: only 3 queries, no empty IN () list, candidates still listed', async () => {
    const tables = { ...standardTables(), shift_instances: [] };
    const { client, queries } = createFakeClient(tables);
    const rota = await new SupabaseRotaRepository(client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });

    expect(rota.shifts).toEqual([]);
    expect(rota.isPublished).toBe(false);
    expect(rota.candidateDrivers.length).toBe(3);
    expect(queries.map((q) => q.table).sort()).toEqual(['drivers', 'rota_publications', 'shift_instances']);
    expect(queries.some((q) => q.filters.some((f) => f.op === 'in'))).toBe(false);
  });

  it('uses a CONSTANT number of queries -- five, however many drivers or shifts there are (no N+1)', async () => {
    const manyDrivers = Array.from({ length: 40 }, (_, i) => driverRow(`d-${i}`, `Driver ${String(i).padStart(2, '0')}`));
    const manyShifts = Array.from({ length: 14 }, (_, i) => shiftRow(`si-${i}`, { date: `2030-01-${String(7 + (i % 7)).padStart(2, '0')}`, sort_order: i }));
    const small = createFakeClient(standardTables());
    const big = createFakeClient({ ...standardTables(), drivers: manyDrivers, shift_instances: manyShifts });

    await new SupabaseRotaRepository(small.client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });
    await new SupabaseRotaRepository(big.client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });

    expect(small.queries.length).toBe(5);
    expect(big.queries.length).toBe(5);
  });

  it('scopes every query: shifts by resort+week+active, drivers by resort, assignments/availability by the week\'s shift ids', async () => {
    const { client, queries } = createFakeClient(standardTables());
    await new SupabaseRotaRepository(client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });

    const q = (table: string) => queries.find((x) => x.table === table)!;
    expect(q('shift_instances').filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'resort_id', value: RESORT },
        { op: 'eq', column: 'week_start', value: WEEK },
        { op: 'eq', column: 'status', value: 'active' },
      ])
    );
    expect(q('drivers').filters).toEqual([{ op: 'eq', column: 'resort_id', value: RESORT }]);
    expect(q('rota_publications').filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'resort_id', value: RESORT },
        { op: 'eq', column: 'week_start', value: WEEK },
      ])
    );
    const ids = ['si-fri', 'si-mon'];
    for (const table of ['rota_assignments', 'availability']) {
      const inFilter = q(table).filters.find((f) => f.op === 'in')!;
      expect(inFilter.column).toBe('shift_instance_id');
      expect([...(inFilter.value as string[])].sort()).toEqual(ids);
    }
  });

  it('reads the inactive resort drivers too (needed to resolve existing assignees), i.e. does NOT filter drivers by is_active', async () => {
    const { client, queries } = createFakeClient(standardTables());
    await new SupabaseRotaRepository(client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });
    expect(queries.find((x) => x.table === 'drivers')!.filters.some((f) => f.column === 'is_active')).toBe(false);
  });

  it('never selects assigned_by, and the model carries no audit context or override reason', async () => {
    const { client, queries } = createFakeClient(standardTables());
    const rota = await new SupabaseRotaRepository(client).getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });
    expect(queries.find((x) => x.table === 'rota_assignments')!.select).not.toMatch(/assigned_by/);
    expect(queries.some((x) => x.table === 'audit_log')).toBe(false);
    expect(JSON.stringify(rota)).not.toMatch(/secret-manager-id|reason|context|override/i);
  });
});

describe('SupabaseRotaRepository writes go through the RPCs ONLY', () => {
  it('assignDriver calls assign_driver with exactly the contract arguments (confirm defaults to false, no availability state is ever sent)', async () => {
    const { client, rpcCalls, writes } = createFakeClient({}, { assign_driver: { data: [{ assignment_id: 'new-1', availability_state: 'available' }], error: null } });
    const result = await new SupabaseRotaRepository(client).assignDriver({ shiftInstanceId: 'si-1', driverId: 'd-1' });

    expect(result).toEqual({ assignmentId: 'new-1', availabilityState: 'available' });
    expect(rpcCalls).toEqual([
      { fn: 'assign_driver', args: { p_shift_instance_id: 'si-1', p_driver_id: 'd-1', p_confirm_availability_override: false, p_reason: undefined } },
    ]);
    expect(Object.keys(rpcCalls[0].args).some((k) => /availability_state|state/.test(k))).toBe(false);
    expect(writes).toEqual([]);
  });

  it('the confirmed retry is the SAME method with confirmAvailabilityOverride=true and the optional reason', async () => {
    const { client, rpcCalls } = createFakeClient({}, { assign_driver: { data: [{ assignment_id: 'new-2', availability_state: 'unavailable' }], error: null } });
    const result = await new SupabaseRotaRepository(client).assignDriver({
      shiftInstanceId: 'si-1',
      driverId: 'd-1',
      confirmAvailabilityOverride: true,
      reason: 'Confirmed by phone',
    });
    expect(result).toEqual({ assignmentId: 'new-2', availabilityState: 'unavailable' });
    expect(rpcCalls[0].args).toMatchObject({ p_confirm_availability_override: true, p_reason: 'Confirmed by phone' });
  });

  it('a null reason is sent as "not provided", not as the string "null"', async () => {
    const { client, rpcCalls } = createFakeClient({}, { assign_driver: { data: [{ assignment_id: 'n', availability_state: 'not_submitted' }], error: null } });
    await new SupabaseRotaRepository(client).assignDriver({ shiftInstanceId: 'si-1', driverId: 'd-1', confirmAvailabilityOverride: true, reason: null });
    expect(rpcCalls[0].args.p_reason).toBeUndefined();
  });

  it('VD001 from the RPC surfaces as a TYPED override-required error carrying the state -- no SQLSTATE or PostgREST shape reaches the caller', async () => {
    for (const state of ['unavailable', 'not_submitted'] as const) {
      const { client } = createFakeClient({}, { assign_driver: { data: null, error: { code: 'VD001', details: state, hint: null, message: 'raw' } } });
      const promise = new SupabaseRotaRepository(client).assignDriver({ shiftInstanceId: 'si-1', driverId: 'd-1' });
      await expect(promise).rejects.toSatisfy((e: unknown) => isAvailabilityOverrideRequired(e) && e.availabilityState === state);
    }
  });

  it('other assignment failures surface as typed RotaAssignmentErrors', async () => {
    const cases: Array<[string, string | null, string]> = [
      ['23505', null, 'duplicate_assignment'],
      ['55006', 'historical_shift', 'historical_shift'],
      ['23514', null, 'rule_violation'],
      ['P0002', null, 'not_found'],
    ];
    for (const [code, details, kind] of cases) {
      const { client } = createFakeClient({}, { assign_driver: { data: null, error: { code, details, hint: null, message: 'm' } } });
      await expect(new SupabaseRotaRepository(client).assignDriver({ shiftInstanceId: 's', driverId: 'd' })).rejects.toSatisfy((e: unknown) =>
        isRotaAssignmentError(e, kind as never)
      );
    }
  });

  it('an unrecognised availability_state from the server is a contract break, not a value to pass along', async () => {
    const { client } = createFakeClient({}, { assign_driver: { data: [{ assignment_id: 'x', availability_state: 'maybe' }], error: null } });
    await expect(new SupabaseRotaRepository(client).assignDriver({ shiftInstanceId: 's', driverId: 'd' })).rejects.toBeInstanceOf(RepositoryError);
  });

  it('an empty RPC result is an error, not a silent success', async () => {
    const { client } = createFakeClient({}, { assign_driver: { data: [], error: null }, unassign_driver: { data: [], error: null } });
    const repo = new SupabaseRotaRepository(client);
    await expect(repo.assignDriver({ shiftInstanceId: 's', driverId: 'd' })).rejects.toBeInstanceOf(RepositoryError);
    await expect(repo.unassignDriver({ shiftInstanceId: 's', driverId: 'd' })).rejects.toBeInstanceOf(RepositoryError);
  });

  it('unassignDriver calls unassign_driver and returns the removed assignment id', async () => {
    const { client, rpcCalls, writes } = createFakeClient({}, { unassign_driver: { data: [{ assignment_id: 'gone-1' }], error: null } });
    const result = await new SupabaseRotaRepository(client).unassignDriver({ shiftInstanceId: 'si-1', driverId: 'd-1' });
    expect(result).toEqual({ assignmentId: 'gone-1' });
    expect(rpcCalls).toEqual([{ fn: 'unassign_driver', args: { p_shift_instance_id: 'si-1', p_driver_id: 'd-1' } }]);
    expect(writes).toEqual([]);
  });

  it('unassign failures surface typed: attendance recorded, historical shift, assignment not found', async () => {
    const cases: Array<[string, string | null, string]> = [
      ['55006', 'attendance_recorded', 'attendance_recorded'],
      ['55006', 'historical_shift', 'historical_shift'],
      ['P0002', null, 'assignment_not_found'],
    ];
    for (const [code, details, kind] of cases) {
      const { client } = createFakeClient({}, { unassign_driver: { data: null, error: { code, details, hint: null, message: 'm' } } });
      await expect(new SupabaseRotaRepository(client).unassignDriver({ shiftInstanceId: 's', driverId: 'd' })).rejects.toSatisfy((e: unknown) =>
        isRotaAssignmentError(e, kind as never)
      );
    }
  });

  it('a full read + assign + unassign cycle performs ZERO direct table writes', async () => {
    const { client, writes } = createFakeClient(standardTables(), {
      assign_driver: { data: [{ assignment_id: 'n', availability_state: 'available' }], error: null },
      unassign_driver: { data: [{ assignment_id: 'n' }], error: null },
    });
    const repo = new SupabaseRotaRepository(client);
    await repo.getManagerWeekRota({ resortId: RESORT, weekStart: WEEK });
    await repo.assignDriver({ shiftInstanceId: 'si-mon', driverId: 'd-alex' });
    await repo.unassignDriver({ shiftInstanceId: 'si-mon', driverId: 'd-alex' });
    expect(writes).toEqual([]);
  });

  it('architecture: the adapter source contains no direct insert/update/delete/upsert at all', () => {
    expect(rotaAdapterSource).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
    // ...and writes only via the two RPCs.
    expect(rotaAdapterSource).toMatch(/\.rpc\('assign_driver'/);
    expect(rotaAdapterSource).toMatch(/\.rpc\('unassign_driver'/);
  });
});

// ---------------------------------------------------------------------------
// Live Driver My Rota: getDriverWeekRota
// ---------------------------------------------------------------------------

const DRIVER_WEEK = '2030-01-07';

const myAssignmentRow = (shiftInstanceId: string, over: Row = {}): Row => ({
  assignment_id: `assignment-${shiftInstanceId}`,
  shift_instance_id: shiftInstanceId,
  resort_id: RESORT,
  date: '2030-01-07',
  week_start: DRIVER_WEEK,
  shift_key: 'dinner',
  name: 'Dinner',
  start_time: '18:00:00',
  end_time: '21:30:00',
  ...over,
});

const publicationRow = (week = DRIVER_WEEK): Row => ({ resort_id: RESORT, week_start: week });

describe('SupabaseRotaRepository.getDriverWeekRota', () => {
  const read = (tables: Record<string, Row[]>, params: { weekStart?: string; driverId?: string } = {}) => {
    const fake = createFakeClient(tables);
    const promise = new SupabaseRotaRepository(fake.client).getDriverWeekRota({ weekStart: params.weekStart ?? DRIVER_WEEK, driverId: params.driverId ?? 'd-me' });
    return { fake, promise };
  };

  it('6. a publication row maps to isPublished = true', async () => {
    const { promise } = read({ driver_visible_week_publications: [publicationRow()], driver_visible_assignments: [] });
    expect((await promise).isPublished).toBe(true);
  });

  it('7. no publication row maps to isPublished = false, and shifts are empty', async () => {
    const { promise } = read({ driver_visible_week_publications: [], driver_visible_assignments: [] });
    expect(await promise).toEqual({ weekStart: DRIVER_WEEK, isPublished: false, shifts: [] });
  });

  it('8. reads exactly two views, each scoped to the selected week only', async () => {
    const { fake, promise } = read({
      driver_visible_week_publications: [publicationRow(), publicationRow('2030-01-14')],
      driver_visible_assignments: [myAssignmentRow('si-mon'), myAssignmentRow('si-next-week', { week_start: '2030-01-14', date: '2030-01-14' })],
    });
    const rota = await promise;

    expect(fake.queries.map((q) => q.table).sort()).toEqual(['driver_visible_assignments', 'driver_visible_week_publications']);
    for (const q of fake.queries) expect(q.filters).toEqual([{ op: 'eq', column: 'week_start', value: DRIVER_WEEK }]);
    expect(rota.shifts.map((s) => s.shiftInstanceId)).toEqual(['si-mon']);
  });

  it('9. the driver id is NEVER sent to the database as a filter -- the session decides, so another id changes nothing', async () => {
    const tables = { driver_visible_week_publications: [publicationRow()], driver_visible_assignments: [myAssignmentRow('si-mon')] };
    const mine = read(tables, { driverId: 'd-me' });
    const someoneElse = read(tables, { driverId: 'd-someone-else' });
    const [a, b] = [await mine.promise, await someoneElse.promise];

    expect(b).toEqual(a);
    expect(someoneElse.fake.queries).toEqual(mine.fake.queries);
    for (const q of someoneElse.fake.queries) {
      expect(q.filters.map((f) => f.column)).toEqual(['week_start']);
      expect(JSON.stringify(q)).not.toContain('d-someone-else');
    }
    expect(someoneElse.fake.rpcCalls).toEqual([]);
  });

  it('10. a published week with zero own assignments is published with no shifts (distinct from unpublished)', async () => {
    const { promise } = read({ driver_visible_week_publications: [publicationRow()], driver_visible_assignments: [] });
    expect(await promise).toEqual({ weekStart: DRIVER_WEEK, isPublished: true, shifts: [] });
  });

  it('11. maps published assignments: name, HH:MM times, date; several shifts on one day; deterministic order', async () => {
    const { promise } = read({
      driver_visible_week_publications: [publicationRow()],
      driver_visible_assignments: [
        myAssignmentRow('si-fri-dinner', { date: '2030-01-11', name: 'Dinner (2P)' }),
        myAssignmentRow('si-fri-lunch', { date: '2030-01-11', name: 'Lunch', start_time: '12:00:00', end_time: '14:00:00' }),
        myAssignmentRow('si-mon'),
      ],
    });
    expect((await promise).shifts).toEqual([
      { shiftInstanceId: 'si-mon', date: '2030-01-07', shiftName: 'Dinner', startTime: '18:00', endTime: '21:30' },
      { shiftInstanceId: 'si-fri-lunch', date: '2030-01-11', shiftName: 'Lunch', startTime: '12:00', endTime: '14:00' },
      { shiftInstanceId: 'si-fri-dinner', date: '2030-01-11', shiftName: 'Dinner (2P)', startTime: '18:00', endTime: '21:30' },
    ]);
  });

  it('12. never touches rota_assignments (or any other base table) and never writes', async () => {
    const { fake, promise } = read({
      rota_assignments: [{ id: 'x', shift_instance_id: 'si-mon', driver_id: 'd-other' }],
      driver_visible_week_publications: [publicationRow()],
      driver_visible_assignments: [myAssignmentRow('si-mon')],
    });
    await promise;
    expect(fake.queries.some((q) => q.table === 'rota_assignments')).toBe(false);
    expect(fake.writes).toEqual([]);
  });

  it('13. never touches rota_publications -- publication state comes only from the driver-safe view', async () => {
    const { fake, promise } = read({
      rota_publications: [{ resort_id: RESORT, week_start: DRIVER_WEEK, published_by: 'manager-secret', generation_source: 'manual' }],
      driver_visible_week_publications: [],
      driver_visible_assignments: [],
    });
    const rota = await promise;
    expect(fake.queries.some((q) => q.table === 'rota_publications')).toBe(false);
    expect(rota.isPublished).toBe(false);
  });

  it('the returned rota carries no manager, colleague, source or audit data even if the underlying rows had extra columns', async () => {
    const { promise } = read({
      driver_visible_week_publications: [{ ...publicationRow(), published_by: 'manager-secret' }],
      driver_visible_assignments: [myAssignmentRow('si-mon', { required_drivers: 4, assignment_source: 'manual', assigned_by: 'manager-secret', driver_id: 'd-other', reason: 'override' })],
    });
    const json = JSON.stringify(await promise);
    expect(json).not.toMatch(/manager-secret|required_drivers|assignment_source|d-other|override|assigned_by/);
  });

  it('turns a database failure into a RepositoryError (no raw error leaks)', async () => {
    const client = {
      from() {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          order: () => b,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } }).then(resolve),
        };
        return b;
      },
    } as unknown as SupabaseClient<Database>;
    await expect(new SupabaseRotaRepository(client).getDriverWeekRota({ weekStart: DRIVER_WEEK, driverId: 'd-me' })).rejects.toBeInstanceOf(RepositoryError);
  });
});

// ---------------------------------------------------------------------------
// Auto-Rota: generateAutoRota (read -> pure plan -> ONE apply_auto_rota call)
// ---------------------------------------------------------------------------

/**
 * A realistic week (2030-01-07..13, far in the future so nothing is historical):
 * Friday needs 2 and already has Alex (active) plus an inactive assignee; Monday
 * is full. Gianni and Tomas are both Available on Friday, so the planner must
 * propose exactly ONE more driver -- Gianni (fewer total assignments than Tomas,
 * who already works Monday).
 */
function autoRotaTables(): Record<string, Row[]> {
  const tables = standardTables();
  tables.availability = [
    ...tables.availability,
    { shift_instance_id: 'si-fri', driver_id: 'd-gianni', resort_id: RESORT, status: 'available' },
    { shift_instance_id: 'si-fri', driver_id: 'd-tomas', resort_id: RESORT, status: 'available' },
  ];
  return tables;
}

const dbResult = (over: Row = {}) => ({
  data: [{ resort_id: RESORT, week_start: WEEK, assigned_count: 7, remaining_open_slots: 3, uncovered_shift_ids: ['si-x'], skipped_past_shift_count: 2, run_id: 'run-123', ...over }],
  error: null,
});
const dbError = (code: string, details: string | null = null) => ({ data: null, error: { message: `db message for ${code}`, code, details } });
const GENERATE = { resortId: RESORT, weekStart: WEEK };

describe('SupabaseRotaRepository.generateAutoRota', () => {
  it('reads the week FRESH, plans, and makes exactly ONE apply_auto_rota call carrying only the minimal plan', async () => {
    const fake = createFakeClient(autoRotaTables(), { apply_auto_rota: dbResult() });
    await new SupabaseRotaRepository(fake.client).generateAutoRota(GENERATE);

    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0].fn).toBe('apply_auto_rota');
    expect(fake.rpcCalls[0].args).toEqual({
      p_resort_id: RESORT,
      p_week_start: WEEK,
      p_plan: [{ shift_instance_id: 'si-fri', driver_id: 'd-gianni' }],
    });
    // The week was read (shifts, drivers, publication, assignments, availability) before planning.
    expect(fake.queries.map((q) => q.table)).toEqual(expect.arrayContaining(['shift_instances', 'drivers', 'rota_assignments', 'availability']));
  });

  it('sends nothing but the shift/driver pair -- no counts, availability, source, coverage or fairness metadata', async () => {
    const fake = createFakeClient(autoRotaTables(), { apply_auto_rota: dbResult() });
    await new SupabaseRotaRepository(fake.client).generateAutoRota(GENERATE);
    const plan = fake.rpcCalls[0].args.p_plan as Array<Record<string, unknown>>;
    for (const row of plan) expect(Object.keys(row).sort()).toEqual(['driver_id', 'shift_instance_id']);
    expect(Object.keys(fake.rpcCalls[0].args).sort()).toEqual(['p_plan', 'p_resort_id', 'p_week_start']);
  });

  it('returns the DATABASE\'s authoritative result mapped to camelCase -- never the planner\'s own numbers', async () => {
    // The planner would report 1 planned assignment and 0 remaining; the database says otherwise.
    const fake = createFakeClient(autoRotaTables(), { apply_auto_rota: dbResult() });
    const result = await new SupabaseRotaRepository(fake.client).generateAutoRota(GENERATE);
    expect(result).toEqual({
      resortId: RESORT,
      weekStart: WEEK,
      assignedCount: 7,
      remainingOpenSlots: 3,
      uncoveredShiftIds: ['si-x'],
      skippedPastShiftCount: 2,
      runId: 'run-123',
    });
  });

  it('partial coverage is a normal success (remainingOpenSlots > 0), and an already-covered week sends an EMPTY plan and succeeds', async () => {
    const covered = createFakeClient(standardTables(), { apply_auto_rota: dbResult({ assigned_count: 0, remaining_open_slots: 0, uncovered_shift_ids: [] }) });
    const result = await new SupabaseRotaRepository(covered.client).generateAutoRota(GENERATE);
    expect(covered.rpcCalls[0].args.p_plan).toEqual([]); // standard fixture has no eligible Available driver for the open Friday slot
    expect(result.assignedCount).toBe(0);
    expect(result.remainingOpenSlots).toBe(0);
  });

  it('STALE plan: discards it, re-reads the week, re-plans FROM SCRATCH, and retries exactly once', async () => {
    const tables = autoRotaTables();
    const fake = createFakeClient(tables, {
      apply_auto_rota: (_args, call) => {
        if (call === 1) {
          // The world moves between read and apply: Gianni flips to Unavailable.
          for (const row of tables.availability) if (row.driver_id === 'd-gianni' && row.shift_instance_id === 'si-fri') row.status = 'unavailable';
          return dbError('VD002', 'stale_plan');
        }
        return dbResult();
      },
    });
    const result = await new SupabaseRotaRepository(fake.client).generateAutoRota(GENERATE);

    expect(fake.rpcCalls).toHaveLength(2);
    expect(fake.rpcCalls[0].args.p_plan).toEqual([{ shift_instance_id: 'si-fri', driver_id: 'd-gianni' }]);
    expect(fake.rpcCalls[1].args.p_plan).toEqual([{ shift_instance_id: 'si-fri', driver_id: 'd-tomas' }]); // re-planned on FRESH data
    expect(fake.queries.filter((q) => q.table === 'shift_instances')).toHaveLength(2); // two independent reads
    expect(result.runId).toBe('run-123');
  });

  it('a SECOND stale plan surfaces the typed error -- no third attempt, no loop', async () => {
    const fake = createFakeClient(autoRotaTables(), { apply_auto_rota: () => dbError('VD002', 'stale_plan') });
    const error = await new SupabaseRotaRepository(fake.client).generateAutoRota(GENERATE).catch((e) => e);
    expect(error).toBeInstanceOf(AutoRotaError);
    expect(isAutoRotaError(error, 'stale_plan')).toBe(true);
    expect(fake.rpcCalls).toHaveLength(2);
  });

  it('a historical_shift from the database (the operational day crossed midnight) is re-read and re-planned exactly once', async () => {
    const fake = createFakeClient(autoRotaTables(), { apply_auto_rota: (_a, call) => (call === 1 ? dbError('55006', 'historical_shift') : dbResult()) });
    const result = await new SupabaseRotaRepository(fake.client).generateAutoRota(GENERATE);
    expect(fake.rpcCalls).toHaveLength(2);
    expect(result.assignedCount).toBe(7);

    const twice = createFakeClient(autoRotaTables(), { apply_auto_rota: () => dbError('55006', 'historical_shift') });
    const error = await new SupabaseRotaRepository(twice.client).generateAutoRota(GENERATE).catch((e) => e);
    expect(isAutoRotaError(error, 'historical_shift')).toBe(true);
    expect(twice.rpcCalls).toHaveLength(2);
  });

  it.each([
    ['published_week', '55006', 'published_week'],
    ['historical_week', '55006', 'historical_week'],
    ['permission_denied', '42501', null],
    ['resort_not_found', 'P0002', null],
    ['invalid_plan', '22023', 'plan_malformed'],
    ['invalid_week', '22023', null],
    ['unknown', 'XX000', null],
  ] as const)('%s is surfaced immediately as a typed error and is NEVER retried (one apply call)', async (kind, code, detail) => {
    const fake = createFakeClient(autoRotaTables(), { apply_auto_rota: () => dbError(code, detail) });
    const error = await new SupabaseRotaRepository(fake.client).generateAutoRota(GENERATE).catch((e) => e);
    expect(isAutoRotaError(error, kind)).toBe(true);
    expect(fake.rpcCalls).toHaveLength(1);
    // A manager never sees SQLSTATEs, DETAIL tokens or database text.
    expect((error as AutoRotaError).userMessage).not.toMatch(/VD002|55006|42501|P0002|22023|stale_plan|published_week|db message/);
  });

  it('an unexpected DETAIL on a known SQLSTATE is NOT mistaken for a known state', async () => {
    for (const [code, detail] of [['VD002', 'something_else'], ['55006', 'mystery']] as const) {
      const fake = createFakeClient(autoRotaTables(), { apply_auto_rota: () => dbError(code, detail) });
      const error = await new SupabaseRotaRepository(fake.client).generateAutoRota(GENERATE).catch((e) => e);
      expect(isAutoRotaError(error, 'unknown')).toBe(true);
      expect(fake.rpcCalls).toHaveLength(1);
    }
  });

  it('a wholly past week still goes to the database with an empty plan, so the DATABASE\'s historical_week verdict is the authoritative one', async () => {
    const tables = standardTables();
    for (const row of tables.shift_instances) {
      row.date = '2020-01-08';
      row.week_start = '2020-01-06';
    }
    const fake = createFakeClient(tables, { apply_auto_rota: () => dbError('55006', 'historical_week') });
    const error = await new SupabaseRotaRepository(fake.client).generateAutoRota({ resortId: RESORT, weekStart: '2020-01-06' }).catch((e) => e);
    expect(isAutoRotaError(error, 'historical_week')).toBe(true);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0].args.p_plan).toEqual([]);
  });

  it('an apply that returns no row is a RepositoryError, not a fabricated result', async () => {
    const fake = createFakeClient(autoRotaTables(), { apply_auto_rota: { data: [], error: null } });
    await expect(new SupabaseRotaRepository(fake.client).generateAutoRota(GENERATE)).rejects.toBeInstanceOf(RepositoryError);
  });

  it('never writes a table, never calls assign_driver, and never calls apply_auto_rota more than twice', async () => {
    const fake = createFakeClient(autoRotaTables(), { apply_auto_rota: () => dbError('VD002', 'stale_plan') });
    await new SupabaseRotaRepository(fake.client).generateAutoRota(GENERATE).catch(() => undefined);
    expect(fake.writes).toEqual([]);
    expect(fake.rpcCalls.every((c) => c.fn === 'apply_auto_rota')).toBe(true);
    expect(fake.rpcCalls.length).toBeLessThanOrEqual(2);
    // Structural: exactly one apply_auto_rota call site, and the Auto-Rota code never reaches for the manual write RPCs.
    expect(rotaAdapterSource.match(/rpc\(\s*'apply_auto_rota'/g)).toHaveLength(1);
    const autoRotaSection = rotaAdapterSource.slice(rotaAdapterSource.indexOf('async generateAutoRota'));
    expect(autoRotaSection).not.toMatch(/assign_driver|unassign_driver|\.insert\(|\.update\(|\.delete\(|\.upsert\(|rota_assignments/);
  });
});

describe('SupabaseRotaRepository.publishRota', () => {
  const RESORT = 'resort-crans';
  const WEEK = '2030-01-07';
  const row = (over: Record<string, unknown> = {}) => ({
    resort_id: RESORT,
    week_start: WEEK,
    published_at: '2030-01-01T10:00:00+00:00',
    uncovered_slots: 0,
    already_published: false,
    ...over,
  });
  const ok = (over: Record<string, unknown> = {}) => ({ data: [row(over)], error: null });
  const fail = (code: string, details: string | null, message = 'db message') => ({ data: null, error: { code, details, hint: null, message } });
  const publish = (fake: ReturnType<typeof createFakeClient>, params: { confirmUncovered?: boolean } = {}) =>
    new SupabaseRotaRepository(fake.client).publishRota({ resortId: RESORT, weekStart: WEEK, ...params });

  it('1-2. calls publish_rota with the right resort and week', async () => {
    const fake = createFakeClient({}, { publish_rota: ok() });
    await publish(fake);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0].fn).toBe('publish_rota');
    expect(fake.rpcCalls[0].args).toMatchObject({ p_resort_id: RESORT, p_week_start: WEEK });
  });

  it('3. confirmUncovered omitted -> p_confirm_uncovered false; explicit false -> false', async () => {
    const omitted = createFakeClient({}, { publish_rota: ok() });
    await publish(omitted);
    expect(omitted.rpcCalls[0].args).toEqual({ p_resort_id: RESORT, p_week_start: WEEK, p_confirm_uncovered: false });
    const explicit = createFakeClient({}, { publish_rota: ok() });
    await publish(explicit, { confirmUncovered: false });
    expect(explicit.rpcCalls[0].args.p_confirm_uncovered).toBe(false);
  });

  it('4. confirmUncovered true -> p_confirm_uncovered true', async () => {
    const fake = createFakeClient({}, { publish_rota: ok({ uncovered_slots: 2 }) });
    await publish(fake, { confirmUncovered: true });
    expect(fake.rpcCalls[0].args).toEqual({ p_resort_id: RESORT, p_week_start: WEEK, p_confirm_uncovered: true });
  });

  it('sends nothing but those three arguments -- no counts, no generation source, no actor', async () => {
    const fake = createFakeClient({}, { publish_rota: ok() });
    await publish(fake, { confirmUncovered: true });
    expect(Object.keys(fake.rpcCalls[0].args).sort()).toEqual(['p_confirm_uncovered', 'p_resort_id', 'p_week_start']);
  });

  it('5. maps snake_case to the camelCase domain result, exposing nothing else', async () => {
    const fake = createFakeClient({}, { publish_rota: { data: [{ ...row({ uncovered_slots: 3 }), generation_source: 'auto', published_by: 'u-1', id: 'p-1' }], error: null } });
    const result = await publish(fake);
    expect(result).toEqual({ resortId: RESORT, weekStart: WEEK, publishedAt: '2030-01-01T10:00:00+00:00', uncoveredSlots: 3, alreadyPublished: false });
    expect(Object.keys(result).sort()).toEqual(['alreadyPublished', 'publishedAt', 'resortId', 'uncoveredSlots', 'weekStart']);
  });

  it('6-7. already published is a NORMAL success that keeps the server\'s original timestamp and count', async () => {
    const fake = createFakeClient({}, { publish_rota: ok({ already_published: true, published_at: '2029-12-30T08:00:00+00:00', uncovered_slots: 4 }) });
    await expect(publish(fake)).resolves.toEqual({
      resortId: RESORT,
      weekStart: WEEK,
      publishedAt: '2029-12-30T08:00:00+00:00',
      uncoveredSlots: 4,
      alreadyPublished: true,
    });
  });

  it('7. a confirmed publish returns the server\'s CURRENT count, not the one from the earlier prompt', async () => {
    const fake = createFakeClient({}, {
      publish_rota: (_args, n) => (n === 1 ? fail('VD003', '3') : ok({ uncovered_slots: 2 })),
    });
    const repo = new SupabaseRotaRepository(fake.client);
    const first = await repo.publishRota({ resortId: RESORT, weekStart: WEEK }).catch((e) => e);
    expect((first as PublishRotaConfirmationRequiredError).uncoveredSlots).toBe(3);
    const second = await repo.publishRota({ resortId: RESORT, weekStart: WEEK, confirmUncovered: true });
    expect(second.uncoveredSlots).toBe(2);
  });

  it('8. VD003 with a valid count -> typed confirmation-required error carrying it', async () => {
    const fake = createFakeClient({}, { publish_rota: fail('VD003', '5') });
    const error = await publish(fake).catch((e) => e);
    expect(isPublishRotaConfirmationRequired(error)).toBe(true);
    expect((error as PublishRotaConfirmationRequiredError).uncoveredSlots).toBe(5);
    expect(error).toBeInstanceOf(RepositoryError);
  });

  it.each([[null], [''], ['0'], ['-1'], ['2.5'], ['abc']])('9. VD003 with invalid DETAIL (%j) -> unknown, not a fake count', async (details) => {
    const fake = createFakeClient({}, { publish_rota: fail('VD003', details) });
    const error = await publish(fake).catch((e) => e);
    expect(isPublishRotaConfirmationRequired(error)).toBe(false);
    expect(isPublishRotaError(error, 'unknown')).toBe(true);
  });

  it.each([
    ['10', '55006', 'historical_week', 'historical_week'],
    ['11', '23514', 'no_shifts', 'no_shifts'],
    ['12', '23514', 'resort_inactive', 'resort_inactive'],
    ['13', 'P0002', null, 'resort_not_found'],
    ['14', '22023', null, 'invalid_week'],
    ['15', '42501', null, 'permission_denied'],
  ])('%s. %s / %j -> PublishRotaError(%s)', async (_n, code, details, kind) => {
    const fake = createFakeClient({}, { publish_rota: fail(code, details) });
    const error = await publish(fake).catch((e) => e);
    expect(isPublishRotaError(error, kind as never)).toBe(true);
    expect(fake.rpcCalls).toHaveLength(1);
  });

  it('16-17. an unknown SQLSTATE, or a known one with an unexpected DETAIL, falls back to unknown', async () => {
    for (const [code, details] of [['XX000', null], ['23514', 'surprise'], ['55006', 'published_week']] as const) {
      const error = await publish(createFakeClient({}, { publish_rota: fail(code, details) })).catch((e) => e);
      expect(isPublishRotaError(error, 'unknown')).toBe(true);
    }
  });

  it('never leaks SQL internals through userMessage', async () => {
    const error = (await publish(createFakeClient({}, { publish_rota: fail('23514', 'no_shifts', 'violates constraint rota_publications_x') })).catch((e) => e)) as RepositoryError;
    expect(error.userMessage).toBe('This rota can’t be published because there are no shifts this week.');
    expect(error.userMessage).not.toMatch(/constraint|rota_publications|23514/);
  });

  it.each([[{ data: [], error: null }], [{ data: null, error: null }], [{ data: [{ resort_id: RESORT }], error: null }], [{ data: [row({ uncovered_slots: '2' })], error: null }]])(
    'a malformed success payload (%j) is a contract break, not a half-valid result',
    async (response) => {
      const error = await publish(createFakeClient({}, { publish_rota: response })).catch((e) => e);
      expect(error).toBeInstanceOf(RepositoryError);
      expect(isPublishRotaError(error)).toBe(false);
    }
  );

  it('18-20. exactly ONE publish_rota call per invocation, no table reads, no direct rota_publications writes', async () => {
    const fake = createFakeClient({}, { publish_rota: ok() });
    await publish(fake);
    await publish(fake, { confirmUncovered: true });
    expect(fake.rpcCalls.map((c) => c.fn)).toEqual(['publish_rota', 'publish_rota']);
    expect(fake.queries).toEqual([]); // no coverage / publication reads either
    expect(fake.writes).toEqual([]);
  });

  it('does not retry on a confirmation-required error (the manager decides, not the repository)', async () => {
    const fake = createFakeClient({}, { publish_rota: fail('VD003', '2') });
    await publish(fake).catch(() => undefined);
    expect(fake.rpcCalls).toHaveLength(1);
  });

  it('architecture: the adapter calls publish_rota once and never writes or derives publication data', () => {
    expect(rotaAdapterSource.match(/rpc\(\s*'publish_rota'/g)).toHaveLength(1);
    expect(rotaAdapterSource).not.toMatch(/from\(\s*'rota_publications'\s*\)\s*\.(insert|update|upsert|delete)/);
    expect(rotaAdapterSource).not.toMatch(/generation_source|published_by/);
  });
});
