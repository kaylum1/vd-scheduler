-- 22_configuration_guards
--
-- Stage 2D Checkpoint 1: real manager Configuration (resorts/drivers/shift
-- types) needs the database to actually enforce three invariants the
-- architecture has always assumed but never mechanically guaranteed before
-- now (nothing previously wrote to these columns outside a migration/seed):
--
--   1. A driver belongs to exactly one resort, permanently. Moving a driver
--      with meaningful history to a different resort is not a casual
--      update -- the correct operation is "deactivate the old driver record,
--      create a new one at the new resort" (never an UPDATE of resort_id).
--   2. A shift type's key is its stable, long-term grid identity and its
--      resort scoping is fixed at creation -- neither may be changed later.
--   3. Deactivating a shift type must not silently orphan active recurring
--      shift templates into an ambiguous state; templates must be retired
--      first.
--
-- ENFORCEMENT CHOICE: plain BEFORE UPDATE triggers that reject the specific
-- column change/transition, full stop -- the same choice already made for
-- shift_instances.date (see 20260908094053_shift_date_immutability_guard.sql)
-- and for the same reasons: a CHECK constraint can't compare OLD vs NEW, and
-- a role-aware exception would weaken the guarantee for the one case (a
-- manager's own UPDATE through the API) it exists to protect. These apply
-- regardless of role -- even a manager cannot bypass them through normal
-- writes. The standard Postgres escape hatch (`set local
-- session_replication_role = replica;`, not reachable through the API)
-- remains available for a genuine one-off data-correction script.

-- =======================================================================
-- 1. DRIVERS: resort_id is immutable after creation.
-- =======================================================================
create or replace function drivers_prevent_resort_change()
returns trigger
language plpgsql
as $$
begin
  if new.resort_id is distinct from old.resort_id then
    raise exception 'A driver''s resort cannot be changed once set. Deactivate this driver and create a new driver profile at the new resort instead.'
      using errcode = '23514'; -- check_violation
  end if;
  return new;
end;
$$;

comment on function drivers_prevent_resort_change() is
  'Rejects any change to drivers.resort_id. Moving a driver to a different resort = deactivate + create new, never an UPDATE.';

create trigger drivers_prevent_resort_change_trg
  before update on drivers
  for each row
  execute function drivers_prevent_resort_change();

-- =======================================================================
-- 2. SHIFT_TYPES: key and resort_id are immutable after creation.
-- =======================================================================
create or replace function shift_types_prevent_identity_change()
returns trigger
language plpgsql
as $$
begin
  if new.key is distinct from old.key then
    raise exception 'A shift type''s key is its stable long-term identity and cannot be changed after creation. Deactivate it and create a new shift type instead.'
      using errcode = '23514'; -- check_violation
  end if;
  if new.resort_id is distinct from old.resort_id then
    raise exception 'A shift type cannot be moved to a different resort.'
      using errcode = '23514'; -- check_violation
  end if;
  return new;
end;
$$;

comment on function shift_types_prevent_identity_change() is
  'Rejects any change to shift_types.key or shift_types.resort_id. Both are fixed at creation; renaming the display `name` remains allowed.';

create trigger shift_types_prevent_identity_change_trg
  before update on shift_types
  for each row
  execute function shift_types_prevent_identity_change();

-- =======================================================================
-- 3. SHIFT_TYPES: deactivation is blocked while active recurring templates
--    reference it, to avoid silently orphaning them into an inconsistent
--    state. Managers must retire/deactivate those templates first (a later
--    checkpoint's UI concern -- not implemented yet, so today this simply
--    prevents the ambiguous state rather than attempting to resolve it).
--    errcode 55006 (object_in_use) is used deliberately, distinct from the
--    23514 (check_violation) used above, so callers can tell "immutable
--    field" and "blocked by dependent data" apart without parsing message
--    text.
-- =======================================================================
create or replace function shift_types_prevent_unsafe_deactivation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active_template_count int;
begin
  if new.is_active = false and old.is_active = true then
    select count(*) into v_active_template_count
    from shift_templates
    where shift_type_id = old.id
      and is_active;

    if v_active_template_count > 0 then
      raise exception 'This shift type has % active recurring shift template(s). Deactivate its templates before deactivating the shift type.', v_active_template_count
        using errcode = '55006'; -- object_in_use
    end if;
  end if;
  return new;
end;
$$;

comment on function shift_types_prevent_unsafe_deactivation() is
  'Blocks shift_types.is_active true->false while any shift_templates row for it is still active. SECURITY DEFINER so the check sees all active templates regardless of the caller''s own row visibility.';

create trigger shift_types_prevent_unsafe_deactivation_trg
  before update on shift_types
  for each row
  execute function shift_types_prevent_unsafe_deactivation();
