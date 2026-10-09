-- 26_resort_lifecycle_management
--
-- Stage 2D Checkpoint 4.1: manager-facing resort lifecycle (Add/Deactivate/
-- Reactivate). `resorts.is_active` already exists (migration 02) and was
-- already wired into RLS (drivers only ever see active resorts) -- what
-- was actually missing is a way for a manager to ever WRITE it. Migration
-- 16's grants on resorts are deliberately `select, update` only, with no
-- INSERT at all, and both the manager SELECT and UPDATE policies exist
-- but nothing before this migration ever called them for a create/
-- deactivate/reactivate action -- there was no manager-facing path to
-- create a resort at all.
--
-- Rather than widen resorts' direct grants, this follows the same atomic-
-- RPC pattern as create_shift/deactivate_shift/reactivate_shift: three
-- SECURITY DEFINER functions, manager-only, each one transaction:
--   - create_resort: generates the internal slug from the name (same
--     idiom as create_shift's key generation) -- the manager never sees
--     or supplies it. timezone is never a parameter; the column's own
--     default ('Europe/Zurich') applies untouched.
--   - deactivate_resort: refuses (55006, matching
--     shift_types_prevent_unsafe_deactivation_trg's convention) while the
--     resort still has active drivers, active shifts (shift_types),
--     upcoming generated shift_instances, or a published week -- listing
--     exactly which ones block it. Never cascades, never silently
--     deactivates/moves/cancels those dependents itself.
--   - reactivate_resort: flips the same row back to active. Same id,
--     same slug, same history -- never a new resort.
--
-- No new column is needed. What IS added: the audit trigger (resorts was
-- never in migration 15's audited-tables list -- an odd gap, since every
-- other configuration table is audited).

create trigger resorts_audit_trg
  after insert or update or delete on resorts
  for each row
  execute function audit_log_row_change();

-- ---------------------------------------------------------------------
-- CREATE RESORT
-- ---------------------------------------------------------------------
create or replace function create_resort(p_name text)
returns table (resort_id uuid, slug text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_base_slug text;
  v_slug text;
  v_suffix int := 1;
begin
  perform assert_active_manager();

  if p_name is null or btrim(p_name) = '' then
    raise exception 'A resort needs a name.' using errcode = '23514';
  end if;

  v_base_slug := trim(both '-' from regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', '-', 'g'));
  if v_base_slug = '' then
    v_base_slug := 'resort';
  end if;
  v_slug := v_base_slug;
  while exists (select 1 from resorts r where r.slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  end loop;

  -- timezone is deliberately omitted -- the column's own default
  -- ('Europe/Zurich') applies. is_active defaults to true too, but stated
  -- explicitly here for clarity.
  insert into resorts (slug, name, is_active)
  values (v_slug, btrim(p_name), true)
  returning id into v_id;

  return query select v_id, v_slug;
end;
$$;

comment on function create_resort(text) is
  'Manager-only, atomic. Creates a new resort with an auto-generated, disambiguated slug (never manager-supplied) and the default Europe/Zurich operational timezone. No manager-facing timezone input exists.';

revoke execute on function create_resort(text) from public;
grant execute on function create_resort(text) to authenticated;

-- ---------------------------------------------------------------------
-- DEACTIVATE RESORT -- blocked while operationally-active dependents
-- remain, never cascades.
-- ---------------------------------------------------------------------
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

  if array_length(v_reasons, 1) > 0 then
    raise exception 'This resort still has %s. Retire these first, then try again.', array_to_string(v_reasons, ', ')
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

-- ---------------------------------------------------------------------
-- REACTIVATE RESORT -- same row, same id, same history.
-- ---------------------------------------------------------------------
create or replace function reactivate_resort(p_resort_id uuid)
returns table (resort_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_active_manager();

  if not exists (select 1 from resorts r where r.id = p_resort_id and not r.is_active) then
    raise exception 'Resort not found or already active.' using errcode = 'P0002';
  end if;

  update resorts r set is_active = true where r.id = p_resort_id;

  return query select p_resort_id;
end;
$$;

comment on function reactivate_resort(uuid) is
  'Manager-only, atomic. Restores the same resort row to active -- same id, same slug, same historical relationships. Never creates a replacement resort.';

revoke execute on function reactivate_resort(uuid) from public;
grant execute on function reactivate_resort(uuid) to authenticated;
