-- 21_operational_timezone
--
-- Timezone policy: operational scheduling data (shift dates, "today",
-- week boundaries, the materialisation horizon, refresh/cancellation
-- eligibility) is computed in the *resort's* timezone (resorts.timezone,
-- already 'Europe/Zurich' by default since migration 02 -- an IANA zone
-- name, which Postgres resolves through its own tzdata and therefore
-- handles CET/CEST/DST transitions automatically; never a fixed numeric
-- offset). System/event timestamps (created_at, submitted_at,
-- occurred_at, cancelled_at, etc.) are untouched: they are already
-- `timestamptz` absolute instants and were never timezone-ambiguous.
--
-- Audit finding: Stage 2C (migrations 18-20) used bare `current_date` in
-- five places (three as a parameter default, two as an inline date
-- comparison). `current_date` reflects the *Postgres session's* timezone
-- (this project's local/hosted Postgres defaults to UTC), not the
-- resort's -- so "today" near midnight Zurich time could silently
-- disagree with Zurich by up to two hours (CEST) regardless of which
-- timezone any particular browser is in. No other migration uses
-- `current_date`, and no operational logic used `now()` for date
-- comparisons (`now()` usages elsewhere are all legitimate `timestamptz`
-- defaults, e.g. submitted_at/published_at -- left untouched).

-- The one operational "what date is it" primitive. Falls back to
-- Europe/Zurich only when no resort_id is given (e.g. a bare utility
-- call) -- V1's only resorts are Swiss anyway; a resort with a different
-- timezone would automatically get its own correct date once seeded,
-- since this always prefers resorts.timezone when a resort_id is
-- available. SECURITY DEFINER so it works regardless of the caller's own
-- RLS visibility into resorts (consistent with the other helpers in this
-- schema, e.g. current_app_user()).
--
-- p_at defaults to now() but can be overridden -- this is what makes the
-- Postgres-tzdata DST behaviour (CET vs CEST) deterministically testable
-- with fixed historical instants instead of depending on whatever moment
-- the test happens to run at.
create or replace function operational_today(p_resort_id uuid default null, p_at timestamptz default now())
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (p_at at time zone coalesce(
    (select r.timezone from resorts r where r.id = p_resort_id),
    'Europe/Zurich'
  ))::date;
$$;

comment on function operational_today(uuid, timestamptz) is
  'The date, in the given resort''s timezone (resorts.timezone), of p_at (defaults to now(), or Europe/Zurich if no resort_id is given). The authoritative "what operational day is it" primitive -- never derive this from current_date (session/server timezone) or a browser-local Date.';

revoke execute on function operational_today(uuid, timestamptz) from public;
grant execute on function operational_today(uuid, timestamptz) to authenticated;

-- end_of_following_month: only its default changes (current_date ->
-- operational_today()). It has no resort context of its own -- every
-- caller below now resolves the resort-specific "today" itself and passes
-- it in explicitly; this default only matters for a bare, resort-less call.
create or replace function end_of_following_month(d date default operational_today())
returns date
language sql
immutable
as $$
  select (date_trunc('month', d) + interval '2 months' - interval '1 day')::date;
$$;

-- materialise_shift_instances: p_from_date/p_to_date defaults resolved
-- against THIS resort's timezone inside the body (a parameter default
-- expression cannot reference a sibling parameter like p_resort_id in
-- Postgres, so this can't be done in the signature itself).
create or replace function materialise_shift_instances(
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
    -- One row per (date, active shift_type) that currently has a governing
    -- active template for that weekday. The exclusion constraint on
    -- shift_templates (migration 05) guarantees at most one match here.
    select
      cd.date,
      st.id as shift_type_id,
      st.key,
      st.name,
      st.sort_order,
      t.id as template_id,
      t.start_time,
      t.end_time,
      t.required_drivers,
      t.base_pay_chf,
      t.delivery_rate_chf,
      t.is_premium
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
       start_time, end_time, required_drivers, base_pay_chf, delivery_rate_chf, is_premium,
       status, origin)
    select
      p_resort_id, g.date, g.shift_type_id, g.template_id, g.key, g.name, g.sort_order,
      g.start_time, g.end_time, g.required_drivers, g.base_pay_chf, g.delivery_rate_chf, g.is_premium,
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
  'Manager-only, insert-only. Creates missing shift_instances from currently active shift_templates over a date range (default: today through end of next month, both resolved in the resort''s own timezone). Never modifies an existing instance of any origin/status.';

-- v_refreshable_instances: "future" is now resort-timezone-aware
-- (operational_today(si.resort_id)) instead of session-timezone current_date.
create or replace view v_refreshable_instances as
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
  si.base_pay_chf as current_base_pay_chf,
  si.delivery_rate_chf as current_delivery_rate_chf,
  si.is_premium as current_is_premium,
  si.template_id as current_template_id,
  t.id as governing_template_id,
  st.name as new_name,
  st.sort_order as new_sort_order,
  t.start_time as new_start_time,
  t.end_time as new_end_time,
  t.required_drivers as new_required_drivers,
  t.base_pay_chf as new_base_pay_chf,
  t.delivery_rate_chf as new_delivery_rate_chf,
  t.is_premium as new_is_premium
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
  'Template-origin, active, future (in the resort''s own timezone), unpublished, un-attended instances that currently have a governing active template. The safety-checked eligible set for both preview_template_refresh and apply_template_refresh. Internal only -- never granted to a client role directly (exposes pay fields).';

-- preview_template_refresh / apply_template_refresh: p_from_date default
-- resolved against this resort's timezone inside the body, same reasoning
-- as materialise_shift_instances above.
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
  current_required_drivers integer,
  new_required_drivers integer,
  would_be_overassigned boolean,
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
    (r.current_start_time, r.current_end_time, r.current_required_drivers, r.current_base_pay_chf, r.current_delivery_rate_chf, r.current_is_premium, r.current_name, r.current_sort_order)
      is distinct from
    (r.new_start_time, r.new_end_time, r.new_required_drivers, r.new_base_pay_chf, r.new_delivery_rate_chf, r.new_is_premium, r.new_name, r.new_sort_order),
    jsonb_strip_nulls(jsonb_build_object(
      'start_time', case when r.current_start_time is distinct from r.new_start_time then jsonb_build_object('old', r.current_start_time, 'new', r.new_start_time) end,
      'end_time', case when r.current_end_time is distinct from r.new_end_time then jsonb_build_object('old', r.current_end_time, 'new', r.new_end_time) end,
      'required_drivers', case when r.current_required_drivers is distinct from r.new_required_drivers then jsonb_build_object('old', r.current_required_drivers, 'new', r.new_required_drivers) end,
      'base_pay_chf', case when r.current_base_pay_chf is distinct from r.new_base_pay_chf then jsonb_build_object('old', r.current_base_pay_chf, 'new', r.new_base_pay_chf) end,
      'delivery_rate_chf', case when r.current_delivery_rate_chf is distinct from r.new_delivery_rate_chf then jsonb_build_object('old', r.current_delivery_rate_chf, 'new', r.new_delivery_rate_chf) end,
      'is_premium', case when r.current_is_premium is distinct from r.new_is_premium then jsonb_build_object('old', r.current_is_premium, 'new', r.new_is_premium) end,
      'name', case when r.current_name is distinct from r.new_name then jsonb_build_object('old', r.current_name, 'new', r.new_name) end,
      'sort_order', case when r.current_sort_order is distinct from r.new_sort_order then jsonb_build_object('old', r.current_sort_order, 'new', r.new_sort_order) end
    )),
    coalesce(a.cnt, 0)::integer,
    r.current_required_drivers,
    r.new_required_drivers,
    coalesce(a.cnt, 0) > r.new_required_drivers,
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
  'Manager-only, read-only. Shows what apply_template_refresh would change for the eligible (v_refreshable_instances) set, including assignment-count/over-assignment/time-change consequences. Never modifies data. Default from_date resolves to "today" in the resort''s own timezone.';

create or replace function apply_template_refresh(p_resort_id uuid, p_from_date date default null)
returns table (
  updated_count integer,
  overassigned_count integer,
  overassigned_shift_instance_ids uuid[],
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
  v_overassigned integer := 0;
  v_overassigned_ids uuid[] := array[]::uuid[];
  v_touched_weeks date[] := array[]::date[];
  v_assignment_count integer;
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
          base_pay_chf = v_row.new_base_pay_chf,
          delivery_rate_chf = v_row.new_delivery_rate_chf,
          is_premium = v_row.new_is_premium,
          template_id = v_row.governing_template_id
      where id = v_row.shift_instance_id;

    v_updated := v_updated + 1;

    select count(*) into v_assignment_count from rota_assignments where shift_instance_id = v_row.shift_instance_id;
    -- Never remove assignments, even when the new headcount is lower --
    -- just report the resulting over-assigned draft state.
    if v_assignment_count > v_row.new_required_drivers then
      v_overassigned := v_overassigned + 1;
      v_overassigned_ids := array_append(v_overassigned_ids, v_row.shift_instance_id);
    end if;

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

  return query select v_updated, v_overassigned, v_overassigned_ids, v_reopened;
end;
$$;

comment on function apply_template_refresh(uuid, date) is
  'Manager-only. Updates exactly the v_refreshable_instances set: snapshot fields + template_id from the current governing template, origin/status/date untouched. Assignments are always retained even if now over the new required_drivers. Relies on the existing shift_instances triggers for audit logging and stale-confirmation reopening -- no duplicate mechanism. Default from_date resolves to "today" in the resort''s own timezone.';

-- preview_template_cancellation: "future" is now resort-timezone-aware.
create or replace function preview_template_cancellation(p_resort_id uuid, p_shift_type_id uuid default null)
returns table (
  shift_instance_id uuid,
  date date,
  shift_type_id uuid,
  shift_key text,
  name text,
  is_published boolean,
  assignment_count integer,
  has_availability_answers boolean,
  has_attendance boolean,
  is_safe_to_cancel boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  perform assert_active_manager();

  return query
  select
    si.id,
    si.date,
    si.shift_type_id,
    si.shift_key,
    si.name,
    shift_instance_week_is_published(si.id),
    coalesce(ra.cnt, 0)::integer,
    exists (select 1 from availability av where av.shift_instance_id = si.id),
    exists (select 1 from attendance att where att.shift_instance_id = si.id),
    (not shift_instance_week_is_published(si.id))
      and not exists (select 1 from attendance att2 where att2.shift_instance_id = si.id)
  from shift_instances si
  left join (
    select shift_instance_id, count(*) as cnt from rota_assignments group by shift_instance_id
  ) ra on ra.shift_instance_id = si.id
  where si.resort_id = p_resort_id
    and si.origin = 'template'
    and si.status = 'active'
    and si.date >= operational_today(si.resort_id)
    and (p_shift_type_id is null or si.shift_type_id = p_shift_type_id)
    -- No active template currently governs this instance's date/weekday.
    and not exists (
      select 1 from shift_templates t
      where t.shift_type_id = si.shift_type_id
        and t.resort_id = si.resort_id
        and t.is_active
        and t.weekday = app_weekday(si.date)
        and t.effective_from <= si.date
        and (t.effective_to is null or t.effective_to >= si.date)
    );
end;
$$;

comment on function preview_template_cancellation(uuid, uuid) is
  'Manager-only, read-only. Lists future (in the resort''s own timezone) template-origin instances with no governing active template left, and whether each is safe to cancel (unpublished, no attendance). Never modifies data; a template being deactivated never auto-cancels anything.';
