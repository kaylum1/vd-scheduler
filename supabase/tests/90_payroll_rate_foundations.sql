-- Payroll rate foundation invariants (Stage 2D Payroll Checkpoint A):
-- shift_base_pay_rules (Shift-level base guarantee) and
-- driver_delivery_rates (driver-level delivery rate). Both effective-dated,
-- manager-only, audited, and NOT read by materialise_shift_instances at all
-- any more -- see 60_shift_staffing.sql for that decoupling proof. This
-- file is pure rate-configuration/resolution correctness; no payroll
-- calculation exists yet (deliberately out of scope for this checkpoint),
-- so "resolution" here means the plain effective-dating predicate a future
-- calculation engine will use, checked directly.
--
-- All dates anchored to a fixed 2027 Nov/Dec calendar, mirroring the
-- product's own worked example (Alex CHF12 until 30 Nov, CHF14 from 1 Dec;
-- Dinner base CHF30 until 30 Nov, CHF35 from 1 Dec) so the two rate tables'
-- tests read the same way and stay deterministic regardless of when the
-- suite runs.

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- A shift at resort_a, and a second shift at resort_b, so the wrong-resort
-- FK case has a genuinely different-resort shift to reference.
do $$
declare
  v_id uuid;
begin
  select shift_type_id into v_id from create_shift(
    current_setting('dbtest.resort_a')::uuid, 'Rate Test Shift', '18:00'::time, '21:30'::time,
    array[0]::smallint[], 1, '2027-01-01'::date, null
  );
  perform set_config('dbtest.rate_shift_type', v_id::text, false);

  select shift_type_id into v_id from create_shift(
    current_setting('dbtest.resort_b')::uuid, 'Rate Test Shift B', '18:00'::time, '21:30'::time,
    array[0]::smallint[], 1, '2027-01-01'::date, null
  );
  perform set_config('dbtest.rate_shift_type_b', v_id::text, false);
end $$;

-- =======================================================================
-- SHIFT_BASE_PAY_RULES
-- =======================================================================
do $$
declare
  v_id uuid;
begin
  insert into shift_base_pay_rules (resort_id, shift_type_id, base_pay_chf, effective_from, effective_to)
  values (current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.rate_shift_type')::uuid, 30.00, '2027-11-01', '2027-11-30')
  returning id into v_id;
  perform set_config('dbtest.base_rule_nov_id', v_id::text, false);

  perform pg_temp.expect_true('shift_base_pay_rules: manager can create a rule',
    exists (select 1 from shift_base_pay_rules where id = v_id and base_pay_chf = 30.00));
end $$;

select pg_temp.expect_true('shift_base_pay_rules: effective range applies correctly -- a date inside the range resolves',
  exists (
    select 1 from shift_base_pay_rules
    where shift_type_id = current_setting('dbtest.rate_shift_type')::uuid and is_active
      and effective_from <= '2027-11-15' and (effective_to is null or effective_to >= '2027-11-15')
  ));
select pg_temp.expect_true('shift_base_pay_rules: effective range applies correctly -- a date before the range does not resolve',
  not exists (
    select 1 from shift_base_pay_rules
    where shift_type_id = current_setting('dbtest.rate_shift_type')::uuid and is_active
      and effective_from <= '2027-10-15' and (effective_to is null or effective_to >= '2027-10-15')
  ));

select pg_temp.expect_error('shift_base_pay_rules: overlapping active period for the same shift rejected (23P01)',
  format('insert into shift_base_pay_rules (resort_id, shift_type_id, base_pay_chf, effective_from, effective_to) values (%L, %L, 99, %L, %L)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.rate_shift_type'), '2027-11-15', '2027-12-15'),
  '23P01');

-- Consecutive, non-overlapping, open-ended successor -- the "rate changes
-- from 1 December" scenario. Succeeds because 2027-11-30 (period 1's end)
-- and 2027-12-01 (period 2's start) do not overlap.
do $$
declare
  v_id uuid;
begin
  insert into shift_base_pay_rules (resort_id, shift_type_id, base_pay_chf, effective_from, effective_to)
  values (current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.rate_shift_type')::uuid, 35.00, '2027-12-01', null)
  returning id into v_id;
  perform set_config('dbtest.base_rule_dec_id', v_id::text, false);

  perform pg_temp.expect_true('shift_base_pay_rules: a consecutive, non-overlapping successor period is allowed',
    exists (select 1 from shift_base_pay_rules where id = v_id));
  perform pg_temp.expect_true('shift_base_pay_rules: open-ended rule (effective_to null) is supported',
    (select effective_to from shift_base_pay_rules where id = v_id) is null);
end $$;

-- Historical-safe resolution: a future rate change does not rewrite the
-- earlier period's own applicable rate.
select pg_temp.expect_true('shift_base_pay_rules: a lookup mid-period-1 (15 Nov) resolves 30.00, not the later rate',
  (select base_pay_chf from shift_base_pay_rules
   where shift_type_id = current_setting('dbtest.rate_shift_type')::uuid and is_active
     and effective_from <= '2027-11-15' and (effective_to is null or effective_to >= '2027-11-15')) = 30.00);
select pg_temp.expect_true('shift_base_pay_rules: a lookup after the change (15 Dec) resolves 35.00 via the open-ended rule',
  (select base_pay_chf from shift_base_pay_rules
   where shift_type_id = current_setting('dbtest.rate_shift_type')::uuid and is_active
     and effective_from <= '2027-12-15' and (effective_to is null or effective_to >= '2027-12-15')) = 35.00);

select pg_temp.expect_error('shift_base_pay_rules: a negative base rate is rejected (23514)',
  format('insert into shift_base_pay_rules (resort_id, shift_type_id, base_pay_chf, effective_from) values (%L, %L, -5, %L)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.rate_shift_type'), '2027-06-01'),
  '23514');
select pg_temp.expect_error('shift_base_pay_rules: a shift belonging to a different resort is rejected (23503)',
  format('insert into shift_base_pay_rules (resort_id, shift_type_id, base_pay_chf, effective_from) values (%L, %L, 30, %L)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.rate_shift_type_b'), '2027-06-01'),
  '23503');

-- ---------------------------------------------------------------------
-- Security: driver/anonymous rejected (reconfirmed here against these
-- specific rule rows; broader coverage in 30_security_rls_audit.sql).
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('shift_base_pay_rules: a driver cannot read any rule row',
  (select count(*) from shift_base_pay_rules) = 0);
select pg_temp.expect_error('shift_base_pay_rules: a driver cannot create a rule (42501)',
  format('insert into shift_base_pay_rules (resort_id, shift_type_id, base_pay_chf, effective_from) values (%L, %L, 30, %L)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.rate_shift_type'), '2027-06-01'),
  '42501');

select pg_temp.act_as('anon');
select pg_temp.expect_error('shift_base_pay_rules: anonymous cannot access it at all (42501)',
  'select count(*) from shift_base_pay_rules', '42501');

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('audit: creating a shift_base_pay_rules row produced an insert audit row',
  exists (select 1 from audit_log where table_name = 'shift_base_pay_rules' and row_id = current_setting('dbtest.base_rule_nov_id')::uuid and action = 'insert'));

-- =======================================================================
-- DRIVER_DELIVERY_RATES
-- =======================================================================
do $$
declare
  v_id uuid;
begin
  insert into driver_delivery_rates (driver_id, resort_id, rate_chf, effective_from, effective_to)
  values (current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, 12.00, '2027-11-01', '2027-11-30')
  returning id into v_id;
  perform set_config('dbtest.rate_nov_id', v_id::text, false);

  perform pg_temp.expect_true('driver_delivery_rates: manager can create a rate',
    exists (select 1 from driver_delivery_rates where id = v_id and rate_chf = 12.00));
end $$;

select pg_temp.expect_true('driver_delivery_rates: effective range applies correctly -- a date inside the range resolves',
  exists (
    select 1 from driver_delivery_rates
    where driver_id = current_setting('dbtest.driver_a_id')::uuid and is_active
      and effective_from <= '2027-11-15' and (effective_to is null or effective_to >= '2027-11-15')
  ));
select pg_temp.expect_true('driver_delivery_rates: effective range applies correctly -- a date before the range does not resolve',
  not exists (
    select 1 from driver_delivery_rates
    where driver_id = current_setting('dbtest.driver_a_id')::uuid and is_active
      and effective_from <= '2027-10-15' and (effective_to is null or effective_to >= '2027-10-15')
  ));

select pg_temp.expect_error('driver_delivery_rates: overlapping active period for the same driver rejected (23P01)',
  format('insert into driver_delivery_rates (driver_id, resort_id, rate_chf, effective_from, effective_to) values (%L, %L, 99, %L, %L)',
    current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), '2027-11-15', '2027-12-15'),
  '23P01');

-- Consecutive, non-overlapping, open-ended successor -- "Tomas CHF14 from 1
-- December" in the product's own worked example.
do $$
declare
  v_id uuid;
begin
  insert into driver_delivery_rates (driver_id, resort_id, rate_chf, effective_from, effective_to)
  values (current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, 14.00, '2027-12-01', null)
  returning id into v_id;
  perform set_config('dbtest.rate_dec_id', v_id::text, false);

  perform pg_temp.expect_true('driver_delivery_rates: a sequential historical/future rate period is allowed',
    exists (select 1 from driver_delivery_rates where id = v_id));
  perform pg_temp.expect_true('driver_delivery_rates: open-ended rate (effective_to null) is supported',
    (select effective_to from driver_delivery_rates where id = v_id) is null);
end $$;

select pg_temp.expect_true('driver_delivery_rates: a lookup mid-period-1 (15 Nov) resolves 12.00, not the later rate',
  (select rate_chf from driver_delivery_rates
   where driver_id = current_setting('dbtest.driver_a_id')::uuid and is_active
     and effective_from <= '2027-11-15' and (effective_to is null or effective_to >= '2027-11-15')) = 12.00);
select pg_temp.expect_true('driver_delivery_rates: a lookup after the change (15 Dec) resolves 14.00 via the open-ended rule',
  (select rate_chf from driver_delivery_rates
   where driver_id = current_setting('dbtest.driver_a_id')::uuid and is_active
     and effective_from <= '2027-12-15' and (effective_to is null or effective_to >= '2027-12-15')) = 14.00);

select pg_temp.expect_error('driver_delivery_rates: a negative rate is rejected (23514)',
  format('insert into driver_delivery_rates (driver_id, resort_id, rate_chf, effective_from) values (%L, %L, -1, %L)',
    current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), '2027-06-01'),
  '23514');
select pg_temp.expect_error('driver_delivery_rates: a driver belonging to a different resort is rejected (23503)',
  format('insert into driver_delivery_rates (driver_id, resort_id, rate_chf, effective_from) values (%L, %L, 12, %L)',
    current_setting('dbtest.driver_b_id'), current_setting('dbtest.resort_a'), '2027-06-01'),
  '23503');

-- Different drivers may have independently different rates.
do $$
declare
  v_id uuid;
begin
  insert into driver_delivery_rates (driver_id, resort_id, rate_chf, effective_from)
  values (current_setting('dbtest.driver_b_id')::uuid, current_setting('dbtest.resort_b')::uuid, 20.00, '2027-11-01')
  returning id into v_id;
  perform set_config('dbtest.rate_driver_b_id', v_id::text, false);
end $$;
select pg_temp.expect_true('driver_delivery_rates: different drivers have independently different rates',
  (select rate_chf from driver_delivery_rates where id = current_setting('dbtest.rate_nov_id')::uuid) = 12.00
  and (select rate_chf from driver_delivery_rates where id = current_setting('dbtest.rate_driver_b_id')::uuid) = 20.00);

-- ---------------------------------------------------------------------
-- Security: a driver cannot read or write even their OWN delivery rate;
-- anonymous has no access at all.
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('driver_delivery_rates: a driver cannot read their own rate',
  (select count(*) from driver_delivery_rates) = 0);
select pg_temp.expect_error('driver_delivery_rates: a driver cannot modify their own rate (42501)',
  format('insert into driver_delivery_rates (driver_id, resort_id, rate_chf, effective_from) values (%L, %L, 999, %L)',
    current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), '2027-06-01'),
  '42501');

select pg_temp.act_as('anon');
select pg_temp.expect_error('driver_delivery_rates: anonymous cannot access it at all (42501)',
  'select count(*) from driver_delivery_rates', '42501');

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('audit: creating a driver_delivery_rates row produced an insert audit row',
  exists (select 1 from audit_log where table_name = 'driver_delivery_rates' and row_id = current_setting('dbtest.rate_nov_id')::uuid and action = 'insert'));
