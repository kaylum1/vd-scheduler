-- Attendance AT-A: record_attendance / clear_attendance (the manager-only,
-- SECURITY DEFINER, week-locked write path), the composite FK from attendance
-- to rota_assignments, and the closure of direct manager writes.
--
-- Real blocking between two connections cannot be shown inside this single
-- transaction; the lock is proven STRUCTURALLY here (both RPCs hold the
-- advisory lock for exactly the assignment's resort/week) and the interleavings
-- (record vs unassign in both orders, clear vs unassign, record vs record,
-- Publish vs record) were verified separately with two live psql sessions (see
-- the AT-A report).
--
-- Dates are relative to each resort's OPERATIONAL today, never current_date.
-- Note: now() is constant inside this one transaction, so recorded_at /
-- updated_at cannot be seen to advance here; recorded_by changing on a
-- correction by a second manager is asserted instead.

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
       and sqlerrm !~* '(violates|constraint|_fkey|_unique|rota_assignments|attendance_|record_attendance\(|clear_attendance\()' then
      perform pg_temp.record_result(p_name, true, null);
    else
      perform pg_temp.record_result(p_name, false,
        format('expected sqlstate %s / detail %s / friendly message; got %s / detail %s / "%s"', p_sqlstate, p_detail, sqlstate, v_detail, sqlerrm));
    end if;
  end;
end;
$$;

create function pg_temp.k(p_name text) returns text language sql as $$ select current_setting('dbtest.at_' || p_name) $$;
create function pg_temp.kid(p_name text) returns uuid language sql as $$ select current_setting('dbtest.at_' || p_name)::uuid $$;

create function pg_temp.at_monday(p_d date) returns date language sql as $$ select p_d - app_weekday(p_d)::integer $$;

-- Every instance gets its OWN shift type (unique per resort/type/date, and several shifts share a date).
create function pg_temp.at_instance(p_resort uuid, p_date date, p_status text default 'active')
returns uuid language plpgsql security definer as $$
declare
  v_type uuid;
  v_id uuid;
begin
  insert into shift_types (resort_id, key, name, sort_order)
  values (p_resort, 'at-' || substr(gen_random_uuid()::text, 1, 8), 'AT Shift', 1) returning id into v_type;
  insert into shift_instances (resort_id, date, shift_type_id, shift_key, name, sort_order, start_time, end_time,
                               required_drivers, status, origin, cancelled_at, cancelled_reason)
  values (p_resort, p_date, v_type, 'at-test', 'AT Shift', 1, '18:00', '21:30', 1, p_status, 'adhoc',
          case when p_status = 'cancelled' then now() end, case when p_status = 'cancelled' then 'at test' end)
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.at_driver(p_resort uuid, p_name text, p_active boolean default true)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into drivers (resort_id, full_name, is_active) values (p_resort, p_name, p_active) returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.at_assign(p_instance uuid, p_driver uuid)
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

-- Publish the week containing p_date (owner write; managers cannot write publications directly).
create function pg_temp.at_publish(p_resort uuid, p_date date)
returns void language plpgsql security definer as $$
begin
  insert into rota_publications (resort_id, week_start, generation_source, published_at)
  values (p_resort, pg_temp.at_monday(p_date), 'manual', now() - interval '1 hour')
  on conflict (resort_id, week_start) do nothing;
end;
$$;

create function pg_temp.rec(p_assignment uuid, p_status text, p_reason text default null) returns jsonb language sql as $$
  select to_jsonb(r) from record_attendance(p_assignment, p_status, p_reason) r
$$;
create function pg_temp.clr(p_assignment uuid, p_reason text) returns jsonb language sql as $$
  select to_jsonb(r) from clear_attendance(p_assignment, p_reason) r
$$;
create function pg_temp.rec_sql(p_assignment uuid, p_status text, p_reason text default null) returns text language sql as $$
  select format('select pg_temp.rec(%L::uuid, %L::text, %L::text)', p_assignment, p_status, p_reason)
$$;
create function pg_temp.clr_sql(p_assignment uuid, p_reason text) returns text language sql as $$
  select format('select pg_temp.clr(%L::uuid, %L::text)', p_assignment, p_reason)
$$;

-- Owner-side readers (so assertions work whatever role the test is in).
create function pg_temp.at_row(p_assignment uuid) returns jsonb language sql security definer as $$
  select to_jsonb(a) from attendance a join rota_assignments ra on ra.shift_instance_id = a.shift_instance_id and ra.driver_id = a.driver_id
  where ra.id = p_assignment
$$;
create function pg_temp.at_count(p_assignment uuid) returns integer language sql security definer as $$
  select count(*)::integer from attendance a join rota_assignments ra on ra.shift_instance_id = a.shift_instance_id and ra.driver_id = a.driver_id
  where ra.id = p_assignment
$$;
create function pg_temp.at_audit_count(p_att uuid) returns integer language sql security definer as $$
  select count(*)::integer from audit_log where table_name = 'attendance' and row_id = p_att
$$;
create function pg_temp.at_audit(p_att uuid, p_action text) returns audit_log language sql security definer as $$
  select a from audit_log a where a.table_name = 'attendance' and a.row_id = p_att and a.action = p_action order by a.occurred_at desc, a.id limit 1
$$;
create function pg_temp.pub_snapshot(p_resort uuid) returns jsonb language sql security definer as $$
  select coalesce(jsonb_agg(to_jsonb(rp) order by rp.week_start), '[]'::jsonb) from rota_publications rp where rp.resort_id = p_resort
$$;

-- Does THIS backend hold the advisory lock for (resort, week)?
create function pg_temp.at_lock_held(p_resort uuid, p_week date)
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
  v_c uuid; v_d uuid;
  v_today date := operational_today(v_a);
  v_tz text;
  v_tc date;
  v_m2 uuid := gen_random_uuid();
  v_mx uuid := gen_random_uuid();
  d1 uuid := current_setting('dbtest.driver_a_id')::uuid;
  d2 uuid; d3 uuid; d4 uuid; d5 uuid; d6 uuid; d7 uuid; d8 uuid; db1 uuid; dd uuid; dc1 uuid; dc2 uuid;
  s uuid;
begin
  -- A second active manager (recorded_by on a correction) and an INACTIVE manager (must be denied).
  insert into auth.users (id, aud, role, email) values (v_m2, 'authenticated', 'authenticated', 'dbtest-manager2@test.local');
  insert into app_users (id, role, driver_id, resort_id, is_active) values (v_m2, 'manager', null, null, true);
  insert into auth.users (id, aud, role, email) values (v_mx, 'authenticated', 'authenticated', 'dbtest-manager-inactive@test.local');
  insert into app_users (id, role, driver_id, resort_id, is_active) values (v_mx, 'manager', null, null, false);
  perform set_config('dbtest.at_m2', v_m2::text, false);
  perform set_config('dbtest.at_mx', v_mx::text, false);

  d2 := pg_temp.at_driver(v_a, 'AT Driver 2'); d3 := pg_temp.at_driver(v_a, 'AT Driver 3');
  d4 := pg_temp.at_driver(v_a, 'AT Driver 4'); d5 := pg_temp.at_driver(v_a, 'AT Driver 5');
  d6 := pg_temp.at_driver(v_a, 'AT Driver 6'); d7 := pg_temp.at_driver(v_a, 'AT Driver 7');
  d8 := pg_temp.at_driver(v_a, 'AT Driver 8');
  perform set_config('dbtest.at_d1', d1::text, false);
  perform set_config('dbtest.at_d7', d7::text, false);
  perform set_config('dbtest.at_d8', d8::text, false);

  -- ---- A / past PUBLISHED shift: four drivers, one per status, plus an inactive one -------------
  s := pg_temp.at_instance(v_a, v_today - 14);
  perform pg_temp.at_publish(v_a, v_today - 14);
  perform set_config('dbtest.at_s_past_pub', s::text, false);
  perform set_config('dbtest.at_a_worked', pg_temp.at_assign(s, d1)::text, false);
  perform set_config('dbtest.at_a_noshow', pg_temp.at_assign(s, d2)::text, false);
  perform set_config('dbtest.at_a_excused', pg_temp.at_assign(s, d3)::text, false);
  perform set_config('dbtest.at_a_cancelled', pg_temp.at_assign(s, d4)::text, false);
  perform set_config('dbtest.at_a_inactive', pg_temp.at_assign(s, d5)::text, false);
  perform set_config('dbtest.at_a_unassigned_driver', d6::text, false);   -- never assigned to s
  perform set_config('dbtest.at_a_second_mgr', pg_temp.at_assign(s, d8)::text, false);
  update drivers set is_active = false where id = d5;                     -- deactivated AFTER being assigned

  -- ---- A / past shift in a CANCELLED instance (same published week) ------------------------------
  s := pg_temp.at_instance(v_a, v_today - 14, 'cancelled');
  perform set_config('dbtest.at_a_cxl_shift', pg_temp.at_assign(s, d2)::text, false);

  -- ---- A / past UNPUBLISHED week (historical backfill) -------------------------------------------
  s := pg_temp.at_instance(v_a, v_today - 28);
  perform set_config('dbtest.at_s_past_draft', s::text, false);
  perform set_config('dbtest.at_a_backfill', pg_temp.at_assign(s, d1)::text, false);
  perform set_config('dbtest.at_a_backfill2', pg_temp.at_assign(s, d2)::text, false);
  perform set_config('dbtest.at_week_past_draft', pg_temp.at_monday(v_today - 28)::text, false);

  -- ---- A / TODAY, week published -----------------------------------------------------------------
  s := pg_temp.at_instance(v_a, v_today);
  perform pg_temp.at_publish(v_a, v_today);
  perform set_config('dbtest.at_s_today', s::text, false);
  perform set_config('dbtest.at_a_today', pg_temp.at_assign(s, d1)::text, false);
  perform set_config('dbtest.at_a_today_race', pg_temp.at_assign(s, d2)::text, false);
  perform set_config('dbtest.at_week_today', pg_temp.at_monday(v_today)::text, false);

  -- ---- A / FUTURE, published week and draft week ---------------------------------------------------
  s := pg_temp.at_instance(v_a, v_today + 14);
  perform pg_temp.at_publish(v_a, v_today + 14);
  perform set_config('dbtest.at_a_future_pub', pg_temp.at_assign(s, d1)::text, false);
  s := pg_temp.at_instance(v_a, v_today + 21);
  perform set_config('dbtest.at_a_future_draft', pg_temp.at_assign(s, d1)::text, false);

  -- ---- B / TODAY, week NOT published (draft today) ------------------------------------------------
  db1 := pg_temp.at_driver(v_b, 'AT Driver B1');
  s := pg_temp.at_instance(v_b, operational_today(v_b));
  perform set_config('dbtest.at_b_today', pg_temp.at_assign(s, db1)::text, false);

  -- ---- B / past published shift (other resort: attendance resort is derived from the assignment) --
  s := pg_temp.at_instance(v_b, operational_today(v_b) - 14);
  perform pg_temp.at_publish(v_b, operational_today(v_b) - 14);
  perform set_config('dbtest.at_b_past', pg_temp.at_assign(s, db1)::text, false);
  perform set_config('dbtest.at_resort_b', v_b::text, false);

  -- ---- D / an INACTIVE resort with a past published shift ----------------------------------------
  insert into resorts (slug, name, timezone) values ('dbtest-at-d', 'AT Test Resort D', 'Europe/Zurich') returning id into v_d;
  dd := pg_temp.at_driver(v_d, 'AT Driver D1');
  s := pg_temp.at_instance(v_d, operational_today(v_d) - 14);
  perform pg_temp.at_publish(v_d, operational_today(v_d) - 14);
  perform set_config('dbtest.at_d_assign', pg_temp.at_assign(s, dd)::text, false);
  update resorts set is_active = false where id = v_d;

  -- ---- C / a timezone whose operational date is NOT a Monday: the current week has a PAST day ------
  select z into v_tz from (values ('Etc/GMT+12'), ('Europe/Zurich'), ('Pacific/Kiritimati')) t(z)
   where app_weekday((now() at time zone z)::date) >= 1 order by z limit 1;
  insert into resorts (slug, name, timezone) values ('dbtest-at-c', 'AT Test Resort C', v_tz) returning id into v_c;
  v_tc := operational_today(v_c);
  dc1 := pg_temp.at_driver(v_c, 'AT Driver C1'); dc2 := pg_temp.at_driver(v_c, 'AT Driver C2');
  s := pg_temp.at_instance(v_c, pg_temp.at_monday(v_tc));                 -- earlier this week (past), week unpublished
  perform set_config('dbtest.at_c_past', pg_temp.at_assign(s, dc1)::text, false);
  s := pg_temp.at_instance(v_c, v_tc);                                    -- today, week unpublished
  perform set_config('dbtest.at_c_today', pg_temp.at_assign(s, dc2)::text, false);
  perform set_config('dbtest.at_resort_c', v_c::text, false);
  perform set_config('dbtest.at_week_c', pg_temp.at_monday(v_tc)::text, false);

  -- ---- "Not recorded" -> clear scenarios ---------------------------------------------------------
  -- today unassign after clear: reuses at_a_today (d1) below. A PAST assignment that gets cleared must stay frozen:
  perform set_config('dbtest.at_a_past_clear', pg_temp.at_assign(pg_temp.at_instance(v_a, v_today - 14 + 0 + 0), d7)::text, false);
  -- ---- two UNPUBLISHED past weeks no fixture write ever locks, used only to prove the RPCs take the week lock ----
  perform set_config('dbtest.at_a_lock_rec', pg_temp.at_assign(pg_temp.at_instance(v_a, v_today - 35), d1)::text, false);
  perform set_config('dbtest.at_week_lock_rec', pg_temp.at_monday(v_today - 35)::text, false);
  perform set_config('dbtest.at_a_lock_clr', pg_temp.at_assign(pg_temp.at_instance(v_a, v_today - 42), d1)::text, false);
  perform set_config('dbtest.at_week_lock_clr', pg_temp.at_monday(v_today - 42)::text, false);
end $$;

-- Nothing has taken those two weeks' locks yet (owner writes to rota_assignments / shift_instances do not lock;
-- only publication writes and the RPCs do), so "held" below can only come from the RPCs themselves.
select pg_temp.expect_true('lock setup: neither lock-proof week is locked before any call',
  not pg_temp.at_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.k('week_lock_rec')::date)
  and not pg_temp.at_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.k('week_lock_clr')::date));

-- ---------------------------------------------------------------------
-- 1. Security surface
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error_detail('security: an authenticated DRIVER cannot call record_attendance (42501)',
  pg_temp.rec_sql(pg_temp.kid('a_worked'), 'worked'), '42501');
select pg_temp.expect_error_detail('security: an authenticated DRIVER cannot call clear_attendance (42501)',
  pg_temp.clr_sql(pg_temp.kid('a_worked'), 'x'), '42501');
select pg_temp.expect_true('security: a driver reads no attendance rows (and there are none to read yet)',
  (select count(*) from attendance) = 0);

select pg_temp.act_as('authenticated', current_setting('dbtest.at_mx')::uuid);
select pg_temp.expect_error_detail('security: an INACTIVE manager is denied (42501)',
  pg_temp.rec_sql(pg_temp.kid('a_worked'), 'worked'), '42501');

select pg_temp.act_as('anon');
select pg_temp.expect_error_detail('security: anon cannot call record_attendance (42501)',
  pg_temp.rec_sql(pg_temp.kid('a_worked'), 'worked'), '42501');
select pg_temp.expect_error_detail('security: anon cannot call clear_attendance (42501)',
  pg_temp.clr_sql(pg_temp.kid('a_worked'), 'x'), '42501');
select pg_temp.expect_error('security: anon cannot read attendance (42501)', 'select count(*) from attendance', '42501');

select pg_temp.as_postgres();
select pg_temp.expect_true('security: EXECUTE on both RPCs is granted to authenticated only, never anon',
  has_function_privilege('authenticated', 'record_attendance(uuid,text,text)', 'execute')
  and has_function_privilege('authenticated', 'clear_attendance(uuid,text)', 'execute')
  and not has_function_privilege('anon', 'record_attendance(uuid,text,text)', 'execute')
  and not has_function_privilege('anon', 'clear_attendance(uuid,text)', 'execute'));
select pg_temp.expect_true('security: both RPCs are SECURITY DEFINER with a pinned search_path',
  (select bool_and(p.prosecdef and p.proconfig::text like '%search_path%') from pg_proc p where p.proname in ('record_attendance', 'clear_attendance')));
select pg_temp.expect_true('security: authenticated keeps SELECT on attendance but has NO insert / update / delete',
  has_table_privilege('authenticated', 'public.attendance', 'select')
  and not has_table_privilege('authenticated', 'public.attendance', 'insert')
  and not has_table_privilege('authenticated', 'public.attendance', 'update')
  and not has_table_privilege('authenticated', 'public.attendance', 'delete'));
select pg_temp.expect_true('security: the FOR ALL manager policy is gone; a SELECT-only manager policy replaces it',
  not exists (select 1 from pg_policies where tablename = 'attendance' and policyname = 'attendance_manager_all')
  and exists (select 1 from pg_policies where tablename = 'attendance' and policyname = 'attendance_manager_select' and cmd = 'SELECT'));

-- ---------------------------------------------------------------------
-- 2. Request shape
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('shape: a null assignment is rejected (22023, no detail)',
  format('select pg_temp.rec(null::uuid, %L::text)', 'worked'), '22023');
select pg_temp.expect_error_detail('shape: a null status is rejected (22023, no detail)',
  format('select pg_temp.rec(%L::uuid, null::text)', pg_temp.k('a_worked')), '22023');
select pg_temp.expect_error_detail('shape: a status outside the four values is rejected (22023, DETAIL invalid_status)',
  pg_temp.rec_sql(pg_temp.kid('a_worked'), 'late'), '22023', 'invalid_status');
select pg_temp.expect_error_detail('shape: status values are case-sensitive stored tokens (Worked is invalid)',
  pg_temp.rec_sql(pg_temp.kid('a_worked'), 'Worked'), '22023', 'invalid_status');
select pg_temp.expect_error_detail('shape: an unknown assignment is not found (P0002)',
  pg_temp.rec_sql(gen_random_uuid(), 'worked'), 'P0002');
select pg_temp.expect_error_detail('shape: clear with a null assignment is rejected (22023)',
  format('select pg_temp.clr(null::uuid, %L::text)', 'x'), '22023');
select pg_temp.expect_error_detail('shape: clear on an unknown assignment is not found (P0002)',
  pg_temp.clr_sql(gen_random_uuid(), 'x'), 'P0002');
select pg_temp.expect_equal('shape: nothing was written by any rejected call', (select count(*) from attendance)::int, 0);

-- ---------------------------------------------------------------------
-- 3. Assignment-backed integrity, direct writes closed
-- ---------------------------------------------------------------------
select pg_temp.expect_error('closed: a manager cannot INSERT into attendance (42501)',
  format('insert into attendance (shift_instance_id, driver_id, resort_id, status) values (%L::uuid, %L::uuid, %L::uuid, %L)',
    pg_temp.k('s_past_pub'), pg_temp.k('d1'), current_setting('dbtest.resort_a'), 'worked'), '42501');

select pg_temp.as_postgres();
select pg_temp.expect_error('integrity: an attendance row for a driver who was NEVER assigned to the shift is impossible (23503, composite FK)',
  format('insert into attendance (shift_instance_id, driver_id, resort_id, status) values (%L::uuid, %L::uuid, %L::uuid, %L)',
    pg_temp.k('s_past_pub'), pg_temp.k('a_unassigned_driver'), current_setting('dbtest.resort_a'), 'worked'), '23503');
select pg_temp.expect_error('integrity: a cross-resort driver/shift pairing is still impossible (23503)',
  format('insert into attendance (shift_instance_id, driver_id, resort_id, status) values (%L::uuid, %L::uuid, %L::uuid, %L)',
    pg_temp.k('s_past_pub'), current_setting('dbtest.driver_b_id'), current_setting('dbtest.resort_a'), 'worked'), '23503');
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- ---------------------------------------------------------------------
-- 4. Recording: each status, create, derived fields
-- ---------------------------------------------------------------------
select set_config('dbtest.at_r_worked', pg_temp.rec(pg_temp.kid('a_worked'), 'worked')::text, false);
select pg_temp.expect_true('record: worked is created (created = true, changed = true)',
  (pg_temp.k('r_worked')::jsonb ->> 'status') = 'worked' and (pg_temp.k('r_worked')::jsonb ->> 'created')::boolean
  and (pg_temp.k('r_worked')::jsonb ->> 'changed')::boolean);
select pg_temp.expect_true('record: no_show is created',
  (pg_temp.rec(pg_temp.kid('a_noshow'), 'no_show') ->> 'status') = 'no_show');
select pg_temp.expect_true('record: excused is created',
  (pg_temp.rec(pg_temp.kid('a_excused'), 'excused') ->> 'status') = 'excused');
select pg_temp.expect_true('record: cancelled (this driver stood down) is created',
  (pg_temp.rec(pg_temp.kid('a_cancelled'), 'cancelled') ->> 'status') = 'cancelled');
select pg_temp.expect_true('record: the result carries the assignment, the DERIVED shift and driver, and the attendance id',
  (pg_temp.k('r_worked')::jsonb ->> 'assignment_id') = pg_temp.k('a_worked')
  and (pg_temp.k('r_worked')::jsonb ->> 'shift_instance_id') = pg_temp.k('s_past_pub')
  and (pg_temp.k('r_worked')::jsonb ->> 'driver_id') = pg_temp.k('d1')
  and (pg_temp.k('r_worked')::jsonb ->> 'attendance_id') = (pg_temp.at_row(pg_temp.kid('a_worked')) ->> 'id'));
select pg_temp.expect_true('record: the row stores the manager (recorded_by), the resort, and leaves actual times and notes untouched',
  (pg_temp.at_row(pg_temp.kid('a_worked')) ->> 'recorded_by') = current_setting('dbtest.manager_id')
  and (pg_temp.at_row(pg_temp.kid('a_worked')) ->> 'resort_id') = current_setting('dbtest.resort_a')
  and (pg_temp.at_row(pg_temp.kid('a_worked')) -> 'actual_start') = 'null'::jsonb
  and (pg_temp.at_row(pg_temp.kid('a_worked')) -> 'actual_end') = 'null'::jsonb
  and (pg_temp.at_row(pg_temp.kid('a_worked')) -> 'notes') = 'null'::jsonb);
select pg_temp.expect_true('record: it is another resort''s attendance when the assignment is -- shift, driver AND resort come only from the assignment',
  (pg_temp.rec(pg_temp.kid('b_past'), 'worked') ->> 'shift_instance_id') is not null
  and (pg_temp.at_row(pg_temp.kid('b_past')) ->> 'resort_id') = current_setting('dbtest.at_resort_b'));

-- ---------------------------------------------------------------------
-- 5. Date / publication rules
-- ---------------------------------------------------------------------
select pg_temp.expect_true('when: a PAST shift in a PUBLISHED week was recorded above with NO reason',
  pg_temp.at_count(pg_temp.kid('a_worked')) = 1);
select pg_temp.expect_equal('when: ...and its audit context says historical_backfill false (no special backfill rule solely because it is historical)',
  ((pg_temp.at_audit((pg_temp.at_row(pg_temp.kid('a_worked')) ->> 'id')::uuid, 'insert')).context ->> 'historical_backfill'), 'false');

select pg_temp.expect_true('when: TODAY with the week published is allowed',
  (pg_temp.rec(pg_temp.kid('a_today'), 'worked') ->> 'created')::boolean);
select pg_temp.expect_error_detail('when: TODAY with the week NOT published -> 55006 week_not_published',
  pg_temp.rec_sql(pg_temp.kid('b_today'), 'worked'), '55006', 'week_not_published');
select pg_temp.expect_error_detail('when: a FUTURE shift in a published week -> 55006 future_shift',
  pg_temp.rec_sql(pg_temp.kid('a_future_pub'), 'worked'), '55006', 'future_shift');
select pg_temp.expect_error_detail('when: a FUTURE shift in a draft week -> 55006 future_shift (future is blocked regardless)',
  pg_temp.rec_sql(pg_temp.kid('a_future_draft'), 'worked'), '55006', 'future_shift');
select pg_temp.expect_error_detail('when: a CANCELLED shift instance blocks new attendance -> 55006 shift_cancelled',
  pg_temp.rec_sql(pg_temp.kid('a_cxl_shift'), 'worked'), '55006', 'shift_cancelled');
select pg_temp.expect_equal('when: none of the rejected calls wrote a row',
  pg_temp.at_count(pg_temp.kid('b_today')) + pg_temp.at_count(pg_temp.kid('a_future_pub')) + pg_temp.at_count(pg_temp.kid('a_future_draft')) + pg_temp.at_count(pg_temp.kid('a_cxl_shift')), 0);

-- Historical backfill: a PAST shift in a week that is not currently published REQUIRES a reason.
select pg_temp.expect_error_detail('backfill: a past UNPUBLISHED assignment without a reason -> 23514 historical_backfill_reason_required',
  pg_temp.rec_sql(pg_temp.kid('a_backfill'), 'worked'), '23514', 'historical_backfill_reason_required');
select pg_temp.expect_error_detail('backfill: a whitespace-only reason counts as no reason',
  pg_temp.rec_sql(pg_temp.kid('a_backfill'), 'worked', E'  \t  '), '23514', 'historical_backfill_reason_required');
select pg_temp.expect_equal('backfill: nothing was written without the reason', pg_temp.at_count(pg_temp.kid('a_backfill')), 0);
select set_config('dbtest.at_pubs_before', pg_temp.pub_snapshot(current_setting('dbtest.resort_a')::uuid)::text, false);
select set_config('dbtest.at_r_backfill', pg_temp.rec(pg_temp.kid('a_backfill'), 'worked', '  Covered the dinner; rota was never published  ')::text, false);
select pg_temp.expect_true('backfill: a past UNPUBLISHED assignment is recorded once a reason is given',
  (pg_temp.k('r_backfill')::jsonb ->> 'created')::boolean and pg_temp.at_count(pg_temp.kid('a_backfill')) = 1);
select pg_temp.expect_true('backfill: the audit context flags historical_backfill = true and carries the TRIMMED reason',
  ((pg_temp.at_audit((pg_temp.k('r_backfill')::jsonb ->> 'attendance_id')::uuid, 'insert')).context ->> 'historical_backfill') = 'true'
  and ((pg_temp.at_audit((pg_temp.k('r_backfill')::jsonb ->> 'attendance_id')::uuid, 'insert')).context ->> 'reason') = 'Covered the dinner; rota was never published');
select pg_temp.expect_true('backfill: the week is NOT published by recording (no rota_publications row was created or changed)',
  pg_temp.pub_snapshot(current_setting('dbtest.resort_a')::uuid) = pg_temp.k('pubs_before')::jsonb
  and not exists (select 1 from rota_publications where resort_id = current_setting('dbtest.resort_a')::uuid and week_start = pg_temp.k('week_past_draft')::date));
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('backfill: ...a past day of the CURRENT unpublished week -> historical_backfill_reason_required',
  pg_temp.rec_sql(pg_temp.kid('c_past'), 'no_show'), '23514', 'historical_backfill_reason_required');
select pg_temp.expect_true('backfill: ...and is recorded with a reason',
  (pg_temp.rec(pg_temp.kid('c_past'), 'no_show', 'No-show, rota not published') ->> 'created')::boolean);
select pg_temp.expect_error_detail('backfill: ...but TODAY in that same unpublished week is still week_not_published (a reason does not override it)',
  pg_temp.rec_sql(pg_temp.kid('c_today'), 'worked', 'trying to backfill today'), '55006', 'week_not_published');

-- ---------------------------------------------------------------------
-- 6. Driver / resort active flags do not matter
-- ---------------------------------------------------------------------
select pg_temp.expect_true('history: a driver deactivated AFTER being assigned can still be recorded',
  (pg_temp.rec(pg_temp.kid('a_inactive'), 'worked') ->> 'created')::boolean);
select pg_temp.expect_true('history: a past shift of a now-INACTIVE resort can still be recorded',
  (pg_temp.rec(pg_temp.kid('d_assign'), 'worked') ->> 'created')::boolean);

-- ---------------------------------------------------------------------
-- 7. Correction, idempotency, reason handling, audit
-- ---------------------------------------------------------------------
-- (a_noshow is currently no_show, recorded by manager 1.)
select pg_temp.expect_equal('audit: the first record wrote exactly one INSERT audit row (a_noshow)',
  pg_temp.at_audit_count((pg_temp.at_row(pg_temp.kid('a_noshow')) ->> 'id')::uuid), 1);
select set_config('dbtest.at_noshow_id', (pg_temp.at_row(pg_temp.kid('a_noshow')) ->> 'id'), false);
select pg_temp.expect_true('audit: the insert context has operation, assignment, resort, week, previous_status null, new_status, historical_backfill false',
  ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'insert')).context ->> 'operation') = 'record_attendance'
  and ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'insert')).context ->> 'assignment_id') = pg_temp.k('a_noshow')
  and ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'insert')).context ->> 'resort_id') = current_setting('dbtest.resort_a')
  and ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'insert')).context ->> 'week_start') = pg_temp.at_monday(operational_today(current_setting('dbtest.resort_a')::uuid) - 14)::text
  and ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'insert')).context -> 'previous_status') = 'null'::jsonb
  and ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'insert')).context ->> 'new_status') = 'no_show'
  and ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'insert')).context ->> 'historical_backfill') = 'false'
  and not ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'insert')).context ? 'reason'));
select pg_temp.expect_true('audit: the actor of the insert is the recording manager',
  (pg_temp.at_audit(pg_temp.kid('noshow_id'), 'insert')).actor_user_id = current_setting('dbtest.manager_id')::uuid);

-- Same persisted state again -> idempotent, even with a different reason, even from another manager.
select pg_temp.expect_true('idempotent: the same status again is a success with changed = false, created = false, the SAME row',
  (pg_temp.rec(pg_temp.kid('a_noshow'), 'no_show') ->> 'changed') = 'false'
  and (pg_temp.rec(pg_temp.kid('a_noshow'), 'no_show') ->> 'created') = 'false'
  and (pg_temp.rec(pg_temp.kid('a_noshow'), 'no_show') ->> 'attendance_id') = pg_temp.k('noshow_id'));
select pg_temp.expect_true('idempotent: ...a DIFFERENT reason with the same status is still no change (reason is audit metadata, not state)',
  (pg_temp.rec(pg_temp.kid('a_noshow'), 'no_show', 'a new explanation') ->> 'changed') = 'false');
select pg_temp.expect_equal('idempotent: ...and no audit row was written (still exactly the one insert)',
  pg_temp.at_audit_count(pg_temp.kid('noshow_id')), 1);
select pg_temp.expect_equal('idempotent: ...and recorded_by is unchanged', (pg_temp.at_row(pg_temp.kid('a_noshow')) ->> 'recorded_by'), current_setting('dbtest.manager_id'));
select pg_temp.expect_true('idempotent: a same-status retry in a historical-backfill week needs no new reason (nothing is written)',
  (pg_temp.rec(pg_temp.kid('a_backfill'), 'worked') ->> 'changed') = 'false');

-- Correction by a SECOND manager: update in place.
select pg_temp.act_as('authenticated', current_setting('dbtest.at_m2')::uuid);
select set_config('dbtest.at_r_correct', pg_temp.rec(pg_temp.kid('a_noshow'), 'excused', 'Doctor''s note received')::text, false);
select pg_temp.expect_true('correct: a different status UPDATES the existing row in place (created = false, changed = true, same id)',
  not (pg_temp.k('r_correct')::jsonb ->> 'created')::boolean and (pg_temp.k('r_correct')::jsonb ->> 'changed')::boolean
  and (pg_temp.k('r_correct')::jsonb ->> 'attendance_id') = pg_temp.k('noshow_id') and (pg_temp.k('r_correct')::jsonb ->> 'status') = 'excused');
select pg_temp.expect_equal('correct: still exactly ONE attendance row for that assignment (unique pair preserved)', pg_temp.at_count(pg_temp.kid('a_noshow')), 1);
select pg_temp.expect_equal('correct: recorded_by now names the manager who made THIS correction',
  (pg_temp.at_row(pg_temp.kid('a_noshow')) ->> 'recorded_by'), current_setting('dbtest.at_m2'));
select pg_temp.expect_true('correct: an UPDATE audit row keeps the previous value (before.status no_show, after.status excused, changed_fields has status)',
  (pg_temp.at_audit(pg_temp.kid('noshow_id'), 'update')).before ->> 'status' = 'no_show'
  and (pg_temp.at_audit(pg_temp.kid('noshow_id'), 'update')).after ->> 'status' = 'excused'
  and 'status' = any ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'update')).changed_fields));
select pg_temp.expect_true('correct: the update context carries previous_status no_show, new_status excused, the reason, and the second manager as actor',
  ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'update')).context ->> 'previous_status') = 'no_show'
  and ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'update')).context ->> 'new_status') = 'excused'
  and ((pg_temp.at_audit(pg_temp.kid('noshow_id'), 'update')).context ->> 'reason') = 'Doctor''s note received'
  and (pg_temp.at_audit(pg_temp.kid('noshow_id'), 'update')).actor_user_id = current_setting('dbtest.at_m2')::uuid);
select pg_temp.expect_true('reason: it lives ONLY in the audit context -- attendance.notes stays null and no reason column exists on the row',
  (pg_temp.at_row(pg_temp.kid('a_noshow')) -> 'notes') = 'null'::jsonb and not (pg_temp.at_row(pg_temp.kid('a_noshow')) ? 'reason'));
select pg_temp.expect_equal('two managers: the second manager recording a DIFFERENT status serialized as a correction -- still one row, two audit rows',
  pg_temp.at_audit_count(pg_temp.kid('noshow_id')), 2);

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('reason: a whitespace-only reason on a past PUBLISHED shift is simply no reason (allowed, no reason key in the context)',
  (pg_temp.rec(pg_temp.kid('a_second_mgr'), 'worked', E'   \n ') ->> 'created')::boolean
  and not ((pg_temp.at_audit((pg_temp.at_row(pg_temp.kid('a_second_mgr')) ->> 'id')::uuid, 'insert')).context ? 'reason'));
select pg_temp.expect_error_detail('reason: more than 500 characters -> 23514 reason_too_long',
  pg_temp.rec_sql(pg_temp.kid('a_second_mgr'), 'no_show', repeat('x', 501)), '23514', 'reason_too_long');
select pg_temp.expect_true('reason: exactly 500 characters is accepted',
  (pg_temp.rec(pg_temp.kid('a_second_mgr'), 'no_show', repeat('y', 500)) ->> 'changed')::boolean);
select pg_temp.expect_true('context: the audit context setting is cleared after record_attendance',
  coalesce(current_setting('app.audit_context', true), '') = '');

-- ---------------------------------------------------------------------
-- 8. Unassign interaction
-- ---------------------------------------------------------------------
select pg_temp.expect_error_detail('unassign: today assignment WITH attendance is blocked (55006 attendance_recorded)',
  format('select unassign_driver(%L::uuid, %L::uuid)', pg_temp.k('s_today'), pg_temp.k('d1')), '55006', 'attendance_recorded');
select pg_temp.expect_equal('unassign: ...and the assignment and its attendance survive', pg_temp.at_count(pg_temp.kid('a_today')), 1);
select pg_temp.as_postgres();
select pg_temp.expect_error('integrity: deleting an assignment that still has attendance is refused by the composite FK as the final defence (23503)',
  format('delete from rota_assignments where id = %L::uuid', pg_temp.k('a_today')), '23503');
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- ---------------------------------------------------------------------
-- 9. clear_attendance
-- ---------------------------------------------------------------------
select pg_temp.expect_error_detail('clear: a reason is REQUIRED (null -> 23514 reason_required)',
  format('select pg_temp.clr(%L::uuid, null::text)', pg_temp.k('a_today')), '23514', 'reason_required');
select pg_temp.expect_error_detail('clear: a whitespace-only reason is not a reason',
  pg_temp.clr_sql(pg_temp.kid('a_today'), E'  \t '), '23514', 'reason_required');
select pg_temp.expect_error_detail('clear: a reason over 500 characters -> 23514 reason_too_long',
  pg_temp.clr_sql(pg_temp.kid('a_today'), repeat('z', 501)), '23514', 'reason_too_long');
select pg_temp.expect_equal('clear: nothing was deleted by the rejected calls', pg_temp.at_count(pg_temp.kid('a_today')), 1);

select set_config('dbtest.at_today_att_id', (pg_temp.at_row(pg_temp.kid('a_today')) ->> 'id'), false);
select set_config('dbtest.at_r_clear', pg_temp.clr(pg_temp.kid('a_today'), '  Marked the wrong driver  ')::text, false);
select pg_temp.expect_true('clear: returns the assignment, the previous status and changed = true',
  (pg_temp.k('r_clear')::jsonb ->> 'assignment_id') = pg_temp.k('a_today')
  and (pg_temp.k('r_clear')::jsonb ->> 'previous_status') = 'worked' and (pg_temp.k('r_clear')::jsonb ->> 'changed')::boolean);
select pg_temp.expect_equal('clear: the attendance row is DELETED (back to Not recorded -- no row at all)', pg_temp.at_count(pg_temp.kid('a_today')), 0);
select pg_temp.expect_true('clear: the rota assignment itself is untouched',
  exists (select 1 from rota_assignments where id = pg_temp.kid('a_today')));
select pg_temp.expect_true('clear: the generic audit trail has the DELETE with the old row snapshot',
  (pg_temp.at_audit(pg_temp.kid('today_att_id'), 'delete')).before ->> 'status' = 'worked'
  and (pg_temp.at_audit(pg_temp.kid('today_att_id'), 'delete')).after is null);
select pg_temp.expect_true('clear: the DELETE context is operation clear_attendance with assignment, resort, week, previous_status and the TRIMMED reason',
  ((pg_temp.at_audit(pg_temp.kid('today_att_id'), 'delete')).context ->> 'operation') = 'clear_attendance'
  and ((pg_temp.at_audit(pg_temp.kid('today_att_id'), 'delete')).context ->> 'assignment_id') = pg_temp.k('a_today')
  and ((pg_temp.at_audit(pg_temp.kid('today_att_id'), 'delete')).context ->> 'resort_id') = current_setting('dbtest.resort_a')
  and ((pg_temp.at_audit(pg_temp.kid('today_att_id'), 'delete')).context ->> 'week_start') = pg_temp.k('week_today')
  and ((pg_temp.at_audit(pg_temp.kid('today_att_id'), 'delete')).context ->> 'previous_status') = 'worked'
  and ((pg_temp.at_audit(pg_temp.kid('today_att_id'), 'delete')).context ->> 'reason') = 'Marked the wrong driver');
select pg_temp.expect_true('context: the audit context setting is cleared after clear_attendance',
  coalesce(current_setting('app.audit_context', true), '') = '');

-- Already Not recorded -> idempotent.
select pg_temp.expect_true('clear: an assignment that is already Not recorded is a success with changed = false and no previous status',
  (pg_temp.clr(pg_temp.kid('a_today'), 'checking') ->> 'changed') = 'false'
  and (pg_temp.clr(pg_temp.kid('a_today'), 'checking') -> 'previous_status') = 'null'::jsonb);
select pg_temp.expect_equal('clear: ...and wrote no further audit row (insert + delete only)',
  pg_temp.at_audit_count(pg_temp.kid('today_att_id')), 2);

-- Today's assignment is removable again after the clear (existing Manual Rota rules).
select pg_temp.expect_true('unassign: after clearing, TODAY''S assignment can be removed again',
  (select count(*) from unassign_driver(pg_temp.kid('s_today'), pg_temp.kid('d1'))) = 1);
select pg_temp.expect_error_detail('clear: ...and once the assignment is gone, recording / clearing it is assignment-not-found (no orphan, no false success)',
  pg_temp.rec_sql(pg_temp.kid('a_today'), 'worked'), 'P0002');

-- A PAST assignment stays frozen even after a clear.
select pg_temp.expect_true('clear past: a past assignment''s attendance can be recorded and cleared',
  (pg_temp.rec(pg_temp.kid('a_past_clear'), 'excused') ->> 'created')::boolean
  and (pg_temp.clr(pg_temp.kid('a_past_clear'), 'recorded in error') ->> 'changed')::boolean);
select pg_temp.expect_error_detail('clear past: ...but the PAST assignment is still not removable (55006 historical_shift)',
  format('select unassign_driver(%L::uuid, %L::uuid)', (select shift_instance_id from rota_assignments where id = pg_temp.kid('a_past_clear')), pg_temp.k('d7')), '55006', 'historical_shift');

-- Clear is not gated on publication / date / shift status.
select pg_temp.expect_true('clear: works for a historical-backfill (unpublished) row without needing the week published',
  (pg_temp.clr(pg_temp.kid('a_backfill'), 'wrong week') ->> 'changed')::boolean and pg_temp.at_count(pg_temp.kid('a_backfill')) = 0);
select pg_temp.as_postgres();
insert into attendance (shift_instance_id, driver_id, resort_id, status)
select ra.shift_instance_id, ra.driver_id, ra.resort_id, 'worked' from rota_assignments ra where ra.id = pg_temp.kid('a_future_draft');
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('clear: can remove a corrupt / legacy FUTURE attendance row (the assignment exists)',
  (pg_temp.clr(pg_temp.kid('a_future_draft'), 'corrupt future row') ->> 'changed')::boolean and pg_temp.at_count(pg_temp.kid('a_future_draft')) = 0);

-- ---------------------------------------------------------------------
-- 10. Locks, publications untouched
-- ---------------------------------------------------------------------
select pg_temp.expect_true('lock: record_attendance takes the advisory lock for the assignment''s resort + week (a week nothing else touched)',
  (pg_temp.rec(pg_temp.kid('a_lock_rec'), 'worked', 'lock proof') ->> 'created')::boolean
  and pg_temp.at_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.k('week_lock_rec')::date));
select pg_temp.expect_true('lock: clear_attendance takes it too -- even on the idempotent already-clear path (it locks before reading)',
  (pg_temp.clr(pg_temp.kid('a_lock_clr'), 'lock proof') ->> 'changed') = 'false'
  and pg_temp.at_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.k('week_lock_clr')::date));
select pg_temp.expect_true('lock: an unrelated week of the same resort is NOT locked, nor the same week of another resort',
  not pg_temp.at_lock_held(current_setting('dbtest.resort_a')::uuid, pg_temp.at_monday(operational_today(current_setting('dbtest.resort_a')::uuid) + 105))
  and not pg_temp.at_lock_held(current_setting('dbtest.resort_b')::uuid, pg_temp.k('week_lock_rec')::date));
select pg_temp.expect_true('publications: no rota_publications row was created or changed by any attendance call',
  (select count(*) from rota_publications where resort_id = current_setting('dbtest.resort_a')::uuid) = 3
  and pg_temp.pub_snapshot(current_setting('dbtest.resort_a')::uuid) = pg_temp.k('pubs_before')::jsonb);

-- ---------------------------------------------------------------------
-- 11. Manager read access is kept; drivers still see nothing
-- ---------------------------------------------------------------------
select pg_temp.expect_true('read: a manager can still SELECT attendance',
  (select count(*) from attendance) > 0);
select pg_temp.expect_error('closed: a manager cannot UPDATE attendance directly (42501)',
  format('update attendance set status = %L where shift_instance_id = %L::uuid', 'no_show', pg_temp.k('s_past_pub')), '42501');
select pg_temp.expect_error('closed: a manager cannot DELETE attendance directly (42501)',
  format('delete from attendance where shift_instance_id = %L::uuid', pg_temp.k('s_past_pub')), '42501');
select pg_temp.expect_true('closed: the failed direct writes changed nothing',
  (select status from attendance where shift_instance_id = pg_temp.kid('s_past_pub') and driver_id = pg_temp.kid('d1')) = 'worked');

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('read: a driver still sees zero attendance rows even though rows exist',
  (select count(*) from attendance) = 0);
select pg_temp.as_postgres();
