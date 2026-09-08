-- 14_harden_availability_rpcs
--
-- Checkpoint 3 intentionally deferred caller authorization on
-- week_availability_status / confirm_availability_week /
-- reopen_availability_week (they took p_driver_id as given). Fixed here.
--
-- DESIGN CHOICE: keep p_driver_id in all three signatures rather than
-- introduce separate driver/manager RPC wrappers. This is the smaller
-- change (no new function names, no client code to branch on caller
-- role), and the authorization rule is a single cheap comparison:
--   - active driver: p_driver_id must equal their own current_driver_id()
--   - active manager: any p_driver_id is permitted (V1: manager access
--     spans all resorts)
--   - anyone else (inactive, unauthenticated, no app_users row): rejected
-- The decision comes entirely from current_app_user() (auth.uid() ->
-- app_users), never from a client-supplied role/driver_id. Rejections use
-- errcode 42501 (insufficient_privilege).
--
-- Deliberately NOT added: a service_role/service-account bypass. Future
-- privileged server-side automation will need its own mechanism; adding
-- one now, without a concrete design for it, would weaken today's
-- authenticated-user check for a need that doesn't exist yet.
--
-- All three stay SECURITY DEFINER with a locked-down search_path (needed
-- so an authorized caller can read/write across shift_instances /
-- availability / rota_publications / availability_submissions once RLS
-- restricts direct table access) and continue to return no
-- base_pay_chf / delivery_rate_chf / is_premium.

create or replace function week_availability_status(p_driver_id uuid, p_week_start date)
returns table (
  state week_availability_state,
  resort_id uuid,
  week_start date,
  total_shifts integer,
  answered_count integer,
  missing_count integer,
  missing_shift_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_caller app_user_context;
  v_resort_id uuid;
  v_total integer;
  v_missing uuid[];
  v_answered integer;
  v_published boolean;
begin
  v_caller := current_app_user();
  if v_caller is null or not v_caller.is_active then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_caller.role = 'driver' and v_caller.driver_id is distinct from p_driver_id then
    raise exception 'drivers may only view their own availability status' using errcode = '42501';
  elsif v_caller.role <> 'driver' and v_caller.role <> 'manager' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if app_weekday(p_week_start) <> 0 then
    raise exception 'week_start must be a Monday, got %', p_week_start;
  end if;

  select d.resort_id into v_resort_id from drivers d where d.id = p_driver_id;
  if v_resort_id is null then
    raise exception 'driver % not found', p_driver_id;
  end if;

  select exists (
    select 1 from rota_publications rp
    where rp.resort_id = v_resort_id
      and rp.week_start = p_week_start
      and rp.published_at is not null
      and rp.unpublished_at is null
  )
  into v_published;

  select
    count(si.id)::integer,
    array_remove(array_agg(si.id) filter (where a.id is null), null)
  into v_total, v_missing
  from shift_instances si
  left join availability a
    on a.shift_instance_id = si.id
   and a.driver_id = p_driver_id
  where si.resort_id = v_resort_id
    and si.week_start = p_week_start
    and si.status = 'active';

  v_total := coalesce(v_total, 0);
  v_missing := coalesce(v_missing, array[]::uuid[]);
  v_answered := v_total - coalesce(array_length(v_missing, 1), 0);

  return query select
    case
      when v_published then 'locked'::week_availability_state
      when v_total = 0 then 'no_shifts'::week_availability_state
      when v_answered = v_total then 'complete'::week_availability_state
      else 'incomplete'::week_availability_state
    end,
    v_resort_id,
    p_week_start,
    v_total,
    v_answered,
    coalesce(array_length(v_missing, 1), 0),
    v_missing;
end;
$$;

comment on function week_availability_status(uuid, date) is
  'Revision 2 derived weekly availability readiness. Authorization: active driver may only query their own driver_id; active manager may query any. Never trusts availability_submissions.submitted_at.';

create or replace function confirm_availability_week(p_driver_id uuid, p_week_start date)
returns table (
  result confirm_week_result,
  resort_id uuid,
  week_start date,
  total_shifts integer,
  answered_count integer,
  missing_shift_ids uuid[],
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_caller app_user_context;
  v_status record;
  v_submitted_at timestamptz;
begin
  v_caller := current_app_user();
  if v_caller is null or not v_caller.is_active then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_caller.role = 'driver' and v_caller.driver_id is distinct from p_driver_id then
    raise exception 'drivers may only confirm their own availability week' using errcode = '42501';
  elsif v_caller.role <> 'driver' and v_caller.role <> 'manager' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if app_weekday(p_week_start) <> 0 then
    raise exception 'week_start must be a Monday, got %', p_week_start;
  end if;

  -- Single readiness authority: also resolves resort_id server-side from
  -- drivers (never client-trusted) and raises if the driver doesn't exist.
  select * into v_status from week_availability_status(p_driver_id, p_week_start);

  if v_status.state = 'locked' then
    return query select
      'locked'::confirm_week_result, v_status.resort_id, p_week_start,
      v_status.total_shifts, v_status.answered_count, v_status.missing_shift_ids,
      null::timestamptz;
    return;
  end if;

  if v_status.answered_count < v_status.total_shifts then
    return query select
      'incomplete'::confirm_week_result, v_status.resort_id, p_week_start,
      v_status.total_shifts, v_status.answered_count, v_status.missing_shift_ids,
      null::timestamptz;
    return;
  end if;

  insert into availability_submissions
    (driver_id, resort_id, week_start, submitted_at, reopened_at, reopened_reason, shift_count_at_submission)
  values
    (p_driver_id, v_status.resort_id, p_week_start, now(), null, null, v_status.total_shifts)
  on conflict (driver_id, week_start) do update
    set submitted_at = excluded.submitted_at,
        reopened_at = null,
        reopened_reason = null,
        shift_count_at_submission = excluded.shift_count_at_submission
  returning availability_submissions.submitted_at into v_submitted_at;

  return query select
    'confirmed'::confirm_week_result, v_status.resort_id, p_week_start,
    v_status.total_shifts, v_status.answered_count, v_status.missing_shift_ids,
    v_submitted_at;
end;
$$;

comment on function confirm_availability_week(uuid, date) is
  'Confirm Week. Authorization: active driver may only confirm their own driver_id; active manager may confirm for any. Upserts availability_submissions only when every current active shift for the resort/week has been answered.';

create or replace function reopen_availability_week(p_driver_id uuid, p_week_start date)
returns table (
  result reopen_week_result,
  resort_id uuid,
  week_start date,
  reopened_at timestamptz,
  reopened_reason text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_caller app_user_context;
  v_resort_id uuid;
  v_published boolean;
  v_existing availability_submissions%rowtype;
  v_reopened_at timestamptz;
  v_reopened_reason text;
begin
  v_caller := current_app_user();
  if v_caller is null or not v_caller.is_active then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_caller.role = 'driver' and v_caller.driver_id is distinct from p_driver_id then
    raise exception 'drivers may only reopen their own availability week' using errcode = '42501';
  elsif v_caller.role <> 'driver' and v_caller.role <> 'manager' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if app_weekday(p_week_start) <> 0 then
    raise exception 'week_start must be a Monday, got %', p_week_start;
  end if;

  select d.resort_id into v_resort_id from drivers d where d.id = p_driver_id;
  if v_resort_id is null then
    raise exception 'driver % not found', p_driver_id;
  end if;

  select exists (
    select 1 from rota_publications rp
    where rp.resort_id = v_resort_id
      and rp.week_start = p_week_start
      and rp.published_at is not null
      and rp.unpublished_at is null
  ) into v_published;

  if v_published then
    return query select 'locked'::reopen_week_result, v_resort_id, p_week_start, null::timestamptz, null::text;
    return;
  end if;

  select * into v_existing from availability_submissions
    where driver_id = p_driver_id and week_start = p_week_start;

  if not found or v_existing.submitted_at is null then
    return query select 'not_submitted'::reopen_week_result, v_resort_id, p_week_start, null::timestamptz, null::text;
    return;
  end if;

  update availability_submissions
    set submitted_at = null,
        reopened_at = now(),
        reopened_reason = 'driver_reopened'
    where driver_id = p_driver_id and week_start = p_week_start
    returning reopened_at, reopened_reason into v_reopened_at, v_reopened_reason;

  return query select 'reopened'::reopen_week_result, v_resort_id, p_week_start, v_reopened_at, v_reopened_reason;
end;
$$;

comment on function reopen_availability_week(uuid, date) is
  'Lets a driver reopen their own previously confirmed, unpublished week (or a manager, any driver''s). Clears submitted_at, stamps reopened_at/reopened_reason=driver_reopened. Never touches availability answers.';

revoke execute on function week_availability_status(uuid, date) from public;
revoke execute on function confirm_availability_week(uuid, date) from public;
revoke execute on function reopen_availability_week(uuid, date) from public;

grant execute on function week_availability_status(uuid, date) to authenticated;
grant execute on function confirm_availability_week(uuid, date) to authenticated;
grant execute on function reopen_availability_week(uuid, date) to authenticated;
