-- Manual Rota MR-A: assign_driver / unassign_driver, the audit_log.context
-- mechanism, and the closed direct-write path on rota_assignments.
--
-- Fixtures are seeded as the database owner via SECURITY DEFINER helpers
-- (an authenticated manager has no direct write access to rota_assignments,
-- shift_instances, availability or attendance); every behaviour under test
-- is then exercised as the real role it applies to -- manager, driver, anon.
--
-- All dates are relative to the resort's OPERATIONAL today (Europe/Zurich
-- via operational_today), never current_date, so the suite is stable
-- whenever it runs and exercises the real today/past boundary.

select pg_temp.as_postgres();

-- ---------------------------------------------------------------------
-- Local helpers
-- ---------------------------------------------------------------------
-- Like pg_temp.expect_error, but also asserts the exception's DETAIL (the
-- machine-readable discriminator for 55006 / VD001) and that the message is
-- friendly -- never a raw constraint/FK name leaking to a manager.
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
    -- An exception raised without DETAIL reports '' (not NULL).
    v_detail := nullif(v_detail, '');
    if sqlstate = p_sqlstate
       and v_detail is not distinct from p_detail
       and sqlerrm !~* '(violates|constraint|_fkey|_unique|rota_assignments_)' then
      perform pg_temp.record_result(p_name, true, null);
    else
      perform pg_temp.record_result(p_name, false,
        format('expected sqlstate %s / detail %s / friendly message; got %s / detail %s / "%s"', p_sqlstate, p_detail, sqlstate, v_detail, sqlerrm));
    end if;
  end;
end;
$$;

create function pg_temp.mr_instance(p_resort uuid, p_type uuid, p_date date, p_required int, p_status text default 'active')
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into shift_instances (resort_id, date, shift_type_id, shift_key, name, sort_order, start_time, end_time,
                               required_drivers, status, origin, cancelled_at, cancelled_reason)
  values (p_resort, p_date, p_type, 'mr-test', 'MR Test Shift', 1, '18:00', '21:30',
          p_required, p_status, 'adhoc',
          case when p_status = 'cancelled' then now() end,
          case when p_status = 'cancelled' then 'mr test' end)
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.mr_driver(p_resort uuid, p_name text, p_active boolean default true)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into drivers (resort_id, full_name, is_active) values (p_resort, p_name, p_active) returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.mr_availability(p_instance uuid, p_driver uuid, p_status text)
returns void language plpgsql security definer as $$
begin
  insert into availability (driver_id, resort_id, shift_instance_id, status)
  values (p_driver, (select resort_id from shift_instances where id = p_instance), p_instance, p_status)
  on conflict (driver_id, shift_instance_id) do update set status = excluded.status;
end;
$$;

create function pg_temp.mr_seed_assignment(p_instance uuid, p_driver uuid)
returns void language plpgsql security definer as $$
begin
  insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source)
  values (p_instance, p_driver, (select resort_id from shift_instances where id = p_instance), 'manual');
end;
$$;

create function pg_temp.mr_attendance(p_instance uuid, p_driver uuid, p_status text)
returns void language plpgsql security definer as $$
begin
  insert into attendance (shift_instance_id, driver_id, resort_id, status)
  values (p_instance, p_driver, (select resort_id from shift_instances where id = p_instance), p_status);
end;
$$;

create function pg_temp.mr_publish(p_resort uuid, p_any_date_in_week date)
returns void language plpgsql security definer as $$
begin
  insert into rota_publications (resort_id, week_start, generation_source)
  values (p_resort, p_any_date_in_week - app_weekday(p_any_date_in_week)::integer, 'manual');
end;
$$;

-- ---------------------------------------------------------------------
-- Fixtures (as database owner)
-- ---------------------------------------------------------------------
do $$
declare
  v_resort uuid := current_setting('dbtest.resort_a')::uuid;
  v_today date := operational_today(v_resort);
  v_type uuid;
begin
  insert into shift_types (resort_id, key, name, sort_order) values (v_resort, 'mr-test', 'MR Test Shift', 1) returning id into v_type;

  perform set_config('dbtest.mr_today', v_today::text, false);
  perform set_config('dbtest.mr_inst_past',      pg_temp.mr_instance(v_resort, v_type, v_today - 2, 1)::text, false);
  perform set_config('dbtest.mr_inst_today',     pg_temp.mr_instance(v_resort, v_type, v_today, 1)::text, false);
  -- required 2, so 3 assignments is a genuine "above required" shift.
  perform set_config('dbtest.mr_inst_future',    pg_temp.mr_instance(v_resort, v_type, v_today + 3, 2)::text, false);
  perform set_config('dbtest.mr_inst_over',      pg_temp.mr_instance(v_resort, v_type, v_today + 4, 1)::text, false);
  perform set_config('dbtest.mr_inst_cancelled', pg_temp.mr_instance(v_resort, v_type, v_today + 5, 1, 'cancelled')::text, false);
  perform set_config('dbtest.mr_inst_att',       pg_temp.mr_instance(v_resort, v_type, v_today + 6, 1)::text, false);
  perform set_config('dbtest.mr_inst_pubfuture', pg_temp.mr_instance(v_resort, v_type, v_today + 14, 1)::text, false);

  perform set_config('dbtest.mr_a2', pg_temp.mr_driver(v_resort, 'MR Driver A2')::text, false);
  perform set_config('dbtest.mr_a4', pg_temp.mr_driver(v_resort, 'MR Driver A4')::text, false);
  perform set_config('dbtest.mr_a5', pg_temp.mr_driver(v_resort, 'MR Driver A5')::text, false);
  perform set_config('dbtest.mr_a6', pg_temp.mr_driver(v_resort, 'MR Driver A6')::text, false);
  perform set_config('dbtest.mr_inactive', pg_temp.mr_driver(v_resort, 'MR Driver Inactive', false)::text, false);

  -- Availability. Driver A: Available everywhere used. A2: explicitly
  -- Unavailable. A4: no row at all (Not Submitted). A5/A6: Available.
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_future')::uuid,    current_setting('dbtest.driver_a_id')::uuid, 'available');
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_future')::uuid,    current_setting('dbtest.mr_a2')::uuid, 'unavailable');
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_over')::uuid,      current_setting('dbtest.mr_a5')::uuid, 'available');
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_over')::uuid,      current_setting('dbtest.mr_a6')::uuid, 'available');
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_today')::uuid,     current_setting('dbtest.driver_a_id')::uuid, 'available');
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_pubfuture')::uuid, current_setting('dbtest.driver_a_id')::uuid, 'available');
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_past')::uuid,      current_setting('dbtest.driver_a_id')::uuid, 'available');
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_cancelled')::uuid, current_setting('dbtest.driver_a_id')::uuid, 'available');
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_future')::uuid,    current_setting('dbtest.mr_inactive')::uuid, 'available');
end $$;

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- =======================================================================
-- ASSIGN: Available driver, normal path
-- =======================================================================
do $$
declare
  v_id uuid;
  v_state text;
begin
  select assignment_id, availability_state into v_id, v_state
  from assign_driver(current_setting('dbtest.mr_inst_future')::uuid, current_setting('dbtest.driver_a_id')::uuid);
  perform set_config('dbtest.mr_assignment_a', v_id::text, false);

  perform pg_temp.expect_true('assign: an Available, active, same-resort driver is assigned with no override needed',
    exists (select 1 from rota_assignments where id = v_id
              and shift_instance_id = current_setting('dbtest.mr_inst_future')::uuid
              and driver_id = current_setting('dbtest.driver_a_id')::uuid));
  perform pg_temp.expect_equal('assign: the RPC returns the availability state it actually used (available)', v_state, 'available');
  perform pg_temp.expect_equal('assign: assignment_source is manual',
    (select assignment_source from rota_assignments where id = v_id), 'manual');
  perform pg_temp.expect_equal('assign: assigned_by is the acting manager',
    (select assigned_by from rota_assignments where id = v_id), current_setting('dbtest.manager_id')::uuid);
  perform pg_temp.expect_equal('assign: resort_id is derived from the shift, never client-supplied',
    (select resort_id from rota_assignments where id = v_id), current_setting('dbtest.resort_a')::uuid);
end $$;

select pg_temp.expect_true('audit: the assignment produced an insert row carrying the assigned row',
  exists (select 1 from audit_log where table_name = 'rota_assignments' and action = 'insert'
            and row_id = current_setting('dbtest.mr_assignment_a')::uuid
            and (after ->> 'driver_id') = current_setting('dbtest.driver_a_id')));
select pg_temp.expect_true('audit: an Available assignment records operation/availability_state=available/availability_override=false, and no reason',
  exists (select 1 from audit_log where table_name = 'rota_assignments' and action = 'insert'
            and row_id = current_setting('dbtest.mr_assignment_a')::uuid
            and context ->> 'operation' = 'assign_driver'
            and context ->> 'availability_state' = 'available'
            and (context ->> 'availability_override')::boolean = false
            and not (context ? 'reason')));

-- =======================================================================
-- ASSIGN: Unavailable requires explicit, server-enforced acknowledgement
-- =======================================================================
select pg_temp.expect_error_detail('assign: an Unavailable driver without acknowledgement is blocked, with the current state in DETAIL (VD001)',
  format('select * from assign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_future'), current_setting('dbtest.mr_a2')),
  'VD001', 'unavailable');
select pg_temp.expect_error_detail('assign: an explicit confirm=false behaves the same as omitting it',
  format('select * from assign_driver(%L::uuid, %L::uuid, false)', current_setting('dbtest.mr_inst_future'), current_setting('dbtest.mr_a2')),
  'VD001', 'unavailable');
select pg_temp.expect_true('assign: the blocked Unavailable attempt inserted nothing',
  not exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_future')::uuid
                and driver_id = current_setting('dbtest.mr_a2')::uuid));
select pg_temp.expect_true('audit: the blocked attempt left no successful assignment audit row',
  not exists (select 1 from audit_log where table_name = 'rota_assignments' and action = 'insert'
                and (after ->> 'driver_id') = current_setting('dbtest.mr_a2')));

do $$
declare
  v_id uuid;
  v_state text;
begin
  select assignment_id, availability_state into v_id, v_state
  from assign_driver(current_setting('dbtest.mr_inst_future')::uuid, current_setting('dbtest.mr_a2')::uuid, true,
                     E'  Driver confirmed by phone  ');
  perform set_config('dbtest.mr_assignment_a2', v_id::text, false);
  perform pg_temp.expect_equal('assign: with acknowledgement an Unavailable driver IS assigned, and the state used is reported', v_state, 'unavailable');
  perform pg_temp.expect_true('assign: the acknowledged Unavailable assignment exists',
    exists (select 1 from rota_assignments where id = v_id));
end $$;

select pg_temp.expect_true('audit: an Unavailable override records availability_state, override=true, and the TRIMMED reason',
  exists (select 1 from audit_log where table_name = 'rota_assignments' and action = 'insert'
            and row_id = current_setting('dbtest.mr_assignment_a2')::uuid
            and context ->> 'operation' = 'assign_driver'
            and context ->> 'availability_state' = 'unavailable'
            and (context ->> 'availability_override')::boolean = true
            and context ->> 'reason' = 'Driver confirmed by phone'));

-- =======================================================================
-- ASSIGN: Not Submitted has its own distinct state
-- =======================================================================
select pg_temp.expect_error_detail('assign: a Not Submitted driver (no availability row) without acknowledgement is blocked, DETAIL not_submitted (VD001)',
  format('select * from assign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_future'), current_setting('dbtest.mr_a4')),
  'VD001', 'not_submitted');
select pg_temp.expect_true('assign: the blocked Not Submitted attempt inserted nothing',
  not exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_future')::uuid
                and driver_id = current_setting('dbtest.mr_a4')::uuid));

do $$
declare
  v_id uuid;
  v_state text;
begin
  -- No reason supplied at all: the reason is genuinely optional.
  select assignment_id, availability_state into v_id, v_state
  from assign_driver(current_setting('dbtest.mr_inst_future')::uuid, current_setting('dbtest.mr_a4')::uuid, true);
  perform set_config('dbtest.mr_assignment_a4', v_id::text, false);
  perform pg_temp.expect_equal('assign: with acknowledgement a Not Submitted driver is assigned, state not_submitted', v_state, 'not_submitted');
end $$;

select pg_temp.expect_true('audit: a Not Submitted override records not_submitted + override=true, and omits reason when none was given (optional reason)',
  exists (select 1 from audit_log where table_name = 'rota_assignments' and action = 'insert'
            and row_id = current_setting('dbtest.mr_assignment_a4')::uuid
            and context ->> 'availability_state' = 'not_submitted'
            and (context ->> 'availability_override')::boolean = true
            and not (context ? 'reason')));

-- =======================================================================
-- ASSIGN: stale-client race -- the server re-reads availability itself
-- =======================================================================
do $$
declare
  v_state text;
begin
  -- A5 loads as Available, then flips to Unavailable before the manager
  -- clicks. The (stale) call carries no acknowledgement and must NOT
  -- silently succeed.
  perform pg_temp.as_postgres();
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_over')::uuid, current_setting('dbtest.mr_a5')::uuid, 'unavailable');
  perform pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

  perform pg_temp.expect_error_detail('race: a driver who became Unavailable after the manager loaded the page is blocked, not silently assigned',
    format('select * from assign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_over'), current_setting('dbtest.mr_a5')),
    'VD001', 'unavailable');

  -- The manager confirms; the server re-evaluates AGAIN and records the state
  -- actually in force at write time (here: it changed back to Available).
  perform pg_temp.as_postgres();
  perform pg_temp.mr_availability(current_setting('dbtest.mr_inst_over')::uuid, current_setting('dbtest.mr_a5')::uuid, 'available');
  perform pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

  select availability_state into v_state
  from assign_driver(current_setting('dbtest.mr_inst_over')::uuid, current_setting('dbtest.mr_a5')::uuid, true, '   ');
  perform pg_temp.expect_equal('race: a confirm flag never overrides the truth -- the state used is the one read at write time', v_state, 'available');
end $$;

select pg_temp.expect_true('audit: a confirm flag on a driver who is actually Available records override=false (not a fabricated override), and a whitespace-only reason normalises to no reason',
  exists (select 1 from audit_log where table_name = 'rota_assignments' and action = 'insert'
            and (after ->> 'driver_id') = current_setting('dbtest.mr_a5')
            and (after ->> 'shift_instance_id') = current_setting('dbtest.mr_inst_over')
            and context ->> 'availability_state' = 'available'
            and (context ->> 'availability_override')::boolean = false
            and not (context ? 'reason')));

-- =======================================================================
-- ASSIGN: optional reason bounds
-- =======================================================================
select pg_temp.expect_error_detail('assign: a reason over 500 characters is rejected with a friendly validation error (23514)',
  format('select * from assign_driver(%L::uuid, %L::uuid, false, %L)', current_setting('dbtest.mr_inst_over'), current_setting('dbtest.mr_a6'), repeat('x', 501)),
  '23514');
select pg_temp.expect_true('assign: the over-long-reason attempt inserted nothing',
  not exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_over')::uuid and driver_id = current_setting('dbtest.mr_a6')::uuid));
do $$
declare
  v_id uuid;
begin
  -- Exactly 500 is allowed. This also assigns a SECOND driver to a
  -- required_drivers=1 shift that is already covered (A5), proving the
  -- requirement is a minimum, not a capacity.
  select assignment_id into v_id from assign_driver(current_setting('dbtest.mr_inst_over')::uuid, current_setting('dbtest.mr_a6')::uuid, false, repeat('y', 500));
  perform set_config('dbtest.mr_assignment_a6', v_id::text, false);
  perform pg_temp.expect_equal('assign: a reason of exactly 500 characters is accepted',
    (select char_length(context ->> 'reason') from audit_log where table_name = 'rota_assignments' and action = 'insert' and row_id = v_id), 500);
end $$;
select pg_temp.expect_equal('assign: required_drivers already met (1/1) does NOT block another assignment (2/1)',
  (select count(*)::int from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_over')::uuid), 2);
select pg_temp.expect_true('assign: the reason is stored ONLY in audit context -- rota_assignments has no reason/override column',
  not exists (select 1 from information_schema.columns where table_name = 'rota_assignments'
                and column_name ~* '(reason|override|note|availability)'));

-- =======================================================================
-- ASSIGN: required_drivers is a minimum, never a capacity
-- =======================================================================
select pg_temp.expect_equal('assign: a required_drivers=2 shift now holds 3 assignments (A, A2, A4) -- exceeded, still allowed',
  (select count(*)::int from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_future')::uuid), 3);

-- =======================================================================
-- ASSIGN: validation rejections (friendly messages, nothing inserted)
-- =======================================================================
select pg_temp.expect_error_detail('assign: an inactive driver is rejected (23514)',
  format('select * from assign_driver(%L::uuid, %L::uuid, true)', current_setting('dbtest.mr_inst_future'), current_setting('dbtest.mr_inactive')),
  '23514');
select pg_temp.expect_error_detail('assign: a driver from a DIFFERENT resort is rejected with a friendly message, not a raw FK error (23514)',
  format('select * from assign_driver(%L::uuid, %L::uuid, true)', current_setting('dbtest.mr_inst_future'), current_setting('dbtest.driver_b_id')),
  '23514');
select pg_temp.expect_error_detail('assign: a cancelled (non-assignable) shift is rejected (23514)',
  format('select * from assign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_cancelled'), current_setting('dbtest.driver_a_id')),
  '23514');
select pg_temp.expect_error_detail('assign: an unknown shift is rejected (P0002)',
  format('select * from assign_driver(%L::uuid, %L::uuid)', gen_random_uuid(), current_setting('dbtest.driver_a_id')),
  'P0002');
select pg_temp.expect_error_detail('assign: an unknown driver is rejected (P0002)',
  format('select * from assign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_future'), gen_random_uuid()),
  'P0002');
select pg_temp.expect_error_detail('assign: assigning the same driver to the same shift twice is rejected cleanly (23505)',
  format('select * from assign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_future'), current_setting('dbtest.driver_a_id')),
  '23505');
select pg_temp.expect_equal('assign: the duplicate attempt left exactly one assignment for that driver+shift',
  (select count(*)::int from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_future')::uuid
     and driver_id = current_setting('dbtest.driver_a_id')::uuid), 1);
select pg_temp.expect_true('assign: none of the rejected attempts (inactive / cross-resort / cancelled) inserted a row',
  not exists (select 1 from rota_assignments where driver_id in (current_setting('dbtest.mr_inactive')::uuid, current_setting('dbtest.driver_b_id')::uuid))
  and not exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_cancelled')::uuid));

-- =======================================================================
-- ASSIGN: operational-date boundary (Europe/Zurich via operational_today)
-- =======================================================================
select pg_temp.expect_error_detail('assign: a shift dated BEFORE operational today is rejected as historical (55006, detail historical_shift)',
  format('select * from assign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_past'), current_setting('dbtest.driver_a_id')),
  '55006', 'historical_shift');
select pg_temp.expect_true('assign: the historical attempt inserted nothing',
  not exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_past')::uuid));
do $$
declare
  v_id uuid;
begin
  select assignment_id into v_id from assign_driver(current_setting('dbtest.mr_inst_today')::uuid, current_setting('dbtest.driver_a_id')::uuid);
  perform pg_temp.expect_true('assign: a shift dated TODAY (operational) is assignable', v_id is not null);
end $$;
select pg_temp.expect_true('assign: a future shift is assignable (A/A2/A4 above)',
  (select count(*) from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_future')::uuid) = 3);

-- =======================================================================
-- PUBLISHED WEEKS: manager edits are allowed and never touch publication
-- =======================================================================
select pg_temp.as_postgres();
select pg_temp.mr_publish(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.mr_today')::date);
select pg_temp.mr_publish(current_setting('dbtest.resort_a')::uuid, (current_setting('dbtest.mr_today')::date + 14));
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_cur_before jsonb;
  v_fut_before jsonb;
  v_pub_audit_before int;
  v_resort uuid := current_setting('dbtest.resort_a')::uuid;
  v_today date := current_setting('dbtest.mr_today')::date;
begin
  select to_jsonb(rp) into v_cur_before from rota_publications rp where rp.resort_id = v_resort and rp.week_start = v_today - app_weekday(v_today)::integer;
  select to_jsonb(rp) into v_fut_before from rota_publications rp where rp.resort_id = v_resort and rp.week_start = (v_today + 14) - app_weekday(v_today + 14)::integer;
  select count(*) into v_pub_audit_before from audit_log where table_name = 'rota_publications';

  -- Current published week: today's shift already has A assigned (above);
  -- add and remove another driver through the RPCs.
  perform assign_driver(current_setting('dbtest.mr_inst_today')::uuid, current_setting('dbtest.mr_a5')::uuid, true);
  perform pg_temp.expect_true('published CURRENT week: manager assignment succeeds',
    exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_today')::uuid and driver_id = current_setting('dbtest.mr_a5')::uuid));
  perform unassign_driver(current_setting('dbtest.mr_inst_today')::uuid, current_setting('dbtest.mr_a5')::uuid);
  perform pg_temp.expect_true('published CURRENT week: manager unassignment succeeds',
    not exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_today')::uuid and driver_id = current_setting('dbtest.mr_a5')::uuid));

  -- Published FUTURE week.
  perform assign_driver(current_setting('dbtest.mr_inst_pubfuture')::uuid, current_setting('dbtest.driver_a_id')::uuid);
  perform pg_temp.expect_true('published FUTURE week: manager assignment succeeds',
    exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_pubfuture')::uuid and driver_id = current_setting('dbtest.driver_a_id')::uuid));
  perform unassign_driver(current_setting('dbtest.mr_inst_pubfuture')::uuid, current_setting('dbtest.driver_a_id')::uuid);
  perform pg_temp.expect_true('published FUTURE week: manager unassignment succeeds',
    not exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_pubfuture')::uuid));

  perform pg_temp.expect_true('publication: the current-week rota_publications row is byte-for-byte unchanged (still published, never unpublished/recreated)',
    (select to_jsonb(rp) from rota_publications rp where rp.resort_id = v_resort and rp.week_start = v_today - app_weekday(v_today)::integer) = v_cur_before);
  perform pg_temp.expect_true('publication: the future-week rota_publications row is byte-for-byte unchanged',
    (select to_jsonb(rp) from rota_publications rp where rp.resort_id = v_resort and rp.week_start = (v_today + 14) - app_weekday(v_today + 14)::integer) = v_fut_before);
  perform pg_temp.expect_equal('publication: assignment edits wrote no rota_publications audit rows',
    (select count(*)::int from audit_log where table_name = 'rota_publications'), v_pub_audit_before);
  perform pg_temp.expect_equal('publication: exactly one publication row per published week -- none were added',
    (select count(*)::int from rota_publications where resort_id = v_resort), 2);
end $$;

-- =======================================================================
-- AUDIT CONTEXT ISOLATION
-- =======================================================================
-- Each RPC is checked IMMEDIATELY after it runs (nothing else in between), so
-- a missing clear in one RPC can never be masked by the other one clearing it.
do $$
declare
  v_assignment uuid;
begin
  -- assign_driver, with an override + reason so the context is distinctive.
  select assignment_id into v_assignment
  from assign_driver(current_setting('dbtest.mr_inst_over')::uuid, current_setting('dbtest.mr_a4')::uuid, true, 'isolation probe: must not leak');

  perform pg_temp.expect_true('context isolation (assign_driver): the transaction-local setting is cleared immediately after the assignment',
    coalesce(current_setting('app.audit_context', true), '') = '');

  -- A later, unrelated audited write in the SAME transaction.
  update drivers set full_name = 'MR Driver A2 (renamed after assign)' where id = current_setting('dbtest.mr_a2')::uuid;
  perform pg_temp.expect_true('context isolation (assign_driver): a later unrelated audited write does NOT inherit the assign_driver context',
    (select context is null from audit_log where table_name = 'drivers' and action = 'update'
       and row_id = current_setting('dbtest.mr_a2')::uuid and (after ->> 'full_name') = 'MR Driver A2 (renamed after assign)'));

  perform unassign_driver(current_setting('dbtest.mr_inst_over')::uuid, current_setting('dbtest.mr_a4')::uuid);
  perform pg_temp.expect_true('context isolation (unassign_driver): the setting is cleared immediately after the removal',
    coalesce(current_setting('app.audit_context', true), '') = '');

  update drivers set full_name = 'MR Driver A2 (renamed after unassign)' where id = current_setting('dbtest.mr_a2')::uuid;
  perform pg_temp.expect_true('context isolation (unassign_driver): a later unrelated audited write does NOT inherit the unassign_driver context',
    (select context is null from audit_log where table_name = 'drivers' and action = 'update'
       and row_id = current_setting('dbtest.mr_a2')::uuid and (after ->> 'full_name') = 'MR Driver A2 (renamed after unassign)'));
end $$;

do $$
begin
  -- Failure path: a context is set, then the unit of work fails inside a
  -- subtransaction (exactly what happens if the RPC's INSERT fails). The
  -- failed subtransaction must not leave the context behind.
  begin
    perform set_config('app.audit_context', '{"operation":"leak_probe","reason":"must never leak"}', true);
    raise exception 'simulated failure after context was set';
  exception when others then
    null;
  end;
  update drivers set full_name = 'MR Driver A4 (renamed)' where id = current_setting('dbtest.mr_a4')::uuid;
  perform pg_temp.expect_true('context isolation: a context set before a FAILED statement does not leak into the next audited write',
    (select context is null from audit_log where table_name = 'drivers' and action = 'update'
       and row_id = current_setting('dbtest.mr_a4')::uuid and (after ->> 'full_name') = 'MR Driver A4 (renamed)'));
end $$;

do $$
begin
  perform set_config('app.audit_context', 'this is not json', true);
  update drivers set full_name = 'MR Driver A5 (renamed)' where id = current_setting('dbtest.mr_a5')::uuid;
  perform pg_temp.expect_true('context robustness: a malformed (non-JSON) context never fails the underlying write',
    (select full_name from drivers where id = current_setting('dbtest.mr_a5')::uuid) = 'MR Driver A5 (renamed)');
  perform pg_temp.expect_true('context robustness: a malformed context is recorded as NULL, not as garbage',
    (select context is null from audit_log where table_name = 'drivers' and action = 'update'
       and row_id = current_setting('dbtest.mr_a5')::uuid and (after ->> 'full_name') = 'MR Driver A5 (renamed)'));

  perform set_config('app.audit_context', '[1,2,3]', true);
  update drivers set full_name = 'MR Driver A6 (renamed)' where id = current_setting('dbtest.mr_a6')::uuid;
  perform pg_temp.expect_true('context robustness: valid JSON that is not an object is recorded as NULL',
    (select context is null from audit_log where table_name = 'drivers' and action = 'update'
       and row_id = current_setting('dbtest.mr_a6')::uuid and (after ->> 'full_name') = 'MR Driver A6 (renamed)'));
  perform set_config('app.audit_context', '', true);
end $$;

-- =======================================================================
-- UNASSIGN
-- =======================================================================
do $$
declare
  v_removed uuid;
begin
  select assignment_id into v_removed from unassign_driver(current_setting('dbtest.mr_inst_future')::uuid, current_setting('dbtest.mr_a4')::uuid);
  perform pg_temp.expect_equal('unassign: returns the id of the assignment it removed', v_removed, current_setting('dbtest.mr_assignment_a4')::uuid);
  perform pg_temp.expect_true('unassign: the targeted assignment is gone (hard DELETE)',
    not exists (select 1 from rota_assignments where id = v_removed));
end $$;
select pg_temp.expect_equal('unassign: ONLY the targeted assignment was removed -- the other drivers on that shift are untouched',
  (select count(*)::int from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_future')::uuid
     and driver_id in (current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.mr_a2')::uuid)), 2);
select pg_temp.expect_true('audit: unassign produced a delete row whose before-image is the removed assignment',
  exists (select 1 from audit_log where table_name = 'rota_assignments' and action = 'delete'
            and row_id = current_setting('dbtest.mr_assignment_a4')::uuid
            and (before ->> 'driver_id') = current_setting('dbtest.mr_a4')
            and after is null));
select pg_temp.expect_true('audit: the unassign delete row carries context.operation = unassign_driver',
  exists (select 1 from audit_log where table_name = 'rota_assignments' and action = 'delete'
            and row_id = current_setting('dbtest.mr_assignment_a4')::uuid
            and context ->> 'operation' = 'unassign_driver'));
select pg_temp.expect_error_detail('unassign: removing an assignment that does not exist is an explicit not-found (P0002), not a silent success',
  format('select * from unassign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_future'), current_setting('dbtest.mr_a4')),
  'P0002');
select pg_temp.expect_error_detail('unassign: a driver who was never assigned to the shift is not found (P0002)',
  format('select * from unassign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_over'), current_setting('dbtest.driver_a_id')),
  'P0002');

-- Historical shift: seed an assignment directly (as owner), then try to remove it.
select pg_temp.as_postgres();
select pg_temp.mr_seed_assignment(current_setting('dbtest.mr_inst_past')::uuid, current_setting('dbtest.driver_a_id')::uuid);
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('unassign: a shift dated before operational today is rejected as historical (55006, detail historical_shift)',
  format('select * from unassign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_past'), current_setting('dbtest.driver_a_id')),
  '55006', 'historical_shift');
select pg_temp.expect_true('unassign: the historical assignment is still there',
  exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_past')::uuid and driver_id = current_setting('dbtest.driver_a_id')::uuid));

-- Attendance guard: ANY attendance row blocks removal, whatever its status.
select pg_temp.as_postgres();
select pg_temp.mr_seed_assignment(current_setting('dbtest.mr_inst_att')::uuid, current_setting('dbtest.mr_a5')::uuid);
select pg_temp.mr_seed_assignment(current_setting('dbtest.mr_inst_att')::uuid, current_setting('dbtest.mr_a6')::uuid);
select pg_temp.mr_attendance(current_setting('dbtest.mr_inst_att')::uuid, current_setting('dbtest.mr_a5')::uuid, 'worked');
select pg_temp.mr_attendance(current_setting('dbtest.mr_inst_att')::uuid, current_setting('dbtest.mr_a6')::uuid, 'cancelled');
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_error_detail('unassign: attendance (worked) blocks removal (55006, detail attendance_recorded)',
  format('select * from unassign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_att'), current_setting('dbtest.mr_a5')),
  '55006', 'attendance_recorded');
select pg_temp.expect_error_detail('unassign: attendance blocks removal regardless of its status -- a cancelled attendance row still blocks',
  format('select * from unassign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_att'), current_setting('dbtest.mr_a6')),
  '55006', 'attendance_recorded');
select pg_temp.expect_true('unassign: the assignments underneath recorded attendance survive, and the attendance rows are untouched',
  (select count(*) from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_att')::uuid) = 2
  and (select count(*) from attendance where shift_instance_id = current_setting('dbtest.mr_inst_att')::uuid) = 2);

-- Inactive drivers: stay assigned (no silent deletion) and can still be removed.
select pg_temp.as_postgres();
update drivers set is_active = false where id = current_setting('dbtest.mr_a2')::uuid;
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('inactive assignee: deactivating a driver does not delete or rewrite their existing assignment',
  exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_future')::uuid and driver_id = current_setting('dbtest.mr_a2')::uuid));
select pg_temp.expect_error_detail('inactive assignee: a NEW assignment of that now-inactive driver is rejected (23514)',
  format('select * from assign_driver(%L::uuid, %L::uuid, true)', current_setting('dbtest.mr_inst_over'), current_setting('dbtest.mr_a2')),
  '23514');
do $$
begin
  perform unassign_driver(current_setting('dbtest.mr_inst_future')::uuid, current_setting('dbtest.mr_a2')::uuid);
  perform pg_temp.expect_true('inactive assignee: the manager CAN remove an inactive driver''s existing assignment',
    not exists (select 1 from rota_assignments where shift_instance_id = current_setting('dbtest.mr_inst_future')::uuid and driver_id = current_setting('dbtest.mr_a2')::uuid));
end $$;

-- =======================================================================
-- SECURITY: the RPCs are the only client write path
-- =======================================================================
select pg_temp.expect_true('manager: can still SELECT rota_assignments (the weekly read model needs it)',
  (select count(*) from rota_assignments) > 0);
select pg_temp.expect_error('manager: cannot INSERT into rota_assignments directly (42501)',
  format('insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source) values (%L, %L, %L, %L)',
    current_setting('dbtest.mr_inst_over'), current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), 'manual'),
  '42501');
select pg_temp.expect_error('manager: cannot UPDATE rota_assignments directly (42501)',
  format('update rota_assignments set assignment_source = %L where id = %L', 'auto', current_setting('dbtest.mr_assignment_a')),
  '42501');
select pg_temp.expect_error('manager: cannot DELETE from rota_assignments directly (42501)',
  format('delete from rota_assignments where id = %L', current_setting('dbtest.mr_assignment_a')),
  '42501');
select pg_temp.expect_true('manager: the failed direct writes changed nothing',
  exists (select 1 from rota_assignments where id = current_setting('dbtest.mr_assignment_a')::uuid and assignment_source = 'manual'));
select pg_temp.expect_true('manager: has no write policy on rota_assignments at all (the only policy left is SELECT-only)',
  (select count(*) from pg_policy where polrelid = 'rota_assignments'::regclass) = 1
  and (select polcmd from pg_policy where polrelid = 'rota_assignments'::regclass) = 'r');
select pg_temp.expect_true('manager: can read audit_log context (manager-only visibility)',
  exists (select 1 from audit_log where table_name = 'rota_assignments' and context is not null));

-- Driver
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error('driver: cannot call assign_driver (42501)',
  format('select * from assign_driver(%L::uuid, %L::uuid, true)', current_setting('dbtest.mr_inst_over'), current_setting('dbtest.driver_a_id')),
  '42501');
select pg_temp.expect_error('driver: cannot call unassign_driver (42501)',
  format('select * from unassign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_future'), current_setting('dbtest.driver_a_id')),
  '42501');
select pg_temp.expect_error('driver: cannot write rota_assignments directly (42501)',
  format('insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source) values (%L, %L, %L, %L)',
    current_setting('dbtest.mr_inst_over'), current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), 'manual'),
  '42501');
select pg_temp.expect_true('driver: still sees no rows of the manager assignment base table even though assignments exist',
  (select count(*) from rota_assignments) = 0);
select pg_temp.expect_true('driver: cannot see audit_log, so override reasons stay manager-only',
  (select count(*) from audit_log) = 0);
select pg_temp.expect_true('driver: the safe view exposes no driver identity, availability, or headcount columns',
  not exists (select 1 from information_schema.columns where table_name = 'driver_visible_assignments'
                and column_name in ('driver_id', 'full_name', 'required_drivers', 'status', 'reason', 'context', 'availability_state')));

-- Anonymous
select pg_temp.act_as('anon');
select pg_temp.expect_error('anon: cannot call assign_driver (42501)',
  format('select * from assign_driver(%L::uuid, %L::uuid, true)', current_setting('dbtest.mr_inst_over'), current_setting('dbtest.driver_a_id')),
  '42501');
select pg_temp.expect_error('anon: cannot call unassign_driver (42501)',
  format('select * from unassign_driver(%L::uuid, %L::uuid)', current_setting('dbtest.mr_inst_future'), current_setting('dbtest.driver_a_id')),
  '42501');
select pg_temp.expect_error('anon: cannot write rota_assignments directly (42501)',
  format('insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source) values (%L, %L, %L, %L)',
    current_setting('dbtest.mr_inst_over'), current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), 'manual'),
  '42501');

-- Driver safe view: exactly the driver's own published assignments, as before.
select pg_temp.as_postgres();
do $$
declare
  v_expected int;
begin
  select count(*) into v_expected
  from rota_assignments ra
  join shift_instances si on si.id = ra.shift_instance_id and si.status = 'active'
  join rota_publications rp on rp.resort_id = si.resort_id and rp.week_start = si.week_start
                            and rp.published_at is not null and rp.unpublished_at is null
  where ra.driver_id = current_setting('dbtest.driver_a_id')::uuid;
  perform set_config('dbtest.mr_expected_visible', v_expected::text, false);
end $$;
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_equal('driver safe view: shows exactly the driver''s own assignments in PUBLISHED weeks (and a manager''s edits there are reflected), nothing else',
  (select count(*)::int from driver_visible_assignments), current_setting('dbtest.mr_expected_visible')::int);
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
