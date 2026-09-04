-- 08_assignments_and_attendance
--
-- rota_assignments: which drivers are assigned to which shift instance.
-- Many drivers can share a shift (e.g. Dinner requiring 3 drivers = 3 rows).
-- No headcount/coverage enforcement here on purpose -- under- and
-- over-assigned draft shifts must both be representable at the DB level.
-- attendance: what actually happened. If a row exists it is truth; if not,
-- the (later) payroll/reporting layer falls back to the published rota
-- assignment. No attendance UI yet -- schema only.

create table rota_assignments (
  id uuid primary key default gen_random_uuid(),
  shift_instance_id uuid not null,
  driver_id uuid not null,
  resort_id uuid not null,
  assignment_source text not null check (assignment_source in ('manual', 'auto')),
  assigned_by uuid references app_users (id),
  assigned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The same driver must never appear twice on one shift. Nothing here
  -- caps the number of *different* drivers on a shift, and nothing checks
  -- that count against shift_instances.required_drivers -- coverage is a
  -- reporting concern, not a write-time constraint.
  constraint rota_assignments_shift_driver_unique unique (shift_instance_id, driver_id),

  constraint rota_assignments_driver_resort_fk
    foreign key (driver_id, resort_id) references drivers (id, resort_id),
  constraint rota_assignments_shift_instance_resort_fk
    foreign key (shift_instance_id, resort_id) references shift_instances (id, resort_id)
);

comment on table rota_assignments is
  'Driver <-> shift_instance assignments. Many drivers per shift; no coverage/headcount enforcement at the DB level.';

create index rota_assignments_shift_instance_id_idx on rota_assignments (shift_instance_id);
create index rota_assignments_driver_id_idx on rota_assignments (driver_id);

create trigger rota_assignments_set_updated_at
  before update on rota_assignments
  for each row
  execute function set_updated_at();

create table attendance (
  id uuid primary key default gen_random_uuid(),
  shift_instance_id uuid not null,
  driver_id uuid not null,
  resort_id uuid not null,
  status text not null check (status in ('worked', 'no_show', 'excused', 'cancelled')),
  actual_start timestamptz,
  actual_end timestamptz,
  notes text,
  recorded_by uuid references app_users (id),
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint attendance_shift_driver_unique unique (shift_instance_id, driver_id),

  constraint attendance_driver_resort_fk
    foreign key (driver_id, resort_id) references drivers (id, resort_id),
  constraint attendance_shift_instance_resort_fk
    foreign key (shift_instance_id, resort_id) references shift_instances (id, resort_id)
);

comment on table attendance is
  'What actually happened for a driver on a shift. If present, attendance is truth; otherwise the published rota_assignment is the fallback. No payroll calculation here.';

create index attendance_shift_instance_id_idx on attendance (shift_instance_id);
create index attendance_driver_id_idx on attendance (driver_id);

create trigger attendance_set_updated_at
  before update on attendance
  for each row
  execute function set_updated_at();
