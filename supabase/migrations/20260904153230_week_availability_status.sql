-- 10_week_availability_status
--
-- Revision 2 derived readiness helper. Completeness is NEVER read off
-- availability_submissions.submitted_at -- it is recomputed on every call
-- from the current active shift set, so a stale old confirmation can never
-- make an unanswered newly-added shift count as complete.
--
-- NOTE ON DEFERRAL: an automatic "reopen availability_submissions when a
-- new shift is added" trigger is intentionally NOT implemented here. That
-- behaviour is a write-time side effect tied to the Confirm Week mutation
-- functions (which checkpoint is explicitly scoped to defer), and its
-- semantics (what reopened_reason to set, whether/how to notify the driver)
-- depend on decisions that belong with those functions. This helper makes
-- the reopening unnecessary for *readiness*, since it never trusts
-- submitted_at in the first place -- it always recomputes from scratch.

create type week_availability_state as enum ('locked', 'no_shifts', 'complete', 'incomplete');

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
as $$
declare
  v_resort_id uuid;
  v_total integer;
  v_missing uuid[];
  v_answered integer;
  v_published boolean;
begin
  if app_weekday(p_week_start) <> 0 then
    raise exception 'week_start must be a Monday, got %', p_week_start;
  end if;

  select d.resort_id into v_resort_id from drivers d where d.id = p_driver_id;
  if v_resort_id is null then
    raise exception 'driver % not found', p_driver_id;
  end if;

  -- Currently published/locked for this specific resort+week only.
  select exists (
    select 1
    from rota_publications rp
    where rp.resort_id = v_resort_id
      and rp.week_start = p_week_start
      and rp.published_at is not null
      and rp.unpublished_at is null
  )
  into v_published;

  -- The ACTIVE CURRENT set of scheduled shifts for this driver's resort/week,
  -- left-joined to this driver's answers. Cancelled shifts are excluded, so
  -- they stop counting the moment they're cancelled; newly added shifts show
  -- up as missing the moment they exist.
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
  'Revision 2 derived weekly availability readiness. Always recomputed from the current active shift set + this driver''s answers + this resort/week''s publication state -- never trusts availability_submissions.submitted_at.';
