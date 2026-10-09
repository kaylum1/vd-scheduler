-- Manual Rota MR-A, migration 2 of 2: atomic manager assignment RPCs, and
-- making them the ONLY client write path to rota_assignments.
--
-- Manual manager assignment is deliberately more permissive than future
-- Auto-Rota. A manager MAY assign an Unavailable or Not Submitted driver (after
-- an explicit, server-enforced acknowledgement), may assign more drivers than
-- required_drivers, and may edit a published current/future week. A manager
-- may NOT assign an inactive driver, assign across resorts, assign the same
-- driver twice to one shift, ordinarily edit a shift dated before the
-- operational today, or unassign a driver once attendance exists for them.
--
-- Every one of those rules is enforced HERE, in the database, not in React.
--
-- ---------------------------------------------------------------------
-- ERROR CONTRACT (stable; the future repository/UI keys off SQLSTATE and,
-- where present, DETAIL -- never the human-readable message text)
-- ---------------------------------------------------------------------
--   42501  not an active manager
--   P0002  shift / driver / assignment not found
--   23514  business-rule rejection: shift cancelled, driver inactive, driver
--          belongs to a different resort, reason longer than 500 chars
--   23505  driver already assigned to this shift
--   55006  locked/conflict. DETAIL distinguishes the cause:
--            historical_shift     the shift is dated before operational today
--            attendance_recorded  attendance exists for this driver+shift
--   VD001  availability override required (assign_driver only). DETAIL is the
--          driver's CURRENT availability state, as read by the server:
--            unavailable | not_submitted
--          Raised only when p_confirm_availability_override is false. Nothing
--          is inserted. The client shows the matching warning and, only after
--          the manager explicitly confirms, retries with the flag set -- the
--          server then re-reads availability again itself.

-- ---------------------------------------------------------------------
-- WRITE PATH: the RPCs below become the only client path to INSERT/UPDATE/
-- DELETE rota_assignments. Managers keep SELECT (the weekly read model needs
-- it); drivers already have no base-table access at all and keep none.
--
-- The FOR ALL manager policy is replaced by a SELECT-only one, rather than
-- merely revoking the grants, so the write path stays closed even if a
-- table grant were ever re-added by mistake. The SECURITY DEFINER RPCs are
-- owned by postgres (BYPASSRLS), so nothing here weakens RLS to make them
-- work. Fixtures/tests that legitimately need to seed assignments directly do
-- so as the database owner, outside any client role.
-- ---------------------------------------------------------------------
drop policy rota_assignments_manager_all on rota_assignments;

create policy rota_assignments_manager_select on rota_assignments for select to authenticated
  using (is_active_manager());

revoke insert, update, delete on rota_assignments from authenticated;

comment on table rota_assignments is
  'Driver <-> shift_instance assignments. Many drivers per shift; no coverage/headcount enforcement at the DB level (required_drivers is a minimum, not a capacity). Clients can only READ this table (managers); every write goes through assign_driver / unassign_driver, which enforce availability-override acknowledgement, active driver/shift, same-resort, no-history-edits, and the attendance guard, and attach audit context.';

-- ---------------------------------------------------------------------
-- ASSIGN
-- ---------------------------------------------------------------------
create or replace function assign_driver(
  p_shift_instance_id uuid,
  p_driver_id uuid,
  p_confirm_availability_override boolean default false,
  p_reason text default null
)
returns table (assignment_id uuid, availability_state text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_caller app_user_context;
  v_shift shift_instances%rowtype;
  v_driver drivers%rowtype;
  v_reason text;
  v_status text;
  v_state text;
  v_context jsonb;
  v_new_id uuid;
begin
  perform assert_active_manager();
  v_caller := current_app_user();

  select * into v_shift from shift_instances si where si.id = p_shift_instance_id;
  if not found then
    raise exception 'Shift not found.' using errcode = 'P0002';
  end if;
  if v_shift.status <> 'active' then
    raise exception 'This shift has been cancelled and can''t be staffed.' using errcode = '23514';
  end if;
  if v_shift.date < operational_today(v_shift.resort_id) then
    raise exception 'This shift is in the past. Past assignments can''t be changed from the weekly rota.'
      using errcode = '55006', detail = 'historical_shift';
  end if;

  select * into v_driver from drivers d where d.id = p_driver_id;
  if not found then
    raise exception 'Driver not found.' using errcode = 'P0002';
  end if;
  if not v_driver.is_active then
    raise exception 'This driver is inactive and can''t be assigned to new shifts.' using errcode = '23514';
  end if;
  if v_driver.resort_id <> v_shift.resort_id then
    raise exception 'This driver belongs to a different resort than this shift.' using errcode = '23514';
  end if;

  v_reason := nullif(btrim(p_reason, E' \t\r\n'), '');
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'The reason must be 500 characters or fewer.' using errcode = '23514';
  end if;

  -- The unique constraint stays the authoritative guard (a concurrent
  -- assignment is caught again around the INSERT below); this up-front check
  -- exists only so the common case reports a clean message, and reports it
  -- BEFORE asking the manager to confirm an availability override they'd
  -- then be unable to act on anyway.
  if exists (
    select 1 from rota_assignments ra
    where ra.shift_instance_id = p_shift_instance_id and ra.driver_id = p_driver_id
  ) then
    raise exception 'This driver is already assigned to this shift.' using errcode = '23505';
  end if;

  -- CURRENT availability, read here at write time. Never taken from the
  -- caller: a stale client that loaded "Available" before the driver changed
  -- their answer must not silently assign an unavailable driver.
  select a.status into v_status
  from availability a
  where a.shift_instance_id = p_shift_instance_id and a.driver_id = p_driver_id;
  v_state := coalesce(v_status, 'not_submitted');

  if v_state <> 'available' and not coalesce(p_confirm_availability_override, false) then
    raise exception '%',
      case v_state
        when 'unavailable' then 'This driver marked themselves unavailable for this shift. Confirm to assign them anyway.'
        else 'This driver has not submitted availability for this shift. Confirm to assign them anyway.'
      end
      using errcode = 'VD001', detail = v_state;
  end if;

  v_context := jsonb_strip_nulls(jsonb_build_object(
    'operation', 'assign_driver',
    'availability_state', v_state,
    'availability_override', v_state <> 'available',
    'reason', v_reason
  ));

  begin
    -- Context is set immediately before, and cleared immediately after, the
    -- single audited write -- nothing else runs in between. If the INSERT
    -- fails, the surrounding subtransaction rollback reverts the setting.
    perform set_config('app.audit_context', v_context::text, true);
    insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source, assigned_by)
    values (p_shift_instance_id, p_driver_id, v_shift.resort_id, 'manual', v_caller.auth_user_id)
    returning id into v_new_id;
    perform set_config('app.audit_context', '', true);
  exception when unique_violation then
    raise exception 'This driver is already assigned to this shift.' using errcode = '23505';
  end;
  perform set_config('app.audit_context', '', true);

  return query select v_new_id, v_state;
end;
$$;

comment on function assign_driver(uuid, uuid, boolean, text) is
  'Manager-only, atomic. Manually assigns a driver to a shift instance (assignment_source = manual). Validates active shift, today-or-future date (resort operational timezone), active driver, same resort, no duplicate. Reads the driver''s CURRENT availability itself: available assigns normally; unavailable/not_submitted raise VD001 (DETAIL = the state, nothing inserted) unless p_confirm_availability_override is true, in which case it assigns and records the override. Never blocks on required_drivers (a minimum, not a capacity) and never on publication (managers may edit a published current/future week; the week stays published). The optional p_reason (trimmed, empty = NULL, max 500) is stored only in audit_log.context, never on rota_assignments. Returns the new assignment id and the availability state actually used.';

revoke execute on function assign_driver(uuid, uuid, boolean, text) from public, anon;
grant execute on function assign_driver(uuid, uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- UNASSIGN
-- ---------------------------------------------------------------------
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
begin
  perform assert_active_manager();

  select * into v_assignment
  from rota_assignments ra
  where ra.shift_instance_id = p_shift_instance_id and ra.driver_id = p_driver_id;
  if not found then
    raise exception 'This driver is not assigned to this shift.' using errcode = 'P0002';
  end if;

  select si.date, si.resort_id into v_shift_date, v_resort_id
  from shift_instances si where si.id = p_shift_instance_id;
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

  perform set_config('app.audit_context', jsonb_build_object('operation', 'unassign_driver')::text, true);
  delete from rota_assignments ra where ra.id = v_assignment.id;
  perform set_config('app.audit_context', '', true);

  return query select v_assignment.id;
end;
$$;

comment on function unassign_driver(uuid, uuid) is
  'Manager-only, atomic. Removes exactly one driver''s assignment from one shift instance (hard DELETE; the generic audit trigger keeps the full before-row). Not found -> P0002. Rejected (55006) for a shift dated before the resort''s operational today (DETAIL historical_shift) and whenever ANY attendance row exists for the driver+shift (DETAIL attendance_recorded). Works in a published current/future week without touching rota_publications. Returns the removed assignment id.';

revoke execute on function unassign_driver(uuid, uuid) from public, anon;
grant execute on function unassign_driver(uuid, uuid) to authenticated;
