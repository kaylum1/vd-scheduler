-- 07_availability_and_publications
--
-- availability: driver x shift_instance answers. Absence of a row means
-- "Not Submitted" -- that is deliberately not a stored status value.
-- availability_submissions: backs the driver's Confirm Week state. It is
-- informational/audit only -- current completeness is ALWAYS derived fresh
-- (see week_availability_status, migration 10), never read off this row.
-- rota_publications: publish/lock state for a whole resort+week, never per
-- shift. shift_instances gets no `published` column.

-- Prerequisite: migration 06 did not add UNIQUE(id, resort_id) on
-- shift_instances because nothing needed a composite FK to it yet.
-- availability/rota_assignments/attendance all do (to make a cross-resort
-- driver<->shift link impossible at the DB level), so add it here rather
-- than editing the already-applied migration 06.
alter table shift_instances
  add constraint shift_instances_id_resort_unique unique (id, resort_id);

create table availability (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null,
  resort_id uuid not null,
  shift_instance_id uuid not null,
  status text not null check (status in ('available', 'unavailable')),
  answered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint availability_driver_shift_unique unique (driver_id, shift_instance_id),

  -- Same-resort integrity: a Crans driver can never be attached to a
  -- Zermatt shift, and resort_id can never be spoofed independently of
  -- either side -- both composite FKs must agree.
  constraint availability_driver_resort_fk
    foreign key (driver_id, resort_id) references drivers (id, resort_id),
  constraint availability_shift_instance_resort_fk
    foreign key (shift_instance_id, resort_id) references shift_instances (id, resort_id)
);

comment on table availability is
  'Driver answers per shift_instance. No row = Not Submitted; that is never a stored status.';

create index availability_shift_instance_id_idx on availability (shift_instance_id);
create index availability_driver_id_idx on availability (driver_id);

create trigger availability_set_updated_at
  before update on availability
  for each row
  execute function set_updated_at();

create table availability_submissions (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null,
  resort_id uuid not null,
  week_start date not null check (app_weekday(week_start) = 0),
  submitted_at timestamptz not null default now(),
  reopened_at timestamptz,
  reopened_reason text,
  -- Informational snapshot only -- never used to infer current completeness.
  shift_count_at_submission integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint availability_submissions_driver_week_unique unique (driver_id, week_start),

  constraint availability_submissions_driver_resort_fk
    foreign key (driver_id, resort_id) references drivers (id, resort_id)
);

comment on table availability_submissions is
  'Audit/history of Confirm Week submissions. NOT a source of truth for current completeness -- that is always derived fresh by week_availability_status (migration 10) from the current active shift set.';

create index availability_submissions_driver_id_idx on availability_submissions (driver_id);

create trigger availability_submissions_set_updated_at
  before update on availability_submissions
  for each row
  execute function set_updated_at();

create table rota_publications (
  id uuid primary key default gen_random_uuid(),
  resort_id uuid not null references resorts (id) on delete restrict,
  week_start date not null check (app_weekday(week_start) = 0),
  published_at timestamptz not null default now(),
  published_by uuid references app_users (id),
  unpublished_at timestamptz,
  generation_source text not null check (generation_source in ('manual', 'auto')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rota_publications_resort_week_unique unique (resort_id, week_start),
  constraint rota_publications_unpublish_after_publish_check
    check (unpublished_at is null or unpublished_at >= published_at)
);

comment on table rota_publications is
  'Single source of truth for whether a resort+week is published/locked. Publication is resort+week, never per shift -- shift_instances has no published flag.';

create trigger rota_publications_set_updated_at
  before update on rota_publications
  for each row
  execute function set_updated_at();
