-- 11_confirm_and_reopen_availability_week
--
-- Confirm Week + Reopen + automatic stale-confirmation invalidation.
--
-- SECURITY SHAPE (explained per Checkpoint 3 instructions; full RLS is a
-- later checkpoint):
-- These functions, and week_availability_status (promoted here to match),
-- run as SECURITY DEFINER with a locked-down search_path. Once RLS is in
-- place, drivers will not be able to see or write other drivers' rows
-- directly -- but these functions still need to read shift_instances /
-- availability / rota_publications and write availability_submissions on
-- the caller's behalf. SECURITY DEFINER lets that happen without granting
-- broad table privileges to the driver role. What SECURITY DEFINER does
-- NOT do here: it does not yet check that the calling user is actually
-- entitled to act as p_driver_id. Today driver_id is simply taken as
-- given (as instructed -- "Do NOT start the full RLS implementation
-- yet"). The RLS checkpoint must add that check (comparing p_driver_id
-- against app_users.driver_id for auth.uid(), or a manager override)
-- before these functions are exposed to end users -- these signatures
-- and the SECURITY DEFINER choice are designed to accept that check
-- being added without changing the return shape. No function here
-- returns base_pay_chf / delivery_rate_chf / is_premium -- premium/pay
-- data is never exposed through this workflow.

alter function week_availability_status(uuid, date) security definer;
alter function week_availability_status(uuid, date) set search_path = public, pg_temp;

-- Migration 07 defined submitted_at as NOT NULL, which fit that
-- checkpoint's scope (a submission row only existed once actually
-- submitted). Reopen must be able to clear it while keeping the row (its
-- reopened_at/reopened_reason history, and the driver's answers, are
-- untouched) -- so it has to be nullable. Fixed here via an additive
-- ALTER rather than editing the already-applied/pushed migration 07.
alter table availability_submissions alter column submitted_at drop not null;

-- ---------------------------------------------------------------------
-- confirm_availability_week
-- ---------------------------------------------------------------------
create type confirm_week_result as enum ('confirmed', 'incomplete', 'locked');

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
  v_status record;
  v_submitted_at timestamptz;
begin
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
  'Confirm Week: upserts availability_submissions only when every current active shift for the driver''s resort/week has been answered. Locked (published) weeks and incomplete weeks write nothing.';

-- ---------------------------------------------------------------------
-- reopen_availability_week
-- ---------------------------------------------------------------------
create type reopen_week_result as enum ('reopened', 'locked', 'not_submitted');

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
  v_resort_id uuid;
  v_published boolean;
  v_existing availability_submissions%rowtype;
  v_reopened_at timestamptz;
  v_reopened_reason text;
begin
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

  -- Reopen the submission state only -- existing availability answers are
  -- untouched (the driver is reopening their confirmation, not their data).
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
  'Lets a driver reopen a previously confirmed, unpublished week. Clears submitted_at, stamps reopened_at/reopened_reason=driver_reopened. Never touches availability answers. Rejected once the resort/week is published.';

-- ---------------------------------------------------------------------
-- Automatic stale-confirmation invalidation (deferred Revision 2 behaviour)
-- ---------------------------------------------------------------------

-- Shared by the trigger below and reusable directly if ever needed.
-- Reopens every currently-confirmed submission for one resort/week,
-- skipping any week that is published (published weeks are locked and
-- manager-controlled -- never auto-reopened). Returns the number of
-- submissions it reopened, mainly for testability.
create or replace function reopen_stale_submissions(p_resort_id uuid, p_week_start date, p_reason text)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with reopened as (
    update availability_submissions s
    set submitted_at = null,
        reopened_at = now(),
        reopened_reason = p_reason
    where s.resort_id = p_resort_id
      and s.week_start = p_week_start
      and s.submitted_at is not null
      and not exists (
        select 1 from rota_publications rp
        where rp.resort_id = p_resort_id
          and rp.week_start = p_week_start
          and rp.published_at is not null
          and rp.unpublished_at is null
      )
    returning 1
  )
  select count(*)::integer from reopened;
$$;

comment on function reopen_stale_submissions(uuid, date, text) is
  'Reopens every currently-confirmed availability_submissions row for one resort+week, unless that resort+week is published. Used by the shift_instances trigger for shift_added / shift_reinstated / shift_time_changed.';

-- Fires on every shift_instances insert/update. Reopens stale confirmations
-- for that shift's own resort+week only (never a different resort/week),
-- and only for the specific transitions below:
--   - a new ACTIVE shift is inserted                -> shift_added
--   - a cancelled shift becomes active again         -> shift_reinstated
--   - start_time/end_time changes on an active shift -> shift_time_changed
-- Deliberately NOT reopened: pay/rate changes, required_drivers changes,
-- is_premium changes, name/sort_order changes, and an active shift being
-- cancelled (cancellation can only reduce required answers, never
-- invalidate an existing one). Published weeks are excluded by
-- reopen_stale_submissions itself.
create or replace function shift_instances_reopen_stale_confirmations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' then
      perform reopen_stale_submissions(new.resort_id, new.week_start, 'shift_added');
    end if;
    return new;
  end if;

  -- tg_op = 'UPDATE'
  if old.status = 'cancelled' and new.status = 'active' then
    perform reopen_stale_submissions(new.resort_id, new.week_start, 'shift_reinstated');
  elsif old.status = 'active' and new.status = 'active'
        and (old.start_time is distinct from new.start_time or old.end_time is distinct from new.end_time) then
    perform reopen_stale_submissions(new.resort_id, new.week_start, 'shift_time_changed');
  end if;

  return new;
end;
$$;

comment on function shift_instances_reopen_stale_confirmations() is
  'Trigger body: invalidates stale Confirm Week submissions when the answered-to shift set changes (added/reinstated/time-changed), scoped to the changed shift''s own resort+week.';

create trigger shift_instances_reopen_stale_confirmations_trg
  after insert or update on shift_instances
  for each row
  execute function shift_instances_reopen_stale_confirmations();
