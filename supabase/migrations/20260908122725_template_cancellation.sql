-- 20_template_cancellation
--
-- Deactivating/ending a shift_template must NEVER automatically cancel
-- already-materialised future shift_instances -- that is an explicit,
-- previewed, manager-confirmed action, symmetrical with template refresh.

-- Read-only. Finds future, active, template-origin instances that no
-- longer have any active governing template (the template was deactivated,
-- or its effective range no longer covers this date/weekday), and reports
-- what a manager needs to decide whether cancelling each is safe.
-- Optionally scoped to one shift_type_id (the normal case: "I just
-- deactivated this shift type/template").
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
    and si.date >= current_date
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
  'Manager-only, read-only. Lists future template-origin instances with no governing active template left, and whether each is safe to cancel (unpublished, no attendance). Never modifies data; a template being deactivated never auto-cancels anything.';

revoke execute on function preview_template_cancellation(uuid, uuid) from public;
grant execute on function preview_template_cancellation(uuid, uuid) to authenticated;

-- Manager-confirmed. Cancels ONLY the is_safe_to_cancel subset that
-- preview_template_cancellation reports (computed by calling it directly,
-- so apply can never cancel a wider set than preview showed) using the
-- existing cancellation semantics (status/cancelled_at/cancelled_reason/
-- cancelled_by) -- never a hard delete, never a published or historical
-- row, never one with attendance.
create or replace function apply_template_cancellation(
  p_resort_id uuid,
  p_shift_type_id uuid default null,
  p_reason text default 'template_deactivated'
)
returns table (
  cancelled_count integer,
  cancelled_shift_instance_ids uuid[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_caller app_user_context;
  v_ids uuid[];
  v_count integer;
begin
  v_caller := current_app_user();
  perform assert_active_manager();

  select array_agg(p.shift_instance_id) into v_ids
  from preview_template_cancellation(p_resort_id, p_shift_type_id) p
  where p.is_safe_to_cancel;

  if v_ids is null then
    return query select 0, array[]::uuid[];
    return;
  end if;

  update shift_instances
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_reason = p_reason,
        cancelled_by = v_caller.auth_user_id
    where id = any(v_ids);

  get diagnostics v_count = row_count;

  return query select v_count, v_ids;
end;
$$;

comment on function apply_template_cancellation(uuid, uuid, text) is
  'Manager-only. Cancels (never deletes) exactly the safe subset preview_template_cancellation reports -- unpublished, un-attended, no-longer-templated future instances. Existing assignments/availability rows are left in place. Relies on the existing shift_instances audit trigger; the Checkpoint 3 stale-confirmation trigger deliberately does not reopen on an active->cancelled transition.';

revoke execute on function apply_template_cancellation(uuid, uuid, text) from public;
grant execute on function apply_template_cancellation(uuid, uuid, text) to authenticated;
