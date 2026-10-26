-- Publish Rota PB-A: publish_rota (the manager-only, SECURITY DEFINER, server-
-- authoritative publish) and the closure of direct manager writes to
-- rota_publications.
--
-- Real blocking between two connections cannot be shown inside this single
-- transaction; the lock is proven STRUCTURALLY here (publish_rota holds the
-- advisory lock for exactly its resort/week) and the interleavings are proven by
-- ordered-state tests (state changes between the confirmation prompt and the
-- confirmed call; Auto-Rota applied before / refused after a publish). Actual
-- two-connection blocking was verified separately against the live local stack
-- (see the PB-A report).
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
       and sqlerrm !~* '(violates|constraint|_fkey|_unique|rota_publications|rota_assignments|availability_|publish_rota\()' then
      perform pg_temp.record_result(p_name, true, null);
    else
      perform pg_temp.record_result(p_name, false,
        format('expected sqlstate %s / detail %s / friendly message; got %s / detail %s / "%s"', p_sqlstate, p_detail, sqlstate, v_detail, sqlerrm));
    end if;
  end;
end;
$$;

create function pg_temp.k(p_name text) returns text language sql as $$ select current_setting('dbtest.pb_' || p_name) $$;
create function pg_temp.kid(p_name text) returns uuid language sql as $$ select current_setting('dbtest.pb_' || p_name)::uuid $$;
create function pg_temp.kd(p_name text) returns date language sql as $$ select current_setting('dbtest.pb_' || p_name)::date $$;

create function pg_temp.pb_monday(p_d date) returns date language sql as $$ select p_d - app_weekday(p_d)::integer $$;

create function pg_temp.pb_instance(p_resort uuid, p_type uuid, p_date date, p_required int, p_status text default 'active')
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into shift_instances (resort_id, date, shift_type_id, shift_key, name, sort_order, start_time, end_time,
                               required_drivers, status, origin, cancelled_at, cancelled_reason)
  values (p_resort, p_date, p_type, 'pb-test', 'PB Shift', 1, '18:00', '21:30',
          p_required, p_status, 'adhoc',
          case when p_status = 'cancelled' then now() end,
          case when p_status = 'cancelled' then 'pb test' end)
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.pb_driver(p_resort uuid, p_name text, p_active boolean default true)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into drivers (resort_id, full_name, is_active) values (p_resort, p_name, p_active) returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.pb_avail(p_instance uuid, p_driver uuid, p_status text)
returns void language plpgsql security definer as $$
begin
  insert into availability (driver_id, resort_id, shift_instance_id, status)
  values (p_driver, (select resort_id from shift_instances where id = p_instance), p_instance, p_status)
  on conflict (driver_id, shift_instance_id) do update set status = excluded.status;
end;
$$;

create function pg_temp.pb_seed(p_instance uuid, p_driver uuid, p_source text default 'manual')
returns void language plpgsql security definer as $$
begin
  insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source)
  values (p_instance, p_driver, (select resort_id from shift_instances where id = p_instance), p_source);
end;
$$;

-- A publication row written directly as the database owner (the only way to
-- create a retracted row in V1: there is no unpublish RPC).
create function pg_temp.pb_retracted(p_resort uuid, p_week date, p_source text default 'manual')
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into rota_publications (resort_id, week_start, generation_source, published_at, unpublished_at)
  values (p_resort, p_week, p_source, now() - interval '2 hours', now() - interval '1 hour')
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.pb_call(p_resort uuid, p_week date, p_confirm boolean default false) returns jsonb language sql as $$
  select to_jsonb(r) from publish_rota(p_resort, p_week, p_confirm) r
$$;

create function pg_temp.pb_sql(p_resort uuid, p_week date, p_confirm boolean default false) returns text language sql as $$
  select format('select pg_temp.pb_call(%L::uuid, %L::date, %L::boolean)', p_resort, p_week, p_confirm)
$$;

-- Rows / audit rows as seen by the database owner.
create function pg_temp.pb_pub_count(p_resort uuid, p_week date) returns integer language sql security definer as $$
  select count(*)::integer from rota_publications where resort_id = p_resort and week_start = p_week
$$;

create function pg_temp.pb_audit_count(p_resort uuid, p_week date) returns integer language sql security definer as $$
  select count(*)::integer from audit_log a
  where a.table_name = 'rota_publications'
    and a.row_id in (select id from rota_publications where resort_id = p_resort and week_start = p_week)
$$;

create function pg_temp.pb_audit_ctx(p_resort uuid, p_week date, p_action text) returns jsonb language sql security definer as $$
  select a.context from audit_log a
  where a.table_name = 'rota_publications' and a.action = p_action
    and a.row_id in (select id from rota_publications where resort_id = p_resort and week_start = p_week)
  order by a.occurred_at desc, a.id limit 1
$$;

create function pg_temp.pb_row(p_resort uuid, p_week date) returns jsonb language sql security definer as $$
  select to_jsonb(rp) from rota_publications rp where resort_id = p_resort and week_start = p_week
$$;

-- Does THIS backend hold the advisory lock for (resort, week)? (pg_locks shows a
-- two-int-key advisory lock as classid = key1, objid = key2, objsubid = 2.)
create function pg_temp.pb_lock_held(p_resort uuid, p_week date)
returns boolean language sql security definer as $$
  select exists (
    select 1
    from pg_locks l, rota_week_lock_keys(p_resort, p_week) k
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 2
      and l.classid::bigint = (k.key1::bigint & 4294967295)
      and l.objid::bigint = (k.key2::bigint & 4294967295)
  )
$$;

create function pg_temp.pb_plan(variadic p_pairs text[]) returns jsonb language plpgsql as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_n int;
begin
  for v_n in 1 .. coalesce(array_length(p_pairs, 1), 0) / 2 loop
    v_out := v_out || jsonb_build_array(jsonb_build_object('shift_instance_id', p_pairs[2 * v_n - 1], 'driver_id', p_pairs[2 * v_n]));
  end loop;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------
-- Fixtures (as database owner)
-- ---------------------------------------------------------------------
do $$
declare
  v_a uuid := current_setting('dbtest.resort_a')::uuid;
  v_b uuid := current_setting('dbtest.resort_b')::uuid;
  v_c uuid; v_d uuid; v_e uuid;
  v_tz text;
  v_today date := operational_today(v_a);
  v_type_a uuid; v_type_b uuid; v_type_c uuid; v_type_c2 uuid; v_type_d uuid; v_type_e uuid;
  d1 uuid := current_setting('dbtest.driver_a_id')::uuid;
  d2 uuid; d3 uuid; di uuid; c1 uuid;
  v_tc date; v_wc date; v_wd date;
  w date;
  s1 uuid; s2 uuid; s3 uuid;
begin
  insert into shift_types (resort_id, key, name, sort_order) values (v_a, 'pb-test', 'PB Shift', 1) returning id into v_type_a;
  insert into shift_types (resort_id, key, name, sort_order) values (v_b, 'pb-test', 'PB Shift', 1) returning id into v_type_b;
  d2 := pg_temp.pb_driver(v_a, 'PB Driver 2');
  d3 := pg_temp.pb_driver(v_a, 'PB Driver 3');
  di := pg_temp.pb_driver(v_a, 'PB Driver Inactive', false);
  perform set_config('dbtest.pb_d1', d1::text, false);
  perform set_config('dbtest.pb_d2', d2::text, false);
  perform set_config('dbtest.pb_d3', d3::text, false);
  perform set_config('dbtest.pb_di', di::text, false);

  -- ---- w_unc: three open positions (Mon x2, Tue x1) + a cancelled shift; no assignments
  w := pg_temp.pb_monday(v_today + 14);
  perform set_config('dbtest.pb_w_unc', w::text, false);
  perform set_config('dbtest.pb_unc_mon', pg_temp.pb_instance(v_a, v_type_a, w, 2)::text, false);
  perform pg_temp.pb_instance(v_a, v_type_a, w + 1, 1);
  perform pg_temp.pb_instance(v_a, v_type_a, w + 2, 1, 'cancelled');

  -- ---- w_cov: fully covered, manual assignments only
  w := pg_temp.pb_monday(v_today + 21);
  perform set_config('dbtest.pb_w_cov', w::text, false);
  s1 := pg_temp.pb_instance(v_a, v_type_a, w, 1);
  s2 := pg_temp.pb_instance(v_a, v_type_a, w + 1, 1);
  perform pg_temp.pb_seed(s1, d1);
  perform pg_temp.pb_seed(s2, d2);
  -- the same week in ANOTHER resort (must stay untouched by publishing resort A)
  perform pg_temp.pb_instance(v_b, v_type_b, w, 1);

  -- ---- w_auto: fully covered, one AUTO assignment
  w := pg_temp.pb_monday(v_today + 28);
  perform set_config('dbtest.pb_w_auto', w::text, false);
  s1 := pg_temp.pb_instance(v_a, v_type_a, w, 1);
  s2 := pg_temp.pb_instance(v_a, v_type_a, w + 1, 1);
  perform pg_temp.pb_seed(s1, d2, 'auto');
  perform pg_temp.pb_seed(s2, d1);

  -- ---- w_none: no shifts at all | w_canc: only a cancelled shift
  perform set_config('dbtest.pb_w_none', pg_temp.pb_monday(v_today + 35)::text, false);
  w := pg_temp.pb_monday(v_today + 42);
  perform set_config('dbtest.pb_w_canc', w::text, false);
  perform pg_temp.pb_instance(v_a, v_type_a, w, 1, 'cancelled');

  -- ---- w_rep: a RETRACTED publication (source manual), covered by a manual assignment
  --      that later gets an auto sibling -> republish recomputes 'auto'
  w := pg_temp.pb_monday(v_today + 49);
  perform set_config('dbtest.pb_w_rep', w::text, false);
  s1 := pg_temp.pb_instance(v_a, v_type_a, w, 1);
  s2 := pg_temp.pb_instance(v_a, v_type_a, w + 1, 1);
  perform pg_temp.pb_seed(s1, d1);
  perform pg_temp.pb_seed(s2, d2, 'auto');
  perform set_config('dbtest.pb_rep_id', pg_temp.pb_retracted(v_a, w, 'manual')::text, false);

  -- ---- w_rep2: a retracted publication stored as 'auto', but NO auto assignment now
  w := pg_temp.pb_monday(v_today + 91);
  perform set_config('dbtest.pb_w_rep2', w::text, false);
  s1 := pg_temp.pb_instance(v_a, v_type_a, w, 1);
  perform pg_temp.pb_seed(s1, d1);
  perform set_config('dbtest.pb_rep2_id', pg_temp.pb_retracted(v_a, w, 'auto')::text, false);

  -- ---- w_sub: coverage definition. Mon needs 2: d1 + an INACTIVE driver (only d1 counts -> 1 open).
  --      Tue needs 1 and has 2 (over-assigned -> 0, never negative). Wed is cancelled & unstaffed (ignored).
  w := pg_temp.pb_monday(v_today + 56);
  perform set_config('dbtest.pb_w_sub', w::text, false);
  s1 := pg_temp.pb_instance(v_a, v_type_a, w, 2);
  s2 := pg_temp.pb_instance(v_a, v_type_a, w + 1, 1);
  perform pg_temp.pb_seed(s1, d1);
  perform pg_temp.pb_seed(s1, di);
  perform pg_temp.pb_seed(s2, d2);
  perform pg_temp.pb_seed(s2, d3);
  perform pg_temp.pb_instance(v_a, v_type_a, w + 2, 1, 'cancelled');

  -- ---- w_stale: three open positions; the count changes between prompt and confirm
  w := pg_temp.pb_monday(v_today + 63);
  perform set_config('dbtest.pb_w_stale', w::text, false);
  perform set_config('dbtest.pb_stale_mon', pg_temp.pb_instance(v_a, v_type_a, w, 1)::text, false);
  perform set_config('dbtest.pb_stale_tue', pg_temp.pb_instance(v_a, v_type_a, w + 1, 1)::text, false);
  perform pg_temp.pb_instance(v_a, v_type_a, w + 2, 1);
  perform pg_temp.pb_avail(pg_temp.kid('stale_mon'), d1, 'available');

  -- ---- w_post: publish, then keep editing manually / try Auto-Rota
  w := pg_temp.pb_monday(v_today + 70);
  perform set_config('dbtest.pb_w_post', w::text, false);
  s1 := pg_temp.pb_instance(v_a, v_type_a, w, 2);
  s2 := pg_temp.pb_instance(v_a, v_type_a, w + 1, 1);
  perform set_config('dbtest.pb_post_mon', s1::text, false);
  perform set_config('dbtest.pb_post_tue', s2::text, false);
  perform pg_temp.pb_avail(s1, d1, 'available');
  perform pg_temp.pb_avail(s1, d2, 'available');
  perform pg_temp.pb_avail(s2, d3, 'available');
  perform pg_temp.pb_seed(s2, d3);

  -- ---- w_dr: driver visibility. driver_a (d1) on Mon, a colleague (d2) on Tue.
  w := pg_temp.pb_monday(v_today + 77);
  perform set_config('dbtest.pb_w_dr', w::text, false);
  s1 := pg_temp.pb_instance(v_a, v_type_a, w, 1);
  s2 := pg_temp.pb_instance(v_a, v_type_a, w + 1, 1);
  perform set_config('dbtest.pb_dr_mon', s1::text, false);
  perform set_config('dbtest.pb_dr_tue', s2::text, false);
  perform pg_temp.pb_seed(s1, d1);
  perform pg_temp.pb_seed(s2, d2);
  perform pg_temp.pb_avail(s1, d1, 'available');

  -- ---- w_apply: Auto-Rota applies first, then the week is published
  w := pg_temp.pb_monday(v_today + 84);
  perform set_config('dbtest.pb_w_apply', w::text, false);
  s1 := pg_temp.pb_instance(v_a, v_type_a, w, 1);
  perform set_config('dbtest.pb_apply_mon', s1::text, false);
  perform pg_temp.pb_avail(s1, d2, 'available');

  -- ---- w_idem: a second fully-covered week to prove the idempotent path takes the lock too
  w := pg_temp.pb_monday(v_today + 98);
  perform set_config('dbtest.pb_w_idem', w::text, false);
  perform pg_temp.pb_seed(pg_temp.pb_instance(v_a, v_type_a, w, 1), d1);

  -- ---- historical, resort A: a wholly past week WITH a shift, and one with none
  w := pg_temp.pb_monday(v_today - 14);
  perform set_config('dbtest.pb_w_past', w::text, false);
  perform pg_temp.pb_instance(v_a, v_type_a, w + 2, 1);
  perform set_config('dbtest.pb_w_pastempty', pg_temp.pb_monday(v_today - 21)::text, false);

  -- ---- an unrelated draft week for untouched-state checks
  w := pg_temp.pb_monday(v_today + 105);
  perform set_config('dbtest.pb_w_draft', w::text, false);
  perform pg_temp.pb_instance(v_a, v_type_a, w, 1);

  -- ---- Resorts C and D: a timezone whose operational date is NOT a Monday, so the
  --      current week genuinely contains a past day and a today.
  select z into v_tz from (values ('Etc/GMT+12'), ('Europe/Zurich'), ('Pacific/Kiritimati')) t(z)
   where app_weekday((now() at time zone z)::date) >= 1 order by z limit 1;

  -- C: current week, partially historical. Past Monday-ish gap (ignored), today covered, today open.
  insert into resorts (slug, name, timezone) values ('dbtest-pb-c', 'PB Test Resort C', v_tz) returning id into v_c;
  insert into shift_types (resort_id, key, name, sort_order) values (v_c, 'pb-test', 'PB Shift', 1) returning id into v_type_c;
  insert into shift_types (resort_id, key, name, sort_order) values (v_c, 'pb-test-2', 'PB Shift 2', 2) returning id into v_type_c2;
  v_tc := operational_today(v_c);
  v_wc := pg_temp.pb_monday(v_tc);
  c1 := pg_temp.pb_driver(v_c, 'PB Driver C1');
  perform set_config('dbtest.pb_c', v_c::text, false);
  perform set_config('dbtest.pb_wc', v_wc::text, false);
  perform pg_temp.pb_instance(v_c, v_type_c, v_tc - 1, 1);                             -- past, unstaffed: NOT counted
  perform pg_temp.pb_seed(pg_temp.pb_instance(v_c, v_type_c, v_tc, 1), c1);            -- today, covered
  perform set_config('dbtest.pb_c_open', pg_temp.pb_instance(v_c, v_type_c2, v_tc, 1)::text, false); -- today, open

  -- D: current week, every ACTIVE shift is before today (the cancelled one is today)
  insert into resorts (slug, name, timezone) values ('dbtest-pb-d', 'PB Test Resort D', v_tz) returning id into v_d;
  insert into shift_types (resort_id, key, name, sort_order) values (v_d, 'pb-test', 'PB Shift', 1) returning id into v_type_d;
  v_wd := pg_temp.pb_monday(operational_today(v_d));
  perform set_config('dbtest.pb_d', v_d::text, false);
  perform set_config('dbtest.pb_wd', v_wd::text, false);
  perform pg_temp.pb_instance(v_d, v_type_d, v_wd, 1);
  perform pg_temp.pb_instance(v_d, v_type_d, operational_today(v_d), 1, 'cancelled');

  -- E: an inactive resort with a future shift
  insert into resorts (slug, name, timezone) values ('dbtest-pb-e', 'PB Test Resort E', 'Europe/Zurich') returning id into v_e;
  insert into shift_types (resort_id, key, name, sort_order) values (v_e, 'pb-test', 'PB Shift', 1) returning id into v_type_e;
  w := pg_temp.pb_monday(operational_today(v_e) + 14);
  perform set_config('dbtest.pb_e', v_e::text, false);
  perform set_config('dbtest.pb_we', w::text, false);
  perform pg_temp.pb_instance(v_e, v_type_e, w, 1);
  update resorts set is_active = false where id = v_e;
end $$;

-- ---------------------------------------------------------------------
-- 1. Security surface
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error_detail('security: an authenticated DRIVER cannot call publish_rota (42501)',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')), '42501');
select pg_temp.expect_true('security: a driver cannot read rota_publications directly (zero rows)',
  (select count(*) from rota_publications) = 0);

select pg_temp.act_as('anon');
select pg_temp.expect_error_detail('security: anon cannot call publish_rota (42501)',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')), '42501');
select pg_temp.expect_error('security: anon cannot read rota_publications (42501)', 'select count(*) from rota_publications', '42501');

select pg_temp.as_postgres();
select pg_temp.expect_true('security: EXECUTE on publish_rota is granted to authenticated only, never anon',
  has_function_privilege('authenticated', 'publish_rota(uuid,date,boolean)', 'execute')
  and not has_function_privilege('anon', 'publish_rota(uuid,date,boolean)', 'execute'));
select pg_temp.expect_true('security: authenticated keeps SELECT on rota_publications but has NO insert / update / delete',
  has_table_privilege('authenticated', 'public.rota_publications', 'select')
  and not has_table_privilege('authenticated', 'public.rota_publications', 'insert')
  and not has_table_privilege('authenticated', 'public.rota_publications', 'update')
  and not has_table_privilege('authenticated', 'public.rota_publications', 'delete'));
select pg_temp.expect_true('security: the FOR ALL manager policy is gone and a SELECT-only manager policy replaces it',
  not exists (select 1 from pg_policies where tablename = 'rota_publications' and policyname = 'rota_publications_manager_all')
  and exists (select 1 from pg_policies where tablename = 'rota_publications' and policyname = 'rota_publications_manager_select' and cmd = 'SELECT'));
select pg_temp.expect_true('security: publish_rota is SECURITY DEFINER with a pinned search_path',
  (select p.prosecdef and p.proconfig::text like '%search_path%' from pg_proc p where p.proname = 'publish_rota'));

-- ---------------------------------------------------------------------
-- 2. Request shape
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('shape: a null resort is rejected (22023)',
  format('select pg_temp.pb_call(null::uuid, %L::date)', pg_temp.k('w_cov')), '22023');
select pg_temp.expect_error_detail('shape: a null week is rejected (22023)',
  format('select pg_temp.pb_call(%L::uuid, null::date)', current_setting('dbtest.resort_a')), '22023');
select pg_temp.expect_error_detail('shape: a week that is not a Monday is rejected (22023)',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov') + 1), '22023');
select pg_temp.expect_error_detail('shape: an unknown resort is not found (P0002)',
  pg_temp.pb_sql(gen_random_uuid(), pg_temp.kd('w_cov')), 'P0002');
select pg_temp.expect_error_detail('guard: an INACTIVE resort cannot publish (23514, DETAIL resort_inactive)',
  pg_temp.pb_sql(pg_temp.kid('e'), pg_temp.kd('we'), true), '23514', 'resort_inactive');
select pg_temp.expect_equal('guard: nothing was written for the inactive resort', pg_temp.pb_pub_count(pg_temp.kid('e'), pg_temp.kd('we')), 0);

-- ---------------------------------------------------------------------
-- 3. Publishability guards (nothing is ever written when they fire)
-- ---------------------------------------------------------------------
select pg_temp.expect_error_detail('guard: zero shifts -> 23514 no_shifts',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_none'), true), '23514', 'no_shifts');
select pg_temp.expect_error_detail('guard: a week with only CANCELLED shifts is also no_shifts',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_canc'), true), '23514', 'no_shifts');
select pg_temp.expect_error_detail('guard: a wholly past week with shifts -> 55006 historical_week',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_past'), true), '55006', 'historical_week');
select pg_temp.expect_error_detail('guard: a wholly past week with NO shifts is historical_week (past takes precedence)',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_pastempty'), true), '55006', 'historical_week');
select pg_temp.expect_error_detail('guard: a current week whose every active shift is before today -> historical_week',
  pg_temp.pb_sql(pg_temp.kid('d'), pg_temp.kd('wd'), true), '55006', 'historical_week');
select pg_temp.expect_true('guard: none of the rejected weeks gained a publication row',
  pg_temp.pb_pub_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_none')) = 0
  and pg_temp.pb_pub_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_canc')) = 0
  and pg_temp.pb_pub_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_past')) = 0
  and pg_temp.pb_pub_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_pastempty')) = 0
  and pg_temp.pb_pub_count(pg_temp.kid('d'), pg_temp.kd('wd')) = 0);

-- ---------------------------------------------------------------------
-- 4. Uncovered acknowledgement (server-authoritative)
-- ---------------------------------------------------------------------
-- Zero assignments: every position is open.
select pg_temp.expect_error_detail('uncovered: an unconfirmed publish with open positions -> VD003 carrying the count (3: Mon x2 + Tue; the cancelled shift is ignored)',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_unc')), 'VD003', '3');
select pg_temp.expect_error_detail('uncovered: an explicit confirm = false behaves the same',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_unc'), false), 'VD003', '3');
select pg_temp.expect_error_detail('uncovered: a NULL confirm is treated as not confirmed',
  format('select pg_temp.pb_call(%L::uuid, %L::date, null::boolean)', current_setting('dbtest.resort_a'), pg_temp.k('w_unc')), 'VD003', '3');
select pg_temp.expect_equal('uncovered: VD003 wrote nothing (no publication row)',
  pg_temp.pb_pub_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_unc')), 0);

-- Coverage definition: inactive assignee does not count; over-assignment never goes negative;
-- cancelled shifts are ignored. w_sub = (2 - 1 active) + max(1 - 2, 0) = 1.
select pg_temp.expect_error_detail('uncovered: counts only ACTIVE drivers, never negative, ignores cancelled shifts (w_sub = 1)',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_sub')), 'VD003', '1');

-- Past gaps are not counted: resort C has an unstaffed PAST shift, a covered today shift and ONE open today shift.
select pg_temp.expect_error_detail('uncovered: a past unstaffed shift is not counted (partially historical week: 1, not 2)',
  pg_temp.pb_sql(pg_temp.kid('c'), pg_temp.kd('wc')), 'VD003', '1');

-- A fully covered week needs no confirmation at all.
select set_config('dbtest.pb_r_cov', pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov'))::text, false);
select pg_temp.expect_true('uncovered: a fully covered week publishes without any confirmation (uncovered_slots 0, not already published)',
  (pg_temp.k('r_cov')::jsonb ->> 'uncovered_slots')::int = 0 and (pg_temp.k('r_cov')::jsonb ->> 'already_published')::boolean = false);

-- Zero assignments may be published through the confirmation flow.
select set_config('dbtest.pb_r_unc', pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_unc'), true)::text, false);
select pg_temp.expect_true('uncovered: a week with ZERO assignments publishes once confirmed (uncovered_slots 3)',
  (pg_temp.k('r_unc')::jsonb ->> 'uncovered_slots')::int = 3 and (pg_temp.k('r_unc')::jsonb ->> 'already_published')::boolean = false);

-- The count in the prompt can go stale; the CONFIRMED call recomputes under the lock.
select pg_temp.expect_error_detail('stale ack: the prompt says 3 open positions',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_stale')), 'VD003', '3');
select assign_driver(pg_temp.kid('stale_mon'), pg_temp.kid('d1'));   -- another manager fills one position meanwhile
select set_config('dbtest.pb_r_stale', pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_stale'), true)::text, false);
select pg_temp.expect_equal('stale ack: the confirmed call reports the CURRENT count (2), not the 3 the manager saw',
  (pg_temp.k('r_stale')::jsonb ->> 'uncovered_slots')::int, 2);
select pg_temp.expect_equal('stale ack: the audit row records the real count at publish time (2), with confirmed_uncovered true',
  (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_stale'), 'insert') ->> 'uncovered_slots')::int, 2);
select pg_temp.expect_true('stale ack: confirmed_uncovered is true in that audit row',
  (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_stale'), 'insert') ->> 'confirmed_uncovered')::boolean);

-- Confirming a week that turns out to be fully covered is harmless and is not recorded as an acknowledgement.
select set_config('dbtest.pb_r_auto', pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_auto'), true)::text, false);
select pg_temp.expect_true('uncovered: confirm = true on a fully covered week publishes with uncovered_slots 0',
  (pg_temp.k('r_auto')::jsonb ->> 'uncovered_slots')::int = 0);
select pg_temp.expect_true('uncovered: ...and the audit row records confirmed_uncovered = false (nothing was acknowledged)',
  not (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_auto'), 'insert') ->> 'confirmed_uncovered')::boolean);

-- Partially historical week: publishes once the open TODAY position is acknowledged.
select set_config('dbtest.pb_r_c', pg_temp.pb_call(pg_temp.kid('c'), pg_temp.kd('wc'), true)::text, false);
select pg_temp.expect_equal('partially historical: a current week with a past day publishes once confirmed (uncovered_slots 1)',
  (pg_temp.k('r_c')::jsonb ->> 'uncovered_slots')::int, 1);

-- ---------------------------------------------------------------------
-- 5. The publication row, the result and generation_source
-- ---------------------------------------------------------------------
select pg_temp.expect_true('row: the result carries the resort, week and the stored published_at',
  (pg_temp.k('r_cov')::jsonb ->> 'resort_id') = current_setting('dbtest.resort_a')
  and (pg_temp.k('r_cov')::jsonb ->> 'week_start') = pg_temp.k('w_cov')
  and (pg_temp.k('r_cov')::jsonb ->> 'published_at')::timestamptz = (pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')) ->> 'published_at')::timestamptz);
select pg_temp.expect_true('row: published_by is the manager, unpublished_at is null, exactly one row',
  (pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')) ->> 'published_by') = current_setting('dbtest.manager_id')
  and (pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')) -> 'unpublished_at') = 'null'::jsonb
  and pg_temp.pb_pub_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')) = 1);
select pg_temp.expect_equal('source: manual assignments only -> manual',
  pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')) ->> 'generation_source', 'manual');
select pg_temp.expect_equal('source: at least one auto assignment -> auto',
  pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_auto')) ->> 'generation_source', 'auto');
select pg_temp.expect_equal('source: zero assignments -> manual',
  pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_unc')) ->> 'generation_source', 'manual');

-- Auto-Rota applied first, then published: the server derives 'auto' from the stored assignment.
select pg_temp.expect_equal('source: Auto-Rota applied to the draft week first (1 assignment created)...',
  (select assigned_count from apply_auto_rota(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_apply'),
     pg_temp.pb_plan(pg_temp.k('apply_mon'), pg_temp.k('d2')))), 1);
select set_config('dbtest.pb_r_apply', pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_apply'))::text, false);
select pg_temp.expect_true('source: ...so the covered week publishes without confirmation',
  (pg_temp.k('r_apply')::jsonb ->> 'uncovered_slots')::int = 0);
select pg_temp.expect_equal('source: ...and generation_source is auto',
  pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_apply')) ->> 'generation_source', 'auto');

-- ---------------------------------------------------------------------
-- 6. Retracted rows are republished by UPDATE (unique per resort + week); source recomputed
-- ---------------------------------------------------------------------
select pg_temp.expect_true('republish: before publishing, the retracted row exists and is not currently published',
  (pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep')) -> 'unpublished_at') <> 'null'::jsonb);
select set_config('dbtest.pb_r_rep', pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep'))::text, false);
select pg_temp.expect_true('republish: succeeds, is not reported as already published, and the SAME row is reused (one row, same id)',
  (pg_temp.k('r_rep')::jsonb ->> 'already_published')::boolean = false
  and pg_temp.pb_pub_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep')) = 1
  and (pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep')) ->> 'id') = pg_temp.k('rep_id'));
select pg_temp.expect_true('republish: unpublished_at cleared, published_at refreshed, published_by is the manager',
  (pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep')) -> 'unpublished_at') = 'null'::jsonb
  and (pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep')) ->> 'published_at')::timestamptz > now() - interval '1 hour'
  and (pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep')) ->> 'published_by') = current_setting('dbtest.manager_id'));
select pg_temp.expect_equal('republish: generation_source is RECOMPUTED from current assignments (stored manual -> an auto assignment exists -> auto)',
  pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep')) ->> 'generation_source', 'auto');
select pg_temp.expect_true('republish: the audit row is an UPDATE whose context says republished = true',
  (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep'), 'update') ->> 'republished')::boolean);

select pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep2'));
select pg_temp.expect_equal('republish: a row stored as auto with NO auto assignment now is recomputed to manual',
  pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_rep2')) ->> 'generation_source', 'manual');

-- ---------------------------------------------------------------------
-- 7. Already published is an idempotent success
-- ---------------------------------------------------------------------
select set_config('dbtest.pb_before_cov', pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov'))::text, false);
select set_config('dbtest.pb_audit_cov', pg_temp.pb_audit_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov'))::text, false);
select set_config('dbtest.pb_r_again', pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov'))::text, false);
select pg_temp.expect_true('idempotent: a second publish succeeds with already_published = true and the ORIGINAL published_at',
  (pg_temp.k('r_again')::jsonb ->> 'already_published')::boolean
  and (pg_temp.k('r_again')::jsonb ->> 'published_at')::timestamptz = (pg_temp.k('before_cov')::jsonb ->> 'published_at')::timestamptz);
select pg_temp.expect_true('idempotent: no write -- the row is byte-for-byte unchanged (even updated_at) and still one row',
  pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')) = pg_temp.k('before_cov')::jsonb
  and pg_temp.pb_pub_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')) = 1);
select pg_temp.expect_equal('idempotent: no additional audit event',
  pg_temp.pb_audit_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')), pg_temp.k('audit_cov')::int);
select pg_temp.expect_true('idempotent: a week published WITH uncovered positions republishes as a success without asking again (no VD003), reporting the current count',
  (pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_unc')) ->> 'already_published')::boolean
  and (pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_unc')) ->> 'uncovered_slots')::int = 3);
select pg_temp.expect_true('idempotent: it is checked before the historical / no-shifts guards (a published week stays a success)',
  (pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_unc'), true) ->> 'already_published')::boolean);

-- ---------------------------------------------------------------------
-- 8. Audit contract
-- ---------------------------------------------------------------------
select pg_temp.expect_true('audit: an insert audit row carries the full publish_rota context',
  (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov'), 'insert') ->> 'operation') = 'publish_rota'
  and (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov'), 'insert') ->> 'resort_id') = current_setting('dbtest.resort_a')
  and (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov'), 'insert') ->> 'week_start') = pg_temp.k('w_cov')
  and (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov'), 'insert') ->> 'uncovered_slots') = '0'
  and (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov'), 'insert') ->> 'generation_source') = 'manual'
  and (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov'), 'insert') ->> 'republished') = 'false');
select pg_temp.expect_true('audit: a confirmed publish of an uncovered week records the count and confirmed_uncovered = true',
  (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_unc'), 'insert') ->> 'uncovered_slots') = '3'
  and (pg_temp.pb_audit_ctx(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_unc'), 'insert') ->> 'confirmed_uncovered') = 'true');
select pg_temp.as_postgres();
select pg_temp.expect_true('audit: the actor is the publishing manager',
  exists (select 1 from audit_log a join rota_publications rp on rp.id = a.row_id
          where a.table_name = 'rota_publications' and a.action = 'insert' and a.actor_user_id = current_setting('dbtest.manager_id')::uuid
            and rp.resort_id = current_setting('dbtest.resort_a')::uuid and rp.week_start = pg_temp.kd('w_cov')));
select pg_temp.expect_true('audit: the audit context setting is cleared after the write',
  coalesce(current_setting('app.audit_context', true), '') = '');
select set_config('dbtest.pb_audit_total', (select count(*) from audit_log where table_name = 'rota_publications')::text, false);

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error('audit setup: a rejected publish (VD003) ...', pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_sub')), 'VD003');
select pg_temp.expect_error('audit setup: ... a historical rejection ...', pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_past'), true), '55006');
select pg_temp.expect_error('audit setup: ... and a no-shifts rejection', pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_none'), true), '23514');
select pg_temp.as_postgres();
select pg_temp.expect_equal('audit: rejected publishes wrote no audit rows at all',
  (select count(*) from audit_log where table_name = 'rota_publications')::text, pg_temp.k('audit_total'));
select pg_temp.expect_true('audit: a rejected publish leaves no stray audit context behind',
  coalesce(current_setting('app.audit_context', true), '') = '');

-- ---------------------------------------------------------------------
-- 9. Direct manager writes are closed; SELECT is kept
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error('closed: a manager can no longer INSERT into rota_publications (42501)',
  format('insert into rota_publications (resort_id, week_start, generation_source) values (%L::uuid, %L::date, %L)',
    current_setting('dbtest.resort_a'), pg_temp.k('w_draft'), 'manual'), '42501');
select pg_temp.expect_error('closed: a manager can no longer UPDATE rota_publications (42501)',
  format('update rota_publications set unpublished_at = now() where resort_id = %L::uuid and week_start = %L::date',
    current_setting('dbtest.resort_a'), pg_temp.k('w_cov')), '42501');
select pg_temp.expect_error('closed: a manager still cannot DELETE rota_publications (42501)',
  format('delete from rota_publications where resort_id = %L::uuid and week_start = %L::date',
    current_setting('dbtest.resort_a'), pg_temp.k('w_cov')), '42501');
select pg_temp.expect_true('closed: ...but a manager can still READ publication state (the manager rota / Availability panel need it)',
  (select count(*) from rota_publications where resort_id = current_setting('dbtest.resort_a')::uuid and week_start = pg_temp.kd('w_cov')) = 1);
select pg_temp.expect_equal('closed: the failed writes changed nothing',
  pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')), pg_temp.k('before_cov')::jsonb);

-- ---------------------------------------------------------------------
-- 10. Driver visibility (live, no snapshot) and cross-resort isolation
-- ---------------------------------------------------------------------
select pg_temp.as_postgres();
select set_config('dbtest.pb_assign_before', (select count(*) from rota_assignments ra join shift_instances si on si.id = ra.shift_instance_id
  where si.resort_id = current_setting('dbtest.resort_a')::uuid and si.week_start = pg_temp.kd('w_dr'))::text, false);
select set_config('dbtest.pb_avail_before', (select count(*) from availability av join shift_instances si on si.id = av.shift_instance_id
  where si.resort_id = current_setting('dbtest.resort_a')::uuid and si.week_start = pg_temp.kd('w_dr'))::text, false);

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('visibility: before publishing, the assigned driver sees neither the assignment nor a publication row',
  not exists (select 1 from driver_visible_assignments where shift_instance_id = pg_temp.kid('dr_mon'))
  and not exists (select 1 from driver_visible_week_publications where week_start = pg_temp.kd('w_dr')));
select pg_temp.expect_true('availability: before publishing, the week is not locked for the driver',
  (select state from week_availability_status(current_setting('dbtest.driver_a_id')::uuid, pg_temp.kd('w_dr'))) <> 'locked');

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_dr'));

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('visibility: after publishing, the driver sees their OWN assignment and the publication signal',
  exists (select 1 from driver_visible_assignments where shift_instance_id = pg_temp.kid('dr_mon'))
  and exists (select 1 from driver_visible_week_publications where week_start = pg_temp.kd('w_dr')));
select pg_temp.expect_true('visibility: ...and still never a colleague''s assignment',
  not exists (select 1 from driver_visible_assignments where shift_instance_id = pg_temp.kid('dr_tue')));
select pg_temp.expect_equal('availability: publishing locks the week for the driver (existing publication semantics)',
  (select state from week_availability_status(current_setting('dbtest.driver_a_id')::uuid, pg_temp.kd('w_dr'))), 'locked'::week_availability_state);
select pg_temp.expect_true('availability: the publication helper behind the availability write policies now reports the week published',
  shift_instance_week_is_published(pg_temp.kid('dr_mon')));

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_b_user_id')::uuid);
select pg_temp.expect_true('isolation: a driver of ANOTHER resort sees nothing of it',
  not exists (select 1 from driver_visible_week_publications where week_start = pg_temp.kd('w_dr'))
  and not exists (select 1 from driver_visible_assignments where week_start = pg_temp.kd('w_dr')));

select pg_temp.as_postgres();
select pg_temp.expect_equal('no side effects: publishing changed no assignment',
  (select count(*) from rota_assignments ra join shift_instances si on si.id = ra.shift_instance_id
    where si.resort_id = current_setting('dbtest.resort_a')::uuid and si.week_start = pg_temp.kd('w_dr'))::text, pg_temp.k('assign_before'));
select pg_temp.expect_equal('no side effects: publishing changed no availability answer',
  (select count(*) from availability av join shift_instances si on si.id = av.shift_instance_id
    where si.resort_id = current_setting('dbtest.resort_a')::uuid and si.week_start = pg_temp.kd('w_dr'))::text, pg_temp.k('avail_before'));
select pg_temp.expect_true('isolation: publishing resort A''s week published nothing for the same week in resort B',
  pg_temp.pb_pub_count(current_setting('dbtest.resort_b')::uuid, pg_temp.kd('w_cov')) = 0);

-- ---------------------------------------------------------------------
-- 11. Auto-Rota lock and manual edits after publishing
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('auto-rota: a published week refuses apply_auto_rota (55006 published_week)',
  format('select to_jsonb(r) from apply_auto_rota(%L::uuid, %L::date, %L::jsonb) r',
    current_setting('dbtest.resort_a'), pg_temp.k('w_dr'), '[]'), '55006', 'published_week');
select pg_temp.expect_equal('auto-rota: an unpublished sibling week is still generated normally (regression)',
  (select assigned_count from apply_auto_rota(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_draft'), '[]'::jsonb)), 0);

-- w_post: publish with 2 open Monday positions (Tue is covered by d3), then keep editing.
select pg_temp.expect_error_detail('post-publish setup: w_post has 2 open positions',
  pg_temp.pb_sql(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_post')), 'VD003', '2');
select pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_post'), true);
select set_config('dbtest.pb_before_post', pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_post'))::text, false);
select set_config('dbtest.pb_audit_post', pg_temp.pb_audit_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_post'))::text, false);

select assign_driver(pg_temp.kid('post_mon'), pg_temp.kid('d1'));
select assign_driver(pg_temp.kid('post_mon'), pg_temp.kid('d2'));
select unassign_driver(pg_temp.kid('post_tue'), pg_temp.kid('d3'));
select pg_temp.expect_true('manual edits: assign / unassign still work in a published week',
  (select count(*) from rota_assignments where shift_instance_id = pg_temp.kid('post_mon')) = 2
  and not exists (select 1 from rota_assignments where shift_instance_id = pg_temp.kid('post_tue')));
select pg_temp.expect_true('manual edits: the publication row is byte-for-byte unchanged and no publication audit row was written',
  pg_temp.pb_row(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_post')) = pg_temp.k('before_post')::jsonb
  and pg_temp.pb_audit_count(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_post')) = pg_temp.k('audit_post')::int);

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('manual edits: the assigned driver sees the new assignment at once (the published rota is live, not a snapshot)',
  exists (select 1 from driver_visible_assignments where shift_instance_id = pg_temp.kid('post_mon')));

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('manual edits: publishing again is idempotent and reports the CURRENT uncovered count (Monday full, Tuesday now open = 1)',
  (pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_post')) ->> 'already_published')::boolean
  and (pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_post')) ->> 'uncovered_slots')::int = 1);

-- ---------------------------------------------------------------------
-- 12. The week lock (structural; real two-connection blocking verified outside this file)
-- ---------------------------------------------------------------------
select pg_temp.expect_true('lock: a publish holds the advisory lock for its resort + week',
  pg_temp.pb_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_cov')));
select pg_temp.expect_true('lock: an unrelated week of the same resort, and the same week of another resort, are NOT locked',
  not pg_temp.pb_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_none') + 7)
  and not pg_temp.pb_lock_held(current_setting('dbtest.resort_b')::uuid, pg_temp.kd('w_cov')));

-- The idempotent path takes the lock too: publish a week via the owner with the lock trigger
-- switched off, so nothing has locked it yet, then call publish_rota.
select pg_temp.as_postgres();
select pg_temp.expect_true('lock setup: nothing holds the idempotent-path week yet', not pg_temp.pb_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_idem')));
alter table rota_publications disable trigger rota_publications_week_lock;
insert into rota_publications (resort_id, week_start, generation_source)
values (current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_idem'), 'manual');
alter table rota_publications enable trigger rota_publications_week_lock;
select pg_temp.expect_true('lock setup: the direct fixture insert did not lock (trigger was off)', not pg_temp.pb_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_idem')));
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('lock: the idempotent already-published path still takes the lock before reading',
  (pg_temp.pb_call(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_idem')) ->> 'already_published')::boolean
  and pg_temp.pb_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.kd('w_idem')));
