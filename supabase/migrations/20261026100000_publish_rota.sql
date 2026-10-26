-- Publish Rota checkpoint PB-A: the authoritative database layer.
--
-- Publishing is the one deliberate, server-validated act that (a) makes a
-- resort-week's assigned shifts visible to drivers, (b) locks driver
-- availability for that week and (c) stops Auto-Rota generating it. All three
-- effects already derive from a CURRENTLY-PUBLISHED rota_publications row
-- (published_at is not null and unpublished_at is null), so publishing is a
-- single row write; nothing else is mutated and nothing is snapshotted.
--
-- This migration adds:
--   1. publish_rota, the one manager-only SECURITY DEFINER RPC that writes it;
--   2. closure of the direct manager write path: managers keep SELECT on
--      rota_publications, but INSERT / UPDATE (and the FOR ALL policy that
--      allowed them) are gone, so every application publication write goes
--      through publish_rota. (There was never a DELETE grant.)
-- No new tables. Unpublish / retract has NO RPC in V1; the table's
-- unpublished_at semantics are untouched and publish_rota can republish a row
-- that has been retracted by other means.
--
-- ---------------------------------------------------------------------
-- publish_rota ERROR CONTRACT (the repository keys off SQLSTATE/DETAIL)
-- ---------------------------------------------------------------------
--   42501  not an active manager (anon: no EXECUTE grant, also 42501)
--   22023  null argument, or p_week_start is not a Monday
--   P0002  resort not found
--   23514  rule violation. DETAIL:
--            resort_inactive  the resort has been deactivated
--            no_shifts        the week has no ACTIVE shift instance at all
--   55006  locked / not allowed. DETAIL:
--            historical_week  the week can no longer be newly published: it
--                             ended before the resort's operational today, or
--                             it has active shifts but none dated today or later
--   VD003  CONFIRMATION REQUIRED (DETAIL = the uncovered position count, as
--          text): open positions remain on today/future active shifts and
--          p_confirm_uncovered was not true. Nothing is written.
-- Already published is SUCCESS (idempotent), not an error.
--
-- Order matters and is part of the contract: shape -> resort exists -> LOCK ->
-- resort active -> already published (idempotent success) -> wholly past ->
-- no active shifts -> no shift today-or-later -> uncovered acknowledgement ->
-- write. Everything after the lock reads fresh state, so a concurrent
-- Auto-Rota apply, manual assign/unassign or publish can never interleave.

create or replace function publish_rota(
  p_resort_id uuid,
  p_week_start date,
  p_confirm_uncovered boolean default false
)
returns table (
  resort_id uuid,
  week_start date,
  published_at timestamptz,
  uncovered_slots integer,
  already_published boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_caller app_user_context;
  v_today date;
  v_pub rota_publications%rowtype;
  v_active_shifts integer;
  v_upcoming_shifts integer;
  v_uncovered integer;
  v_source text;
  v_confirmed boolean;
  v_exists boolean;
  v_context jsonb;
  v_published_at timestamptz;
begin
  perform assert_active_manager();
  v_caller := current_app_user();

  -- ---- request shape (cheap, no lock held yet) -----------------------
  if p_resort_id is null or p_week_start is null then
    raise exception 'Publishing needs a resort and a week.' using errcode = '22023';
  end if;
  if app_weekday(p_week_start) <> 0 then
    raise exception 'The week must start on a Monday.' using errcode = '22023';
  end if;
  if not exists (select 1 from resorts r where r.id = p_resort_id) then
    raise exception 'Resort not found.' using errcode = 'P0002';
  end if;

  -- ---- serialize with every other writer of this resort/week ----------
  perform rota_week_lock(p_resort_id, p_week_start);

  if not exists (select 1 from resorts r where r.id = p_resort_id and r.is_active) then
    raise exception 'This resort is inactive, so its rota can''t be published.'
      using errcode = '23514', detail = 'resort_inactive';
  end if;

  v_today := operational_today(p_resort_id);

  select * into v_pub
  from rota_publications rp
  where rp.resort_id = p_resort_id and rp.week_start = p_week_start;
  v_exists := found;

  -- Uncovered count: today/future ACTIVE shifts only (past gaps can no longer
  -- be filled), counting active drivers' assignments only -- the same
  -- definition Auto-Rota uses, computed under the lock.
  select coalesce(sum(o.open_slots), 0)::integer into v_uncovered
  from _auto_rota_open_slots(p_resort_id, p_week_start, v_today) o;

  -- ---- already published: idempotent success, no write, no audit -------
  if v_exists and v_pub.published_at is not null and v_pub.unpublished_at is null then
    return query select p_resort_id, p_week_start, v_pub.published_at, v_uncovered, true;
    return;
  end if;

  -- ---- publishability guards -----------------------------------------
  if p_week_start + 6 < v_today then
    raise exception 'This week is in the past, so it can''t be published.'
      using errcode = '55006', detail = 'historical_week';
  end if;

  select count(*)::integer, count(*) filter (where si.date >= v_today)::integer
    into v_active_shifts, v_upcoming_shifts
  from shift_instances si
  where si.resort_id = p_resort_id and si.week_start = p_week_start and si.status = 'active';

  if v_active_shifts = 0 then
    raise exception 'This week has no shifts to publish.'
      using errcode = '23514', detail = 'no_shifts';
  end if;
  if v_upcoming_shifts = 0 then
    raise exception 'Every shift in this week is already in the past, so it can''t be published.'
      using errcode = '55006', detail = 'historical_week';
  end if;

  -- ---- uncovered acknowledgement (server-authoritative) ---------------
  v_confirmed := v_uncovered > 0 and coalesce(p_confirm_uncovered, false);
  if v_uncovered > 0 and not v_confirmed then
    raise exception '% position(s) in this week are still uncovered. Confirm to publish anyway.', v_uncovered
      using errcode = 'VD003', detail = v_uncovered::text;
  end if;

  -- ---- generation_source: derived here, never supplied by the caller ---
  select case when exists (
           select 1
           from rota_assignments ra
           join shift_instances si on si.id = ra.shift_instance_id
           where si.resort_id = p_resort_id and si.week_start = p_week_start
             and ra.assignment_source = 'auto'
         ) then 'auto' else 'manual' end
    into v_source;

  v_context := jsonb_build_object(
    'operation', 'publish_rota',
    'resort_id', p_resort_id,
    'week_start', p_week_start,
    'uncovered_slots', v_uncovered,
    'confirmed_uncovered', v_confirmed,
    'generation_source', v_source,
    'republished', v_exists
  );

  -- Context is set immediately before, and cleared immediately after, the one
  -- audited write -- nothing else runs in between.
  if v_exists then
    -- A retracted row: unique(resort_id, week_start) forbids a second row, so
    -- republish by UPDATE and recompute generation_source from the CURRENT
    -- assignments.
    perform set_config('app.audit_context', v_context::text, true);
    update rota_publications rp
       set published_at = now(),
           unpublished_at = null,
           published_by = v_caller.auth_user_id,
           generation_source = v_source
     where rp.id = v_pub.id
    returning rp.published_at into v_published_at;
    perform set_config('app.audit_context', '', true);
  else
    perform set_config('app.audit_context', v_context::text, true);
    insert into rota_publications (resort_id, week_start, published_at, published_by, generation_source)
    values (p_resort_id, p_week_start, now(), v_caller.auth_user_id, v_source)
    returning rota_publications.published_at into v_published_at;
    perform set_config('app.audit_context', '', true);
  end if;

  return query select p_resort_id, p_week_start, v_published_at, v_uncovered, false;
end;
$$;

comment on function publish_rota(uuid, date, boolean) is
  'Manager-only, atomic. Publishes one resort + Monday week (the ONLY application write path to rota_publications). Takes the resort/week lock first (serializes with Auto-Rota, manual assign/unassign and other publishes). Already currently published -> idempotent success (already_published = true, no write, no audit). Rejects: inactive resort (23514 resort_inactive); wholly past week or a week with active shifts but none dated today or later (55006 historical_week); no active shifts (23514 no_shifts). If open positions remain on today/future active shifts (required_drivers minus ACTIVE assignments) and p_confirm_uncovered is not true -> VD003 with DETAIL = the count, nothing written; the count is recomputed under the lock, never taken from the caller. Inserts the row, or republishes a retracted row by UPDATE (published_at = now(), unpublished_at = NULL). generation_source is derived server-side: auto if any assignment in that resort/week has assignment_source = auto, else manual (recomputed on republish). Does not touch assignments, availability or any other table; drivers see the live assignments (no snapshot). Audit context: operation publish_rota, resort_id, week_start, uncovered_slots, confirmed_uncovered, generation_source, republished. Returns the publication state.';

revoke execute on function publish_rota(uuid, date, boolean) from public, anon;
grant execute on function publish_rota(uuid, date, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Close the direct manager write path to rota_publications
-- ---------------------------------------------------------------------
-- Managers keep read access (the manager rota and Availability panel read the
-- publication state). Drivers have none (LD-A) and anon never did. The
-- SECURITY DEFINER publish_rota writes as the table owner.
drop policy rota_publications_manager_all on rota_publications;

create policy rota_publications_manager_select on rota_publications for select to authenticated
  using (is_active_manager());

revoke insert, update, delete on rota_publications from authenticated;
