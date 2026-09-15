-- Rota rule foundation invariants (Stage 2D Checkpoint 3), plus proof that
-- materialise_shift_instances has ZERO payroll-rate responsibility (Stage 2D
-- Payroll Checkpoint A) -- shift_base_pay_rules/driver_delivery_rates
-- overlap/effective-dating/security coverage lives in
-- 90_payroll_rate_foundations.sql instead, a dedicated file, now that rate
-- configuration is fully decoupled from shift generation.
-- All dates anchored to a fixed 2027 calendar so the suite is deterministic
-- regardless of when it runs. 2027-01-04 is a Monday (app_weekday
-- Monday=0..Sunday=6); Saturdays in January 2027 are 2, 9, 16, 23, 30.

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_id uuid;
begin
  select shift_type_id into v_id from create_shift(
    v_resort_id, 'PR Full', '17:00'::time, '21:00'::time,
    array[0,1,2,3,4,5,6]::smallint[], '2027-01-01'::date, '2027-01-31'::date
  );
  perform set_config('dbtest.pr_st_full', v_id::text, false);

  -- Deliberately NEVER given a shift_base_pay_rules row -- proves
  -- materialisation neither requires nor resolves one (Payroll Checkpoint A).
  select shift_type_id into v_id from create_shift(
    v_resort_id, 'PR No Rate Config', '12:00'::time, '14:00'::time,
    array[0,1,2,3,4,5,6]::smallint[], '2027-01-01'::date, '2027-01-31'::date
  );
  perform set_config('dbtest.pr_st_no_payroll', v_id::text, false);

  select shift_type_id into v_id from create_shift(
    v_resort_id, 'PR No Rota', '08:00'::time, '10:00'::time,
    array[0,1,2,3,4,5,6]::smallint[], '2027-01-01'::date, '2027-01-31'::date
  );
  perform set_config('dbtest.pr_st_no_rota', v_id::text, false);
end $$;

-- 3-tier rota rules exercising precedence (date > weekday > default) and
-- seasonal weekday effective dating. No shift_base_pay_rules rows are
-- inserted for ANY of these shift types in this file -- materialisation
-- must not need one to resolve schedule/staffing.
do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_st_full uuid := current_setting('dbtest.pr_st_full')::uuid;
begin
  -- Default tier: every day, required=1, not premium.
  insert into rota_rules_default (resort_id, shift_type_id, required_drivers, is_premium, effective_from, effective_to)
  values (v_resort_id, v_st_full, 1, false, '2027-01-01', '2027-01-31');

  -- Weekday tier: Saturdays, two seasonal periods with different values --
  -- exercises seasonal weekday effective dating and high-value resolution
  -- (weekday beats default's is_premium too).
  insert into rota_rules_weekday (resort_id, shift_type_id, weekday, required_drivers, is_premium, effective_from, effective_to)
  values (v_resort_id, v_st_full, 5, 2, true, '2027-01-01', '2027-01-15');
  insert into rota_rules_weekday (resort_id, shift_type_id, weekday, required_drivers, is_premium, effective_from, effective_to)
  values (v_resort_id, v_st_full, 5, 4, false, '2027-01-16', '2027-01-31');

  -- Date tier: one specific Saturday beats the weekday rule too.
  insert into rota_rules_date (resort_id, shift_type_id, specific_date, required_drivers, is_premium)
  values (v_resort_id, v_st_full, '2027-01-23', 9, true);

  insert into rota_rules_default (resort_id, shift_type_id, required_drivers, is_premium, effective_from, effective_to)
  values (v_resort_id, current_setting('dbtest.pr_st_no_payroll')::uuid, 3, false, '2027-01-01', '2027-01-31');
end $$;

-- ---------------------------------------------------------------------
-- Overlap prevention on the three rota-rule tables (shift_base_pay_rules'
-- own overlap prevention is covered in 90_payroll_rate_foundations.sql).
-- ---------------------------------------------------------------------
select pg_temp.expect_error('rota_rules_default: overlapping active periods for the same shift type rejected (23P01)',
  format('insert into rota_rules_default (resort_id, shift_type_id, required_drivers, is_premium, effective_from, effective_to) values (%L, %L, 5, false, %L, %L)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.pr_st_full'), '2027-01-10', '2027-02-01'),
  '23P01');
select pg_temp.expect_error('rota_rules_weekday: overlapping active periods for the same shift type + weekday rejected (23P01)',
  format('insert into rota_rules_weekday (resort_id, shift_type_id, weekday, required_drivers, is_premium, effective_from, effective_to) values (%L, %L, 5, 7, false, %L, %L)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.pr_st_full'), '2027-01-10', '2027-02-01'),
  '23P01');
select pg_temp.expect_error('rota_rules_date: a second active row for the same shift type + exact date is rejected (23505)',
  format('insert into rota_rules_date (resort_id, shift_type_id, specific_date, required_drivers, is_premium) values (%L, %L, %L, 1, false)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.pr_st_full'), '2027-01-23'),
  '23505');

-- ---------------------------------------------------------------------
-- Materialise and inspect precedence / seasonal behaviour / high-value
-- resolution. Also proves shift_instances carries no financial columns
-- at all any more (Stage 2D Payroll Checkpoint A).
-- ---------------------------------------------------------------------
select materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-01-01'::date, '2027-01-31'::date);

select pg_temp.expect_true('shift_instances: base_pay_chf/delivery_rate_chf columns no longer exist -- pay is never a schedule/rota snapshot concern',
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shift_instances'
      and column_name in ('base_pay_chf', 'delivery_rate_chf')
  ));

do $$
declare
  v_st_full uuid := current_setting('dbtest.pr_st_full')::uuid;
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_row shift_instances%rowtype;
begin
  select * into v_row from shift_instances where resort_id = v_resort_id and shift_type_id = v_st_full and date = '2027-01-23';
  perform pg_temp.expect_true('precedence: date-tier override wins on 2027-01-23 (required=9, premium=true)',
    v_row.required_drivers = 9 and v_row.is_premium = true, format('got required=%s premium=%s', v_row.required_drivers, v_row.is_premium));

  select * into v_row from shift_instances where resort_id = v_resort_id and shift_type_id = v_st_full and date = '2027-01-09';
  perform pg_temp.expect_true('seasonal weekday: period 1 (2027-01-09): required=2, premium=true',
    v_row.required_drivers = 2 and v_row.is_premium = true, format('got required=%s premium=%s', v_row.required_drivers, v_row.is_premium));

  select * into v_row from shift_instances where resort_id = v_resort_id and shift_type_id = v_st_full and date = '2027-01-30';
  perform pg_temp.expect_true('seasonal weekday: period 2 (2027-01-30): required=4, premium=false',
    v_row.required_drivers = 4 and v_row.is_premium = false, format('got required=%s premium=%s', v_row.required_drivers, v_row.is_premium));

  select * into v_row from shift_instances where resort_id = v_resort_id and shift_type_id = v_st_full and date = '2027-01-05';
  perform pg_temp.expect_true('default tier: a non-Saturday, non-overridden date (2027-01-05): required=1, premium=false',
    v_row.required_drivers = 1 and v_row.is_premium = false, format('got required=%s premium=%s', v_row.required_drivers, v_row.is_premium));
  perform pg_temp.expect_true('schedule: start/end time still resolved correctly from shift_templates (17:00-21:00)',
    v_row.start_time = '17:00'::time and v_row.end_time = '21:00'::time);
end $$;

-- ---------------------------------------------------------------------
-- Missing rota config: never invents a value, never blocks materialisation.
-- Missing (or entirely absent) payroll-rate config is likewise never a
-- materialisation concern any more -- PR No Rate Config has NO
-- shift_base_pay_rules row at all, anywhere, and still materialises fine.
-- ---------------------------------------------------------------------
do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_st_no_payroll uuid := current_setting('dbtest.pr_st_no_payroll')::uuid;
  v_st_no_rota uuid := current_setting('dbtest.pr_st_no_rota')::uuid;
  v_row shift_instances%rowtype;
begin
  select * into v_row from shift_instances where resort_id = v_resort_id and shift_type_id = v_st_no_payroll and date = '2027-01-05';
  perform pg_temp.expect_true('materialisation never requires a shift_base_pay_rules row: staffing still resolves for a shift with zero rate configuration',
    v_row.required_drivers = 3);

  select * into v_row from shift_instances where resort_id = v_resort_id and shift_type_id = v_st_no_rota and date = '2027-01-05';
  perform pg_temp.expect_true('missing rota rule: required_drivers is NULL, not 1', v_row.required_drivers is null);
  perform pg_temp.expect_true('missing rota rule: is_premium is NULL, not false', v_row.is_premium is null);
  perform pg_temp.expect_true('missing rota rule: does not block materialisation (the instance was still created)',
    v_row.id is not null);

  perform pg_temp.expect_true('required_drivers is never 0 anywhere (NULL or a real positive count only)',
    not exists (select 1 from shift_instances where required_drivers = 0));
end $$;

-- ---------------------------------------------------------------------
-- missing_payroll_rule_count is gone from the RPC's return shape entirely
-- (not just always-zero) -- structural proof, same idiom as the OUT-
-- parameter-name checks used throughout this suite. missing_rota_rule_count
-- is retained.
-- ---------------------------------------------------------------------
select pg_temp.expect_true('materialise_shift_instances: missing_payroll_rule_count no longer exists in its return shape',
  not (
    (select proargnames from pg_proc where proname = 'materialise_shift_instances')
    && array['missing_payroll_rule_count']
  ));
select pg_temp.expect_true('materialise_shift_instances: missing_rota_rule_count still exists',
  (
    (select proargnames from pg_proc where proname = 'materialise_shift_instances')
    && array['missing_rota_rule_count']
  ));

-- Source-text guard: materialise_shift_instances must never re-couple
-- itself to either rate table again.
select pg_temp.expect_true('materialise_shift_instances: function body never references shift_base_pay_rules',
  pg_get_functiondef('materialise_shift_instances(uuid, date, date)'::regprocedure) not ilike '%shift_base_pay_rules%');
select pg_temp.expect_true('materialise_shift_instances: function body never references driver_delivery_rates',
  pg_get_functiondef('materialise_shift_instances(uuid, date, date)'::regprocedure) not ilike '%driver_delivery_rates%');

do $$
declare
  v_result record;
begin
  select * into v_result from materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-01-06'::date, '2027-01-06'::date);
  perform pg_temp.expect_true('missing_rota_rule_count counts exactly the shift(s) with no rota rule',
    v_result.missing_rota_rule_count = 1, format('got %s', v_result.missing_rota_rule_count));
end $$;

do $$
declare
  v_first record;
  v_second record;
begin
  select * into v_first from materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-01-01'::date, '2027-01-31'::date);
  select * into v_second from materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-01-01'::date, '2027-01-31'::date);
  perform pg_temp.expect_true('repeated materialisation creates nothing new the second time', v_second.created_count = 0);
  perform pg_temp.expect_true('repeated materialisation reports an identical missing-rota-rule count both times (idempotent)',
    v_first.missing_rota_rule_count = v_second.missing_rota_rule_count);
end $$;

-- ---------------------------------------------------------------------
-- Coverage states: no service / staffing not configured / uncovered /
-- covered, driven purely by required_drivers' nullability + assignment
-- count -- no separate status column.
-- ---------------------------------------------------------------------
select pg_temp.expect_true('coverage: no shift_instance at all for a date = "no service" (not this suite''s concern, verified structurally elsewhere)',
  not exists (select 1 from shift_instances where resort_id = current_setting('dbtest.resort_a')::uuid and shift_type_id = current_setting('dbtest.pr_st_full')::uuid and date = '2026-12-31'));
select pg_temp.expect_true('coverage: "staffing not configured" is exactly required_drivers IS NULL on a real instance',
  exists (select 1 from shift_instances where shift_type_id = current_setting('dbtest.pr_st_no_rota')::uuid and required_drivers is null));
select pg_temp.expect_true('coverage: "uncovered" is a real configured requirement with fewer assignments than required',
  (select required_drivers from shift_instances where shift_type_id = current_setting('dbtest.pr_st_full')::uuid and date = '2027-01-05') > 0);

-- ---------------------------------------------------------------------
-- Security: manager permitted; driver sees nothing from the rota-rule
-- tables exercised in this file (payroll-rate security is covered fully in
-- 90_payroll_rate_foundations.sql, and more broadly in
-- 30_security_rls_audit.sql).
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('rota_rules_default: invisible to a driver session', (select count(*) from rota_rules_default) = 0);
select pg_temp.expect_true('rota_rules_weekday: invisible to a driver session', (select count(*) from rota_rules_weekday) = 0);
select pg_temp.expect_true('rota_rules_date: invisible to a driver session', (select count(*) from rota_rules_date) = 0);
