-- 05_shift_types_and_templates
-- shift_types: stable, per-resort shift identity (key/name/sort order).
-- shift_templates: effective-dated versions of a shift type's schedule/pay
-- parameters. No hourly pay fields -- only base pay and delivery rate.

create table shift_types (
  id uuid primary key default gen_random_uuid(),
  resort_id uuid not null references resorts (id) on delete restrict,
  key text not null,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shift_types_resort_key_unique unique (resort_id, key),
  -- Preserved for the composite FKs used by shift_templates/shift_instances
  -- to guarantee a shift type is referenced together with its own resort.
  constraint shift_types_id_resort_unique unique (id, resort_id)
);

comment on table shift_types is
  'Stable, per-resort shift identity. Schedule/pay parameters live on effective-dated shift_templates.';

create index shift_types_resort_id_idx on shift_types (resort_id);

create trigger shift_types_set_updated_at
  before update on shift_types
  for each row
  execute function set_updated_at();

create table shift_templates (
  id uuid primary key default gen_random_uuid(),
  resort_id uuid not null,
  shift_type_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  required_drivers integer not null check (required_drivers > 0),
  base_pay_chf numeric(10, 2) not null check (base_pay_chf >= 0),
  delivery_rate_chf numeric(10, 2) not null check (delivery_rate_chf >= 0),
  is_premium boolean not null default false,
  effective_from date not null,
  -- null = open-ended (still the current version).
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shift_templates_effective_range_check
    check (effective_to is null or effective_to >= effective_from),

  -- Ties the template to a shift type that genuinely belongs to resort_id.
  constraint shift_templates_shift_type_resort_fk
    foreign key (shift_type_id, resort_id) references shift_types (id, resort_id),

  -- Lets shift_instances take a composite FK on (template_id, shift_type_id)
  -- so a materialised instance can never point at a template of a different
  -- shift type than the one it claims.
  constraint shift_templates_id_shift_type_unique unique (id, shift_type_id),

  -- No two active template versions for the same shift type + weekday may
  -- have overlapping effective-date ranges (weekday = Monday=0..Sunday=6,
  -- via app_weekday). Requires btree_gist (migration 01).
  constraint shift_templates_no_overlap
    exclude using gist (
      shift_type_id with =,
      weekday with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
    ) where (is_active)
);

comment on table shift_templates is
  'Effective-dated schedule/pay parameters for a shift type. No hourly pay fields.';

create index shift_templates_shift_type_id_idx on shift_templates (shift_type_id);
create index shift_templates_resort_id_idx on shift_templates (resort_id);

create trigger shift_templates_set_updated_at
  before update on shift_templates
  for each row
  execute function set_updated_at();
