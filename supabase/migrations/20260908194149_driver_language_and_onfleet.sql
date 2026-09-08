-- 23_driver_language_and_onfleet
--
-- Stage 2D Checkpoint 1.1: driver preferred language + hardening the
-- existing driver_onfleet_mappings model for real Configuration UI use.

-- =======================================================================
-- 1. SUPPORTED_LANGUAGES -- extensible driver-facing language reference.
--
-- A lookup table rather than a CHECK(preferred_language in ('en','fr')):
-- adding a third supported language later is one INSERT, not a migration
-- that rewrites a constraint on the drivers table. V1 ships with exactly
-- the two languages Checkpoint 1.1 asked for; nothing here implies more
-- are supported yet -- only that adding one doesn't require touching the
-- driver model.
-- =======================================================================
create table supported_languages (
  code text primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table supported_languages is
  'Reference list of languages drivers may set as preferred_language. Add a language by inserting a row here, not by altering drivers.';

create trigger supported_languages_set_updated_at
  before update on supported_languages
  for each row
  execute function set_updated_at();

insert into supported_languages (code, name) values
  ('en', 'English'),
  ('fr', 'French');

alter table supported_languages enable row level security;
alter table supported_languages force row level security;
revoke all on supported_languages from anon, authenticated;
grant select on supported_languages to authenticated;

-- Reference data every authenticated session (manager or driver) may read
-- -- needed so a driver's own client can eventually render this list too,
-- and so the manager Configuration UI never has to hard-code it.
create policy supported_languages_authenticated_select on supported_languages for select to authenticated
  using (true);

-- =======================================================================
-- 2. DRIVERS.PREFERRED_LANGUAGE
--
-- Lives on the driver profile (not app_users): must be settable during
-- onboarding before a login exists, and must survive a login being
-- replaced (Stage 2B's account provisioning is deliberately separate from
-- the driver record). Defaults to 'en', matching the current all-English
-- manager/driver UI.
-- =======================================================================
alter table drivers
  add column preferred_language text not null default 'en'
  references supported_languages (code);

comment on column drivers.preferred_language is
  'Driver''s preferred UI language (references supported_languages). Authoritative for driver-UI localisation from Stage 3 onward; the manager UI stays English for now.';

-- =======================================================================
-- 3. DRIVER_ONFLEET_MAPPINGS -- one active mapping per driver at a time.
--
-- The table (migration 03) already prevents one Onfleet identity being
-- actively claimed twice at a resort. It never constrained the other
-- direction: nothing stopped a driver from ending up with two
-- simultaneously-active mappings. "Edit/replace a mapping" (Checkpoint
-- 1.1 section 2) only has one obvious meaning -- deactivate the old
-- mapping, create a new one, same as the driver-resort and shift-type-key
-- immutability guards -- so that meaning is made a real, enforced
-- invariant here rather than left as a UI convention nothing checks.
-- =======================================================================
create unique index driver_onfleet_mappings_driver_active_unique
  on driver_onfleet_mappings (driver_id)
  where is_active;

comment on index driver_onfleet_mappings_driver_active_unique is
  'At most one active Onfleet mapping per driver. Replacing a mapping = deactivate the old one, insert a new one (see set_driver_onfleet_mapping).';

-- Atomically replaces a driver's active Onfleet mapping: deactivates
-- whatever was active (if anything) and inserts the new one, so a manager
-- editing the mapping never observes -- or leaves behind on a failure --
-- a driver with either zero or two active mappings. resort_id is resolved
-- server-side from the driver's own row, never trusted from the caller.
create or replace function set_driver_onfleet_mapping(p_driver_id uuid, p_onfleet_worker_id text)
returns driver_onfleet_mappings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_resort_id uuid;
  v_row driver_onfleet_mappings;
begin
  perform assert_active_manager();

  if p_onfleet_worker_id is null or btrim(p_onfleet_worker_id) = '' then
    raise exception 'onfleet worker name/id must not be blank' using errcode = '23514';
  end if;

  select resort_id into v_resort_id from drivers where id = p_driver_id;
  if v_resort_id is null then
    raise exception 'driver % not found', p_driver_id using errcode = 'P0002';
  end if;

  update driver_onfleet_mappings
    set is_active = false
    where driver_id = p_driver_id
      and is_active;

  insert into driver_onfleet_mappings (resort_id, driver_id, onfleet_worker_id, is_active)
  values (v_resort_id, p_driver_id, btrim(p_onfleet_worker_id), true)
  returning * into v_row;

  return v_row;
end;
$$;

comment on function set_driver_onfleet_mapping(uuid, text) is
  'Manager-only. Atomically deactivates a driver''s current active Onfleet mapping (if any) and creates a new active one. resort_id is always resolved from drivers, never client-supplied.';

revoke execute on function set_driver_onfleet_mapping(uuid, text) from public;
grant execute on function set_driver_onfleet_mapping(uuid, text) to authenticated;
