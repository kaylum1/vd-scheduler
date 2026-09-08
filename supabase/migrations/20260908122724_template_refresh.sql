-- 19_template_refresh
--
-- Manager-confirmed template refresh: preview what would change if the
-- currently governing templates were reapplied to already-materialised
-- future instances, then apply only what the manager confirmed. Both
-- functions are built on the same v_refreshable_instances definition of
-- "safe to touch", so the set apply() can change is always exactly the
-- set preview() showed -- never wider.

-- Internal only (no EXECUTE grant to authenticated/anon): exposes
-- base_pay_chf/delivery_rate_chf, so it must never be queryable directly
-- by a client. Only the manager-authorized functions below read it.
--
-- A row appears here only when ALL of:
--   - origin = 'template'
--   - status = 'active'
--   - date >= current_date (never touch history)
--   - the resort/week is unpublished (shift_instance_week_is_published(), Checkpoint 4)
--   - no attendance exists for it
--   - an active governing template exists for that resort/shift_type/weekday/date
-- Historical, published, ad-hoc, cancelled, and attended shifts never
-- appear here, regardless of what changed on the template side.
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
  and si.date >= current_date
  and not shift_instance_week_is_published(si.id)
  and not exists (select 1 from attendance a where a.shift_instance_id = si.id);

comment on view v_refreshable_instances is
  'Template-origin, active, future, unpublished, un-attended instances that currently have a governing active template. The safety-checked eligible set for both preview_template_refresh and apply_template_refresh. Internal only -- never granted to a client role directly (exposes pay fields).';

-- Read-only. Reports, per eligible instance, the current vs. would-be
-- snapshot, which fields differ, and consequences a manager needs before
-- confirming (assignment count, whether the new headcount would be below
-- it, whether the time is changing).
create or replace function preview_template_refresh(p_resort_id uuid, p_from_date date default current_date)
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
begin
  perform assert_active_manager();

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
    and r.date >= p_from_date;
end;
$$;

comment on function preview_template_refresh(uuid, date) is
  'Manager-only, read-only. Shows what apply_template_refresh would change for the eligible (v_refreshable_instances) set, including assignment-count/over-assignment/time-change consequences. Never modifies data.';

revoke execute on function preview_template_refresh(uuid, date) from public;
grant execute on function preview_template_refresh(uuid, date) to authenticated;

-- Manager-confirmed apply. Updates ONLY rows currently in
-- v_refreshable_instances -- exactly the set preview_template_refresh
-- reported, never wider. Plain per-row UPDATEs so the existing
-- Checkpoint 3 stale-confirmation trigger and Checkpoint 4 audit trigger
-- fire naturally: a start_time/end_time change reopens confirmed
-- availability (shift_time_changed) automatically; pay/rate/headcount/
-- premium/name/order-only changes do not. No second mechanism is
-- introduced for either behaviour.
create or replace function apply_template_refresh(p_resort_id uuid, p_from_date date default current_date)
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
    select * from v_refreshable_instances where resort_id = p_resort_id and date >= p_from_date
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
  'Manager-only. Updates exactly the v_refreshable_instances set: snapshot fields + template_id from the current governing template, origin/status/date untouched. Assignments are always retained even if now over the new required_drivers. Relies on the existing shift_instances triggers for audit logging and stale-confirmation reopening -- no duplicate mechanism.';

revoke execute on function apply_template_refresh(uuid, date) from public;
grant execute on function apply_template_refresh(uuid, date) to authenticated;
