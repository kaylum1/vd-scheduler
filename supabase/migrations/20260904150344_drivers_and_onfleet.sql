-- 03_drivers_and_onfleet
-- Drivers belong to exactly one resort. Onfleet identity mapping is explicit
-- and verified only — never fuzzy-matched.

create table drivers (
  id uuid primary key default gen_random_uuid(),
  resort_id uuid not null references resorts(id) on delete restrict,
  full_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Preserved so other tables (e.g. driver_onfleet_mappings, and future
  -- availability/rota tables) can take a composite FK on (driver_id, resort_id)
  -- and have Postgres guarantee the driver actually belongs to that resort.
  constraint drivers_id_resort_unique unique (id, resort_id)
);

comment on table drivers is
  'One row per driver. Exactly one resort per driver. Deactivate (is_active = false) rather than delete once a driver has historical data.';

create index drivers_resort_id_idx on drivers (resort_id);

create trigger drivers_set_updated_at
  before update on drivers
  for each row
  execute function set_updated_at();

-- Explicit, verified Onfleet identity mapping. No fuzzy matching: every row
-- here represents a manually confirmed link between a driver and an Onfleet
-- worker identity for a given resort.
create table driver_onfleet_mappings (
  id uuid primary key default gen_random_uuid(),
  resort_id uuid not null,
  driver_id uuid not null,
  onfleet_worker_id text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Ensures the mapping's resort always matches the resort of the driver it
  -- points to (relies on drivers_id_resort_unique above).
  constraint driver_onfleet_mappings_driver_resort_fk
    foreign key (driver_id, resort_id) references drivers (id, resort_id)
);

comment on table driver_onfleet_mappings is
  'Explicit, human-verified driver <-> Onfleet worker identity links. Never fuzzy-matched.';

create index driver_onfleet_mappings_driver_id_idx on driver_onfleet_mappings (driver_id);

-- An Onfleet identity can only be actively claimed by one mapping per resort
-- at a time (a driver's historical/deactivated mappings do not block reuse).
create unique index driver_onfleet_mappings_active_identity_unique
  on driver_onfleet_mappings (resort_id, onfleet_worker_id)
  where is_active;

create trigger driver_onfleet_mappings_set_updated_at
  before update on driver_onfleet_mappings
  for each row
  execute function set_updated_at();
