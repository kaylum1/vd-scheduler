-- Attendance AT-A2: Driver Check-in (check_in_to_shift, the internal deterministic
-- _check_in / _check_in_window, driver_check_ins, the unassign_driver check-in guard,
-- and the driver-safe view extension).
--
-- Check-in is EVIDENCE; final attendance (88_record_attendance.sql) is the manager's
-- payroll truth. Real blocking between two connections cannot be shown inside this single
-- rolled-back transaction: the week lock is proven STRUCTURALLY here, and the interleavings
-- (check-in vs unassign in both orders, vs record_attendance in both orders, check-in vs
-- check-in, Publish then check-in, clear_attendance) were verified separately with two
-- live psql sessions (see the AT-A2 report).
--
-- Exact window boundaries and DST use _check_in with an INJECTED instant (the public RPC has
-- no time argument). The public RPC itself is exercised with shifts whose window certainly
-- contains "now" (today 00:00-23:59:59), a past shift (closed) and a tomorrow shift (too early).

select pg_temp.as_postgres();

-- ---------------------------------------------------------------------
-- Local helpers
-- ---------------------------------------------------------------------
create function pg_temp.expect_error_detail(p_name text, p_sql text, p_sqlstate text, p_detail text default null)
returns void language plpgsql as $$
declare
  v_detail text;
begin
  begin
    execute p_sql;
    perform pg_temp.record_result(p_name, false, 'expected error ' || p_sqlstate || ' but none was raised');
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    v_detail := nullif(v_detail, '');
    if sqlstate = p_sqlstate
       and v_detail is not distinct from p_detail
       and sqlerrm !~* '(violates|constraint|_fkey|_unique|rota_assignments|driver_check_ins|check_in_to_shift\(|_check_in\()' then
      perform pg_temp.record_result(p_name, true, null);
    else
      perform pg_temp.record_result(p_name, false,
        format('expected sqlstate %s / detail %s / friendly message; got %s / detail %s / "%s"', p_sqlstate, p_detail, sqlstate, v_detail, sqlerrm));
    end if;
  end;
end;
$$;

create function pg_temp.k(p_name text) returns text language sql as $$ select current_setting('dbtest.ci_' || p_name) $$;
create function pg_temp.kid(p_name text) returns uuid language sql as $$ select current_setting('dbtest.ci_' || p_name)::uuid $$;
create function pg_temp.ts(p_text text) returns timestamptz language sql as $$ select p_text::timestamptz $$;
create function pg_temp.ci_monday(p_d date) returns date language sql as $$ select p_d - app_weekday(p_d)::integer $$;

create function pg_temp.ci_instance(p_resort uuid, p_date date, p_start time, p_end time, p_status text default 'active')
returns uuid language plpgsql security definer as $$
declare
  v_type uuid;
  v_id uuid;
begin
  insert into shift_types (resort_id, key, name, sort_order)
  values (p_resort, 'ci-' || substr(gen_random_uuid()::text, 1, 8), 'CI Shift', 1) returning id into v_type;
  insert into shift_instances (resort_id, date, shift_type_id, shift_key, name, sort_order, start_time, end_time,
                               required_drivers, status, origin, cancelled_at, cancelled_reason)
  values (p_resort, p_date, v_type, 'ci-test', 'CI Shift', 1, p_start, p_end, 1, p_status, 'adhoc',
          case when p_status = 'cancelled' then now() end, case when p_status = 'cancelled' then 'ci test' end)
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.ci_driver(p_resort uuid, p_name text, p_active boolean default true)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into drivers (resort_id, full_name, is_active) values (p_resort, p_name, p_active) returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.ci_assign(p_instance uuid, p_driver uuid)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source)
  values (p_instance, p_driver, (select resort_id from shift_instances where id = p_instance), 'manual')
  returning id into v_id;
  return v_id;
end;
$$;

-- A fresh driver + assignment on a shift; the ids are stored as dbtest.ci_<name> / dbtest.ci_<name>_d.
create function pg_temp.ci_mk(p_name text, p_instance uuid)
returns void language plpgsql security definer as $$
declare
  v_driver uuid;
begin
  v_driver := pg_temp.ci_driver((select resort_id from shift_instances where id = p_instance), 'CI ' || p_name);
  perform set_config('dbtest.ci_' || p_name || '_d', v_driver::text, false);
  perform set_config('dbtest.ci_' || p_name, pg_temp.ci_assign(p_instance, v_driver)::text, false);
end;
$$;

create function pg_temp.ci_publish(p_resort uuid, p_date date)
returns void language plpgsql security definer as $$
begin
  insert into rota_publications (resort_id, week_start, generation_source, published_at)
  values (p_resort, pg_temp.ci_monday(p_date), 'manual', now() - interval '1 hour')
  on conflict (resort_id, week_start) do nothing;
end;
$$;

-- Internal core as the database owner, with an injected instant.
create function pg_temp.chk(p_assignment uuid, p_driver uuid, p_at timestamptz) returns jsonb language sql as $$
  select to_jsonb(r) from _check_in(p_assignment, p_driver, p_at) r
$$;
create function pg_temp.chk_sql(p_assignment uuid, p_driver uuid, p_at timestamptz) returns text language sql as $$
  select format('select pg_temp.chk(%L::uuid, %L::uuid, %L::timestamptz)', p_assignment, p_driver, p_at)
$$;
-- Public RPC (session identity).
create function pg_temp.pub(p_assignment uuid) returns jsonb language sql as $$
  select to_jsonb(r) from check_in_to_shift(p_assignment) r
$$;
create function pg_temp.pub_sql(p_assignment uuid) returns text language sql as $$
  select format('select pg_temp.pub(%L::uuid)', p_assignment)
$$;

-- Owner-side readers.
create function pg_temp.ci_row(p_assignment uuid) returns jsonb language sql security definer as $$
  select to_jsonb(ci) from driver_check_ins ci where ci.assignment_id = p_assignment
$$;
create function pg_temp.ci_count(p_assignment uuid) returns integer language sql security definer as $$
  select count(*)::integer from driver_check_ins ci where ci.assignment_id = p_assignment
$$;
create function pg_temp.ci_audit_count(p_assignment uuid) returns integer language sql security definer as $$
  select count(*)::integer from audit_log a
  where a.table_name = 'driver_check_ins' and a.row_id in (select id from driver_check_ins where assignment_id = p_assignment)
$$;
create function pg_temp.ci_audit(p_assignment uuid) returns audit_log language sql security definer as $$
  select a from audit_log a
  where a.table_name = 'driver_check_ins' and a.action = 'insert' and a.row_id in (select id from driver_check_ins where assignment_id = p_assignment)
  limit 1
$$;
create function pg_temp.ci_window(p_instance uuid) returns jsonb language sql security definer as $$
  select to_jsonb(w) from _check_in_window(p_instance) w
$$;
create function pg_temp.att_count() returns integer language sql security definer as $$ select count(*)::integer from attendance $$;

create function pg_temp.ci_lock_held(p_resort uuid, p_week date)
returns boolean language sql security definer as $$
  select exists (
    select 1
    from pg_locks l, rota_week_lock_keys(p_resort, p_week) k
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 2
      and l.classid::bigint = (k.key1::bigint & 4294967295)
      and l.objid::bigint = (k.key2::bigint & 4294967295)
  )
$$;

-- ---------------------------------------------------------------------
-- Fixtures (as database owner)
-- ---------------------------------------------------------------------
do $$
declare
  v_a uuid := current_setting('dbtest.resort_a')::uuid;
  v_today date := operational_today(v_a);
  v_t uuid;
  v_d2 uuid; v_d2u uuid := gen_random_uuid();
  v_di uuid; v_diu uuid := gen_random_uuid();
  d1 uuid := current_setting('dbtest.driver_a_id')::uuid;
  s uuid;
begin
  -- A second ACTIVE driver with a login (resort A) and an INACTIVE driver with a login.
  v_d2 := pg_temp.ci_driver(v_a, 'CI Other Driver');
  insert into auth.users (id, aud, role, email) values (v_d2u, 'authenticated', 'authenticated', 'dbtest-ci-d2@test.local');
  insert into app_users (id, role, driver_id, resort_id, is_active) values (v_d2u, 'driver', v_d2, null, true);
  perform set_config('dbtest.ci_d2', v_d2::text, false);
  perform set_config('dbtest.ci_d2_user', v_d2u::text, false);
  v_di := pg_temp.ci_driver(v_a, 'CI Inactive Driver');
  insert into auth.users (id, aud, role, email) values (v_diu, 'authenticated', 'authenticated', 'dbtest-ci-di@test.local');
  insert into app_users (id, role, driver_id, resort_id, is_active) values (v_diu, 'driver', v_di, null, true);
  perform set_config('dbtest.ci_di_user', v_diu::text, false);
  perform set_config('dbtest.ci_d1', d1::text, false);

  -- ---- S1: the exact-boundary shift, 2027-06-14 (Mon, CEST = UTC+2), 18:00-21:00, week published ----
  --   start 16:00:00Z   opens 15:30:00Z   closes 19:00:00Z
  s := pg_temp.ci_instance(v_a, date '2027-06-14', time '18:00', time '21:00');
  perform pg_temp.ci_publish(v_a, date '2027-06-14');
  perform set_config('dbtest.ci_s1', s::text, false);
  perform pg_temp.ci_mk('open', s);      perform pg_temp.ci_mk('start', s);
  perform pg_temp.ci_mk('late', s);      perform pg_temp.ci_mk('close', s);
  perform pg_temp.ci_mk('early', s);     perform pg_temp.ci_mk('closed', s);
  perform pg_temp.ci_mk('idem', s);      perform pg_temp.ci_mk('idem_att', s);
  perform pg_temp.ci_mk('att_first', s); perform pg_temp.ci_mk('att_early', s);
  perform pg_temp.ci_mk('nocreate', s);
  perform set_config('dbtest.ci_s1_owner', pg_temp.ci_assign(s, d1)::text, false);          -- driver_a's own assignment
  perform set_config('dbtest.ci_s1_other', pg_temp.ci_assign(s, v_d2)::text, false);        -- the other driver's assignment

  -- ---- Lunch AND Dinner on one date for driver_a: independent check-ins ----
  perform set_config('dbtest.ci_lunch', pg_temp.ci_assign(pg_temp.ci_instance(v_a, date '2027-06-15', time '12:00', time '14:00'), d1)::text, false);
  perform set_config('dbtest.ci_dinner', pg_temp.ci_assign(pg_temp.ci_instance(v_a, date '2027-06-15', time '18:00', time '21:00'), d1)::text, false);

  -- ---- cancelled shift in the published week; draft week; both in-window instants are injected ----
  perform set_config('dbtest.ci_cxl', pg_temp.ci_assign(pg_temp.ci_instance(v_a, date '2027-06-16', time '18:00', time '21:00', 'cancelled'), d1)::text, false);
  perform set_config('dbtest.ci_draft', pg_temp.ci_assign(pg_temp.ci_instance(v_a, date '2027-06-23', time '18:00', time '21:00'), d1)::text, false);

  -- ---- DST: spring-forward day 2027-03-28 (Sun; CET -> CEST) and fall-back day 2027-10-31 (Sun; CEST -> CET) ----
  s := pg_temp.ci_instance(v_a, date '2027-03-28', time '18:00', time '21:00');
  perform pg_temp.ci_publish(v_a, date '2027-03-28');
  perform set_config('dbtest.ci_s_spring', s::text, false);
  perform pg_temp.ci_mk('spring_open', s); perform pg_temp.ci_mk('spring_early', s); perform pg_temp.ci_mk('spring_close', s); perform pg_temp.ci_mk('spring_closed', s);
  perform set_config('dbtest.ci_spring_owner', pg_temp.ci_assign(s, d1)::text, false);
  s := pg_temp.ci_instance(v_a, date '2027-10-31', time '18:00', time '21:00');
  perform pg_temp.ci_publish(v_a, date '2027-10-31');
  perform set_config('dbtest.ci_s_fall', s::text, false);
  perform pg_temp.ci_mk('fall_open', s); perform pg_temp.ci_mk('fall_early', s); perform pg_temp.ci_mk('fall_close', s); perform pg_temp.ci_mk('fall_closed', s);
  perform set_config('dbtest.ci_fall_owner', pg_temp.ci_assign(s, d1)::text, false);
  -- the ordinary days on either side, to prove the offset really differs
  perform set_config('dbtest.ci_s_mar27', pg_temp.ci_instance(v_a, date '2027-03-27', time '18:00', time '21:00')::text, false);
  perform set_config('dbtest.ci_s_oct30', pg_temp.ci_instance(v_a, date '2027-10-30', time '18:00', time '21:00')::text, false);

  -- ---- a resort in a DIFFERENT timezone (Asia/Tokyo, UTC+9): the window follows resorts.timezone ----
  insert into resorts (slug, name, timezone) values ('dbtest-ci-tokyo', 'CI Tokyo', 'Asia/Tokyo') returning id into v_t;
  s := pg_temp.ci_instance(v_t, date '2027-06-14', time '18:00', time '21:00');
  perform pg_temp.ci_publish(v_t, date '2027-06-14');
  perform set_config('dbtest.ci_s_tokyo', s::text, false);
  perform pg_temp.ci_mk('tokyo_open', s); perform pg_temp.ci_mk('tokyo_early', s);

  -- ---- today / past / tomorrow shifts for the PUBLIC RPC ----
  s := pg_temp.ci_instance(v_a, v_today, time '00:00', time '23:59:59');         -- window certainly contains "now"
  perform pg_temp.ci_publish(v_a, v_today);
  perform set_config('dbtest.ci_pub_shift', s::text, false);
  perform set_config('dbtest.ci_pub', pg_temp.ci_assign(s, d1)::text, false);
  perform set_config('dbtest.ci_pub_other', pg_temp.ci_assign(s, v_d2)::text, false);
  perform set_config('dbtest.ci_pub_inactive', pg_temp.ci_assign(s, v_di)::text, false);
  update drivers set is_active = false where id = v_di;
  perform set_config('dbtest.ci_yesterday', pg_temp.ci_assign(pg_temp.ci_instance(v_a, v_today - 1, time '18:00', time '21:00'), d1)::text, false);
  perform pg_temp.ci_publish(v_a, v_today - 1);
  perform set_config('dbtest.ci_tomorrow', pg_temp.ci_assign(pg_temp.ci_instance(v_a, v_today + 1, time '18:00', time '21:00'), d1)::text, false);
  perform pg_temp.ci_publish(v_a, v_today + 1);

  -- ---- today 18:00-21:00 (unassign guard) ----
  s := pg_temp.ci_instance(v_a, v_today, time '18:00', time '21:00');
  perform set_config('dbtest.ci_today_shift', s::text, false);
  perform pg_temp.ci_mk('today_unassign', s);
  perform pg_temp.ci_mk('today_both', s);
  perform pg_temp.ci_mk('today_plain', s);

  -- ---- a PAST published shift for the check-in -> attendance flow (record_attendance allows it) ----
  s := pg_temp.ci_instance(v_a, v_today - 14, time '18:00', time '21:00');
  perform pg_temp.ci_publish(v_a, v_today - 14);
  perform set_config('dbtest.ci_flow_shift', s::text, false);
  perform pg_temp.ci_mk('flow', s);

  -- ---- a week NOTHING else locks: the check-in lock proof (publication row inserted with the lock trigger OFF) ----
  s := pg_temp.ci_instance(v_a, date '2027-07-05', time '18:00', time '21:00');
  alter table rota_publications disable trigger rota_publications_week_lock;
  insert into rota_publications (resort_id, week_start, generation_source, published_at)
  values (v_a, date '2027-07-05', 'manual', now() - interval '1 hour');
  alter table rota_publications enable trigger rota_publications_week_lock;
  perform pg_temp.ci_mk('lockproof', s);
end $$;

select pg_temp.expect_true('lock setup: the lock-proof week is not locked before any call',
  not pg_temp.ci_lock_held(current_setting('dbtest.resort_a')::uuid, date '2027-07-05'));

-- ---------------------------------------------------------------------
-- 1. Surface: grants, signature, table security
-- ---------------------------------------------------------------------
select pg_temp.expect_true('surface: the public RPC takes NO timestamp and NO driver id -- its only INPUT argument is the assignment',
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p where p.proname = 'check_in_to_shift') = 'p_assignment_id uuid'
  and (select p.pronargs from pg_proc p where p.proname = 'check_in_to_shift') = 1);
select pg_temp.expect_true('surface: check_in_to_shift is SECURITY DEFINER with a pinned search_path, executable by authenticated only (not anon)',
  (select p.prosecdef and p.proconfig::text like '%search_path%' from pg_proc p where p.proname = 'check_in_to_shift')
  and has_function_privilege('authenticated', 'check_in_to_shift(uuid)', 'execute')
  and not has_function_privilege('anon', 'check_in_to_shift(uuid)', 'execute'));
select pg_temp.expect_true('surface: the internal helpers are NOT executable by clients (authenticated or anon)',
  not has_function_privilege('authenticated', '_check_in(uuid,uuid,timestamptz)', 'execute')
  and not has_function_privilege('anon', '_check_in(uuid,uuid,timestamptz)', 'execute')
  and not has_function_privilege('authenticated', '_check_in_window(uuid)', 'execute')
  and not has_function_privilege('anon', '_check_in_window(uuid)', 'execute'));
select pg_temp.expect_true('surface: the table has exactly id, assignment_id, checked_in_at -- no location, status, late flag, check-out or timestamps',
  (select array_agg(column_name::text order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'driver_check_ins')
    = array['assignment_id', 'checked_in_at', 'id']);
select pg_temp.expect_true('surface: RLS is enabled and forced; authenticated has SELECT only; there is only a manager SELECT policy',
  (select relrowsecurity and relforcerowsecurity from pg_class where relname = 'driver_check_ins')
  and has_table_privilege('authenticated', 'public.driver_check_ins', 'select')
  and not has_table_privilege('authenticated', 'public.driver_check_ins', 'insert')
  and not has_table_privilege('authenticated', 'public.driver_check_ins', 'update')
  and not has_table_privilege('authenticated', 'public.driver_check_ins', 'delete')
  and not has_table_privilege('anon', 'public.driver_check_ins', 'select')
  and (select count(*) from pg_policies where tablename = 'driver_check_ins') = 1
  and exists (select 1 from pg_policies where tablename = 'driver_check_ins' and policyname = 'driver_check_ins_manager_select' and cmd = 'SELECT'));

-- ---------------------------------------------------------------------
-- 2. Window instants (resort timezone, DST)
-- ---------------------------------------------------------------------
select pg_temp.expect_equal('window: Zurich summer shift 18:00-21:00 opens 15:30Z and closes 19:00Z',
  pg_temp.ci_window(pg_temp.kid('s1')), jsonb_build_object('opens_at', '2027-06-14T15:30:00+00:00', 'closes_at', '2027-06-14T19:00:00+00:00'));
select pg_temp.expect_equal('window: the SPRING-FORWARD day (CEST, UTC+2) -- opens 15:30Z, closes 19:00Z',
  pg_temp.ci_window(pg_temp.kid('s_spring')), jsonb_build_object('opens_at', '2027-03-28T15:30:00+00:00', 'closes_at', '2027-03-28T19:00:00+00:00'));
select pg_temp.expect_equal('window: the day BEFORE spring-forward is still CET (UTC+1) -- opens 16:30Z, closes 20:00Z (the offset really moves)',
  pg_temp.ci_window(pg_temp.kid('s_mar27')), jsonb_build_object('opens_at', '2027-03-27T16:30:00+00:00', 'closes_at', '2027-03-27T20:00:00+00:00'));
select pg_temp.expect_equal('window: the FALL-BACK day (CET, UTC+1) -- opens 16:30Z, closes 20:00Z',
  pg_temp.ci_window(pg_temp.kid('s_fall')), jsonb_build_object('opens_at', '2027-10-31T16:30:00+00:00', 'closes_at', '2027-10-31T20:00:00+00:00'));
select pg_temp.expect_equal('window: the day BEFORE fall-back is still CEST (UTC+2) -- opens 15:30Z, closes 19:00Z',
  pg_temp.ci_window(pg_temp.kid('s_oct30')), jsonb_build_object('opens_at', '2027-10-30T15:30:00+00:00', 'closes_at', '2027-10-30T19:00:00+00:00'));
select pg_temp.expect_equal('window: a resort in Asia/Tokyo (UTC+9) uses ITS timezone, not Zurich -- opens 08:30Z, closes 12:00Z',
  pg_temp.ci_window(pg_temp.kid('s_tokyo')), jsonb_build_object('opens_at', '2027-06-14T08:30:00+00:00', 'closes_at', '2027-06-14T12:00:00+00:00'));

-- ---------------------------------------------------------------------
-- 3. Exact boundaries (injected instants, S1: opens 15:30:00Z .. closes 19:00:00Z, both inclusive)
-- ---------------------------------------------------------------------
select pg_temp.expect_error_detail('boundary: ONE MICROSECOND before opening is blocked (check_in_too_early)',
  pg_temp.chk_sql(pg_temp.kid('early'), pg_temp.kid('early_d'), pg_temp.ts('2027-06-14 15:29:59.999999+00')), '55006', 'check_in_too_early');
select set_config('dbtest.ci_r_open', pg_temp.chk(pg_temp.kid('open'), pg_temp.kid('open_d'), pg_temp.ts('2027-06-14 15:30:00+00'))::text, false);
select pg_temp.expect_true('boundary: the EXACT opening instant (17:30 local) is accepted, stored as that instant, created = true',
  (pg_temp.k('r_open')::jsonb ->> 'created')::boolean
  and (pg_temp.ci_row(pg_temp.kid('open')) ->> 'checked_in_at')::timestamptz = pg_temp.ts('2027-06-14 15:30:00+00')
  and (pg_temp.k('r_open')::jsonb ->> 'checked_in_at')::timestamptz = pg_temp.ts('2027-06-14 15:30:00+00'));
select pg_temp.expect_true('window: the scheduled start (16:00:00Z) is accepted',
  (pg_temp.chk(pg_temp.kid('start'), pg_temp.kid('start_d'), pg_temp.ts('2027-06-14 16:00:00+00')) ->> 'created')::boolean);
select pg_temp.expect_true('window: a LATE check-in during the shift (18:45Z, 45 minutes after start) is accepted, and nothing "late" is stored',
  (pg_temp.chk(pg_temp.kid('late'), pg_temp.kid('late_d'), pg_temp.ts('2027-06-14 18:45:00+00')) ->> 'created')::boolean
  and (select array_agg(column_name::text) from information_schema.columns where table_name = 'driver_check_ins' and column_name ~* 'late|minutes') is null);
select pg_temp.expect_true('boundary: the EXACT closing instant (21:00 local, 19:00:00Z) is accepted (inclusive)',
  (pg_temp.chk(pg_temp.kid('close'), pg_temp.kid('close_d'), pg_temp.ts('2027-06-14 19:00:00+00')) ->> 'created')::boolean);
select pg_temp.expect_error_detail('boundary: ONE MICROSECOND after closing is blocked (check_in_closed)',
  pg_temp.chk_sql(pg_temp.kid('closed'), pg_temp.kid('closed_d'), pg_temp.ts('2027-06-14 19:00:00.000001+00')), '55006', 'check_in_closed');
select pg_temp.expect_equal('boundary: neither blocked attempt wrote a row', pg_temp.ci_count(pg_temp.kid('early')) + pg_temp.ci_count(pg_temp.kid('closed')), 0);

-- DST days: the SAME wall-clock boundaries, different UTC instants.
select pg_temp.expect_error_detail('dst spring: 1 microsecond before 17:30 local on the spring-forward day (15:30Z) is too early',
  pg_temp.chk_sql(pg_temp.kid('spring_early'), pg_temp.kid('spring_early_d'), pg_temp.ts('2027-03-28 15:29:59.999999+00')), '55006', 'check_in_too_early');
select pg_temp.expect_true('dst spring: exactly 15:30Z (17:30 CEST) is accepted',
  (pg_temp.chk(pg_temp.kid('spring_open'), pg_temp.kid('spring_open_d'), pg_temp.ts('2027-03-28 15:30:00+00')) ->> 'created')::boolean);
select pg_temp.expect_true('dst spring: exactly 19:00Z (21:00 CEST) is accepted, 1 microsecond later is closed',
  (pg_temp.chk(pg_temp.kid('spring_close'), pg_temp.kid('spring_close_d'), pg_temp.ts('2027-03-28 19:00:00+00')) ->> 'created')::boolean);
select pg_temp.expect_error_detail('dst spring: 19:00:00.000001Z is closed',
  pg_temp.chk_sql(pg_temp.kid('spring_closed'), pg_temp.kid('spring_closed_d'), pg_temp.ts('2027-03-28 19:00:00.000001+00')), '55006', 'check_in_closed');
select pg_temp.expect_error_detail('dst fall: 1 microsecond before 17:30 local on the fall-back day (16:30Z) is too early',
  pg_temp.chk_sql(pg_temp.kid('fall_early'), pg_temp.kid('fall_early_d'), pg_temp.ts('2027-10-31 16:29:59.999999+00')), '55006', 'check_in_too_early');
select pg_temp.expect_true('dst fall: exactly 16:30Z (17:30 CET) is accepted',
  (pg_temp.chk(pg_temp.kid('fall_open'), pg_temp.kid('fall_open_d'), pg_temp.ts('2027-10-31 16:30:00+00')) ->> 'created')::boolean);
select pg_temp.expect_true('dst fall: exactly 20:00Z (21:00 CET) is accepted, 1 microsecond later is closed',
  (pg_temp.chk(pg_temp.kid('fall_close'), pg_temp.kid('fall_close_d'), pg_temp.ts('2027-10-31 20:00:00+00')) ->> 'created')::boolean);
select pg_temp.expect_error_detail('dst fall: 20:00:00.000001Z is closed',
  pg_temp.chk_sql(pg_temp.kid('fall_closed'), pg_temp.kid('fall_closed_d'), pg_temp.ts('2027-10-31 20:00:00.000001+00')), '55006', 'check_in_closed');
select pg_temp.expect_true('timezone: in Tokyo 08:30Z (17:30 JST) is accepted; the Zurich-equivalent 15:30Z is already closed there',
  (pg_temp.chk(pg_temp.kid('tokyo_open'), pg_temp.kid('tokyo_open_d'), pg_temp.ts('2027-06-14 08:30:00+00')) ->> 'created')::boolean);
select pg_temp.expect_error_detail('timezone: ...15:30Z is NOT inside the Tokyo window (it closed at 12:00Z)',
  pg_temp.chk_sql(pg_temp.kid('tokyo_early'), pg_temp.kid('tokyo_early_d'), pg_temp.ts('2027-06-14 15:30:00+00')), '55006', 'check_in_closed');

-- ---------------------------------------------------------------------
-- 4. Gates: cancelled, draft, ownership, shape (internal core, in-window instant)
-- ---------------------------------------------------------------------
select pg_temp.expect_error_detail('gate: a CANCELLED shift instance -> 55006 shift_cancelled',
  pg_temp.chk_sql(pg_temp.kid('cxl'), pg_temp.kid('d1'), pg_temp.ts('2027-06-16 16:00:00+00')), '55006', 'shift_cancelled');
select pg_temp.expect_error_detail('gate: a week that is NOT published -> 55006 week_not_published',
  pg_temp.chk_sql(pg_temp.kid('draft'), pg_temp.kid('d1'), pg_temp.ts('2027-06-23 16:00:00+00')), '55006', 'week_not_published');
select pg_temp.expect_error_detail('gate: another driver''s assignment is P0002 -- indistinguishable from a missing one',
  pg_temp.chk_sql(pg_temp.kid('s1_owner'), pg_temp.kid('d2'), pg_temp.ts('2027-06-14 16:00:00+00')), 'P0002');
select pg_temp.expect_error_detail('gate: a nonexistent assignment is P0002',
  pg_temp.chk_sql(gen_random_uuid(), pg_temp.kid('d1'), pg_temp.ts('2027-06-14 16:00:00+00')), 'P0002');
select pg_temp.expect_error_detail('gate: a null assignment is 22023',
  format('select pg_temp.chk(null::uuid, %L::uuid, %L::timestamptz)', pg_temp.k('d1'), pg_temp.ts('2027-06-14 16:00:00+00')), '22023');
select pg_temp.expect_equal('gate: none of the rejected calls wrote a row',
  pg_temp.ci_count(pg_temp.kid('cxl')) + pg_temp.ci_count(pg_temp.kid('draft')) + pg_temp.ci_count(pg_temp.kid('s1_owner')), 0);

-- ---------------------------------------------------------------------
-- 5. Idempotency (an existing check-in is returned BEFORE any gate)
-- ---------------------------------------------------------------------
select set_config('dbtest.ci_r_idem1', pg_temp.chk(pg_temp.kid('idem'), pg_temp.kid('idem_d'), pg_temp.ts('2027-06-14 16:10:00+00'))::text, false);
select pg_temp.expect_true('idempotent: a repeat returns the ORIGINAL id and timestamp with created = false, even with a LATER instant',
  not (pg_temp.chk(pg_temp.kid('idem'), pg_temp.kid('idem_d'), pg_temp.ts('2027-06-14 18:00:00+00')) ->> 'created')::boolean
  and (pg_temp.chk(pg_temp.kid('idem'), pg_temp.kid('idem_d'), pg_temp.ts('2027-06-14 18:00:00+00')) ->> 'check_in_id') = (pg_temp.k('r_idem1')::jsonb ->> 'check_in_id')
  and (pg_temp.chk(pg_temp.kid('idem'), pg_temp.kid('idem_d'), pg_temp.ts('2027-06-14 18:00:00+00')) ->> 'checked_in_at')::timestamptz = pg_temp.ts('2027-06-14 16:10:00+00'));
select pg_temp.expect_equal('idempotent: the stored timestamp is unchanged by repeats',
  (pg_temp.ci_row(pg_temp.kid('idem')) ->> 'checked_in_at')::timestamptz, pg_temp.ts('2027-06-14 16:10:00+00'));
select pg_temp.expect_equal('idempotent: still ONE row for the assignment and ONE audit insert', pg_temp.ci_count(pg_temp.kid('idem')) * 10 + pg_temp.ci_audit_count(pg_temp.kid('idem')), 11);
select pg_temp.expect_true('idempotent: a retry AFTER the window closed is still a success (the original), not check_in_closed',
  not (pg_temp.chk(pg_temp.kid('idem'), pg_temp.kid('idem_d'), pg_temp.ts('2027-06-14 23:00:00+00')) ->> 'created')::boolean);
select pg_temp.expect_error_detail('idempotent: ownership is still proved first -- another driver repeating gets P0002, not the original',
  pg_temp.chk_sql(pg_temp.kid('idem'), pg_temp.kid('d2'), pg_temp.ts('2027-06-14 16:10:00+00')), 'P0002');

-- ---------------------------------------------------------------------
-- 6. Attendance interaction
-- ---------------------------------------------------------------------
insert into attendance (shift_instance_id, driver_id, resort_id, status)
select ra.shift_instance_id, ra.driver_id, ra.resort_id, 'no_show' from rota_assignments ra where ra.id = pg_temp.kid('att_first');
insert into attendance (shift_instance_id, driver_id, resort_id, status)
select ra.shift_instance_id, ra.driver_id, ra.resort_id, 'no_show' from rota_assignments ra where ra.id = pg_temp.kid('att_early');

select pg_temp.expect_error_detail('attendance: final attendance already recorded blocks a FIRST check-in (55006 attendance_already_recorded)',
  pg_temp.chk_sql(pg_temp.kid('att_first'), pg_temp.kid('att_first_d'), pg_temp.ts('2027-06-14 16:30:00+00')), '55006', 'attendance_already_recorded');
select pg_temp.expect_error_detail('attendance: ...but the WINDOW is tested first, so outside it the driver gets the neutral window error, not the attendance one',
  pg_temp.chk_sql(pg_temp.kid('att_early'), pg_temp.kid('att_early_d'), pg_temp.ts('2027-06-14 10:00:00+00')), '55006', 'check_in_too_early');
select pg_temp.expect_equal('attendance: no check-in row was created for either', pg_temp.ci_count(pg_temp.kid('att_first')) + pg_temp.ci_count(pg_temp.kid('att_early')), 0);

-- Check-in FIRST, then final attendance: the retry is still the original success (idempotent beats the attendance gate).
select set_config('dbtest.ci_r_idem_att', pg_temp.chk(pg_temp.kid('idem_att'), pg_temp.kid('idem_att_d'), pg_temp.ts('2027-06-14 16:20:00+00'))::text, false);
insert into attendance (shift_instance_id, driver_id, resort_id, status)
select ra.shift_instance_id, ra.driver_id, ra.resort_id, 'worked' from rota_assignments ra where ra.id = pg_temp.kid('idem_att');
select pg_temp.expect_true('attendance: a check-in written FIRST survives final attendance, and a retry afterwards is still the ORIGINAL success (created = false), not attendance_already_recorded',
  not (pg_temp.chk(pg_temp.kid('idem_att'), pg_temp.kid('idem_att_d'), pg_temp.ts('2027-06-14 16:25:00+00')) ->> 'created')::boolean
  and (pg_temp.chk(pg_temp.kid('idem_att'), pg_temp.kid('idem_att_d'), pg_temp.ts('2027-06-14 16:25:00+00')) ->> 'checked_in_at')::timestamptz = pg_temp.ts('2027-06-14 16:20:00+00')
  and pg_temp.ci_count(pg_temp.kid('idem_att')) = 1);
select pg_temp.expect_equal('attendance: a check-in creates NO attendance row (the check-in did not change the attendance count)',
  (select pg_temp.att_count()), 3);
select set_config('dbtest.ci_att_before', pg_temp.att_count()::text, false);
select pg_temp.chk(pg_temp.kid('nocreate'), pg_temp.kid('nocreate_d'), pg_temp.ts('2027-06-14 16:05:00+00'));
select pg_temp.expect_equal('attendance: ...and a fresh check-in leaves the attendance table unchanged',
  pg_temp.att_count(), pg_temp.k('att_before')::int);

-- ---------------------------------------------------------------------
-- 7. Lunch and Dinner on the same day are independent
-- ---------------------------------------------------------------------
select pg_temp.expect_true('independent: Lunch (inside 09:30Z-12:00Z) and Dinner (inside 15:30Z-19:00Z) on one date each get their OWN check-in',
  (pg_temp.chk(pg_temp.kid('lunch'), pg_temp.kid('d1'), pg_temp.ts('2027-06-15 10:15:00+00')) ->> 'created')::boolean
  and (pg_temp.chk(pg_temp.kid('dinner'), pg_temp.kid('d1'), pg_temp.ts('2027-06-15 16:15:00+00')) ->> 'created')::boolean);
select pg_temp.expect_equal('independent: two rows exist for the one driver on that date',
  (select count(*)::int from driver_check_ins where assignment_id in (pg_temp.kid('lunch'), pg_temp.kid('dinner'))), 2);
select pg_temp.expect_true('independent: Lunch''s check-in does not satisfy Dinner (distinct rows, distinct times)',
  (pg_temp.ci_row(pg_temp.kid('lunch')) ->> 'id') <> (pg_temp.ci_row(pg_temp.kid('dinner')) ->> 'id')
  and (pg_temp.ci_row(pg_temp.kid('lunch')) ->> 'checked_in_at')::timestamptz <> (pg_temp.ci_row(pg_temp.kid('dinner')) ->> 'checked_in_at')::timestamptz);

-- ---------------------------------------------------------------------
-- 8. Audit
-- ---------------------------------------------------------------------
select pg_temp.expect_true('audit: the first check-in wrote ONE insert audit row whose context has operation, assignment, shift, driver, resort and week',
  ((pg_temp.ci_audit(pg_temp.kid('open'))).context ->> 'operation') = 'driver_check_in'
  and ((pg_temp.ci_audit(pg_temp.kid('open'))).context ->> 'assignment_id') = pg_temp.k('open')
  and ((pg_temp.ci_audit(pg_temp.kid('open'))).context ->> 'shift_instance_id') = pg_temp.k('s1')
  and ((pg_temp.ci_audit(pg_temp.kid('open'))).context ->> 'driver_id') = pg_temp.k('open_d')
  and ((pg_temp.ci_audit(pg_temp.kid('open'))).context ->> 'resort_id') = current_setting('dbtest.resort_a')
  and ((pg_temp.ci_audit(pg_temp.kid('open'))).context ->> 'week_start') = '2027-06-14');
select pg_temp.expect_true('audit: the row snapshot already carries checked_in_at',
  ((pg_temp.ci_audit(pg_temp.kid('open'))).after ->> 'checked_in_at')::timestamptz = pg_temp.ts('2027-06-14 15:30:00+00'));
select pg_temp.expect_true('audit: the audit context setting is cleared after a check-in',
  coalesce(current_setting('app.audit_context', true), '') = '');

-- ---------------------------------------------------------------------
-- 9. The PUBLIC RPC (session identity)
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select set_config('dbtest.ci_t0', clock_timestamp()::text, false);
select set_config('dbtest.ci_r_pub', pg_temp.pub(pg_temp.kid('pub'))::text, false);
select set_config('dbtest.ci_t1', clock_timestamp()::text, false);
select pg_temp.expect_true('public: the owning driver checks in inside the window (created = true) with the SERVER time',
  (pg_temp.k('r_pub')::jsonb ->> 'created')::boolean
  and (pg_temp.k('r_pub')::jsonb ->> 'checked_in_at')::timestamptz between pg_temp.k('t0')::timestamptz and pg_temp.k('t1')::timestamptz);
select pg_temp.expect_true('public: the result names the assignment and the derived shift instance',
  (pg_temp.k('r_pub')::jsonb ->> 'assignment_id') = pg_temp.k('pub') and (pg_temp.k('r_pub')::jsonb ->> 'shift_instance_id') = pg_temp.k('pub_shift'));
select pg_temp.expect_true('public: a repeat is created = false and returns the original id and timestamp',
  not (pg_temp.pub(pg_temp.kid('pub')) ->> 'created')::boolean
  and (pg_temp.pub(pg_temp.kid('pub')) ->> 'check_in_id') = (pg_temp.k('r_pub')::jsonb ->> 'check_in_id')
  and (pg_temp.pub(pg_temp.kid('pub')) ->> 'checked_in_at')::timestamptz = (pg_temp.k('r_pub')::jsonb ->> 'checked_in_at')::timestamptz);
select pg_temp.expect_equal('public: one row and one audit insert for the assignment after the repeats',
  pg_temp.ci_count(pg_temp.kid('pub')) * 10 + pg_temp.ci_audit_count(pg_temp.kid('pub')), 11);
select pg_temp.expect_true('public: the audit actor is the checking-in driver',
  (pg_temp.ci_audit(pg_temp.kid('pub'))).actor_user_id = current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error_detail('public: a shift whose window already closed (yesterday) -> check_in_closed',
  pg_temp.pub_sql(pg_temp.kid('yesterday')), '55006', 'check_in_closed');
select pg_temp.expect_error_detail('public: a shift that has not opened (tomorrow) -> check_in_too_early',
  pg_temp.pub_sql(pg_temp.kid('tomorrow')), '55006', 'check_in_too_early');
select pg_temp.expect_error_detail('public: another driver''s assignment -> P0002 (no probing)',
  pg_temp.pub_sql(pg_temp.kid('pub_other')), 'P0002');
select pg_temp.expect_error_detail('public: a nonexistent assignment -> P0002',
  pg_temp.pub_sql(gen_random_uuid()), 'P0002');
select pg_temp.expect_error_detail('public: a null assignment -> 22023',
  'select pg_temp.pub(null::uuid)', '22023');

-- the driver view
select pg_temp.expect_true('view: the driver sees their OWN checked_in_at on the assignment',
  (select checked_in_at from driver_visible_assignments where assignment_id = pg_temp.kid('pub')) = (pg_temp.k('r_pub')::jsonb ->> 'checked_in_at')::timestamptz);
select pg_temp.expect_true('view: the not-yet-checked-in assignment has a null checked_in_at',
  (select checked_in_at is null from driver_visible_assignments where assignment_id = pg_temp.kid('tomorrow')));
select pg_temp.expect_true('view: opens_at / closes_at are the server-computed window and equal _check_in_window',
  (select jsonb_build_object('opens_at', check_in_opens_at, 'closes_at', check_in_closes_at) from driver_visible_assignments where assignment_id = pg_temp.kid('s1_owner'))
    = pg_temp.ci_window(pg_temp.kid('s1')));
select pg_temp.expect_true('view: ...also across both DST days',
  (select jsonb_build_object('opens_at', check_in_opens_at, 'closes_at', check_in_closes_at) from driver_visible_assignments where assignment_id = pg_temp.kid('spring_owner'))
    = pg_temp.ci_window(pg_temp.kid('s_spring'))
  and (select jsonb_build_object('opens_at', check_in_opens_at, 'closes_at', check_in_closes_at) from driver_visible_assignments where assignment_id = pg_temp.kid('fall_owner'))
    = pg_temp.ci_window(pg_temp.kid('s_fall')));
select pg_temp.expect_true('view: the existing columns are unchanged and ONLY the three check-in columns were appended',
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'driver_visible_assignments')
    = array['assignment_id', 'shift_instance_id', 'resort_id', 'date', 'week_start', 'shift_key', 'name', 'start_time', 'end_time', 'checked_in_at', 'check_in_opens_at', 'check_in_closes_at']);
select pg_temp.expect_true('view: no attendance status, no driver identity and no pay column is exposed',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'driver_visible_assignments'
              and column_name ~* 'status|attendance|driver_id|full_name|pay|rate|notes'));
select pg_temp.expect_true('view: the driver sees no row of another driver''s assignment (their own check-in is not another''s)',
  not exists (select 1 from driver_visible_assignments where assignment_id = pg_temp.kid('pub_other')));
select pg_temp.expect_error('closed: a driver cannot INSERT a check-in directly (42501)',
  format('insert into driver_check_ins (assignment_id, checked_in_at) values (%L::uuid, now())', pg_temp.k('tomorrow')), '42501');
select pg_temp.expect_true('closed: a driver reads NO rows from driver_check_ins even though their own exists (drivers use the view)',
  (select count(*) from driver_check_ins) = 0);

-- another driver
select pg_temp.act_as('authenticated', current_setting('dbtest.ci_d2_user')::uuid);
select pg_temp.expect_error_detail('public: ANOTHER driver cannot check in to driver_a''s assignment -> P0002',
  pg_temp.pub_sql(pg_temp.kid('pub')), 'P0002');
select pg_temp.expect_true('view: ...and cannot see driver_a''s check-in timestamp either',
  not exists (select 1 from driver_visible_assignments where assignment_id = pg_temp.kid('pub')));

-- inactive driver, manager, anon
select pg_temp.act_as('authenticated', current_setting('dbtest.ci_di_user')::uuid);
select pg_temp.expect_error_detail('public: an INACTIVE driver is denied (42501)', pg_temp.pub_sql(pg_temp.kid('pub_inactive')), '42501');
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('public: a MANAGER cannot check in on a driver''s behalf (42501)', pg_temp.pub_sql(pg_temp.kid('pub')), '42501');
select pg_temp.expect_true('read: a manager CAN read the check-in table',
  (select count(*) from driver_check_ins where assignment_id = pg_temp.kid('pub')) = 1
  and (select checked_in_at from driver_check_ins where assignment_id = pg_temp.kid('pub')) = (pg_temp.k('r_pub')::jsonb ->> 'checked_in_at')::timestamptz);
select pg_temp.expect_error('closed: a manager cannot INSERT a check-in (42501)',
  format('insert into driver_check_ins (assignment_id, checked_in_at) values (%L::uuid, now())', pg_temp.k('tomorrow')), '42501');
select pg_temp.expect_error('closed: a manager cannot UPDATE a check-in (42501)',
  format('update driver_check_ins set checked_in_at = now() where assignment_id = %L::uuid', pg_temp.k('pub')), '42501');
select pg_temp.expect_error('closed: a manager cannot DELETE a check-in (42501)',
  format('delete from driver_check_ins where assignment_id = %L::uuid', pg_temp.k('pub')), '42501');
select pg_temp.act_as('anon');
select pg_temp.expect_error_detail('public: anon cannot check in (42501)', pg_temp.pub_sql(pg_temp.kid('pub')), '42501');
select pg_temp.expect_error('closed: anon cannot read driver_check_ins (42501)', 'select count(*) from driver_check_ins', '42501');
select pg_temp.as_postgres();

-- ---------------------------------------------------------------------
-- 10. Unassign interaction and the FK
-- ---------------------------------------------------------------------
-- Today 18:00-21:00 (Zurich): inject 18:30 local today.
select set_config('dbtest.ci_today_1830',
  ((operational_today(current_setting('dbtest.resort_a')::uuid) + time '18:30') at time zone 'Europe/Zurich')::text, false);
select pg_temp.chk(pg_temp.kid('today_unassign'), pg_temp.kid('today_unassign_d'), pg_temp.k('today_1830')::timestamptz);
select pg_temp.chk(pg_temp.kid('today_both'), pg_temp.kid('today_both_d'), pg_temp.k('today_1830')::timestamptz);
insert into attendance (shift_instance_id, driver_id, resort_id, status)
select ra.shift_instance_id, ra.driver_id, ra.resort_id, 'worked' from rota_assignments ra where ra.id = pg_temp.kid('today_both');

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('unassign: today''s assignment WITH a driver check-in is blocked (55006 check_in_recorded -- a distinct token)',
  format('select unassign_driver(%L::uuid, %L::uuid)', pg_temp.k('today_shift'), pg_temp.k('today_unassign_d')), '55006', 'check_in_recorded');
select pg_temp.expect_true('unassign: ...and the assignment and its check-in survive',
  exists (select 1 from rota_assignments where id = pg_temp.kid('today_unassign')) and pg_temp.ci_count(pg_temp.kid('today_unassign')) = 1);
select pg_temp.expect_error_detail('unassign: with BOTH attendance and a check-in the existing attendance_recorded token still wins (unchanged precedence)',
  format('select unassign_driver(%L::uuid, %L::uuid)', pg_temp.k('today_shift'), pg_temp.k('today_both_d')), '55006', 'attendance_recorded');
select pg_temp.expect_true('unassign: an assignment with NO check-in and no attendance is still removable (existing behaviour preserved)',
  (select count(*) from unassign_driver(pg_temp.kid('today_shift'), pg_temp.kid('today_plain_d'))) = 1);
select pg_temp.as_postgres();
select pg_temp.expect_error('integrity: deleting an assignment that has a check-in is refused by the FK as the final defence (23503)',
  format('delete from rota_assignments where id = %L::uuid', pg_temp.k('today_unassign')), '23503');
select pg_temp.expect_error('integrity: a check-in for a nonexistent assignment is impossible (23503)',
  format('insert into driver_check_ins (assignment_id, checked_in_at) values (%L::uuid, now())', gen_random_uuid()), '23503');
select pg_temp.expect_error('integrity: a second check-in row for one assignment is impossible (23505, one per assignment)',
  format('insert into driver_check_ins (assignment_id, checked_in_at) values (%L::uuid, now())', pg_temp.k('open')), '23505');

-- ---------------------------------------------------------------------
-- 11. Check-in first, then ANY final attendance; clearing attendance keeps the check-in
-- ---------------------------------------------------------------------
select set_config('dbtest.ci_flow_at',
  ((operational_today(current_setting('dbtest.resort_a')::uuid) - 14 + time '18:30') at time zone 'Europe/Zurich')::text, false);
select pg_temp.expect_true('flow: a check-in on a published past shift (injected 18:30 local) is created',
  (pg_temp.chk(pg_temp.kid('flow'), pg_temp.kid('flow_d'), pg_temp.k('flow_at')::timestamptz) ->> 'created')::boolean);
select set_config('dbtest.ci_flow_original', (pg_temp.ci_row(pg_temp.kid('flow')) ->> 'checked_in_at'), false);

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('flow: after a check-in the manager may record NO SHOW (check-in is evidence, not truth)',
  (select (r.created and r.changed) from record_attendance(pg_temp.kid('flow'), 'no_show') r));
select pg_temp.expect_true('flow: ...then correct it to WORKED, EXCUSED and CANCELLED -- every status stays legal after a check-in',
  (select r.changed from record_attendance(pg_temp.kid('flow'), 'worked') r)
  and (select r.changed from record_attendance(pg_temp.kid('flow'), 'excused') r)
  and (select r.changed from record_attendance(pg_temp.kid('flow'), 'cancelled') r));
select pg_temp.expect_equal('flow: the check-in timestamp is untouched by every attendance change',
  (pg_temp.ci_row(pg_temp.kid('flow')) ->> 'checked_in_at'), pg_temp.k('flow_original'));
select pg_temp.expect_true('flow: clear_attendance succeeds (changed = true)...',
  (select r.changed from clear_attendance(pg_temp.kid('flow'), 'recorded in error') r));
select pg_temp.expect_equal('flow: ...and the assignment is back to Not recorded (no attendance row)',
  (select count(*)::int from attendance a join rota_assignments ra on ra.shift_instance_id = a.shift_instance_id and ra.driver_id = a.driver_id where ra.id = pg_temp.kid('flow')), 0);
select pg_temp.expect_equal('flow: ...and NEVER deletes the driver''s check-in evidence (same row, same timestamp)',
  (pg_temp.ci_row(pg_temp.kid('flow')) ->> 'checked_in_at'), pg_temp.k('flow_original'));
select pg_temp.expect_true('flow: the manager can then record the corrected attendance',
  (select r.changed from record_attendance(pg_temp.kid('flow'), 'worked') r));
select pg_temp.expect_equal('flow: still exactly one check-in row and one insert audit row for it', pg_temp.ci_count(pg_temp.kid('flow')) * 10 + pg_temp.ci_audit_count(pg_temp.kid('flow')), 11);
select pg_temp.as_postgres();

-- ---------------------------------------------------------------------
-- 12. The week lock (a week no fixture write ever locked)
-- ---------------------------------------------------------------------
select pg_temp.expect_true('lock: _check_in takes the advisory lock for the assignment''s resort + week (a created check-in)',
  (pg_temp.chk(pg_temp.kid('lockproof'), pg_temp.kid('lockproof_d'), pg_temp.ts('2027-07-05 16:30:00+00')) ->> 'created')::boolean
  and pg_temp.ci_lock_held(current_setting('dbtest.resort_a')::uuid, date '2027-07-05'));
select pg_temp.expect_true('lock: an unrelated week of the same resort is NOT locked',
  not pg_temp.ci_lock_held(current_setting('dbtest.resort_a')::uuid, date '2027-09-06'));
select pg_temp.expect_true('context: the audit context setting is clear at the end',
  coalesce(current_setting('app.audit_context', true), '') = '');
