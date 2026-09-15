-- 29_simplify_shift_staffing
--
-- Stage 2D: Shift Staffing Simplification. Replaces the never-fully-built
-- manager-facing "Rota Rules" system (rota_rules_default/weekday/date --
-- Stage 2D Checkpoint 3) with a single product decision: `required_drivers`
-- belongs directly to the Shift (shift_templates), exactly like start_time/
-- end_time already do. A different staffing period for the same service is
-- simply a different, separately-named Shift (e.g. "Dinner (1P)" vs
-- "Dinner (2P)") -- never a precedence/override system.
--
-- Approved via architecture review (see conversation history) following the
-- observation that no manager-facing Rota Rules UI, repository writer, or
-- consumer was ever built -- only raw-SQL test/fixture inserts existed
-- anywhere against rota_rules_default/weekday/date. There is therefore
-- nothing to migrate data out of; those three tables are dropped outright,
-- not deprecated.
--
-- Payroll (shift_base_pay_rules/driver_delivery_rates and their RPCs) is
-- completely independent of staffing and is untouched by this migration.
--
-- LOCAL DEV DATA NOTE: shift_templates.required_drivers has been NULL for
-- every row created since Checkpoint 3 (the atomic create_shift/revise_shift/
-- reactivate_shift RPCs never wrote it -- staffing was meant to live in the
-- Rota Rule tables instead). There is no real historical value to backfill
-- from, and this is pre-launch/local-development data throughout, so this
-- migration does NOT backfill existing NULLs to a guessed value (never 1)
-- and does NOT add a schema default. Making the column NOT NULL only works
-- because a full `supabase db reset` applies every migration against an
-- empty database before any seed script runs -- if you are instead applying
-- this migration incrementally against a local database that already has
-- shift_templates rows, reset your local stack first (`npm run db:reset:test`
-- / `npx supabase db reset`).
--
-- =======================================================================
-- 1. ATOMIC SHIFT RPCs -- required_drivers becomes a required input,
--    threaded through the shared _apply_shift_weekdays() helper into
--    shift_templates. Validated (>= 1) the same way name/time already are:
--    no silent coalesce, no default of 1. deactivate_shift is untouched --
--    it never wrote required_drivers and still doesn't.
-- =======================================================================
drop function if exists _apply_shift_weekdays(uuid, uuid, time, time, smallint[], date, date);

create function _apply_shift_weekdays(
  p_shift_type_id uuid,
  p_resort_id uuid,
  p_start_time time,
  p_end_time time,
  p_weekdays smallint[],
  p_required_drivers integer,
  p_effective_from date,
  p_effective_to date default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_weekday smallint;
  v_dropped record;
  v_current record;
begin
  if p_weekdays is null or array_length(p_weekdays, 1) is null then
    raise exception 'Select at least one day of the week.' using errcode = '23514';
  end if;
  if p_required_drivers is null or p_required_drivers < 1 then
    raise exception 'At least 1 driver is required.' using errcode = '23514';
  end if;

  -- Weekdays this shift currently operates on but the new selection
  -- drops entirely: end their active period the day before the change.
  for v_dropped in
    select distinct weekday from shift_templates
    where shift_type_id = p_shift_type_id
      and resort_id = p_resort_id
      and is_active
      and weekday <> all (p_weekdays)
  loop
    update shift_templates
      set is_active = false,
          effective_to = greatest(effective_from, p_effective_from - 1)
      where shift_type_id = p_shift_type_id
        and resort_id = p_resort_id
        and weekday = v_dropped.weekday
        and is_active;
  end loop;

  -- Weekdays in the new selection: reconcile against whatever is
  -- currently active for that weekday, then (re)establish it with the
  -- new time/staffing from p_effective_from.
  foreach v_weekday in array p_weekdays loop
    select * into v_current
    from shift_templates
    where shift_type_id = p_shift_type_id
      and resort_id = p_resort_id
      and weekday = v_weekday
      and is_active;

    if found and v_current.effective_from >= p_effective_from then
      -- This version has never taken effect before the new date -- it is
      -- still a future plan, not history. Replace it in place rather
      -- than opening a second row that would zero-width-collide with it.
      update shift_templates
        set start_time = p_start_time,
            end_time = p_end_time,
            required_drivers = p_required_drivers,
            effective_from = p_effective_from,
            effective_to = p_effective_to
        where id = v_current.id;
    else
      if found then
        update shift_templates
          set is_active = false,
              effective_to = p_effective_from - 1
          where id = v_current.id;
      end if;

      insert into shift_templates (
        resort_id, shift_type_id, weekday, start_time, end_time, required_drivers, effective_from, effective_to, is_active
      ) values (
        p_resort_id, p_shift_type_id, v_weekday, p_start_time, p_end_time, p_required_drivers, p_effective_from, p_effective_to, true
      );
    end if;
  end loop;
end;
$$;

comment on function _apply_shift_weekdays(uuid, uuid, time, time, smallint[], integer, date, date) is
  'Internal helper shared by create_shift/revise_shift/reactivate_shift. Reconciles shift_templates (schedule + required_drivers) for one shift type against a new weekday/time/staffing selection in a single atomic pass. Never called directly by clients.';

revoke execute on function _apply_shift_weekdays(uuid, uuid, time, time, smallint[], integer, date, date) from public;

drop function if exists create_shift(uuid, text, time, time, smallint[], date, date);

create function create_shift(
  p_resort_id uuid,
  p_name text,
  p_start_time time,
  p_end_time time,
  p_weekdays smallint[],
  p_required_drivers integer,
  p_effective_from date default null,
  p_effective_to date default null
)
returns table (shift_type_id uuid, key text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift_type_id uuid;
  v_base_key text;
  v_key text;
  v_suffix int := 1;
  v_sort_order int;
  v_effective_from date;
begin
  perform assert_active_manager();

  if p_name is null or btrim(p_name) = '' then
    raise exception 'A shift needs a name.' using errcode = '23514';
  end if;
  if p_end_time <= p_start_time then
    raise exception 'End time must be after start time.' using errcode = '23514';
  end if;
  if p_required_drivers is null or p_required_drivers < 1 then
    raise exception 'At least 1 driver is required.' using errcode = '23514';
  end if;

  v_effective_from := coalesce(p_effective_from, operational_today(p_resort_id));

  v_base_key := trim(both '_' from regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', '_', 'g'));
  if v_base_key = '' then
    v_base_key := 'shift';
  end if;
  v_key := v_base_key;
  while exists (select 1 from shift_types st where st.resort_id = p_resort_id and st.key = v_key) loop
    v_suffix := v_suffix + 1;
    v_key := v_base_key || '_' || v_suffix;
  end loop;

  select coalesce(max(sort_order), -1) + 1 into v_sort_order
  from shift_types where resort_id = p_resort_id;

  insert into shift_types (resort_id, key, name, sort_order, is_active)
  values (p_resort_id, v_key, btrim(p_name), v_sort_order, true)
  returning id into v_shift_type_id;

  -- Atomic with the shift_types insert above: any failure here (e.g. an
  -- invalid weekday) rolls back the shift_types row too, so a shift is
  -- never left half-created.
  perform _apply_shift_weekdays(v_shift_type_id, p_resort_id, p_start_time, p_end_time, p_weekdays, p_required_drivers, v_effective_from, p_effective_to);

  return query select v_shift_type_id, v_key;
end;
$$;

comment on function create_shift(uuid, text, time, time, smallint[], integer, date, date) is
  'Manager-only, atomic. Creates a new shift (stable shift_type + its weekday schedule + required_drivers) in one transaction. required_drivers is mandatory (>= 1, no default) -- staffing lives on the Shift itself, never a separate rota-rule system. A failure partway through rolls back the whole action, never a partially-created shift.';

revoke execute on function create_shift(uuid, text, time, time, smallint[], integer, date, date) from public;
grant execute on function create_shift(uuid, text, time, time, smallint[], integer, date, date) to authenticated;

drop function if exists revise_shift(uuid, uuid, text, time, time, smallint[], date, date);

create function revise_shift(
  p_shift_type_id uuid,
  p_resort_id uuid,
  p_name text,
  p_start_time time,
  p_end_time time,
  p_weekdays smallint[],
  p_required_drivers integer,
  p_effective_from date default null,
  p_effective_to date default null
)
returns table (shift_type_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_from date;
  v_is_active boolean;
begin
  perform assert_active_manager();

  select is_active into v_is_active from shift_types
  where id = p_shift_type_id and resort_id = p_resort_id;

  if not found then
    raise exception 'Shift not found.' using errcode = 'P0002';
  end if;
  if not v_is_active then
    raise exception 'An inactive shift must be reactivated before it can be revised.' using errcode = '55006';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'A shift needs a name.' using errcode = '23514';
  end if;
  if p_end_time <= p_start_time then
    raise exception 'End time must be after start time.' using errcode = '23514';
  end if;
  if p_required_drivers is null or p_required_drivers < 1 then
    raise exception 'At least 1 driver is required.' using errcode = '23514';
  end if;

  v_effective_from := coalesce(p_effective_from, operational_today(p_resort_id));

  update shift_types set name = btrim(p_name) where id = p_shift_type_id;

  perform _apply_shift_weekdays(p_shift_type_id, p_resort_id, p_start_time, p_end_time, p_weekdays, p_required_drivers, v_effective_from, p_effective_to);

  return query select p_shift_type_id;
end;
$$;

comment on function revise_shift(uuid, uuid, text, time, time, smallint[], integer, date, date) is
  'Manager-only, atomic. Revises an active shift''s name/time/weekdays/required_drivers/effective dates in one transaction. Never rewrites history: a weekday version that already governs real dates is retired (effective_to = the day before the change), not overwritten in place -- staffing changes go through the same versioned history as schedule changes.';

revoke execute on function revise_shift(uuid, uuid, text, time, time, smallint[], integer, date, date) from public;
grant execute on function revise_shift(uuid, uuid, text, time, time, smallint[], integer, date, date) to authenticated;

drop function if exists reactivate_shift(uuid, uuid, time, time, smallint[], date, date);

create function reactivate_shift(
  p_shift_type_id uuid,
  p_resort_id uuid,
  p_start_time time,
  p_end_time time,
  p_weekdays smallint[],
  p_required_drivers integer,
  p_effective_from date default null,
  p_effective_to date default null
)
returns table (shift_type_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_from date;
  v_is_active boolean;
begin
  perform assert_active_manager();

  select is_active into v_is_active from shift_types
  where id = p_shift_type_id and resort_id = p_resort_id;

  if not found then
    raise exception 'Shift not found.' using errcode = 'P0002';
  end if;
  if v_is_active then
    raise exception 'This shift is already active.' using errcode = '23514';
  end if;
  if p_end_time <= p_start_time then
    raise exception 'End time must be after start time.' using errcode = '23514';
  end if;
  if p_required_drivers is null or p_required_drivers < 1 then
    raise exception 'At least 1 driver is required.' using errcode = '23514';
  end if;

  v_effective_from := coalesce(p_effective_from, operational_today(p_resort_id));

  update shift_types set is_active = true where id = p_shift_type_id;

  -- Every prior template row for this shift type is inactive at this
  -- point (the shift was fully deactivated), so _apply_shift_weekdays'
  -- "reconcile against the current active row" logic finds nothing to
  -- retire/replace for any weekday and always inserts fresh rows --
  -- satisfying "never resurrect old historical rows" by construction.
  perform _apply_shift_weekdays(p_shift_type_id, p_resort_id, p_start_time, p_end_time, p_weekdays, p_required_drivers, v_effective_from, p_effective_to);

  return query select p_shift_type_id;
end;
$$;

comment on function reactivate_shift(uuid, uuid, time, time, smallint[], integer, date, date) is
  'Manager-only, atomic. Reactivates an inactive shift under the same stable shift_type_id, creating brand-new active shift_templates rows (including a required staffing count) from p_effective_from. Never flips an old historical row back to active.';

revoke execute on function reactivate_shift(uuid, uuid, time, time, smallint[], integer, date, date) from public;
grant execute on function reactivate_shift(uuid, uuid, time, time, smallint[], integer, date, date) to authenticated;

-- =======================================================================
-- 2. SHIFT_TEMPLATES.REQUIRED_DRIVERS becomes authoritative and mandatory
--    again -- the check (required_drivers > 0) constraint from the
--    original table definition was never dropped, only the NOT NULL was
--    (Checkpoint 3); restoring it here is enough, no backfill (see the
--    migration header note above).
-- =======================================================================
alter table shift_templates alter column required_drivers set not null;

comment on column shift_templates.required_drivers is
  'Authoritative staffing requirement for this Shift/weekday version (Stage 2D staffing simplification). Mandatory (>= 1, no default) -- a different staffing period for the same service is a separately-named Shift, never an override/precedence rule.';

comment on column shift_templates.is_premium is
  'Inert legacy column (Stage 2D staffing simplification): no longer populated, resolved, or read anywhere. High-value/fairness is not part of the V1 product model. Left nullable rather than dropped to avoid an unrelated column-removal migration.';

-- =======================================================================
-- 3. MATERIALISE_SHIFT_INSTANCES -- reads required_drivers directly off
--    shift_templates (already joined for schedule). No rota-rule join, no
--    precedence, no missing_rota_rule_count (that concept no longer
--    exists -- required_drivers is mandatory at Shift-creation time, so a
--    materialised instance can never be missing it). is_premium is no
--    longer resolved/populated at all (left NULL, inert column).
-- =======================================================================
drop function if exists materialise_shift_instances(uuid, date, date);

create function materialise_shift_instances(
  p_resort_id uuid,
  p_from_date date default null,
  p_to_date date default null
)
returns table (
  created_count integer,
  skipped_existing_count integer,
  from_date date,
  to_date date
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_from_date date;
  v_to_date date;
  v_created integer;
  v_total_governing integer;
begin
  perform assert_active_manager();
  v_from_date := coalesce(p_from_date, operational_today(p_resort_id));
  v_to_date := coalesce(p_to_date, end_of_following_month(v_from_date));
  if v_from_date > v_to_date then
    raise exception 'from_date (%) must not be after the computed to_date (%)', v_from_date, v_to_date;
  end if;

  with candidate_dates as (
    select generate_series(v_from_date, v_to_date, interval '1 day')::date as date
  ),
  governing as (
    select
      cd.date,
      st.id as shift_type_id,
      st.key,
      st.name,
      st.sort_order,
      t.id as template_id,
      t.start_time,
      t.end_time,
      t.required_drivers
    from candidate_dates cd
    join shift_types st
      on st.resort_id = p_resort_id
     and st.is_active
    join shift_templates t
      on t.shift_type_id = st.id
     and t.resort_id = p_resort_id
     and t.is_active
     and t.weekday = app_weekday(cd.date)
     and t.effective_from <= cd.date
     and (t.effective_to is null or t.effective_to >= cd.date)
  ),
  inserted as (
    insert into shift_instances
      (resort_id, date, shift_type_id, template_id, shift_key, name, sort_order,
       start_time, end_time, required_drivers,
       status, origin)
    select
      p_resort_id, g.date, g.shift_type_id, g.template_id, g.key, g.name, g.sort_order,
      g.start_time, g.end_time, g.required_drivers,
      'active', 'template'
    from governing g
    -- Belt-and-suspenders alongside ON CONFLICT: never even attempt a row
    -- that already exists for this identity.
    where not exists (
      select 1 from shift_instances si
      where si.resort_id = p_resort_id
        and si.shift_type_id = g.shift_type_id
        and si.date = g.date
    )
    on conflict (resort_id, shift_type_id, date) do nothing
    returning 1
  )
  select
    (select count(*) from inserted),
    (select count(*) from governing)
  into v_created, v_total_governing;

  return query select v_created, (v_total_governing - v_created), v_from_date, v_to_date;
end;
$$;

comment on function materialise_shift_instances(uuid, date, date) is
  'Manager-only, insert-only. Schedule and required_drivers both come directly from active shift_templates -- no rota-rule join, no precedence, no missing-staffing count (required_drivers is mandatory at Shift-creation time). Pay is never resolved here (Stage 2D Payroll Checkpoint A) -- shift_base_pay_rules/driver_delivery_rates are resolved later, at actual payroll-calculation time. Never modifies an existing instance of any origin/status.';

revoke execute on function materialise_shift_instances(uuid, date, date) from public;
grant execute on function materialise_shift_instances(uuid, date, date) to authenticated;

alter table shift_instances alter column required_drivers set not null;

comment on column shift_instances.required_drivers is
  'Operational snapshot of the governing Shift''s required_drivers at materialisation time (Stage 2D staffing simplification). Mandatory -- materialisation can never produce a NULL here any more, since required_drivers is mandatory on shift_templates itself.';

comment on column shift_instances.is_premium is
  'Inert legacy column (Stage 2D staffing simplification): no longer resolved or populated by materialise_shift_instances. High-value/fairness is not part of the V1 product model.';

-- =======================================================================
-- 4. TEMPLATE REFRESH now includes required_drivers in its comparison and
--    application -- the manager previews a staffing change (alongside any
--    schedule change) and explicitly applies it, exactly like a
--    name/time change already works. Deliberately does NOT add
--    required_drivers to `time_would_change`/the availability-reopen
--    trigger below: a staffing-only change must never reopen a driver's
--    already-confirmed availability (that stays scoped to a genuine
--    start_time/end_time change, unchanged from before).
-- =======================================================================
drop view if exists v_refreshable_instances;

create view v_refreshable_instances as
select
  si.id as shift_instance_id,
  si.resort_id,
  si.date,
  si.week_start,
  si.shift_type_id,
  si.shift_key,
  si.name as current_name,
  si.sort_order as current_sort_order,
  si.start_time as current_start_time,
  si.end_time as current_end_time,
  si.required_drivers as current_required_drivers,
  si.template_id as current_template_id,
  t.id as governing_template_id,
  st.name as new_name,
  st.sort_order as new_sort_order,
  t.start_time as new_start_time,
  t.end_time as new_end_time,
  t.required_drivers as new_required_drivers
from shift_instances si
join shift_types st on st.id = si.shift_type_id
join shift_templates t
  on t.shift_type_id = si.shift_type_id
 and t.resort_id = si.resort_id
 and t.is_active
 and t.weekday = app_weekday(si.date)
 and t.effective_from <= si.date
 and (t.effective_to is null or t.effective_to >= si.date)
where si.origin = 'template'
  and si.status = 'active'
  and si.date >= operational_today(si.resort_id)
  and not shift_instance_week_is_published(si.id)
  and not exists (select 1 from attendance a where a.shift_instance_id = si.id);

comment on view v_refreshable_instances is
  'Template-origin, active, future (in the resort''s own timezone), unpublished, un-attended instances that currently have a governing active template. Schedule fields (name/sort_order/start_time/end_time) plus required_drivers (Stage 2D staffing simplification) -- pay/high-value are still never schedule-refresh concerns. The safety-checked eligible set for both preview_template_refresh and apply_template_refresh. Internal only -- never granted to a client role directly.';

create or replace function preview_template_refresh(p_resort_id uuid, p_from_date date default null)
returns table (
  shift_instance_id uuid,
  date date,
  shift_type_id uuid,
  shift_key text,
  name text,
  current_template_id uuid,
  new_template_id uuid,
  will_change boolean,
  changed_fields jsonb,
  assignment_count integer,
  time_would_change boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_from_date date;
begin
  perform assert_active_manager();
  v_from_date := coalesce(p_from_date, operational_today(p_resort_id));

  return query
  select
    r.shift_instance_id,
    r.date,
    r.shift_type_id,
    r.shift_key,
    r.current_name,
    r.current_template_id,
    r.governing_template_id,
    (r.current_start_time, r.current_end_time, r.current_name, r.current_sort_order, r.current_required_drivers)
      is distinct from
    (r.new_start_time, r.new_end_time, r.new_name, r.new_sort_order, r.new_required_drivers),
    jsonb_strip_nulls(jsonb_build_object(
      'start_time', case when r.current_start_time is distinct from r.new_start_time then jsonb_build_object('old', r.current_start_time, 'new', r.new_start_time) end,
      'end_time', case when r.current_end_time is distinct from r.new_end_time then jsonb_build_object('old', r.current_end_time, 'new', r.new_end_time) end,
      'name', case when r.current_name is distinct from r.new_name then jsonb_build_object('old', r.current_name, 'new', r.new_name) end,
      'sort_order', case when r.current_sort_order is distinct from r.new_sort_order then jsonb_build_object('old', r.current_sort_order, 'new', r.new_sort_order) end,
      'required_drivers', case when r.current_required_drivers is distinct from r.new_required_drivers then jsonb_build_object('old', r.current_required_drivers, 'new', r.new_required_drivers) end
    )),
    coalesce(a.cnt, 0)::integer,
    -- Deliberately scoped to start/end time only -- a required_drivers-only
    -- change must never reopen already-confirmed driver availability.
    (r.current_start_time is distinct from r.new_start_time) or (r.current_end_time is distinct from r.new_end_time)
  from v_refreshable_instances r
  left join (
    select shift_instance_id, count(*) as cnt from rota_assignments group by shift_instance_id
  ) a on a.shift_instance_id = r.shift_instance_id
  where r.resort_id = p_resort_id
    and r.date >= v_from_date;
end;
$$;

comment on function preview_template_refresh(uuid, date) is
  'Manager-only, read-only. Shows what apply_template_refresh would change for the eligible (v_refreshable_instances) set -- schedule fields (name/sort_order/start_time/end_time) plus required_drivers (Stage 2D staffing simplification). Never modifies data. Default from_date resolves to "today" in the resort''s own timezone.';

create or replace function apply_template_refresh(p_resort_id uuid, p_from_date date default null)
returns table (
  updated_count integer,
  reopened_submission_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_from_date date;
  v_row record;
  v_updated integer := 0;
  v_touched_weeks date[] := array[]::date[];
  v_reopened integer;
  v_previously_confirmed_weeks date[];
begin
  perform assert_active_manager();
  v_from_date := coalesce(p_from_date, operational_today(p_resort_id));

  -- Snapshot which weeks were confirmed *before* this apply, so the
  -- reopened-count below reflects an actual state transition rather than a
  -- timestamp comparison -- now() is frozen at transaction start (not
  -- clock_timestamp()), so comparing it against a clock_timestamp()
  -- captured here would be wrong by construction, not just under a test
  -- transaction.
  select array_agg(distinct week_start) into v_previously_confirmed_weeks
  from availability_submissions
  where resort_id = p_resort_id and submitted_at is not null;

  for v_row in
    select * from v_refreshable_instances where resort_id = p_resort_id and date >= v_from_date
  loop
    update shift_instances
      set name = v_row.new_name,
          sort_order = v_row.new_sort_order,
          start_time = v_row.new_start_time,
          end_time = v_row.new_end_time,
          required_drivers = v_row.new_required_drivers,
          template_id = v_row.governing_template_id
      where id = v_row.shift_instance_id;

    v_updated := v_updated + 1;

    -- Deliberately scoped to start/end time only -- a required_drivers-only
    -- change must never reopen already-confirmed driver availability.
    if (v_row.current_start_time is distinct from v_row.new_start_time)
       or (v_row.current_end_time is distinct from v_row.new_end_time) then
      if not (v_row.week_start = any(v_touched_weeks)) then
        v_touched_weeks := array_append(v_touched_weeks, v_row.week_start);
      end if;
    end if;
  end loop;

  if v_touched_weeks is not null and array_length(v_touched_weeks, 1) is not null
     and v_previously_confirmed_weeks is not null then
    select count(*) into v_reopened
    from availability_submissions s
    where s.resort_id = p_resort_id
      and s.week_start = any(v_touched_weeks)
      and s.week_start = any(v_previously_confirmed_weeks)
      and s.submitted_at is null
      and s.reopened_reason = 'shift_time_changed';
  else
    v_reopened := 0;
  end if;

  return query select v_updated, v_reopened;
end;
$$;

comment on function apply_template_refresh(uuid, date) is
  'Manager-only. Updates exactly the v_refreshable_instances set: schedule snapshot fields (name/sort_order/start_time/end_time) + required_drivers (Stage 2D staffing simplification) + template_id from the current governing template. A required_drivers-only change never reopens availability -- only a genuine start/end time change does. Assignments are always retained regardless of any staffing change. Relies on the existing shift_instances triggers for audit logging and stale-confirmation reopening. Default from_date resolves to "today" in the resort''s own timezone.';

-- =======================================================================
-- 5. DROP the obsolete Rota Rule tables outright (never a manager-facing
--    UI/repository/RPC was built against them -- only raw-SQL test/fixture
--    inserts anywhere in this codebase, confirmed by inspection). Each
--    DROP TABLE takes its own policies/triggers/indexes with it; no other
--    table has a foreign key into any of these three, and no view
--    references them, so a plain DROP (no CASCADE) is enough and nothing
--    unintended is removed.
-- =======================================================================
drop table rota_rules_date;
drop table rota_rules_weekday;
drop table rota_rules_default;
