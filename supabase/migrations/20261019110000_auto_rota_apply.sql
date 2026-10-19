-- Auto-Rota checkpoint AR-A: the authoritative database execution layer.
--
-- Architecture (approved): a pure deterministic TypeScript planner (a later
-- checkpoint) PROPOSES who fills each open position; Postgres decides whether
-- every proposed assignment is still safe, all-or-nothing, under a lock. The
-- database does NOT reproduce the fairness algorithm -- it only enforces the
-- safety invariants -- so a planner/SQL disagreement can only ever cause a
-- rejection, never an unsafe write. The submitted plan is UNTRUSTED input.
--
-- This migration adds:
--   1. the per-resort-per-week transaction lock (rota_week_lock) and its key
--      function;
--   2. a trigger so every publication write serializes on that same lock;
--   3. assign_driver / unassign_driver re-created ONLY to take that lock
--      first (concurrency serialization; every other behaviour is unchanged);
--   4. apply_auto_rota, the one atomic, manager-only RPC that applies a plan.
--
-- ---------------------------------------------------------------------
-- THE WEEK LOCK
-- ---------------------------------------------------------------------
-- Everything that can change whether an Auto-Rota apply is valid for one
-- resort + Monday-anchored week takes the SAME transaction-scoped advisory
-- lock: apply_auto_rota, assign_driver, unassign_driver, and any write to
-- rota_publications (insert / update / delete). Transaction-level, so it is
-- released automatically on commit or rollback; there is no lock table.
--
-- Key (documented, deterministic, no text hashing, no randomness):
--   pg_advisory_xact_lock(key1 int4, key2 int4)   -- the two-key form
--   key1 = the resort UUID's 16 bytes read as four big-endian 32-bit words,
--          XOR-ed together (signed int4). UUIDs are random v4, so the
--          fold is well distributed.
--   key2 = week_start - DATE '2000-01-01'   (days, int4)
-- The same resort + week always maps to the same pair; different weeks or
-- resorts map to different pairs (a 1-in-2^32 resort-fold collision would
-- only ever cause two unrelated resorts to wait on each other briefly -- never
-- a correctness problem). The two-int-key advisory space is separate from the
-- single-bigint one, and nothing else in this project takes advisory locks.
--
-- ---------------------------------------------------------------------
-- apply_auto_rota ERROR CONTRACT (the repository keys off SQLSTATE/DETAIL)
-- ---------------------------------------------------------------------
--   42501  not an active manager (anon: no EXECUTE grant, also 42501)
--   P0002  resort not found
--   22023  malformed / structurally invalid request: not a Monday, null
--          argument, plan not a JSON array, an element that is not an object
--          with exactly {shift_instance_id, driver_id} as UUID strings, a
--          duplicate pair inside the plan, more than 1000 rows, or a pair
--          that cannot belong to this request at all (DETAIL plan_shift_not_in_week
--          / plan_driver_not_in_resort -- shifts and drivers never change
--          resort or week, so that is never a race).
--   55006  locked / not allowed. DETAIL:
--            published_week   the week is currently published
--            historical_week  the whole week is before the operational today
--            historical_shift a planned pair targets a shift before today
--   VD002  STALE PLAN (DETAIL stale_plan): structurally fine, but current
--          authoritative state no longer permits it -- availability changed,
--          the driver is inactive, the shift was cancelled, the driver is
--          already assigned, or applying it would exceed the shift's CURRENT
--          open coverage. Nothing is written; the repository re-reads,
--          re-plans and retries once.
-- Partial coverage, "no eligible driver" and "nothing to create" are SUCCESS.

-- ---------------------------------------------------------------------
-- 1. Lock key + lock
-- ---------------------------------------------------------------------
create or replace function rota_week_lock_keys(p_resort_id uuid, p_week_start date)
returns table (key1 integer, key2 integer)
language sql
immutable
as $$
  select
    (('x' || substr(h.hex, 1, 8))::bit(32)::integer)
      # (('x' || substr(h.hex, 9, 8))::bit(32)::integer)
      # (('x' || substr(h.hex, 17, 8))::bit(32)::integer)
      # (('x' || substr(h.hex, 25, 8))::bit(32)::integer),
    (p_week_start - date '2000-01-01')
  from (select replace(p_resort_id::text, '-', '') as hex) h;
$$;

comment on function rota_week_lock_keys(uuid, date) is
  'The two int4 advisory-lock keys for one resort + week: key1 = the four 32-bit words of the resort UUID XOR-ed together, key2 = days since 2000-01-01 of week_start. Deterministic and collision-safe in practice.';

create or replace function rota_week_lock(p_resort_id uuid, p_week_start date)
returns void
language plpgsql
volatile
as $$
declare
  v_keys record;
begin
  select * into v_keys from rota_week_lock_keys(p_resort_id, p_week_start);
  perform pg_advisory_xact_lock(v_keys.key1, v_keys.key2);
end;
$$;

comment on function rota_week_lock(uuid, date) is
  'Takes the transaction-scoped advisory lock for one resort + week. Held until the transaction ends. Taken by apply_auto_rota, assign_driver, unassign_driver and every rota_publications write, so they serialize per resort/week. Internal: callable only by the SECURITY DEFINER functions/trigger that need it.';

revoke execute on function rota_week_lock_keys(uuid, date) from public, anon, authenticated;
revoke execute on function rota_week_lock(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Publication writes serialize on the same lock
-- ---------------------------------------------------------------------
-- There is no Publish RPC yet; publication is a direct manager write. A
-- trigger makes ANY path -- today's direct write, tomorrow's Publish RPC --
-- wait for an in-flight Auto-Rota apply, and makes an apply that starts later
-- observe the committed publication. Covers INSERT (publish), UPDATE (e.g.
-- unpublished_at) and DELETE (a removed publication is an unpublish).
create or replace function rota_publications_take_week_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform rota_week_lock(new.resort_id, new.week_start);
  end if;
  if tg_op = 'DELETE'
     or (tg_op = 'UPDATE' and (old.resort_id, old.week_start) is distinct from (new.resort_id, new.week_start)) then
    perform rota_week_lock(old.resort_id, old.week_start);
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function rota_publications_take_week_lock() from public, anon, authenticated;

create trigger rota_publications_week_lock
  before insert or update or delete on rota_publications
  for each row execute function rota_publications_take_week_lock();

-- ---------------------------------------------------------------------
-- 3. assign_driver / unassign_driver: take the week lock, change nothing else
-- ---------------------------------------------------------------------
-- Bodies are identical to migration 20261009100100 except for the lock (and,
-- in assign_driver, re-reading the shift row once the lock is held so a
-- cancellation that committed while waiting is seen). Every availability /
-- publication / history / attendance / reason / audit rule and every error
-- code is unchanged; supabase/tests/85_manual_rota_assignments.sql passes
-- unmodified.
create or replace function assign_driver(
  p_shift_instance_id uuid,
  p_driver_id uuid,
  p_confirm_availability_override boolean default false,
  p_reason text default null
)
returns table (assignment_id uuid, availability_state text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_caller app_user_context;
  v_shift shift_instances%rowtype;
  v_driver drivers%rowtype;
  v_reason text;
  v_status text;
  v_state text;
  v_context jsonb;
  v_new_id uuid;
begin
  perform assert_active_manager();
  v_caller := current_app_user();

  select * into v_shift from shift_instances si where si.id = p_shift_instance_id;
  if not found then
    raise exception 'Shift not found.' using errcode = 'P0002';
  end if;

  -- Serialize with Auto-Rota, other manual edits and publication for this
  -- resort/week, then re-read so everything below sees post-lock state.
  perform rota_week_lock(v_shift.resort_id, v_shift.week_start);
  select * into v_shift from shift_instances si where si.id = p_shift_instance_id;
  if not found then
    raise exception 'Shift not found.' using errcode = 'P0002';
  end if;

  if v_shift.status <> 'active' then
    raise exception 'This shift has been cancelled and can''t be staffed.' using errcode = '23514';
  end if;
  if v_shift.date < operational_today(v_shift.resort_id) then
    raise exception 'This shift is in the past. Past assignments can''t be changed from the weekly rota.'
      using errcode = '55006', detail = 'historical_shift';
  end if;

  select * into v_driver from drivers d where d.id = p_driver_id;
  if not found then
    raise exception 'Driver not found.' using errcode = 'P0002';
  end if;
  if not v_driver.is_active then
    raise exception 'This driver is inactive and can''t be assigned to new shifts.' using errcode = '23514';
  end if;
  if v_driver.resort_id <> v_shift.resort_id then
    raise exception 'This driver belongs to a different resort than this shift.' using errcode = '23514';
  end if;

  v_reason := nullif(btrim(p_reason, E' \t\r\n'), '');
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'The reason must be 500 characters or fewer.' using errcode = '23514';
  end if;

  -- The unique constraint stays the authoritative guard (a concurrent
  -- assignment is caught again around the INSERT below); this up-front check
  -- exists only so the common case reports a clean message, and reports it
  -- BEFORE asking the manager to confirm an availability override they'd
  -- then be unable to act on anyway.
  if exists (
    select 1 from rota_assignments ra
    where ra.shift_instance_id = p_shift_instance_id and ra.driver_id = p_driver_id
  ) then
    raise exception 'This driver is already assigned to this shift.' using errcode = '23505';
  end if;

  -- CURRENT availability, read here at write time. Never taken from the
  -- caller: a stale client that loaded "Available" before the driver changed
  -- their answer must not silently assign an unavailable driver.
  select a.status into v_status
  from availability a
  where a.shift_instance_id = p_shift_instance_id and a.driver_id = p_driver_id;
  v_state := coalesce(v_status, 'not_submitted');

  if v_state <> 'available' and not coalesce(p_confirm_availability_override, false) then
    raise exception '%',
      case v_state
        when 'unavailable' then 'This driver marked themselves unavailable for this shift. Confirm to assign them anyway.'
        else 'This driver has not submitted availability for this shift. Confirm to assign them anyway.'
      end
      using errcode = 'VD001', detail = v_state;
  end if;

  v_context := jsonb_strip_nulls(jsonb_build_object(
    'operation', 'assign_driver',
    'availability_state', v_state,
    'availability_override', v_state <> 'available',
    'reason', v_reason
  ));

  begin
    -- Context is set immediately before, and cleared immediately after, the
    -- single audited write -- nothing else runs in between. If the INSERT
    -- fails, the surrounding subtransaction rollback reverts the setting.
    perform set_config('app.audit_context', v_context::text, true);
    insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source, assigned_by)
    values (p_shift_instance_id, p_driver_id, v_shift.resort_id, 'manual', v_caller.auth_user_id)
    returning id into v_new_id;
    perform set_config('app.audit_context', '', true);
  exception when unique_violation then
    raise exception 'This driver is already assigned to this shift.' using errcode = '23505';
  end;
  perform set_config('app.audit_context', '', true);

  return query select v_new_id, v_state;
end;
$$;

comment on function assign_driver(uuid, uuid, boolean, text) is
  'Manager-only, atomic. Manually assigns a driver to a shift instance (assignment_source = manual). Takes the resort/week lock first (serializes with Auto-Rota and publication). Validates active shift, today-or-future date (resort operational timezone), active driver, same resort, no duplicate. Reads the driver''s CURRENT availability itself: available assigns normally; unavailable/not_submitted raise VD001 (DETAIL = the state, nothing inserted) unless p_confirm_availability_override is true, in which case it assigns and records the override. Never blocks on required_drivers (a minimum, not a capacity) and never on publication (managers may edit a published current/future week; the week stays published). The optional p_reason (trimmed, empty = NULL, max 500) is stored only in audit_log.context, never on rota_assignments. Returns the new assignment id and the availability state actually used.';

revoke execute on function assign_driver(uuid, uuid, boolean, text) from public, anon;
grant execute on function assign_driver(uuid, uuid, boolean, text) to authenticated;

create or replace function unassign_driver(
  p_shift_instance_id uuid,
  p_driver_id uuid
)
returns table (assignment_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_assignment rota_assignments%rowtype;
  v_shift_date date;
  v_resort_id uuid;
  v_week_start date;
begin
  perform assert_active_manager();

  select * into v_assignment
  from rota_assignments ra
  where ra.shift_instance_id = p_shift_instance_id and ra.driver_id = p_driver_id;
  if not found then
    raise exception 'This driver is not assigned to this shift.' using errcode = 'P0002';
  end if;

  select si.date, si.resort_id, si.week_start into v_shift_date, v_resort_id, v_week_start
  from shift_instances si where si.id = p_shift_instance_id;

  -- Serialize with Auto-Rota, other manual edits and publication for this
  -- resort/week; then confirm the assignment is still there (it could have
  -- been removed by whoever held the lock).
  perform rota_week_lock(v_resort_id, v_week_start);
  if not exists (select 1 from rota_assignments ra where ra.id = v_assignment.id) then
    raise exception 'This driver is not assigned to this shift.' using errcode = 'P0002';
  end if;

  if v_shift_date < operational_today(v_resort_id) then
    raise exception 'This shift is in the past. Past assignments can''t be changed from the weekly rota.'
      using errcode = '55006', detail = 'historical_shift';
  end if;

  -- ANY attendance row blocks ordinary removal -- status is deliberately not
  -- inspected. Once attendance exists the assignment underneath it is
  -- operational history; correcting that is a separate, audited workflow.
  if exists (
    select 1 from attendance att
    where att.shift_instance_id = p_shift_instance_id and att.driver_id = p_driver_id
  ) then
    raise exception 'Attendance has already been recorded for this driver on this shift, so the assignment can''t be removed.'
      using errcode = '55006', detail = 'attendance_recorded';
  end if;

  perform set_config('app.audit_context', jsonb_build_object('operation', 'unassign_driver')::text, true);
  delete from rota_assignments ra where ra.id = v_assignment.id;
  perform set_config('app.audit_context', '', true);

  return query select v_assignment.id;
end;
$$;

comment on function unassign_driver(uuid, uuid) is
  'Manager-only, atomic. Removes exactly one driver''s assignment from one shift instance (hard DELETE; the generic audit trigger keeps the full before-row). Takes the resort/week lock first (serializes with Auto-Rota and publication). Not found -> P0002. Rejected (55006) for a shift dated before the resort''s operational today (DETAIL historical_shift) and whenever ANY attendance row exists for the driver+shift (DETAIL attendance_recorded). Works in a published current/future week without touching rota_publications. Returns the removed assignment id.';

revoke execute on function unassign_driver(uuid, uuid) from public, anon;
grant execute on function unassign_driver(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. apply_auto_rota
-- ---------------------------------------------------------------------
-- Internal: the open positions of every ACTIVE shift of one resort/week dated
-- today or later. open_slots = max(required_drivers - active assignments, 0),
-- counting only ACTIVE drivers' assignments (inactive assignees stay stored
-- but never count toward coverage); a manual assignment counts regardless of
-- the availability it was made under. Used before and after the insert.
create or replace function _auto_rota_open_slots(p_resort_id uuid, p_week_start date, p_today date)
returns table (shift_instance_id uuid, open_slots integer, shift_date date, sort_order integer, start_time time, shift_name text)
language sql
stable
as $$
  select
    si.id,
    greatest(si.required_drivers - (
      select count(*)::integer
      from rota_assignments ra
      join drivers d on d.id = ra.driver_id and d.is_active
      where ra.shift_instance_id = si.id
    ), 0),
    si.date, si.sort_order, si.start_time, si.name
  from shift_instances si
  where si.resort_id = p_resort_id
    and si.week_start = p_week_start
    and si.status = 'active'
    and si.date >= p_today;
$$;

revoke execute on function _auto_rota_open_slots(uuid, date, date) from public, anon, authenticated;

create or replace function apply_auto_rota(
  p_resort_id uuid,
  p_week_start date,
  p_plan jsonb
)
returns table (
  resort_id uuid,
  week_start date,
  assigned_count integer,
  remaining_open_slots integer,
  uncovered_shift_ids uuid[],
  skipped_past_shift_count integer,
  run_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_caller app_user_context;
  v_today date;
  v_elem jsonb;
  v_shift uuid;
  v_driver uuid;
  v_shift_ids uuid[] := '{}';
  v_driver_ids uuid[] := '{}';
  v_n integer;
  v_distinct integer;
  v_locked integer;
  v_open_before integer;
  v_created integer := 0;
  v_run_id uuid := gen_random_uuid();
  v_context jsonb;
  v_remaining integer;
  v_uncovered uuid[];
  v_skipped integer;
begin
  perform assert_active_manager();
  v_caller := current_app_user();

  -- ---- request shape (cheap, no lock held yet) -----------------------
  if p_resort_id is null or p_week_start is null or p_plan is null then
    raise exception 'Auto-Rota needs a resort, a week and a plan.' using errcode = '22023';
  end if;
  if app_weekday(p_week_start) <> 0 then
    raise exception 'The week must start on a Monday.' using errcode = '22023';
  end if;
  if not exists (select 1 from resorts r where r.id = p_resort_id) then
    raise exception 'Resort not found.' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_plan) <> 'array' then
    raise exception 'The Auto-Rota plan must be a list of assignments.' using errcode = '22023', detail = 'plan_malformed';
  end if;
  if jsonb_array_length(p_plan) > 1000 then
    raise exception 'The Auto-Rota plan is too large.' using errcode = '22023', detail = 'plan_malformed';
  end if;

  for v_elem in select e.value from jsonb_array_elements(p_plan) as e(value) loop
    if jsonb_typeof(v_elem) is distinct from 'object' then
      raise exception 'Each planned assignment must be exactly a shift_instance_id and a driver_id.'
        using errcode = '22023', detail = 'plan_malformed';
    end if;
    -- (Separate statement: jsonb_object_keys is only safe on an object.)
    if exists (select 1 from jsonb_object_keys(v_elem) k where k not in ('shift_instance_id', 'driver_id'))
       or jsonb_typeof(v_elem -> 'shift_instance_id') is distinct from 'string'
       or jsonb_typeof(v_elem -> 'driver_id') is distinct from 'string' then
      raise exception 'Each planned assignment must be exactly a shift_instance_id and a driver_id.'
        using errcode = '22023', detail = 'plan_malformed';
    end if;
    begin
      v_shift := (v_elem ->> 'shift_instance_id')::uuid;
      v_driver := (v_elem ->> 'driver_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Each planned assignment must use valid ids.' using errcode = '22023', detail = 'plan_malformed';
    end;
    v_shift_ids := v_shift_ids || v_shift;
    v_driver_ids := v_driver_ids || v_driver;
  end loop;

  v_n := coalesce(array_length(v_shift_ids, 1), 0);
  select count(distinct (p.s, p.d)) into v_distinct from unnest(v_shift_ids, v_driver_ids) as p(s, d);
  if v_distinct <> v_n then
    raise exception 'The Auto-Rota plan assigns the same driver to the same shift more than once.'
      using errcode = '22023', detail = 'plan_malformed';
  end if;

  -- ---- serialize with every other writer of this resort/week ----------
  perform rota_week_lock(p_resort_id, p_week_start);

  if exists (
    select 1 from rota_publications rp
    where rp.resort_id = p_resort_id and rp.week_start = p_week_start
      and rp.published_at is not null and rp.unpublished_at is null
  ) then
    raise exception 'This rota is published. Auto-Rota only fills unpublished weeks.'
      using errcode = '55006', detail = 'published_week';
  end if;

  v_today := operational_today(p_resort_id);
  if p_week_start + 6 < v_today then
    raise exception 'This week is in the past. Auto-Rota can''t generate it.'
      using errcode = '55006', detail = 'historical_week';
  end if;

  -- ---- validate the WHOLE plan against fresh, locked state ------------
  if v_n > 0 then
    -- Identity: shifts and drivers never change resort or week, so a pair that
    -- does not belong to this request is a bad request, not a race.
    if exists (
      select 1 from unnest(v_shift_ids) as p(id)
      where not exists (
        select 1 from shift_instances si
        where si.id = p.id and si.resort_id = p_resort_id and si.week_start = p_week_start
      )
    ) then
      raise exception 'The plan includes a shift that is not part of this resort and week.'
        using errcode = '22023', detail = 'plan_shift_not_in_week';
    end if;
    if exists (
      select 1 from unnest(v_driver_ids) as p(id)
      where not exists (select 1 from drivers d where d.id = p.id and d.resort_id = p_resort_id)
    ) then
      raise exception 'The plan includes a driver who does not belong to this resort.'
        using errcode = '22023', detail = 'plan_driver_not_in_resort';
    end if;

    -- Row locks (shared, in a fixed order): a concurrent shift cancellation or
    -- revision, driver deactivation, or driver availability change must wait
    -- for this transaction instead of slipping between validation and insert.
    perform 1 from shift_instances si where si.id = any (v_shift_ids) order by si.id for share;
    perform 1 from drivers d where d.id = any (v_driver_ids) order by d.id for share;

    if exists (select 1 from shift_instances si where si.id = any (v_shift_ids) and si.date < v_today) then
      raise exception 'The plan includes a shift in the past.' using errcode = '55006', detail = 'historical_shift';
    end if;

    -- Stale: structurally fine, but current state no longer allows it.
    if exists (select 1 from shift_instances si where si.id = any (v_shift_ids) and si.status <> 'active')
       or exists (select 1 from drivers d where d.id = any (v_driver_ids) and not d.is_active) then
      raise exception 'The rota changed while it was being generated, so nothing was added. Please try again.'
        using errcode = 'VD002', detail = 'stale_plan';
    end if;

    -- Every pair needs an EXISTING, explicit 'available' row for that exact
    -- shift. Locking it (FOR SHARE) blocks a driver's Available -> Unavailable
    -- update until this transaction ends; a row that was just changed is
    -- skipped by the re-check, so the count falls short -> stale.
    select count(*) into v_locked from (
      select a.id
      from availability a
      join unnest(v_shift_ids, v_driver_ids) as p(s, d) on a.shift_instance_id = p.s and a.driver_id = p.d
      where a.status = 'available'
      order by a.id
      for share of a
    ) locked_rows;
    if v_locked <> v_n then
      raise exception 'The rota changed while it was being generated, so nothing was added. Please try again.'
        using errcode = 'VD002', detail = 'stale_plan';
    end if;

    -- Already assigned (any status of driver): the plan is out of date.
    if exists (
      select 1 from rota_assignments ra
      join unnest(v_shift_ids, v_driver_ids) as p(s, d) on ra.shift_instance_id = p.s and ra.driver_id = p.d
    ) then
      raise exception 'The rota changed while it was being generated, so nothing was added. Please try again.'
        using errcode = 'VD002', detail = 'stale_plan';
    end if;

    -- Never over-assign: per shift, the planned rows must fit the CURRENT open
    -- coverage (required_drivers minus ACTIVE assignments, re-read here).
    if exists (
      select 1
      from (select p.id as shift_id, count(*)::integer as planned from unnest(v_shift_ids) as p(id) group by p.id) pl
      join _auto_rota_open_slots(p_resort_id, p_week_start, v_today) o on o.shift_instance_id = pl.shift_id
      where pl.planned > o.open_slots
    ) then
      raise exception 'The rota changed while it was being generated, so nothing was added. Please try again.'
        using errcode = 'VD002', detail = 'stale_plan';
    end if;
  end if;

  -- ---- apply: all rows or none ---------------------------------------
  select coalesce(sum(o.open_slots), 0)::integer into v_open_before
  from _auto_rota_open_slots(p_resort_id, p_week_start, v_today) o;

  if v_n > 0 then
    v_context := jsonb_build_object(
      'operation', 'auto_rota',
      'run_id', v_run_id,
      'resort_id', p_resort_id,
      'week_start', p_week_start,
      'availability_state', 'available',
      'availability_override', false,
      'created_count', v_n,
      'uncovered_after', greatest(v_open_before - v_n, 0)
    );
    begin
      -- Set immediately before, cleared immediately after, the one bulk insert
      -- (the same discipline as assign_driver). A failure rolls the whole
      -- subtransaction -- and the setting -- back.
      perform set_config('app.audit_context', v_context::text, true);
      insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source, assigned_by)
      select p.s, p.d, p_resort_id, 'auto', v_caller.auth_user_id
      from unnest(v_shift_ids, v_driver_ids) with ordinality as p(s, d, ord)
      order by p.ord;
      get diagnostics v_created = row_count;
      perform set_config('app.audit_context', '', true);
    exception when unique_violation then
      raise exception 'The rota changed while it was being generated, so nothing was added. Please try again.'
        using errcode = 'VD002', detail = 'stale_plan';
    end;
    perform set_config('app.audit_context', '', true);
  end if;

  -- ---- the authoritative result, computed from the database -----------
  select coalesce(sum(o.open_slots), 0)::integer,
         coalesce(array_agg(o.shift_instance_id order by o.shift_date, o.sort_order, o.start_time, o.shift_name, o.shift_instance_id)
                  filter (where o.open_slots > 0), '{}')
    into v_remaining, v_uncovered
  from _auto_rota_open_slots(p_resort_id, p_week_start, v_today) o;

  select count(*)::integer into v_skipped
  from shift_instances si
  where si.resort_id = p_resort_id and si.week_start = p_week_start and si.status = 'active' and si.date < v_today;

  return query select p_resort_id, p_week_start, v_created, v_remaining, v_uncovered, v_skipped, v_run_id;
end;
$$;

comment on function apply_auto_rota(uuid, date, jsonb) is
  'Manager-only, atomic, all-or-nothing. Applies a PROPOSED Auto-Rota plan ([{"shift_instance_id","driver_id"},...], untrusted) to one resort + Monday week: takes the resort/week lock; rejects a published week (55006 published_week) and a wholly past week (55006 historical_week); validates EVERY pair against fresh locked state (shift in this resort+week, active, dated today or later; driver exists, active, same resort; an explicit available row for that exact shift; not already assigned; no duplicates; fits the shift''s CURRENT open coverage = required_drivers minus ACTIVE assignments) and then inserts every row with assignment_source = auto and assigned_by = the manager, or none. Structurally invalid requests -> 22023; a plan the current state no longer permits -> VD002 stale_plan. Partial coverage and an empty plan are success. Audit context per row: operation auto_rota, run_id, resort_id, week_start, availability_state available, availability_override false, created_count, uncovered_after. Returns the server-computed summary: assigned_count, remaining_open_slots and uncovered_shift_ids (today/future active shifts only), skipped_past_shift_count, run_id. The database does not choose WHO is assigned -- the planner does; this function only decides whether each proposed assignment is safe.';

revoke execute on function apply_auto_rota(uuid, date, jsonb) from public, anon;
grant execute on function apply_auto_rota(uuid, date, jsonb) to authenticated;
