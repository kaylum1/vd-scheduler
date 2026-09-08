-- 18_shift_materialisation
--
-- The approved mechanism that safely creates dated shift_instances from
-- active shift_templates. Materialisation is INSERT-ONLY: an existing
-- instance for (resort_id, shift_type_id, date) is never modified here,
-- regardless of its origin/status -- that is what makes it safe to run
-- repeatedly and safe alongside manager overrides/ad-hoc shifts/cancelled
-- history.

-- Revision 2's origin model distinguishes three states: template (still
-- exactly what materialisation produced), override (template-derived --
-- template_id is retained -- but a manager has since manually diverged its
-- snapshot from the template), and adhoc (template_id IS NULL). Migration
-- 06 only had two (template/adhoc), which was sufficient until now: the
-- template-refresh safety rules in this checkpoint (migration 19) must
-- exclude an overridden instance from automatic refresh even though it is
-- still template-derived, which needs a value distinct from plain
-- 'template' to check against. Extended here (additive, on the
-- already-applied/pushed migration 06) rather than editing it. No code in
-- this checkpoint transitions a row to 'override' yet -- that arrives with
-- a future single-shift manager-edit operation; this migration prepares
-- the data model and the refresh logic's exclusion of it, and is proven
-- by directly setting origin='override' in the test suite.
alter table shift_instances drop constraint shift_instances_origin_check;
alter table shift_instances add constraint shift_instances_origin_check
  check (origin = any (array['template', 'override', 'adhoc']));

alter table shift_instances drop constraint shift_instances_origin_template_check;
alter table shift_instances add constraint shift_instances_origin_template_check
  check (
    (origin in ('template', 'override') and template_id is not null)
    or
    (origin = 'adhoc' and template_id is null)
  );

-- Shared by every manager-only function added in this checkpoint
-- (materialisation, template refresh, template cancellation) so the
-- authorization rule lives in exactly one place. Internal only -- no
-- EXECUTE grant to authenticated; only other SECURITY DEFINER functions
-- owned by postgres call it.
create or replace function assert_active_manager()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller app_user_context;
begin
  v_caller := current_app_user();
  if v_caller is null or not v_caller.is_active or v_caller.role <> 'manager' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function assert_active_manager() from public;

-- Reusable date-range helper (avoids hard-coding "today through end of
-- next month" into every caller). Given any date, returns the last day of
-- the following calendar month.
create or replace function end_of_following_month(d date default current_date)
returns date
language sql
immutable
as $$
  select (date_trunc('month', d) + interval '2 months' - interval '1 day')::date;
$$;

revoke execute on function end_of_following_month(date) from public;
grant execute on function end_of_following_month(date) to authenticated;

-- Materialises shift_instances for one resort over [p_from_date, p_to_date]
-- (default: today through end of next month) from the currently governing
-- active shift_templates. ON CONFLICT DO NOTHING against the stable
-- identity (resort_id, shift_type_id, date) is what makes this safe to
-- re-run and safe next to any pre-existing row of any origin/status.
create or replace function materialise_shift_instances(
  p_resort_id uuid,
  p_from_date date default current_date,
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
  v_to_date date;
  v_created integer;
  v_total_governing integer;
begin
  perform assert_active_manager();

  v_to_date := coalesce(p_to_date, end_of_following_month(current_date));
  if p_from_date > v_to_date then
    raise exception 'p_from_date (%) must not be after the computed to_date (%)', p_from_date, v_to_date;
  end if;

  with candidate_dates as (
    select generate_series(p_from_date, v_to_date, interval '1 day')::date as date
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

  return query select v_created, (v_total_governing - v_created), p_from_date, v_to_date;
end;
$$;

comment on function materialise_shift_instances(uuid, date, date) is
  'Manager-only, insert-only. Creates missing shift_instances from currently active shift_templates over a date range (default: today through end of next month). Never modifies an existing instance of any origin/status.';

revoke execute on function materialise_shift_instances(uuid, date, date) from public;
grant execute on function materialise_shift_instances(uuid, date, date) to authenticated;
