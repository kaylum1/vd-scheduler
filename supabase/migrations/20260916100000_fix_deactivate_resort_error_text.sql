-- Fix deactivate_resort's malformed manager-facing error text.
--
-- migration 20260915115014_resort_lifecycle_management.sql's deactivate_resort
-- raises its blocked-dependency message with `raise exception '...%s...'`.
-- PL/pgSQL's RAISE only recognises a bare `%` as a substitution placeholder
-- (there is no printf-style `%s`) -- the argument is substituted for `%` and
-- the literal `s` that follows it is left in the output, e.g. "2 active
-- shifts" becomes "2 active shiftss". This is a pure text-formatting bug:
-- the 55006 errcode, the blocking logic, and every other behaviour are
-- unaffected.
--
-- Fixed here as a forward CREATE OR REPLACE rather than by editing the
-- historical migration in place, per this project's append-only migration
-- history rule. Everything else about the function -- parameters, return
-- type, SECURITY DEFINER, search_path, assert_active_manager() gating, the
-- exact set of blocking dependency checks, and the audit trigger it relies
-- on -- is byte-for-byte unchanged from the original.

create or replace function deactivate_resort(p_resort_id uuid)
returns table (resort_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reasons text[] := array[]::text[];
  v_count integer;
begin
  perform assert_active_manager();

  if not exists (select 1 from resorts r where r.id = p_resort_id and r.is_active) then
    raise exception 'Resort not found or already inactive.' using errcode = 'P0002';
  end if;

  select count(*) into v_count from drivers d where d.resort_id = p_resort_id and d.is_active;
  if v_count > 0 then
    v_reasons := array_append(v_reasons, format('%s active driver%s', v_count, case when v_count = 1 then '' else 's' end));
  end if;

  select count(*) into v_count from shift_types st where st.resort_id = p_resort_id and st.is_active;
  if v_count > 0 then
    v_reasons := array_append(v_reasons, format('%s active shift%s', v_count, case when v_count = 1 then '' else 's' end));
  end if;

  -- Shift Setup being fully retired (no active shift_types) does not by
  -- itself mean nothing is scheduled -- materialisation is insert-only and
  -- already-generated future instances survive a template's deactivation
  -- (Stage 2C safety model). Checked independently, on purpose.
  select count(*) into v_count
  from shift_instances si
  where si.resort_id = p_resort_id
    and si.status = 'active'
    and si.date >= operational_today(p_resort_id);
  if v_count > 0 then
    v_reasons := array_append(v_reasons, format('%s upcoming generated shift%s', v_count, case when v_count = 1 then '' else 's' end));
  end if;

  select count(*) into v_count
  from rota_publications rp
  where rp.resort_id = p_resort_id
    and rp.published_at is not null
    and rp.unpublished_at is null;
  if v_count > 0 then
    v_reasons := array_append(v_reasons, format('%s published week%s', v_count, case when v_count = 1 then '' else 's' end));
  end if;

  -- Fixed: `%s` -> `%`. RAISE (unlike the format() calls above, which are a
  -- genuinely different function and correctly use %s) only ever takes a
  -- bare `%` as its placeholder.
  if array_length(v_reasons, 1) > 0 then
    raise exception 'This resort still has %. Retire these first, then try again.', array_to_string(v_reasons, ', ')
      using errcode = '55006';
  end if;

  update resorts r set is_active = false where r.id = p_resort_id;

  return query select p_resort_id;
end;
$$;

comment on function deactivate_resort(uuid) is
  'Manager-only, atomic. Marks a resort inactive -- never deletes it, never cascades to its drivers/shifts/instances/publications. Refused (55006) while the resort still has active drivers, active shifts, upcoming generated shift instances, or a published week; the exception names exactly which.';

revoke execute on function deactivate_resort(uuid) from public;
grant execute on function deactivate_resort(uuid) to authenticated;
