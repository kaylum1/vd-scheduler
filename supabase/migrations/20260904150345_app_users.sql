-- 04_app_users
-- Sole bridge between Supabase auth identities and the app's role model.
-- driver_id is the ONLY auth -> driver relationship (drivers.auth_user_id
-- must never exist). A driver's resort is derived from drivers.resort_id and
-- is never duplicated here.

create table app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('manager', 'driver')),
  driver_id uuid references drivers (id),
  -- Manager resort scope, nullable = all resorts (the only mode used in V1).
  -- Meaningless for role = 'driver' (see app_users_role_scope_check below).
  resort_id uuid references resorts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One login maximum per driver.
  constraint app_users_driver_id_unique unique (driver_id),

  -- A driver login must point at a driver and must not carry its own resort
  -- scope (that comes from drivers.resort_id). A manager login must not be
  -- tied to a driver record.
  constraint app_users_role_scope_check check (
    (role = 'driver' and driver_id is not null and resort_id is null)
    or
    (role = 'manager' and driver_id is null)
  )
);

comment on table app_users is
  'Auth identity -> app role mapping. driver_id is the sole auth->driver relationship; managers optionally get a nullable resort scope (null = all resorts).';

create index app_users_resort_id_idx on app_users (resort_id);

create trigger app_users_set_updated_at
  before update on app_users
  for each row
  execute function set_updated_at();
