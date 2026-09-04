-- 02_resorts
-- Top-level tenant/scope table. Every driver, shift type, and shift instance
-- belongs to exactly one resort.

create table resorts (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name text not null,
  timezone text not null default 'Europe/Zurich',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint resorts_slug_unique unique (slug)
);

comment on table resorts is
  'Tenant/scope table. Resorts are deactivated (is_active = false), never hard-deleted, once they have historical data.';

create trigger resorts_set_updated_at
  before update on resorts
  for each row
  execute function set_updated_at();
