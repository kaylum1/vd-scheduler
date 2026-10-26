-- Attendance checkpoint AT-A2: the Driver Check-in database/security layer.
--
-- A driver taps "Check in" on their own published assignment; the SERVER records
-- the timestamp; the manager sees that evidence beside the assignment and then
-- records the FINAL attendance (AT-A) -- which alone is payroll truth.
--
--   DRIVER CHECK-IN  = operational evidence ("the authenticated driver invoked the
--                      app's check-in at checked_in_at"). It proves nothing about
--                      physical location (no GPS / geofence / IP / photo / device
--                      id) and is NOT attendance: it never creates, implies or
--                      changes an attendance row, and carries no pay meaning.
--   FINAL ATTENDANCE = manager-authoritative (record_attendance / clear_attendance).
--
-- This migration adds:
--   1. driver_check_ins: one immutable row per rota assignment;
--   2. _check_in_window(shift): the check-in window, computed in the RESORT's
--      timezone (internal);
--   3. _check_in(assignment, driver, at): the deterministic core (internal, not
--      executable by clients -- it takes an explicit instant so boundaries and DST
--      can be tested exactly);
--   4. check_in_to_shift(assignment): the one driver-facing RPC;
--   5. unassign_driver re-created ONLY to add a check-in guard;
--   6. driver_visible_assignments extended with the driver's OWN check-in time and
--      the server-computed window (appended columns only).
-- No check-out, no lateness status, no persisted "late", no automatic attendance,
-- no clear-check-in workflow in V1. No payroll calculation.
--
-- ---------------------------------------------------------------------
-- WINDOW (both ends INCLUSIVE; resorts.timezone, never the device clock)
-- ---------------------------------------------------------------------
--   opens_at  = ((date + start_time) AT TIME ZONE tz) - 30 minutes
--   closes_at =  (date + end_time)   AT TIME ZONE tz
-- Everything is compared as timestamptz; the 30 minutes is subtracted from the
-- absolute instant (no local-time hop), so DST cannot shift it. Overnight shifts
-- are not supported, so start < end on one date. A late check-in between the
-- scheduled start and end is valid; nothing "late" is persisted.
--
-- ---------------------------------------------------------------------
-- CHECK-IN ERROR CONTRACT (the repository keys off SQLSTATE / DETAIL)
-- ---------------------------------------------------------------------
--   42501  not an active DRIVER (anon, a manager, an inactive driver, no app user)
--   22023  null assignment id
--   P0002  assignment not found -- ALSO for another driver's assignment, so an
--          assignment id can never be probed (there is no "not yours" error)
--   55006  not allowed now. DETAIL:
--            shift_cancelled | week_not_published | check_in_too_early |
--            check_in_closed | attendance_already_recorded
-- Order after ownership is proved (under the resort/week lock):
--   existing check-in -> RETURNED (idempotent, created = false, original row) before
--   every gate below, so a legitimate retry stays a success even after the window
--   closed or attendance was recorded; then shift_cancelled -> week_not_published
--   -> check_in_too_early / check_in_closed -> attendance_already_recorded -> insert.
-- (The window is tested before attendance so a driver is never told, through the
-- error, that final attendance exists unless the window itself is open.)
-- Existing Manual Rota contract: unassign_driver now ALSO raises
--   55006 DETAIL check_in_recorded when a check-in exists for the assignment.
--
-- ---------------------------------------------------------------------
-- LOCKING
-- ---------------------------------------------------------------------
-- check_in takes the existing rota_week_lock(resort, week) -- the same lock as
-- assign_driver, unassign_driver, apply_auto_rota, publish_rota, record_attendance
-- and clear_attendance -- finds the assignment, locks, re-reads, then validates
-- and inserts. clock_timestamp() is read AFTER the lock is held (now() is the
-- transaction start and could be stale after waiting). The FK is the last defence.

-- ---------------------------------------------------------------------
-- 1. driver_check_ins
-- ---------------------------------------------------------------------
create table driver_check_ins (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null unique references rota_assignments (id) on delete restrict,
  checked_in_at timestamptz not null
);

comment on table driver_check_ins is
  'Driver check-in EVIDENCE: one immutable row per rota assignment, written only by check_in_to_shift with the SERVER time. Proves only that the authenticated driver invoked the check-in at checked_in_at -- no location is captured or implied. It is NOT attendance: it never creates or changes an attendance row and has no payroll meaning (final attendance is manager-recorded). No update, delete, check-out or late status in V1. The assignment (RESTRICT) gives driver, shift, resort and week; once a check-in exists the assignment cannot be removed.';

alter table driver_check_ins enable row level security;
alter table driver_check_ins force row level security;
revoke all on driver_check_ins from anon, authenticated;
grant select on driver_check_ins to authenticated;

-- Managers read it for the manager rota. Drivers get NO table access: they read their own
-- check-in only through driver_visible_assignments. All writes go through check_in_to_shift.
create policy driver_check_ins_manager_select on driver_check_ins for select to authenticated
  using (is_active_manager());

create trigger driver_check_ins_audit_trg
  after insert or update or delete on driver_check_ins
  for each row execute function audit_log_row_change();

-- ---------------------------------------------------------------------
-- 2. The window (internal; the driver view inlines the same two expressions)
-- ---------------------------------------------------------------------
create or replace function _check_in_window(p_shift_instance_id uuid)
returns table (opens_at timestamptz, closes_at timestamptz)
language sql
stable
as $$
  select
    ((si.date + si.start_time) at time zone r.timezone) - interval '30 minutes',
    (si.date + si.end_time) at time zone r.timezone
  from shift_instances si
  join resorts r on r.id = si.resort_id
  where si.id = p_shift_instance_id;
$$;

comment on function _check_in_window(uuid) is
  'Internal. The inclusive check-in window of one shift instance as timestamptz: opens 30 minutes before the scheduled start, closes at the scheduled end, both computed in the resort''s own timezone (resorts.timezone) from the shift date and wall-clock times. Used by _check_in; driver_visible_assignments inlines the identical expressions (a function inside a view runs with the invoking user''s privileges).';

revoke execute on function _check_in_window(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. The deterministic core (internal; explicit driver and instant)
-- ---------------------------------------------------------------------
create or replace function _check_in(
  p_assignment_id uuid,
  p_driver_id uuid,
  p_at timestamptz default null
)
returns table (
  check_in_id uuid,
  assignment_id uuid,
  shift_instance_id uuid,
  checked_in_at timestamptz,
  created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_assignment rota_assignments%rowtype;
  v_shift shift_instances%rowtype;
  v_existing driver_check_ins%rowtype;
  v_win record;
  v_now timestamptz;
  v_id uuid;
begin
  if p_assignment_id is null or p_driver_id is null then
    raise exception 'Check-in needs an assignment.' using errcode = '22023';
  end if;

  -- Ownership is part of the lookup: another driver's assignment is indistinguishable from a missing one.
  select * into v_assignment from rota_assignments ra where ra.id = p_assignment_id and ra.driver_id = p_driver_id;
  if not found then
    raise exception 'This assignment could not be found.' using errcode = 'P0002';
  end if;
  select * into v_shift from shift_instances si where si.id = v_assignment.shift_instance_id;

  perform rota_week_lock(v_shift.resort_id, v_shift.week_start);

  -- Post-lock state: an unassign that committed while we waited is seen here.
  select * into v_assignment from rota_assignments ra where ra.id = p_assignment_id and ra.driver_id = p_driver_id;
  if not found then
    raise exception 'This assignment could not be found.' using errcode = 'P0002';
  end if;
  select * into v_shift from shift_instances si where si.id = v_assignment.shift_instance_id;

  -- An existing check-in is returned as-is (idempotent) before any gate: same row, same timestamp, no write, no audit.
  select * into v_existing from driver_check_ins ci where ci.assignment_id = v_assignment.id;
  if found then
    return query select v_existing.id, v_assignment.id, v_assignment.shift_instance_id, v_existing.checked_in_at, false;
    return;
  end if;

  if v_shift.status <> 'active' then
    raise exception 'This shift was cancelled, so check-in isn''t available.'
      using errcode = '55006', detail = 'shift_cancelled';
  end if;

  if not exists (
    select 1 from rota_publications rp
    where rp.resort_id = v_shift.resort_id and rp.week_start = v_shift.week_start
      and rp.published_at is not null and rp.unpublished_at is null
  ) then
    raise exception 'This rota hasn''t been published yet, so check-in isn''t available.'
      using errcode = '55006', detail = 'week_not_published';
  end if;

  -- The authoritative instant: read AFTER the lock (or injected, for deterministic tests only).
  v_now := coalesce(p_at, clock_timestamp());
  select * into v_win from _check_in_window(v_shift.id);
  if v_now < v_win.opens_at then
    raise exception 'Check-in isn''t open yet for this shift.'
      using errcode = '55006', detail = 'check_in_too_early';
  end if;
  if v_now > v_win.closes_at then
    raise exception 'The check-in window for this shift has closed.'
      using errcode = '55006', detail = 'check_in_closed';
  end if;

  if exists (
    select 1 from attendance a
    where a.shift_instance_id = v_assignment.shift_instance_id and a.driver_id = v_assignment.driver_id
  ) then
    raise exception 'Check-in isn''t available for this shift.'
      using errcode = '55006', detail = 'attendance_already_recorded';
  end if;

  perform set_config('app.audit_context', jsonb_build_object(
    'operation', 'driver_check_in',
    'assignment_id', v_assignment.id,
    'shift_instance_id', v_assignment.shift_instance_id,
    'driver_id', v_assignment.driver_id,
    'resort_id', v_shift.resort_id,
    'week_start', v_shift.week_start
  )::text, true);
  insert into driver_check_ins (assignment_id, checked_in_at)
  values (v_assignment.id, v_now)
  returning driver_check_ins.id into v_id;
  perform set_config('app.audit_context', '', true);

  return query select v_id, v_assignment.id, v_assignment.shift_instance_id, v_now, true;
end;
$$;

comment on function _check_in(uuid, uuid, timestamptz) is
  'Internal, NOT executable by clients. The check-in core with an explicit driver and (optional) instant so window boundaries and DST are testable exactly; p_at null = clock_timestamp() read after the week lock. Ownership is part of the assignment lookup (P0002 for a missing or someone else''s assignment); takes rota_week_lock; an existing check-in is returned unchanged (created = false) before any gate; then shift_cancelled, week_not_published, check_in_too_early / check_in_closed (inclusive window), attendance_already_recorded; inserts one row with the validated instant.';

revoke execute on function _check_in(uuid, uuid, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. The driver-facing RPC
-- ---------------------------------------------------------------------
create or replace function check_in_to_shift(p_assignment_id uuid)
returns table (
  check_in_id uuid,
  assignment_id uuid,
  shift_instance_id uuid,
  checked_in_at timestamptz,
  created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_caller app_user_context;
begin
  v_caller := current_app_user();
  -- ONLY an active driver. A manager cannot check in on a driver's behalf; an inactive driver, anon and a
  -- caller with no app user are all denied. The driver id is derived here, never supplied by the client.
  if v_caller is null or not v_caller.is_active or v_caller.role <> 'driver' or v_caller.driver_id is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_assignment_id is null then
    raise exception 'Check-in needs an assignment.' using errcode = '22023';
  end if;

  return query
    select r.check_in_id, r.assignment_id, r.shift_instance_id, r.checked_in_at, r.created
    from _check_in(p_assignment_id, v_caller.driver_id, null) r;
end;
$$;

comment on function check_in_to_shift(uuid) is
  'Driver-only, atomic. Records the calling driver''s check-in on ONE of their own rota assignments with the SERVER time (the caller cannot supply a time or a driver id). Allowed from 30 minutes before the shift''s scheduled start through its scheduled end (inclusive, resort timezone), only for a currently published week and an active shift, and only if no final attendance exists yet. A repeat returns the ORIGINAL check-in (created = false) with no write and no audit. Another driver''s and a missing assignment are both P0002. Managers, inactive drivers and anon are denied (42501). Evidence only: never creates attendance, proves no location. Errors: 22023, P0002, 55006 DETAIL shift_cancelled | week_not_published | check_in_too_early | check_in_closed | attendance_already_recorded. Audit context: operation driver_check_in, assignment_id, shift_instance_id, driver_id, resort_id, week_start.';

revoke execute on function check_in_to_shift(uuid) from public, anon;
grant execute on function check_in_to_shift(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. unassign_driver: add the check-in guard (everything else unchanged)
-- ---------------------------------------------------------------------
-- Body identical to migration 20261019110000 except for the new guard after the attendance
-- guard. A check-in is evidence about this exact assignment (FK RESTRICT): removing the
-- assignment would orphan it, so removal is refused with a distinct, stable token. If the
-- operational reality differs, the manager records / corrects the final attendance.
create or replace function unassign_driver(
  p_shift_instance_id uuid,
  p_driver_id uuid
)
returns table (assignment_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_assignment rota_assignments%rowtype;
  v_shift_date date;
  v_resort_id uuid;
  v_week_start date;
begin
  perform assert_active_manager();

  select * into v_assignment
  from rota_assignments ra
  where ra.shift_instance_id = p_shift_instance_id and ra.driver_id = p_driver_id;
  if not found then
    raise exception 'This driver is not assigned to this shift.' using errcode = 'P0002';
  end if;

  select si.date, si.resort_id, si.week_start into v_shift_date, v_resort_id, v_week_start
  from shift_instances si where si.id = p_shift_instance_id;

  -- Serialize with Auto-Rota, other manual edits, publication, attendance and check-in for this
  -- resort/week; then confirm the assignment is still there (it could have been removed by
  -- whoever held the lock).
  perform rota_week_lock(v_resort_id, v_week_start);
  if not exists (select 1 from rota_assignments ra where ra.id = v_assignment.id) then
    raise exception 'This driver is not assigned to this shift.' using errcode = 'P0002';
  end if;

  if v_shift_date < operational_today(v_resort_id) then
    raise exception 'This shift is in the past. Past assignments can''t be changed from the weekly rota.'
      using errcode = '55006', detail = 'historical_shift';
  end if;

  -- ANY attendance row blocks ordinary removal -- status is deliberately not
  -- inspected. Once attendance exists the assignment underneath it is
  -- operational history; correcting that is a separate, audited workflow.
  if exists (
    select 1 from attendance att
    where att.shift_instance_id = p_shift_instance_id and att.driver_id = p_driver_id
  ) then
    raise exception 'Attendance has already been recorded for this driver on this shift, so the assignment can''t be removed.'
      using errcode = '55006', detail = 'attendance_recorded';
  end if;

  -- A driver check-in is evidence about this assignment; it blocks removal too (distinct token).
  if exists (select 1 from driver_check_ins ci where ci.assignment_id = v_assignment.id) then
    raise exception 'This driver has already checked in to this shift, so the assignment can''t be removed.'
      using errcode = '55006', detail = 'check_in_recorded';
  end if;

  perform set_config('app.audit_context', jsonb_build_object('operation', 'unassign_driver')::text, true);
  delete from rota_assignments ra where ra.id = v_assignment.id;
  perform set_config('app.audit_context', '', true);

  return query select v_assignment.id;
end;
$$;

comment on function unassign_driver(uuid, uuid) is
  'Manager-only, atomic. Removes exactly one driver''s assignment from one shift instance (hard DELETE; the generic audit trigger keeps the full before-row). Takes the resort/week lock first (serializes with Auto-Rota, publication, attendance and check-in). Not found -> P0002. Rejected (55006) for a shift dated before the resort''s operational today (DETAIL historical_shift), whenever ANY attendance row exists for the driver+shift (DETAIL attendance_recorded), and whenever the driver has checked in to it (DETAIL check_in_recorded). Works in a published current/future week without touching rota_publications. Returns the removed assignment id.';

revoke execute on function unassign_driver(uuid, uuid) from public, anon;
grant execute on function unassign_driver(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. driver_visible_assignments: the driver's OWN check-in + the server-computed window
-- ---------------------------------------------------------------------
-- Appended columns only (existing columns keep their names, types and order). The view
-- stays owner-executed and session-filtered to the calling ACTIVE driver's own
-- assignments in published weeks and active shifts, so the left join can only ever
-- surface that driver's own check-in. No colleague check-in and no attendance status
-- is exposed. The window instants are computed here (resort timezone) so the UI never
-- does timezone arithmetic; the RPC stays authoritative if a device clock is wrong.
-- The expressions are INLINED rather than calling _check_in_window: PostgreSQL checks
-- function EXECUTE (and runs a function's own table reads) as the INVOKING user, not the
-- view owner, so an internal helper cannot be called from a client-readable view. The
-- tests assert the view and _check_in_window always agree (incl. across DST).
create or replace view driver_visible_assignments
with (security_invoker = false)
as
select
  ra.id as assignment_id,
  si.id as shift_instance_id,
  si.resort_id,
  si.date,
  si.week_start,
  si.shift_key,
  si.name,
  si.start_time,
  si.end_time,
  ci.checked_in_at,
  ((si.date + si.start_time) at time zone r.timezone) - interval '30 minutes' as check_in_opens_at,
  (si.date + si.end_time) at time zone r.timezone as check_in_closes_at
from rota_assignments ra
join shift_instances si on si.id = ra.shift_instance_id
join resorts r on r.id = si.resort_id
join rota_publications rp
  on rp.resort_id = si.resort_id
 and rp.week_start = si.week_start
 and rp.published_at is not null
 and rp.unpublished_at is null
left join driver_check_ins ci on ci.assignment_id = ra.id
where si.status = 'active'
  and exists (
    select 1 from current_app_user() cau
    where cau.role = 'driver' and cau.is_active and cau.driver_id = ra.driver_id
  );

comment on view driver_visible_assignments is
  'Driver-safe "My Rota": only the calling driver''s own assignments, only for published resort/weeks, only active shifts. Also the driver''s OWN check-in time (checked_in_at, null until they check in) and the server-computed inclusive check-in window (check_in_opens_at / check_in_closes_at, resort timezone). No co-assigned driver identities or their check-ins, no attendance status, pay, premium or headcount. A draft/unpublished assignment never appears here.';
