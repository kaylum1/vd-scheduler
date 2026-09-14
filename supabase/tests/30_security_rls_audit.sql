-- Security / RLS / audit invariants (Stage 2D Checkpoint 3.1).
-- Anonymous access, driver row-level scoping, manager cross-resort access,
-- RPC-level caller authorization, and audit logging.

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_shift_type_id uuid;
begin
  select shift_type_id into v_shift_type_id from create_shift(
    v_resort_id, 'Security Test Shift', '09:00'::time, '11:00'::time,
    array[0]::smallint[], '2027-05-03'::date, null -- 2027-05-03 is a Monday
  );
  perform set_config('dbtest.sec_shift_type', v_shift_type_id::text, false);
  insert into payroll_rules (resort_id, shift_type_id, base_pay_chf, delivery_rate_chf, effective_from)
  values (v_resort_id, v_shift_type_id, 100, 5, '2027-05-01');
  insert into rota_rules_default (resort_id, shift_type_id, required_drivers, is_premium, effective_from)
  values (v_resort_id, v_shift_type_id, 1, true, '2027-05-01');
  perform materialise_shift_instances(v_resort_id, '2027-05-03'::date, '2027-05-03'::date);
end $$;

-- =======================================================================
-- ANONYMOUS: cannot access business data at all (no table-level grant --
-- not merely "RLS filters it to zero rows").
-- =======================================================================
select pg_temp.act_as('anon');
select pg_temp.expect_error('anon: cannot select drivers (42501)', 'select count(*) from drivers', '42501');
select pg_temp.expect_error('anon: cannot select shift_instances (42501)', 'select count(*) from shift_instances', '42501');
select pg_temp.expect_error('anon: cannot select resorts (42501)', 'select count(*) from resorts', '42501');
select pg_temp.expect_error('anon: cannot select availability (42501)', 'select count(*) from availability', '42501');
select pg_temp.expect_error('anon: cannot select payroll_rules (42501)', 'select count(*) from payroll_rules', '42501');
select pg_temp.expect_error('anon: cannot select audit_log (42501)', 'select count(*) from audit_log', '42501');
select pg_temp.expect_error('anon: cannot call a manager RPC (42501)',
  format('select create_shift(%L::uuid, %L, %L::time, %L::time, array[0]::smallint[], null, null)',
    current_setting('dbtest.resort_a'), 'Anon Shift', '09:00', '10:00'),
  '42501');

-- =======================================================================
-- DRIVER: own record only; no visibility into manager-only config/pay/
-- premium/audit/onfleet tables at all.
-- =======================================================================
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);

select pg_temp.expect_true('driver: sees only their own drivers row',
  (select array_agg(id) from drivers) = array[current_setting('dbtest.driver_a_id')::uuid]);
select pg_temp.expect_true('driver: sees only their own app_users row',
  (select array_agg(id) from app_users) = array[current_setting('dbtest.driver_a_user_id')::uuid]);

select pg_temp.expect_true('driver: no rows from shift_instances (base table; drivers use driver_visible_shifts instead)',
  (select count(*) from shift_instances) = 0);
select pg_temp.expect_true('driver: no rows from shift_templates',
  (select count(*) from shift_templates) = 0);
select pg_temp.expect_true('driver: no rows from payroll_rules',
  (select count(*) from payroll_rules) = 0);
select pg_temp.expect_true('driver: no rows from rota_rules_default',
  (select count(*) from rota_rules_default) = 0);
select pg_temp.expect_true('driver: no rows from rota_rules_weekday',
  (select count(*) from rota_rules_weekday) = 0);
select pg_temp.expect_true('driver: no rows from rota_rules_date',
  (select count(*) from rota_rules_date) = 0);
select pg_temp.expect_true('driver: no rows from driver_onfleet_mappings',
  (select count(*) from driver_onfleet_mappings) = 0);
select pg_temp.expect_true('driver: no rows from attendance',
  (select count(*) from attendance) = 0);
select pg_temp.expect_true('driver: no rows from payroll_adjustments',
  (select count(*) from payroll_adjustments) = 0);
select pg_temp.expect_true('driver: no rows from audit_log',
  (select count(*) from audit_log) = 0);
select pg_temp.expect_true('driver: no rows from rota_assignments (base table; drivers use driver_visible_assignments instead)',
  (select count(*) from rota_assignments) = 0);

select pg_temp.expect_error('driver: cannot call create_shift (42501)',
  format('select create_shift(%L::uuid, %L, %L::time, %L::time, array[0]::smallint[], null, null)',
    current_setting('dbtest.resort_a'), 'Driver Shift', '09:00', '10:00'),
  '42501');
select pg_temp.expect_error('driver: cannot call materialise_shift_instances (42501)',
  format('select materialise_shift_instances(%L::uuid, null, null)', current_setting('dbtest.resort_a')),
  '42501');
select pg_temp.expect_error('driver: cannot call set_driver_onfleet_mapping (42501)',
  format('select set_driver_onfleet_mapping(%L::uuid, %L)', current_setting('dbtest.driver_a_id'), 'w1'),
  '42501');

-- driver_visible_shifts never exposes premium/pay/headcount, even though
-- the underlying materialised instance has them configured (is_premium in
-- particular, per the product rule that drivers must never see it).
select pg_temp.expect_true('driver_visible_shifts: never exposes is_premium/pay/required_drivers columns (structural)',
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'driver_visible_shifts'
      and column_name in ('is_premium', 'base_pay_chf', 'delivery_rate_chf', 'required_drivers', 'template_id', 'origin')
  ));
select pg_temp.expect_true('driver_visible_shifts: driver_a sees the shift materialised in their own resort',
  exists (select 1 from driver_visible_shifts where shift_type_id = current_setting('dbtest.sec_shift_type')::uuid));

-- =======================================================================
-- RPC AUTH: a driver cannot act as another driver.
-- =======================================================================
do $$
begin
  perform pg_temp.expect_error('RPC auth: a driver cannot call week_availability_status for another driver (42501)',
    format('select * from week_availability_status(%L::uuid, %L::date)', current_setting('dbtest.driver_b_id'), '2027-05-03'),
    '42501');
  perform pg_temp.expect_error('RPC auth: a driver cannot call confirm_availability_week for another driver (42501)',
    format('select * from confirm_availability_week(%L::uuid, %L::date)', current_setting('dbtest.driver_b_id'), '2027-05-03'),
    '42501');
  perform pg_temp.expect_error('RPC auth: a driver cannot call reopen_availability_week for another driver (42501)',
    format('select * from reopen_availability_week(%L::uuid, %L::date)', current_setting('dbtest.driver_b_id'), '2027-05-03'),
    '42501');
  -- A driver acting as themselves is fine.
  perform pg_temp.expect_true('RPC auth: a driver CAN call week_availability_status for themselves',
    (select true from week_availability_status(current_setting('dbtest.driver_a_id')::uuid, '2027-05-03'::date) limit 1));
end $$;

-- =======================================================================
-- MANAGER: V1 cross-resort access -- a manager may act on ANY resort,
-- despite app_users.resort_id being NULL for managers (no per-resort scope).
-- =======================================================================
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('manager: can select drivers across BOTH resorts (V1 has no per-resort manager scoping)',
  (select count(distinct resort_id) from drivers where id in (current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.driver_b_id')::uuid)) = 2);
select pg_temp.expect_true('manager: can query week_availability_status for a driver in the OTHER resort',
  (select true from week_availability_status(current_setting('dbtest.driver_b_id')::uuid, '2027-05-03'::date) limit 1));

-- =======================================================================
-- AUDIT: audited changes produce before/after/actor; audit_log itself is
-- never client-writable.
-- =======================================================================
do $$
declare
  v_before_name text;
begin
  select full_name into v_before_name from drivers where id = current_setting('dbtest.driver_a_id')::uuid;
  update drivers set full_name = 'DB Test Driver A (renamed)' where id = current_setting('dbtest.driver_a_id')::uuid;

  perform pg_temp.expect_true('audit: an audited UPDATE produces a row with populated before/after and the acting manager as actor',
    exists (
      select 1 from audit_log
      where table_name = 'drivers' and row_id = current_setting('dbtest.driver_a_id')::uuid and action = 'update'
        and (before ->> 'full_name') = v_before_name
        and (after ->> 'full_name') = 'DB Test Driver A (renamed)'
        and actor_user_id = current_setting('dbtest.manager_id')::uuid
    ));
end $$;

select pg_temp.expect_error('audit: audit_log is not client-writable, even by a manager (42501)',
  format('insert into audit_log (table_name, row_id, action, actor_source) values (%L, %L, %L, %L)',
    'drivers', current_setting('dbtest.driver_a_id'), 'update', 'user'),
  '42501');
