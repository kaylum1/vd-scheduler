-- Auto-Rota AR-A: apply_auto_rota (the atomic, manager-only apply of a PROPOSED,
-- UNTRUSTED plan), the per-resort/week transaction lock, and the publication
-- trigger. (The planner that chooses WHO to propose is a later checkpoint; the
-- database only decides whether each proposed assignment is still safe.)
--
-- assign_driver / unassign_driver were re-created in the same migration only to
-- take the week lock: 85_manual_rota_assignments.sql is the regression proof
-- that their behaviour is unchanged and runs unmodified.
--
-- Real blocking between two connections cannot be shown inside this single
-- transaction; the lock is therefore proven STRUCTURALLY here (every writer
-- acquires the advisory lock for exactly its resort/week) and the
-- interleavings are proven by "stale plan" tests (state changes between
-- planning and apply -> rejected, nothing written). Actual two-connection
-- blocking was verified separately against the live local stack (see the AR-A
-- report).
--
-- Dates are relative to each resort's OPERATIONAL today, never current_date.

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
    -- Messages are for managers: never a raw constraint / table / function name.
    if sqlstate = p_sqlstate
       and v_detail is not distinct from p_detail
       and sqlerrm !~* '(violates|constraint|_fkey|_unique|rota_assignments|availability_|auto_rota\()' then
      perform pg_temp.record_result(p_name, true, null);
    else
      perform pg_temp.record_result(p_name, false,
        format('expected sqlstate %s / detail %s / friendly message; got %s / detail %s / "%s"', p_sqlstate, p_detail, sqlstate, v_detail, sqlerrm));
    end if;
  end;
end;
$$;

create function pg_temp.i(p_name text) returns uuid language sql as $$ select current_setting('dbtest.ar_' || p_name)::uuid $$;

create function pg_temp.ar_monday(p_d date) returns date language sql as $$ select p_d - app_weekday(p_d)::integer $$;

create function pg_temp.ar_instance(p_resort uuid, p_type uuid, p_date date, p_required int, p_status text default 'active')
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into shift_instances (resort_id, date, shift_type_id, shift_key, name, sort_order, start_time, end_time,
                               required_drivers, status, origin, cancelled_at, cancelled_reason)
  values (p_resort, p_date, p_type, 'ar-test', 'AR Shift', 1, '18:00', '21:30',
          p_required, p_status, 'adhoc',
          case when p_status = 'cancelled' then now() end,
          case when p_status = 'cancelled' then 'ar test' end)
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.ar_driver(p_resort uuid, p_name text, p_active boolean default true)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into drivers (resort_id, full_name, is_active) values (p_resort, p_name, p_active) returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.ar_avail(p_instance uuid, p_driver uuid, p_status text)
returns void language plpgsql security definer as $$
begin
  insert into availability (driver_id, resort_id, shift_instance_id, status)
  values (p_driver, (select resort_id from shift_instances where id = p_instance), p_instance, p_status)
  on conflict (driver_id, shift_instance_id) do update set status = excluded.status;
end;
$$;

create function pg_temp.ar_seed(p_instance uuid, p_driver uuid, p_source text default 'manual')
returns void language plpgsql security definer as $$
begin
  insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source)
  values (p_instance, p_driver, (select resort_id from shift_instances where id = p_instance), p_source);
end;
$$;

create function pg_temp.ar_publish(p_resort uuid, p_week date, p_retracted boolean default false)
returns void language plpgsql security definer as $$
begin
  insert into rota_publications (resort_id, week_start, generation_source, published_at, unpublished_at)
  values (p_resort, p_week, 'manual', now() - interval '1 hour', case when p_retracted then now() end);
end;
$$;

-- A plan: alternating shift_instance_id, driver_id texts.
create function pg_temp.ar_plan(variadic p_pairs text[]) returns jsonb language plpgsql as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_k int;
begin
  for v_k in 1 .. coalesce(array_length(p_pairs, 1), 0) / 2 loop
    v_out := v_out || jsonb_build_array(jsonb_build_object('shift_instance_id', p_pairs[2 * v_k - 1], 'driver_id', p_pairs[2 * v_k]));
  end loop;
  return v_out;
end;
$$;

create function pg_temp.ar_apply(p_resort uuid, p_week date, p_plan jsonb) returns jsonb language sql as $$
  select to_jsonb(r) from apply_auto_rota(p_resort, p_week, p_plan) r
$$;

create function pg_temp.ar_sql(p_resort uuid, p_week date, p_plan jsonb) returns text language sql as $$
  select format('select pg_temp.ar_apply(%L::uuid, %L::date, %L::jsonb)', p_resort, p_week, p_plan)
$$;

-- Does THIS backend hold the advisory lock for (resort, week)? (pg_locks shows a
-- two-int-key advisory lock as classid = key1, objid = key2, objsubid = 2.)
create function pg_temp.ar_lock_held(p_resort uuid, p_week date)
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
  v_b uuid := current_setting('dbtest.resort_b')::uuid;
  v_c uuid;
  v_tz text;
  v_today date := operational_today(v_a);
  v_type_a uuid;
  v_type_b uuid;
  v_type_c uuid;
  v_w date := pg_temp.ar_monday(v_today + 14);
  v_tc date;
  v_wc date;
  d1 uuid := current_setting('dbtest.driver_a_id')::uuid;
  d2 uuid; d3 uuid; d4 uuid; d5 uuid; di uuid;
  c1 uuid;
  s_mon uuid; s_tue uuid; s_wed uuid; s_thu uuid; s_fri uuid; s_sun uuid; s_cx uuid;
begin
  insert into shift_types (resort_id, key, name, sort_order) values (v_a, 'ar-test', 'AR Shift', 1) returning id into v_type_a;
  insert into shift_types (resort_id, key, name, sort_order) values (v_b, 'ar-test', 'AR Shift', 1) returning id into v_type_b;

  d2 := pg_temp.ar_driver(v_a, 'AR Driver 2');
  d3 := pg_temp.ar_driver(v_a, 'AR Driver 3');
  d4 := pg_temp.ar_driver(v_a, 'AR Driver 4');
  d5 := pg_temp.ar_driver(v_a, 'AR Driver 5');
  di := pg_temp.ar_driver(v_a, 'AR Driver Inactive', false);
  perform set_config('dbtest.ar_d1', d1::text, false);
  perform set_config('dbtest.ar_d2', d2::text, false);
  perform set_config('dbtest.ar_d3', d3::text, false);
  perform set_config('dbtest.ar_d4', d4::text, false);
  perform set_config('dbtest.ar_d5', d5::text, false);
  perform set_config('dbtest.ar_di', di::text, false);
  perform set_config('dbtest.ar_w', v_w::text, false);

  -- ---- Week W (a draft week two weeks out) ----------------------------
  s_mon := pg_temp.ar_instance(v_a, v_type_a, v_w + 0, 2);
  s_tue := pg_temp.ar_instance(v_a, v_type_a, v_w + 1, 1);
  s_wed := pg_temp.ar_instance(v_a, v_type_a, v_w + 2, 2);
  s_thu := pg_temp.ar_instance(v_a, v_type_a, v_w + 3, 1);
  s_fri := pg_temp.ar_instance(v_a, v_type_a, v_w + 4, 1);
  s_cx  := pg_temp.ar_instance(v_a, v_type_a, v_w + 5, 1, 'cancelled');
  s_sun := pg_temp.ar_instance(v_a, v_type_a, v_w + 6, 1);
  perform set_config('dbtest.ar_s_mon', s_mon::text, false);
  perform set_config('dbtest.ar_s_tue', s_tue::text, false);
  perform set_config('dbtest.ar_s_wed', s_wed::text, false);
  perform set_config('dbtest.ar_s_thu', s_thu::text, false);
  perform set_config('dbtest.ar_s_fri', s_fri::text, false);
  perform set_config('dbtest.ar_s_cx', s_cx::text, false);
  perform set_config('dbtest.ar_s_sun', s_sun::text, false);

  -- Availability. d1/d2 Available widely; d3 Unavailable at Mon and Sun; d4 has
  -- NO row at Mon (Not Submitted); d5 Available at Mon; the inactive driver is
  -- Available at Mon/Tue (still never eligible).
  perform pg_temp.ar_avail(s_mon, d1, 'available');  perform pg_temp.ar_avail(s_mon, d2, 'available');
  perform pg_temp.ar_avail(s_mon, d3, 'unavailable'); perform pg_temp.ar_avail(s_mon, d5, 'available');
  perform pg_temp.ar_avail(s_mon, di, 'available');
  perform pg_temp.ar_avail(s_tue, d1, 'available');  perform pg_temp.ar_avail(s_tue, d2, 'available');
  perform pg_temp.ar_avail(s_tue, di, 'available');
  perform pg_temp.ar_avail(s_wed, d1, 'available');  perform pg_temp.ar_avail(s_wed, d2, 'available');
  perform pg_temp.ar_avail(s_wed, d3, 'available');
  perform pg_temp.ar_avail(s_thu, d1, 'available');  perform pg_temp.ar_avail(s_thu, d2, 'available');
  perform pg_temp.ar_avail(s_fri, d1, 'available');  perform pg_temp.ar_avail(s_fri, d2, 'available');
  perform pg_temp.ar_avail(s_cx, d1, 'available');
  perform pg_temp.ar_avail(s_sun, d1, 'available');  perform pg_temp.ar_avail(s_sun, d3, 'unavailable');

  -- Existing assignments (seeded as owner): thu manual d1 (full), fri AUTO d2
  -- (full), sun manual d3 (a manual override of an Unavailable answer; full),
  -- wed manual d1 (1 of 2), mon an INACTIVE driver (does not count).
  perform pg_temp.ar_seed(s_thu, d1, 'manual');
  perform pg_temp.ar_seed(s_fri, d2, 'auto');
  perform pg_temp.ar_seed(s_sun, d3, 'manual');
  perform pg_temp.ar_seed(s_wed, d1, 'manual');
  perform pg_temp.ar_seed(s_mon, di, 'manual');

  -- A shift in resort B in the same week (cross-resort rejection).
  perform set_config('dbtest.ar_sb', pg_temp.ar_instance(v_b, v_type_b, v_w + 1, 1)::text, false);

  -- ---- Week W2: partial coverage / zero eligible ----------------------
  perform set_config('dbtest.ar_w2', pg_temp.ar_monday(v_today + 21)::text, false);
  perform set_config('dbtest.ar_s2_mon', pg_temp.ar_instance(v_a, v_type_a, pg_temp.ar_monday(v_today + 21), 2)::text, false);
  perform set_config('dbtest.ar_s2_tue', pg_temp.ar_instance(v_a, v_type_a, pg_temp.ar_monday(v_today + 21) + 1, 1)::text, false);
  perform pg_temp.ar_avail(pg_temp.i('s2_mon'), d1, 'available');
  perform pg_temp.ar_avail(pg_temp.i('s2_mon'), d2, 'available');

  -- ---- Week W3: published ----------------------------------------------
  perform set_config('dbtest.ar_w3', pg_temp.ar_monday(v_today + 28)::text, false);
  perform set_config('dbtest.ar_s3', pg_temp.ar_instance(v_a, v_type_a, pg_temp.ar_monday(v_today + 28) + 1, 1)::text, false);
  perform pg_temp.ar_avail(pg_temp.i('s3'), d1, 'available');
  perform pg_temp.ar_publish(v_a, pg_temp.ar_monday(v_today + 28));

  -- ---- Week W4: published AFTER planning (race) -------------------------
  perform set_config('dbtest.ar_w4', pg_temp.ar_monday(v_today + 35)::text, false);
  perform set_config('dbtest.ar_s4', pg_temp.ar_instance(v_a, v_type_a, pg_temp.ar_monday(v_today + 35) + 1, 1)::text, false);
  perform pg_temp.ar_avail(pg_temp.i('s4'), d1, 'available');

  -- ---- Week W5: published then RETRACTED (unpublished_at set) -----------
  perform set_config('dbtest.ar_w5', pg_temp.ar_monday(v_today + 42)::text, false);
  perform set_config('dbtest.ar_s5', pg_temp.ar_instance(v_a, v_type_a, pg_temp.ar_monday(v_today + 42) + 1, 1)::text, false);
  perform pg_temp.ar_avail(pg_temp.i('s5'), d1, 'available');
  perform pg_temp.ar_publish(v_a, pg_temp.ar_monday(v_today + 42), true);

  -- ---- Week W6: two single-slot shifts (write-failure rollback) ---------
  perform set_config('dbtest.ar_w6', pg_temp.ar_monday(v_today + 49)::text, false);
  perform set_config('dbtest.ar_s6a', pg_temp.ar_instance(v_a, v_type_a, pg_temp.ar_monday(v_today + 49) + 1, 1)::text, false);
  perform set_config('dbtest.ar_s6b', pg_temp.ar_instance(v_a, v_type_a, pg_temp.ar_monday(v_today + 49) + 2, 1)::text, false);
  perform pg_temp.ar_avail(pg_temp.i('s6a'), d1, 'available');
  perform pg_temp.ar_avail(pg_temp.i('s6b'), d5, 'available');

  -- ---- Lock-structure weeks (each touched by exactly one kind of writer) -
  perform set_config('dbtest.ar_wl_assign', pg_temp.ar_monday(v_today + 70)::text, false);
  perform set_config('dbtest.ar_sl_assign', pg_temp.ar_instance(v_a, v_type_a, pg_temp.ar_monday(v_today + 70) + 1, 1)::text, false);
  perform pg_temp.ar_avail(pg_temp.i('sl_assign'), d1, 'available');
  perform set_config('dbtest.ar_wl_unassign', pg_temp.ar_monday(v_today + 77)::text, false);
  perform set_config('dbtest.ar_sl_unassign', pg_temp.ar_instance(v_a, v_type_a, pg_temp.ar_monday(v_today + 77) + 1, 1)::text, false);
  perform pg_temp.ar_seed(pg_temp.i('sl_unassign'), d1, 'manual');   -- direct seed: takes no lock
  -- The update/delete weeks are seeded with the lock trigger DISABLED so that
  -- the seed itself cannot be what acquires the lock under test.
  alter table rota_publications disable trigger rota_publications_week_lock;
  perform pg_temp.ar_publish(v_a, pg_temp.ar_monday(v_today + 91));
  perform pg_temp.ar_publish(v_a, pg_temp.ar_monday(v_today + 98));
  alter table rota_publications enable trigger rota_publications_week_lock;

  -- ---- Resort C: a timezone whose operational date is NOT a Monday so the
  -- current week genuinely contains a past day, a today and (maybe) future days.
  select z into v_tz from (values ('Etc/GMT+12'), ('Europe/Zurich'), ('Pacific/Kiritimati')) t(z)
   where app_weekday((now() at time zone z)::date) >= 1 order by z limit 1;
  insert into resorts (slug, name, timezone) values ('dbtest-ar-c', 'AR Test Resort C', v_tz) returning id into v_c;
  insert into shift_types (resort_id, key, name, sort_order) values (v_c, 'ar-test', 'AR Shift', 1) returning id into v_type_c;
  v_tc := operational_today(v_c);
  v_wc := pg_temp.ar_monday(v_tc);
  c1 := pg_temp.ar_driver(v_c, 'AR Driver C1');
  perform set_config('dbtest.ar_c', v_c::text, false);
  perform set_config('dbtest.ar_wc', v_wc::text, false);
  perform set_config('dbtest.ar_wp', (v_wc - 7)::text, false);
  perform set_config('dbtest.ar_c1', c1::text, false);
  perform set_config('dbtest.ar_sc_past', pg_temp.ar_instance(v_c, v_type_c, v_tc - 1, 1)::text, false);
  perform set_config('dbtest.ar_sc_today', pg_temp.ar_instance(v_c, v_type_c, v_tc, 1)::text, false);
  perform set_config('dbtest.ar_sc_week_past', pg_temp.ar_instance(v_c, v_type_c, v_wc - 5, 1)::text, false);
  perform pg_temp.ar_avail(pg_temp.i('sc_past'), c1, 'available');
  perform pg_temp.ar_avail(pg_temp.i('sc_today'), c1, 'available');
  perform pg_temp.ar_avail(pg_temp.i('sc_week_past'), c1, 'available');
end $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error_detail('security: an authenticated DRIVER cannot call apply_auto_rota (42501)',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date, '[]'::jsonb), '42501');

select pg_temp.act_as('anon');
select pg_temp.expect_error_detail('security: anon cannot call apply_auto_rota (42501)',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date, '[]'::jsonb), '42501');

select pg_temp.as_postgres();
select pg_temp.expect_true('security: EXECUTE on apply_auto_rota is granted to authenticated only, never anon',
  has_function_privilege('authenticated', 'apply_auto_rota(uuid,date,jsonb)', 'execute')
  and not has_function_privilege('anon', 'apply_auto_rota(uuid,date,jsonb)', 'execute'));
select pg_temp.expect_true('security: the lock/key/open-slot helpers are internal -- not executable by authenticated or anon',
  not has_function_privilege('authenticated', 'rota_week_lock(uuid,date)', 'execute')
  and not has_function_privilege('anon', 'rota_week_lock(uuid,date)', 'execute')
  and not has_function_privilege('authenticated', 'rota_week_lock_keys(uuid,date)', 'execute')
  and not has_function_privilege('authenticated', '_auto_rota_open_slots(uuid,date,date)', 'execute'));

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error('security: the direct write path to rota_assignments is still closed for a manager (42501)',
  format('insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source) values (%L::uuid, %L::uuid, %L::uuid, %L)',
    current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_d1'), current_setting('dbtest.resort_a'), 'auto'),
  '42501');

-- ---------------------------------------------------------------------
-- Manager can call; an EMPTY plan on an uncovered draft week is a valid
-- success reporting the authoritative gaps (partial/zero coverage is not an error)
-- ---------------------------------------------------------------------
do $$
declare
  r jsonb := pg_temp.ar_apply(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date, '[]'::jsonb);
begin
  perform pg_temp.expect_equal('manager: an empty plan on an uncovered draft week succeeds and creates nothing', (r ->> 'assigned_count')::int, 0);
  -- mon 2 (the inactive assignee does not count), tue 1, wed 1 (one active manual of 2); thu/fri/sun are full; the cancelled shift is not considered.
  perform pg_temp.expect_equal('result: remaining_open_slots is computed from current ACTIVE assignments (2 + 1 + 1)', (r ->> 'remaining_open_slots')::int, 4);
  perform pg_temp.expect_true('result: uncovered_shift_ids are exactly the shifts with a gap, in date order',
    (r -> 'uncovered_shift_ids') = jsonb_build_array(pg_temp.i('s_mon'), pg_temp.i('s_tue'), pg_temp.i('s_wed')));
  perform pg_temp.expect_equal('result: nothing in the current week is in the past, so skipped_past_shift_count is 0', (r ->> 'skipped_past_shift_count')::int, 0);
  perform pg_temp.expect_true('result: echoes the resort and week and carries a run id',
    (r ->> 'resort_id')::uuid = current_setting('dbtest.resort_a')::uuid and (r ->> 'week_start')::date = current_setting('dbtest.ar_w')::date and (r ->> 'run_id') is not null);
  perform pg_temp.expect_true('result: the inactive driver''s existing assignment is NOT counted (Monday shows both slots open) and an active manual OVERRIDE assignment IS counted (Sunday is not a gap)',
    (r -> 'uncovered_shift_ids') ? pg_temp.i('s_mon')::text and not ((r -> 'uncovered_shift_ids') ? pg_temp.i('s_sun')::text));
end $$;

-- ---------------------------------------------------------------------
-- Malformed / structurally invalid requests (22023 -- never a "stale" race)
-- ---------------------------------------------------------------------
select pg_temp.expect_error_detail('malformed: the plan is not an array',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date, '{"shift_instance_id":"x"}'::jsonb), '22023', 'plan_malformed');
select pg_temp.expect_error_detail('malformed: a null plan',
  format('select pg_temp.ar_apply(%L::uuid, %L::date, null::jsonb)', current_setting('dbtest.resort_a'), current_setting('dbtest.ar_w')), '22023');
select pg_temp.expect_error_detail('malformed: an element without a driver_id',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    jsonb_build_array(jsonb_build_object('shift_instance_id', current_setting('dbtest.ar_s_tue')))), '22023', 'plan_malformed');
select pg_temp.expect_error_detail('malformed: an invalid UUID',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan('not-a-uuid', current_setting('dbtest.ar_d1'))), '22023', 'plan_malformed');
select pg_temp.expect_error_detail('malformed: an element that is not an object',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date, '["x"]'::jsonb), '22023', 'plan_malformed');
select pg_temp.expect_error_detail('malformed: the plan may NOT carry an assignment_source (or any extra field) -- the server decides',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    jsonb_build_array(jsonb_build_object('shift_instance_id', current_setting('dbtest.ar_s_tue'), 'driver_id', current_setting('dbtest.ar_d1'), 'assignment_source', 'manual'))),
  '22023', 'plan_malformed');
select pg_temp.expect_error_detail('malformed: the plan may NOT carry an availability state',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    jsonb_build_array(jsonb_build_object('shift_instance_id', current_setting('dbtest.ar_s_tue'), 'driver_id', current_setting('dbtest.ar_d1'), 'availability', 'available'))),
  '22023', 'plan_malformed');
select pg_temp.expect_error_detail('malformed: the same shift + driver twice inside the plan',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_d1'), current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_d1'))),
  '22023', 'plan_malformed');
select pg_temp.expect_error_detail('malformed: an oversized plan (1001 rows)',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    (select jsonb_agg(jsonb_build_object('shift_instance_id', gen_random_uuid(), 'driver_id', gen_random_uuid())) from generate_series(1, 1001))),
  '22023', 'plan_malformed');
select pg_temp.expect_error_detail('malformed: a week that does not start on a Monday',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, (current_setting('dbtest.ar_w')::date + 1), '[]'::jsonb), '22023');
select pg_temp.expect_error_detail('malformed: a missing resort',
  format('select pg_temp.ar_apply(null::uuid, %L::date, %L::jsonb)', current_setting('dbtest.ar_w'), '[]'),
  '22023');
select pg_temp.expect_error_detail('an unknown resort is not found (P0002)',
  pg_temp.ar_sql(gen_random_uuid(), current_setting('dbtest.ar_w')::date, '[]'::jsonb), 'P0002');

-- ---------------------------------------------------------------------
-- Identity: a pair that cannot belong to this resort + week is a bad request
-- ---------------------------------------------------------------------
select pg_temp.expect_error_detail('identity: a shift of ANOTHER resort is rejected (plan outside resort)',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_sb'), current_setting('dbtest.ar_d1'))), '22023', 'plan_shift_not_in_week');
select pg_temp.expect_error_detail('identity: a shift of ANOTHER WEEK is rejected (plan outside week)',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s2_mon'), current_setting('dbtest.ar_d1'))), '22023', 'plan_shift_not_in_week');
select pg_temp.expect_error_detail('identity: a shift that does not exist is rejected',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(gen_random_uuid()::text, current_setting('dbtest.ar_d1'))), '22023', 'plan_shift_not_in_week');
select pg_temp.expect_error_detail('identity: a driver of ANOTHER resort is rejected (same-resort invariant)',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_tue'), current_setting('dbtest.driver_b_id'))), '22023', 'plan_driver_not_in_resort');

-- ---------------------------------------------------------------------
-- Stale plans (VD002): the proposal is no longer allowed by CURRENT state
-- ---------------------------------------------------------------------
select pg_temp.expect_error_detail('stale: an INACTIVE driver is rejected even though an Available row exists',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_di'))), 'VD002', 'stale_plan');
select pg_temp.expect_error_detail('stale: an UNAVAILABLE driver is never eligible -- no override exists',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_mon'), current_setting('dbtest.ar_d3'))), 'VD002', 'stale_plan');
select pg_temp.expect_error_detail('stale: a NOT SUBMITTED driver (no row) is never eligible',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_mon'), current_setting('dbtest.ar_d4'))), 'VD002', 'stale_plan');
select pg_temp.expect_error_detail('stale: availability is per EXACT shift -- Available on Tuesday does not make a driver eligible on Thursday-without-a-row',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_wed'), current_setting('dbtest.ar_d5'))), 'VD002', 'stale_plan');
select pg_temp.expect_error_detail('stale: a driver ALREADY assigned to the shift (with capacity left) is rejected',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_wed'), current_setting('dbtest.ar_d1'))), 'VD002', 'stale_plan');
select pg_temp.expect_error_detail('stale: a cancelled shift is not assignable',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_cx'), current_setting('dbtest.ar_d1'))), 'VD002', 'stale_plan');
select pg_temp.expect_error_detail('coverage: two planned rows for a shift with ONE open slot (2 of 2 with one already filled) would over-assign -- rejected',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_wed'), current_setting('dbtest.ar_d2'), current_setting('dbtest.ar_s_wed'), current_setting('dbtest.ar_d3'))), 'VD002', 'stale_plan');
select pg_temp.expect_error_detail('coverage: an active MANUAL assignment counts -- a full shift (thu 1/1) accepts nothing more',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_thu'), current_setting('dbtest.ar_d2'))), 'VD002', 'stale_plan');
select pg_temp.expect_error_detail('coverage: an active AUTO assignment counts -- a full shift (fri 1/1) accepts nothing more',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_fri'), current_setting('dbtest.ar_d1'))), 'VD002', 'stale_plan');
select pg_temp.expect_error_detail('coverage: a manual assignment made despite an Unavailable answer still counts as existing coverage (sun 1/1)',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_sun'), current_setting('dbtest.ar_d1'))), 'VD002', 'stale_plan');

-- ---------------------------------------------------------------------
-- Races, simulated as interleavings: the plan was valid when made, then the
-- world changed, then apply runs. (Real blocking is verified separately.)
-- ---------------------------------------------------------------------
select pg_temp.as_postgres();
update availability set status = 'unavailable' where shift_instance_id = current_setting('dbtest.ar_s_tue')::uuid and driver_id = current_setting('dbtest.ar_d1')::uuid;
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('race: the driver flipped Available -> Unavailable after the plan was made -- rejected',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_d1'))), 'VD002', 'stale_plan');
select pg_temp.as_postgres();
update availability set status = 'available' where shift_instance_id = current_setting('dbtest.ar_s_tue')::uuid and driver_id = current_setting('dbtest.ar_d1')::uuid;

select pg_temp.ar_seed(current_setting('dbtest.ar_s_tue')::uuid, current_setting('dbtest.ar_d2')::uuid, 'manual');
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('race: a manager assigned someone to the open slot after the plan was made -- the plan would now over-assign, rejected',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_d1'))), 'VD002', 'stale_plan');
select pg_temp.as_postgres();
delete from rota_assignments where shift_instance_id = current_setting('dbtest.ar_s_tue')::uuid;

update drivers set is_active = false where id = current_setting('dbtest.ar_d1')::uuid;
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('race: the driver was deactivated after the plan was made -- rejected',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_d1'))), 'VD002', 'stale_plan');
select pg_temp.as_postgres();
update drivers set is_active = true where id = current_setting('dbtest.ar_d1')::uuid;

update shift_instances set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'ar race' where id = current_setting('dbtest.ar_s_tue')::uuid;
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('race: the shift was cancelled after the plan was made -- rejected',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_d1'))), 'VD002', 'stale_plan');
select pg_temp.as_postgres();
update shift_instances set status = 'active', cancelled_at = null, cancelled_reason = null where id = current_setting('dbtest.ar_s_tue')::uuid;

-- ---------------------------------------------------------------------
-- Atomic rollback: one bad row in a multi-row plan means NOTHING is written
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
do $$
declare
  v_before int := (select count(*) from rota_assignments);
  v_audit_before int := (select count(*) from audit_log where table_name = 'rota_assignments');
begin
  begin
    perform pg_temp.ar_apply(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
      pg_temp.ar_plan(current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_d1'),
                      current_setting('dbtest.ar_s_wed'), current_setting('dbtest.ar_d2'),
                      current_setting('dbtest.ar_s_mon'), current_setting('dbtest.ar_d3')));   -- d3 is Unavailable on Monday
    perform pg_temp.record_result('rollback: a plan with one invalid row among valid ones is rejected', false, 'no error raised');
  exception when sqlstate 'VD002' then
    perform pg_temp.record_result('rollback: a plan with one invalid row among valid ones is rejected', true, null);
  end;
  perform pg_temp.expect_equal('rollback: none of the valid rows from the rejected plan were written', (select count(*) from rota_assignments)::int, v_before);
  perform pg_temp.expect_equal('rollback: and no audit rows were left behind', (select count(*) from audit_log where table_name = 'rota_assignments')::int, v_audit_before);
end $$;

-- ---------------------------------------------------------------------
-- The main successful run on week W
-- ---------------------------------------------------------------------
select pg_temp.as_postgres();
-- Snapshot of every existing assignment in the week (manual AND auto) and of
-- every availability row, to prove the apply leaves them untouched.
select set_config('dbtest.ar_before_assignments',
  (select coalesce(jsonb_agg(to_jsonb(ra) order by ra.id), '[]'::jsonb)::text from rota_assignments ra
    where ra.shift_instance_id in (select id from shift_instances where week_start = current_setting('dbtest.ar_w')::date)), false);
select set_config('dbtest.ar_before_availability', (select md5(coalesce(string_agg(a::text, '|' order by a.id), '')) from availability a), false);
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  r jsonb;
  v_pub_before int := (select count(*) from rota_publications where resort_id = current_setting('dbtest.resort_a')::uuid and week_start = current_setting('dbtest.ar_w')::date);
begin
  -- 4 proposals: tue<-d1, wed<-d2 (fills 2/2), mon<-d1 and mon<-d2 (two slots even though an INACTIVE driver is already on mon).
  r := pg_temp.ar_apply(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_d1'),
                    current_setting('dbtest.ar_s_wed'), current_setting('dbtest.ar_d2'),
                    current_setting('dbtest.ar_s_mon'), current_setting('dbtest.ar_d1'),
                    current_setting('dbtest.ar_s_mon'), current_setting('dbtest.ar_d2')));
  perform set_config('dbtest.ar_last', r::text, false);
  perform pg_temp.expect_equal('apply: assigned_count is the number of rows actually created', (r ->> 'assigned_count')::int, 4);
  perform pg_temp.expect_equal('apply: remaining_open_slots is 0 once every position is filled', (r ->> 'remaining_open_slots')::int, 0);
  perform pg_temp.expect_true('apply: uncovered_shift_ids is empty', (r -> 'uncovered_shift_ids') = '[]'::jsonb);
  perform pg_temp.expect_equal('publication: applying to a draft week does not create or change a publication row',
    (select count(*) from rota_publications where resort_id = current_setting('dbtest.resort_a')::uuid and week_start = current_setting('dbtest.ar_w')::date)::int, v_pub_before);
end $$;

select pg_temp.as_postgres();
select pg_temp.expect_true('source: every created row has assignment_source = auto',
  (select count(*) from rota_assignments ra
     where ra.assignment_source = 'auto'
       and (ra.shift_instance_id, ra.driver_id) in (
         (current_setting('dbtest.ar_s_tue')::uuid, current_setting('dbtest.ar_d1')::uuid),
         (current_setting('dbtest.ar_s_wed')::uuid, current_setting('dbtest.ar_d2')::uuid),
         (current_setting('dbtest.ar_s_mon')::uuid, current_setting('dbtest.ar_d1')::uuid),
         (current_setting('dbtest.ar_s_mon')::uuid, current_setting('dbtest.ar_d2')::uuid))) = 4);
select pg_temp.expect_true('assigned_by: created rows record the acting manager',
  (select count(*) from rota_assignments ra where ra.assignment_source = 'auto' and ra.assigned_by = current_setting('dbtest.manager_id')::uuid
     and ra.shift_instance_id = any (array[current_setting('dbtest.ar_s_tue')::uuid, current_setting('dbtest.ar_s_wed')::uuid, current_setting('dbtest.ar_s_mon')::uuid])
     and ra.driver_id in (current_setting('dbtest.ar_d1')::uuid, current_setting('dbtest.ar_d2')::uuid)) >= 4);
select pg_temp.expect_true('same-resort: every created row carries the resort of its shift and driver',
  not exists (select 1 from rota_assignments ra join shift_instances si on si.id = ra.shift_instance_id join drivers d on d.id = ra.driver_id
               where ra.assignment_source = 'auto' and (ra.resort_id <> si.resort_id or ra.resort_id <> d.resort_id)));
select pg_temp.expect_true('existing assignments (manual AND auto) are completely untouched by the apply',
  (select coalesce(jsonb_agg(to_jsonb(ra) order by ra.id), '[]'::jsonb) from rota_assignments ra
    where ra.id in (select (e ->> 'id')::uuid from jsonb_array_elements(current_setting('dbtest.ar_before_assignments')::jsonb) e))
  = current_setting('dbtest.ar_before_assignments')::jsonb);
select pg_temp.expect_true('the INACTIVE driver''s existing assignment is kept (stored, never removed) alongside the two new Monday rows',
  (select count(*) from rota_assignments where shift_instance_id = current_setting('dbtest.ar_s_mon')::uuid) = 3
  and exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.ar_s_mon')::uuid and driver_id = current_setting('dbtest.ar_di')::uuid));
select pg_temp.expect_equal('availability: the apply changed no availability row',
  (select md5(coalesce(string_agg(a::text, '|' order by a.id), '')) from availability a), current_setting('dbtest.ar_before_availability'));

-- ---- audit ------------------------------------------------------------
select pg_temp.expect_equal('audit: one audit row per created assignment, all carrying this run id',
  (select count(*) from audit_log where table_name = 'rota_assignments' and action = 'insert'
     and context ->> 'run_id' = (current_setting('dbtest.ar_last')::jsonb ->> 'run_id'))::int, 4);
select pg_temp.expect_true('audit: context = auto_rota, resort, week, a normal Available non-override assignment, plus the compact counts',
  (select bool_and(context ->> 'operation' = 'auto_rota'
                   and (context ->> 'resort_id')::uuid = current_setting('dbtest.resort_a')::uuid
                   and (context ->> 'week_start')::date = current_setting('dbtest.ar_w')::date
                   and context ->> 'availability_state' = 'available'
                   and (context -> 'availability_override') = 'false'::jsonb
                   and (context ->> 'created_count')::int = 4
                   and (context ->> 'uncovered_after')::int = 0)
     from audit_log where table_name = 'rota_assignments' and action = 'insert'
      and context ->> 'run_id' = (current_setting('dbtest.ar_last')::jsonb ->> 'run_id')));
select pg_temp.expect_true('audit: the context holds ONLY those eight keys -- never the plan',
  (select bool_and((select array_agg(k order by k) from jsonb_object_keys(context) k)
                   = array['availability_override', 'availability_state', 'created_count', 'operation', 'resort_id', 'run_id', 'uncovered_after', 'week_start'])
     from audit_log where table_name = 'rota_assignments' and action = 'insert'
      and context ->> 'run_id' = (current_setting('dbtest.ar_last')::jsonb ->> 'run_id')));
select pg_temp.expect_true('audit: the actor is the manager who ran it',
  (select bool_and(actor_user_id = current_setting('dbtest.manager_id')::uuid) from audit_log where table_name = 'rota_assignments' and action = 'insert'
      and context ->> 'run_id' = (current_setting('dbtest.ar_last')::jsonb ->> 'run_id')));
update shift_instances set name = 'AR Shift (renamed after run)' where id = current_setting('dbtest.ar_s_mon')::uuid;
select pg_temp.expect_true('audit: the context is cleared after the insert -- a later unrelated audited write does not inherit it',
  (select count(*) from audit_log where table_name = 'shift_instances' and action = 'update' and row_id = current_setting('dbtest.ar_s_mon')::uuid and context is null) = 1);
select pg_temp.expect_true('audit: the transaction-local setting itself is cleared',
  coalesce(nullif(current_setting('app.audit_context', true), ''), 'cleared') = 'cleared');

-- ---- re-run behaviour --------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
do $$
declare
  r jsonb := pg_temp.ar_apply(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date, '[]'::jsonb);
begin
  perform pg_temp.expect_true('re-run: an empty plan on a fully covered draft week succeeds with zero created and no gaps',
    (r ->> 'assigned_count')::int = 0 and (r ->> 'remaining_open_slots')::int = 0 and (r -> 'uncovered_shift_ids') = '[]'::jsonb);
end $$;
select pg_temp.expect_error_detail('re-run: applying the SAME plan again is stale (everything is already assigned) and creates nothing',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s_tue'), current_setting('dbtest.ar_d1'))), 'VD002', 'stale_plan');

-- ---------------------------------------------------------------------
-- Partial coverage and zero eligible drivers are SUCCESS
-- ---------------------------------------------------------------------
do $$
declare
  v_audit_before int;
  r jsonb;
begin
  r := pg_temp.ar_apply(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w2')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s2_mon'), current_setting('dbtest.ar_d1')));
  perform pg_temp.expect_equal('partial coverage: one of two required drivers is eligible -> one assigned, the apply SUCCEEDS', (r ->> 'assigned_count')::int, 1);
  perform pg_temp.expect_equal('partial coverage: remaining_open_slots counts the open Monday slot plus the shift nobody can cover (1 + 1)', (r ->> 'remaining_open_slots')::int, 2);
  perform pg_temp.expect_true('partial coverage: uncovered_shift_ids lists both, in date order (zero eligible drivers is not an error)',
    (r -> 'uncovered_shift_ids') = jsonb_build_array(pg_temp.i('s2_mon'), pg_temp.i('s2_tue')));

  v_audit_before := (select count(*) from audit_log where table_name = 'rota_assignments');
  begin
    -- d2 is Available on Monday (valid) but has no answer for Tuesday (invalid): all or nothing.
    perform pg_temp.ar_apply(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w2')::date,
      pg_temp.ar_plan(current_setting('dbtest.ar_s2_mon'), current_setting('dbtest.ar_d2'), current_setting('dbtest.ar_s2_tue'), current_setting('dbtest.ar_d2')));
    perform pg_temp.record_result('rollback: valid-then-invalid multi-row plan is rejected as a whole', false, 'no error raised');
  exception when sqlstate 'VD002' then
    perform pg_temp.record_result('rollback: valid-then-invalid multi-row plan is rejected as a whole', true, null);
  end;
  perform pg_temp.expect_true('rollback: the valid first row was not written and nothing was audited',
    not exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.ar_s2_mon')::uuid and driver_id = current_setting('dbtest.ar_d2')::uuid)
    and (select count(*) from audit_log where table_name = 'rota_assignments') = v_audit_before);
end $$;

-- ---------------------------------------------------------------------
-- A genuine WRITE failure part-way through the insert rolls everything back
-- ---------------------------------------------------------------------
select pg_temp.as_postgres();
create function public.ar_test_fail() returns trigger language plpgsql as $$
begin
  if new.driver_id = current_setting('dbtest.ar_d5')::uuid then
    raise exception 'ar test: forced write failure';
  end if;
  return new;
end;
$$;
create trigger ar_test_fail before insert on rota_assignments for each row execute function public.ar_test_fail();
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('write failure: the second row cannot be inserted -> the whole apply fails',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w6')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s6a'), current_setting('dbtest.ar_d1'), current_setting('dbtest.ar_s6b'), current_setting('dbtest.ar_d5'))), 'P0001');
select pg_temp.expect_true('write failure: the first row (inserted before the failure) was rolled back, and the audit context did not leak',
  not exists (select 1 from rota_assignments where shift_instance_id in (current_setting('dbtest.ar_s6a')::uuid, current_setting('dbtest.ar_s6b')::uuid))
  and coalesce(nullif(current_setting('app.audit_context', true), ''), 'cleared') = 'cleared');
select pg_temp.as_postgres();
drop trigger ar_test_fail on rota_assignments;
drop function public.ar_test_fail();
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_equal('write failure: with the fault gone the very same plan applies cleanly (nothing was left behind)',
  (pg_temp.ar_apply(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w6')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s6a'), current_setting('dbtest.ar_d1'), current_setting('dbtest.ar_s6b'), current_setting('dbtest.ar_d5'))) ->> 'assigned_count')::int, 2);

-- ---------------------------------------------------------------------
-- Publication guard
-- ---------------------------------------------------------------------
select pg_temp.as_postgres();
select set_config('dbtest.ar_pub3_before',
  (select to_jsonb(rp)::text from rota_publications rp where rp.resort_id = current_setting('dbtest.resort_a')::uuid and rp.week_start = current_setting('dbtest.ar_w3')::date), false);
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('published: even an EMPTY plan is rejected for a currently published week',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w3')::date, '[]'::jsonb), '55006', 'published_week');
select pg_temp.expect_error_detail('published: a plan for a published week is rejected',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w3')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s3'), current_setting('dbtest.ar_d1'))), '55006', 'published_week');
select pg_temp.as_postgres();
select pg_temp.expect_true('published: nothing was inserted and the publication row is byte-for-byte unchanged',
  not exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.ar_s3')::uuid)
  and (select to_jsonb(rp)::text from rota_publications rp where rp.resort_id = current_setting('dbtest.resort_a')::uuid and rp.week_start = current_setting('dbtest.ar_w3')::date)
      = current_setting('dbtest.ar_pub3_before'));

-- Race: the plan was valid on a draft week, then the week was published, then apply runs.
select pg_temp.ar_publish(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w4')::date);
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('race: the week was published after the plan was made -- rejected, no automatic assignment lands in a published week',
  pg_temp.ar_sql(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w4')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s4'), current_setting('dbtest.ar_d1'))), '55006', 'published_week');
select pg_temp.expect_equal('published (retracted): a week whose publication was RETRACTED (unpublished_at set) is a draft again and accepts a plan',
  (pg_temp.ar_apply(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w5')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_s5'), current_setting('dbtest.ar_d1'))) ->> 'assigned_count')::int, 1);

-- ---------------------------------------------------------------------
-- History (resort C: an operational date that is not a Monday, so the current
-- week genuinely holds a past day AND today)
-- ---------------------------------------------------------------------
select pg_temp.expect_error_detail('history: a planned pair targeting a PAST shift is rejected (a malicious plan cannot assign the past)',
  pg_temp.ar_sql(current_setting('dbtest.ar_c')::uuid, current_setting('dbtest.ar_wc')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_sc_past'), current_setting('dbtest.ar_c1'))), '55006', 'historical_shift');
select pg_temp.expect_error_detail('history: a week that is entirely in the past is rejected even with an empty plan',
  pg_temp.ar_sql(current_setting('dbtest.ar_c')::uuid, current_setting('dbtest.ar_wp')::date, '[]'::jsonb), '55006', 'historical_week');
select pg_temp.expect_error_detail('history: ...and with a plan',
  pg_temp.ar_sql(current_setting('dbtest.ar_c')::uuid, current_setting('dbtest.ar_wp')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_sc_week_past'), current_setting('dbtest.ar_c1'))), '55006', 'historical_week');
do $$
declare
  r jsonb;
begin
  r := pg_temp.ar_apply(current_setting('dbtest.ar_c')::uuid, current_setting('dbtest.ar_wc')::date,
    pg_temp.ar_plan(current_setting('dbtest.ar_sc_today'), current_setting('dbtest.ar_c1')));
  perform pg_temp.expect_equal('history: TODAY is assignable (operational date of the resort''s own timezone)', (r ->> 'assigned_count')::int, 1);
  perform pg_temp.expect_true('history: the past shift in the same week is NOT a gap in the result -- only today/future is considered -- and is reported as skipped',
    (r ->> 'remaining_open_slots')::int = 0 and (r -> 'uncovered_shift_ids') = '[]'::jsonb and (r ->> 'skipped_past_shift_count')::int = 1);
end $$;

-- ---------------------------------------------------------------------
-- The week lock: key design, and every writer acquires exactly its own lock
-- ---------------------------------------------------------------------
select pg_temp.as_postgres();
select pg_temp.expect_true('lock key: deterministic -- the same resort + week always maps to the same pair',
  (select k.key1 from rota_week_lock_keys(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date) k)
    = (select k.key1 from rota_week_lock_keys(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date) k)
  and (select k.key2 from rota_week_lock_keys(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date) k)
    = (select k.key2 from rota_week_lock_keys(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date) k));
select pg_temp.expect_true('lock key: documented formula -- key2 is the number of days since 2000-01-01, key1 depends only on the resort',
  (select k.key2 from rota_week_lock_keys(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date) k) = (current_setting('dbtest.ar_w')::date - date '2000-01-01')
  and (select k.key1 from rota_week_lock_keys(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date) k)
    = (select k.key1 from rota_week_lock_keys(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w2')::date) k));
select pg_temp.expect_true('lock key: different weeks, and different resorts, map to different pairs (no needless serialization)',
  (select (k.key1, k.key2) from rota_week_lock_keys(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date) k)
    is distinct from (select (k.key1, k.key2) from rota_week_lock_keys(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w2')::date) k)
  and (select (k.key1, k.key2) from rota_week_lock_keys(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_w')::date) k)
    is distinct from (select (k.key1, k.key2) from rota_week_lock_keys(current_setting('dbtest.resort_b')::uuid, current_setting('dbtest.ar_w')::date) k));

do $$
declare
  v_a uuid := current_setting('dbtest.resort_a')::uuid;
  v_today date := operational_today(v_a);
  v_apply date := pg_temp.ar_monday(v_today + 63);
  v_pub_ins date := pg_temp.ar_monday(v_today + 84);
  v_pub_upd date := pg_temp.ar_monday(v_today + 91);
  v_pub_del date := pg_temp.ar_monday(v_today + 98);
  v_unrelated date := pg_temp.ar_monday(v_today + 105);
  v_assign date := current_setting('dbtest.ar_wl_assign')::date;
  v_unassign date := current_setting('dbtest.ar_wl_unassign')::date;
begin
  perform pg_temp.expect_true('lock: before any writer touches them, none of these weeks is locked by this transaction',
    not pg_temp.ar_lock_held(v_a, v_apply) and not pg_temp.ar_lock_held(v_a, v_assign) and not pg_temp.ar_lock_held(v_a, v_unassign)
    and not pg_temp.ar_lock_held(v_a, v_pub_ins) and not pg_temp.ar_lock_held(v_a, v_pub_upd) and not pg_temp.ar_lock_held(v_a, v_pub_del));
end $$;

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.ar_apply(current_setting('dbtest.resort_a')::uuid, pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 63), '[]'::jsonb);
select pg_temp.expect_true('lock: apply_auto_rota takes the lock for exactly its resort + week',
  pg_temp.ar_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 63)));

select assign_driver(current_setting('dbtest.ar_sl_assign')::uuid, current_setting('dbtest.ar_d1')::uuid);
select pg_temp.expect_true('lock: assign_driver takes the lock for its shift''s resort + week',
  pg_temp.ar_lock_held(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_wl_assign')::date));

select unassign_driver(current_setting('dbtest.ar_sl_unassign')::uuid, current_setting('dbtest.ar_d1')::uuid);
select pg_temp.expect_true('lock: unassign_driver takes the lock for its shift''s resort + week',
  pg_temp.ar_lock_held(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.ar_wl_unassign')::date));

-- Direct publication writes are owner-only since PB-A (publish_rota is the manager path,
-- proven to take the same lock in 87_publish_rota.sql); the trigger fires for any writer.
select pg_temp.as_postgres();
insert into rota_publications (resort_id, week_start, generation_source)
values (current_setting('dbtest.resort_a')::uuid, pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 84), 'manual');
select pg_temp.expect_true('lock: a publication INSERT (publish) takes the lock for its resort + week',
  pg_temp.ar_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 84)));

update rota_publications set unpublished_at = now()
 where resort_id = current_setting('dbtest.resort_a')::uuid and week_start = pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 91);
select pg_temp.expect_true('lock: a publication UPDATE (unpublish) takes the lock for its resort + week',
  pg_temp.ar_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 91)));

select pg_temp.as_postgres();
delete from rota_publications
 where resort_id = current_setting('dbtest.resort_a')::uuid and week_start = pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 98);
select pg_temp.expect_true('lock: a publication DELETE takes the lock for its resort + week',
  pg_temp.ar_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 98)));
select pg_temp.expect_true('lock: an unrelated week of the same resort, and the same week of another resort, are NOT locked',
  not pg_temp.ar_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 105))
  and not pg_temp.ar_lock_held(current_setting('dbtest.resort_b')::uuid, pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 63)));
select pg_temp.expect_true('lock: publication semantics are unchanged -- the retracted row keeps its published_at, only unpublished_at was set',
  (select published_at is not null and unpublished_at is not null from rota_publications
    where resort_id = current_setting('dbtest.resort_a')::uuid and week_start = pg_temp.ar_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 91)));
