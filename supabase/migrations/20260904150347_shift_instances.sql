-- 06_shift_instances (Revision 2 stable identity design)
--
-- A concrete, dated shift. Identity is STABLE: (resort_id, shift_type_id,
-- date). start_time is a mutable, snapshotted attribute and must never be
-- part of identity -- this is the Revision 2 correction over the superseded
-- (resort_id, date, shift_key, start_time) design.

create table shift_instances (
  id uuid primary key default gen_random_uuid(),
  resort_id uuid not null references resorts (id) on delete restrict,
  date date not null,
  -- Monday-anchored week start, derived from date via the app-wide
  -- Monday=0..Sunday=6 weekday convention (app_weekday, migration 01).
  week_start date generated always as (date - app_weekday(date)::integer) stored,

  shift_type_id uuid not null,
  -- Template lineage. Retained even when a materialised shift has been
  -- manager-overridden. Ad-hoc shifts use template_id IS NULL.
  template_id uuid,

  -- --- Snapshotted at materialisation/creation time ---
  shift_key text not null,
  name text not null,
  sort_order integer not null,
  start_time time not null,
  end_time time not null,
  required_drivers integer not null check (required_drivers > 0),
  base_pay_chf numeric(10, 2) not null check (base_pay_chf >= 0),
  delivery_rate_chf numeric(10, 2) not null check (delivery_rate_chf >= 0),
  is_premium boolean not null default false,

  status text not null default 'active' check (status in ('active', 'cancelled')),
  origin text not null check (origin in ('template', 'adhoc')),

  cancelled_at timestamptz,
  cancelled_reason text,
  cancelled_by uuid references app_users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- CRITICAL identity rule: stable uniqueness. Do NOT include start_time --
  -- it is mutable and cannot be part of identity.
  constraint shift_instances_resort_shift_type_date_unique
    unique (resort_id, shift_type_id, date),

  -- Ties the instance to a shift type that genuinely belongs to resort_id.
  constraint shift_instances_shift_type_resort_fk
    foreign key (shift_type_id, resort_id) references shift_types (id, resort_id),

  -- When template_id is set, it must point at a template of the same
  -- shift_type this instance claims (composite FK; not enforced while
  -- template_id is null, per standard MATCH SIMPLE semantics).
  constraint shift_instances_template_shift_type_fk
    foreign key (template_id, shift_type_id) references shift_templates (id, shift_type_id),

  constraint shift_instances_origin_template_check check (
    (origin = 'template' and template_id is not null)
    or
    (origin = 'adhoc' and template_id is null)
  ),

  constraint shift_instances_cancellation_check check (
    (status = 'cancelled' and cancelled_at is not null)
    or
    (status = 'active' and cancelled_at is null and cancelled_reason is null and cancelled_by is null)
  )
);

comment on table shift_instances is
  'Concrete, dated shift. Stable identity = (resort_id, shift_type_id, date); start_time is mutable and never part of identity (Revision 2).';

create index shift_instances_resort_date_idx on shift_instances (resort_id, date);
create index shift_instances_week_start_idx on shift_instances (resort_id, week_start);
create index shift_instances_template_id_idx on shift_instances (template_id);

create trigger shift_instances_set_updated_at
  before update on shift_instances
  for each row
  execute function set_updated_at();
