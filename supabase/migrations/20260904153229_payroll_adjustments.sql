-- 09_payroll_adjustments
--
-- Generic MANUAL additions/deductions. amount_chf is always stored positive;
-- the `type` determines whether it adds or subtracts when totals are
-- computed later (not implemented in this checkpoint). No automatic
-- petrol/parking/train logic -- those are just descriptions on an
-- expense_reimbursement row. Corrections use voiding, never hard delete.

create table payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null,
  resort_id uuid not null,
  date date not null,
  type text not null check (type in ('expense_reimbursement', 'bonus', 'other_addition', 'deduction')),
  amount_chf numeric(10, 2) not null check (amount_chf > 0),
  description text,
  shift_instance_id uuid,
  created_by uuid references app_users (id),
  voided_at timestamptz,
  voided_by uuid references app_users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payroll_adjustments_driver_resort_fk
    foreign key (driver_id, resort_id) references drivers (id, resort_id),

  -- Optional shift link: when supplied, its resort must also match. Not
  -- enforced while shift_instance_id is null (standard MATCH SIMPLE
  -- composite FK semantics).
  constraint payroll_adjustments_shift_instance_resort_fk
    foreign key (shift_instance_id, resort_id) references shift_instances (id, resort_id),

  constraint payroll_adjustments_void_consistency_check
    check (
      (voided_at is null and voided_by is null)
      or
      (voided_at is not null)
    )
);

comment on table payroll_adjustments is
  'Generic manual payroll additions/deductions. amount_chf is always positive; `type` decides add vs subtract at calculation time (not implemented yet). Never hard-deleted -- corrections void instead.';

create index payroll_adjustments_driver_id_idx on payroll_adjustments (driver_id);
create index payroll_adjustments_shift_instance_id_idx on payroll_adjustments (shift_instance_id);

create trigger payroll_adjustments_set_updated_at
  before update on payroll_adjustments
  for each row
  execute function set_updated_at();
