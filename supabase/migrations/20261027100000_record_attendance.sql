-- Attendance checkpoint AT-A: the authoritative database/security layer.
--
-- Attendance is operational truth about what happened to an ASSIGNED driver on
-- a Shift. It is manager-authoritative (drivers never self-report it: it affects
-- pay) and belongs to an existing rota_assignment. This migration adds:
--   1. a composite FK attendance(shift_instance_id, driver_id) ->
--      rota_assignments(shift_instance_id, driver_id) ON DELETE RESTRICT, so an
--      attendance row for an unassigned pair is impossible by construction and
--      an assignment can never be deleted from under its attendance;
--   2. record_attendance, the one manager-only RPC that creates / corrects a row;
--   3. clear_attendance, the one manager-only RPC that returns an assignment to
--      "Not recorded" (a correction tool, never a general DELETE grant);
--   4. closure of the direct manager INSERT / UPDATE / DELETE path (SELECT kept);
--   5. a corrected table comment.
-- No new tables. actual_start / actual_end / notes are NOT exposed (reserved,
-- untouched columns). No payroll calculation exists or is implied.
--
-- ---------------------------------------------------------------------
-- MEANING
-- ---------------------------------------------------------------------
--   no attendance row  = NOT RECORDED (there is no persisted pending status)
--   worked             the driver worked this assigned Shift
--   no_show            the driver was expected, did not work, absence not accepted
--   excused            the driver did not work and management accepted the absence
--   cancelled          THIS DRIVER was stood down / their attendance was cancelled
--                      and they did not work. It does NOT mean the Shift Instance
--                      was cancelled (that is shift_instances.status).
-- Downstream (payroll, NOT built): only worked earns the Shift base guarantee;
-- no_show, excused, cancelled and "no row" do not. Missing attendance will become
-- a payroll exception; the published rota is NOT an attendance fallback.
--
-- ---------------------------------------------------------------------
-- WHEN ATTENDANCE MAY BE RECORDED (operational_today(resort), resort timezone)
-- ---------------------------------------------------------------------
--   Shift cancelled                  -> 55006 shift_cancelled (new recording only)
--   Shift date AFTER today           -> 55006 future_shift
--   Shift date = today               -> the week MUST currently be published
--                                       (55006 week_not_published otherwise): a
--                                       draft day is still operationally editable
--   Shift date BEFORE today          -> allowed whether or not the week is
--                                       published. If the week is NOT currently
--                                       published this is a HISTORICAL BACKFILL
--                                       and an explicit reason is REQUIRED
--                                       (23514 historical_backfill_reason_required)
--                                       so the exception is visibly auditable.
-- No start/end-time arithmetic, the shift need not have ended. The driver's
-- active flag and the resort's active flag never matter (history stays
-- correctable). This function never publishes a week and never touches
-- rota_publications (a wholly past week cannot be newly published, so forbidding
-- unpublished past attendance would make payroll permanently impossible after a
-- missed Publish).
--
-- ---------------------------------------------------------------------
-- ERROR CONTRACT (the repository keys off SQLSTATE / DETAIL)
-- ---------------------------------------------------------------------
--   42501  not an active manager (anon: no EXECUTE grant, also 42501)
--   22023  null argument; DETAIL invalid_status for a status outside the four
--   P0002  assignment not found (never existed, or removed while we waited)
--   55006  not allowed now. DETAIL: week_not_published | future_shift | shift_cancelled
--   23514  rule violation. DETAIL: reason_too_long |
--          historical_backfill_reason_required (record) | reason_required (clear)
--
-- ---------------------------------------------------------------------
-- LOCKING
-- ---------------------------------------------------------------------
-- Both RPCs take the existing rota_week_lock(resort, week) -- the same lock as
-- assign_driver, unassign_driver, apply_auto_rota and publish_rota -- then re-read
-- the assignment, so attendance serializes with unassign (whichever gets the lock
-- first wins, never an orphan) and with Publish (publication is read under it).
-- The composite FK is the final defence if any path ever missed the lock.

-- ---------------------------------------------------------------------
-- 1. Composite FK: attendance can only exist for an actual assignment
-- ---------------------------------------------------------------------
-- (Before this migration the local database holds no attendance rows outside
-- rolled-back test transactions, so no orphan can fail the constraint.)
alter table attendance
  add constraint attendance_assignment_fk
  foreign key (shift_instance_id, driver_id)
  references rota_assignments (shift_instance_id, driver_id)
  on delete restrict;

comment on table attendance is
  'What actually happened for an ASSIGNED driver on a Shift (one row per rota assignment; the composite FK to rota_assignments makes an unassigned pair impossible). NO ROW = NOT RECORDED -- there is no pending status. Manager-authoritative: written only by record_attendance / clear_attendance, never by drivers. For payroll only status = worked earns the Shift base guarantee; no_show, excused, cancelled and a missing row do not, and a missing row is a future payroll exception -- the published rota is NOT an attendance fallback. status = cancelled means this DRIVER was stood down, not that the Shift Instance was cancelled. actual_start / actual_end / notes are reserved and not written by the V1 RPCs. No payroll calculation exists yet.';

-- ---------------------------------------------------------------------
-- 2. record_attendance
-- ---------------------------------------------------------------------
create or replace function record_attendance(
  p_assignment_id uuid,
  p_status text,
  p_reason text default null
)
returns table (
  attendance_id uuid,
  assignment_id uuid,
  shift_instance_id uuid,
  driver_id uuid,
  status text,
  recorded_at timestamptz,
  updated_at timestamptz,
  created boolean,
  changed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_caller app_user_context;
  v_assignment rota_assignments%rowtype;
  v_shift shift_instances%rowtype;
  v_att attendance%rowtype;
  v_exists boolean;
  v_today date;
  v_published boolean;
  v_backfill boolean;
  v_reason text;
  v_context jsonb;
  v_att_id uuid;
  v_recorded_at timestamptz;
  v_updated_at timestamptz;
begin
  perform assert_active_manager();
  v_caller := current_app_user();

  -- ---- request shape (cheap, no lock held yet) -----------------------
  if p_assignment_id is null or p_status is null then
    raise exception 'Attendance needs an assignment and a status.' using errcode = '22023';
  end if;
  if p_status not in ('worked', 'no_show', 'excused', 'cancelled') then
    raise exception 'That is not a valid attendance status.' using errcode = '22023', detail = 'invalid_status';
  end if;
  v_reason := nullif(btrim(p_reason, E' \t\r\n'), '');
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'The reason must be 500 characters or fewer.' using errcode = '23514', detail = 'reason_too_long';
  end if;

  -- ---- find the week, serialize, then re-read ------------------------
  select * into v_assignment from rota_assignments ra where ra.id = p_assignment_id;
  if not found then
    raise exception 'This assignment could not be found.' using errcode = 'P0002';
  end if;
  select * into v_shift from shift_instances si where si.id = v_assignment.shift_instance_id;

  perform rota_week_lock(v_shift.resort_id, v_shift.week_start);

  -- Everything below sees post-lock state: an unassign that committed while we
  -- waited is seen here, so a vanished assignment is assignment_not_found.
  select * into v_assignment from rota_assignments ra where ra.id = p_assignment_id;
  if not found then
    raise exception 'This assignment could not be found.' using errcode = 'P0002';
  end if;
  select * into v_shift from shift_instances si where si.id = v_assignment.shift_instance_id;

  -- ---- when may it be recorded ---------------------------------------
  if v_shift.status <> 'active' then
    raise exception 'This shift was cancelled, so attendance can''t be recorded for it.'
      using errcode = '55006', detail = 'shift_cancelled';
  end if;

  v_today := operational_today(v_shift.resort_id);
  if v_shift.date > v_today then
    raise exception 'This shift hasn''t started yet. Attendance can be recorded from the shift date.'
      using errcode = '55006', detail = 'future_shift';
  end if;

  v_published := exists (
    select 1 from rota_publications rp
    where rp.resort_id = v_shift.resort_id and rp.week_start = v_shift.week_start
      and rp.published_at is not null and rp.unpublished_at is null
  );
  if v_shift.date = v_today and not v_published then
    raise exception 'Publish this rota before recording attendance for today.'
      using errcode = '55006', detail = 'week_not_published';
  end if;
  -- A past shift in a week that is not currently published: a historical backfill.
  v_backfill := v_shift.date < v_today and not v_published;

  -- ---- same persisted state -> idempotent success --------------------
  select * into v_att from attendance a
  where a.shift_instance_id = v_assignment.shift_instance_id and a.driver_id = v_assignment.driver_id;
  v_exists := found;

  if v_exists and v_att.status = p_status then
    -- The reason is audit metadata, not persisted attendance state: nothing changes, nothing is audited.
    return query select v_att.id, v_assignment.id, v_assignment.shift_instance_id, v_assignment.driver_id,
                        v_att.status, v_att.recorded_at, v_att.updated_at, false, false;
    return;
  end if;

  if v_backfill and v_reason is null then
    raise exception 'This week was never published. Give a reason to record historical attendance.'
      using errcode = '23514', detail = 'historical_backfill_reason_required';
  end if;

  -- ---- write (audit context set immediately before, cleared after) ----
  v_context := jsonb_build_object(
    'operation', 'record_attendance',
    'assignment_id', v_assignment.id,
    'resort_id', v_shift.resort_id,
    'week_start', v_shift.week_start,
    'previous_status', case when v_exists then v_att.status end,
    'new_status', p_status,
    'historical_backfill', v_backfill
  );
  if v_reason is not null then
    v_context := v_context || jsonb_build_object('reason', v_reason);
  end if;

  perform set_config('app.audit_context', v_context::text, true);
  if v_exists then
    -- Correction: update the one row in place. recorded_by / recorded_at track the LATEST manager
    -- recording action (the previous values live in the audit row's before-snapshot).
    update attendance a
       set status = p_status,
           recorded_by = v_caller.auth_user_id,
           recorded_at = now()
     where a.id = v_att.id
    returning a.id, a.recorded_at, a.updated_at into v_att_id, v_recorded_at, v_updated_at;
  else
    insert into attendance (shift_instance_id, driver_id, resort_id, status, recorded_by)
    values (v_assignment.shift_instance_id, v_assignment.driver_id, v_assignment.resort_id, p_status, v_caller.auth_user_id)
    returning attendance.id, attendance.recorded_at, attendance.updated_at into v_att_id, v_recorded_at, v_updated_at;
  end if;
  perform set_config('app.audit_context', '', true);

  return query select v_att_id, v_assignment.id, v_assignment.shift_instance_id, v_assignment.driver_id,
                      p_status, v_recorded_at, v_updated_at, not v_exists, true;
end;
$$;

comment on function record_attendance(uuid, text, text) is
  'Manager-only, atomic. Records (first time) or corrects (in place) the attendance of ONE rota assignment: status worked | no_show | excused | cancelled (cancelled = this driver was stood down, NOT a cancelled Shift). The assignment id is the identity; shift, driver, resort and week are derived from it under the resort/week lock. Rejected: a cancelled Shift (55006 shift_cancelled), a Shift after the resort''s operational today (future_shift), today in a week that is not currently published (week_not_published). A PAST shift is allowed whether or not the week is published; if it is not, it is a historical backfill that REQUIRES a reason (23514 historical_backfill_reason_required) and is flagged in the audit. The driver''s and the resort''s active flags never matter. Same persisted status again is an idempotent success (changed = false, no write, no audit). recorded_by / recorded_at are set to the manager and time of the latest recording. The optional reason (trimmed, empty = none, max 500) is audit metadata only; it is never stored on attendance. Never touches rota_publications or the assignment. Audit context: operation record_attendance, assignment_id, resort_id, week_start, previous_status, new_status, historical_backfill, reason (when given).';

revoke execute on function record_attendance(uuid, text, text) from public, anon;
grant execute on function record_attendance(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. clear_attendance
-- ---------------------------------------------------------------------
-- The controlled way back to "Not recorded". Without it one accidental entry
-- would block unassigning a today assignment forever (an attendance row of any
-- status blocks removal). It does not touch the assignment, publication,
-- availability, the Shift or any pay. Not gated on publication, date or shift
-- status: historical corrections (and removal of any corrupt future row) must
-- stay possible. The assignment must still exist.
create or replace function clear_attendance(
  p_assignment_id uuid,
  p_reason text
)
returns table (
  assignment_id uuid,
  previous_status text,
  changed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_assignment rota_assignments%rowtype;
  v_shift shift_instances%rowtype;
  v_att attendance%rowtype;
  v_reason text;
  v_context jsonb;
begin
  perform assert_active_manager();

  if p_assignment_id is null then
    raise exception 'Clearing attendance needs an assignment.' using errcode = '22023';
  end if;
  v_reason := nullif(btrim(p_reason, E' \t\r\n'), '');
  if v_reason is null then
    raise exception 'Give a reason for clearing this attendance.' using errcode = '23514', detail = 'reason_required';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'The reason must be 500 characters or fewer.' using errcode = '23514', detail = 'reason_too_long';
  end if;

  select * into v_assignment from rota_assignments ra where ra.id = p_assignment_id;
  if not found then
    raise exception 'This assignment could not be found.' using errcode = 'P0002';
  end if;
  select * into v_shift from shift_instances si where si.id = v_assignment.shift_instance_id;

  perform rota_week_lock(v_shift.resort_id, v_shift.week_start);

  select * into v_assignment from rota_assignments ra where ra.id = p_assignment_id;
  if not found then
    raise exception 'This assignment could not be found.' using errcode = 'P0002';
  end if;

  select * into v_att from attendance a
  where a.shift_instance_id = v_assignment.shift_instance_id and a.driver_id = v_assignment.driver_id;
  if not found then
    -- Already Not recorded: idempotent success, no write, no audit.
    return query select v_assignment.id, null::text, false;
    return;
  end if;

  v_context := jsonb_build_object(
    'operation', 'clear_attendance',
    'assignment_id', v_assignment.id,
    'resort_id', v_shift.resort_id,
    'week_start', v_shift.week_start,
    'previous_status', v_att.status,
    'reason', v_reason
  );
  perform set_config('app.audit_context', v_context::text, true);
  delete from attendance a where a.id = v_att.id;
  perform set_config('app.audit_context', '', true);

  return query select v_assignment.id, v_att.status, true;
end;
$$;

comment on function clear_attendance(uuid, text) is
  'Manager-only, atomic. Returns ONE rota assignment to "Not recorded" by deleting its attendance row (a correction tool; direct DELETE stays closed). A reason is REQUIRED (trimmed, max 500: 23514 reason_required / reason_too_long). Takes the resort/week lock first. No row = idempotent success (changed = false, no write, no audit). Not gated on publication, date or Shift status so historical corrections stay possible. Does not touch the assignment, publication, availability, the Shift or pay; afterwards a today assignment can be removed again under the normal Manual Rota rules (a past one stays frozen). The generic audit DELETE keeps the old row; context: operation clear_attendance, assignment_id, resort_id, week_start, previous_status, reason.';

revoke execute on function clear_attendance(uuid, text) from public, anon;
grant execute on function clear_attendance(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Close the direct manager write path (SELECT kept for the read model)
-- ---------------------------------------------------------------------
drop policy attendance_manager_all on attendance;

create policy attendance_manager_select on attendance for select to authenticated
  using (is_active_manager());

revoke insert, update, delete on attendance from authenticated;
