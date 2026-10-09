-- Shift staffing invariants (Stage 2D staffing simplification).
--
-- Replaces the old rota_rules_default/weekday/date precedence suite --
-- that manager-facing "Rota Rules" system was abandoned before any UI/
-- repository/RPC was ever built against it (only raw-SQL test/fixture
-- inserts existed anywhere in this codebase), in favour of a single
-- decision: `required_drivers` lives directly on the Shift
-- (`shift_templates`), mandatory at creation time, exactly like
-- start_time/end_time already do. A different staffing period for the same
-- service is simply a separately-named Shift (e.g. "Dinner (1P)" vs
-- "Dinner (2P)"), never an override/precedence rule.
--
-- Payroll (shift_base_pay_rules/driver_delivery_rates) is independent of
-- staffing and is exercised separately in 90_payroll_rate_foundations.sql /
-- 95_payroll_rate_rpcs.sql / 97_payroll_rate_corrections.sql.
--
-- All dates anchored to a fixed 2027 calendar so the suite is deterministic
-- regardless of when it runs. 2027-01-04 is a Monday (app_weekday
-- Monday=0..Sunday=6).

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- ---------------------------------------------------------------------
-- create_shift requires required_drivers (>= 1); no schema default, never
-- silently coalesced to 1.
-- ---------------------------------------------------------------------
select pg_temp.expect_error('create_shift: required_drivers = 0 is rejected (23514)',
  format('select create_shift(%L::uuid, %L, %L::time, %L::time, array[0]::smallint[], 0, %L::date, null)',
    current_setting('dbtest.resort_a'), 'Staffing Zero Drivers', '17:00', '21:00', '2027-01-01'),
  '23514');
select pg_temp.expect_error('create_shift: a negative required_drivers is rejected (23514)',
  format('select create_shift(%L::uuid, %L, %L::time, %L::time, array[0]::smallint[], -1, %L::date, null)',
    current_setting('dbtest.resort_a'), 'Staffing Negative Drivers', '17:00', '21:00', '2027-01-01'),
  '23514');
select pg_temp.expect_error('create_shift: a NULL required_drivers is rejected (23514)',
  format('select create_shift(%L::uuid, %L, %L::time, %L::time, array[0]::smallint[], null, %L::date, null)',
    current_setting('dbtest.resort_a'), 'Staffing Null Drivers', '17:00', '21:00', '2027-01-01'),
  '23514');

-- ---------------------------------------------------------------------
-- Two separately-named Shifts with genuinely different staffing may share
-- the same time/weekday/date range with no overlap conflict at all --
-- shift_templates_no_overlap is scoped per shift_type_id, and staffing is
-- never part of that identity. This is the product's own "Dinner (1P)" /
-- "Dinner (2P)" pattern, never parsed from the name.
-- ---------------------------------------------------------------------
do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_1p uuid;
  v_2p uuid;
begin
  select shift_type_id into v_1p from create_shift(
    v_resort_id, 'Dinner (1P)', '18:00'::time, '21:30'::time,
    array[0,1,2,3,4,5,6]::smallint[], 1, '2027-01-01'::date, '2027-01-15'::date
  );
  perform set_config('dbtest.staffing_1p', v_1p::text, false);

  select shift_type_id into v_2p from create_shift(
    v_resort_id, 'Dinner (2P)', '18:00'::time, '21:30'::time,
    array[0,1,2,3,4,5,6]::smallint[], 2, '2027-01-16'::date, '2027-01-31'::date
  );
  perform set_config('dbtest.staffing_2p', v_2p::text, false);
end $$;

select pg_temp.expect_true('two separately-named Shifts with identical times and different staffing both exist -- no overlap conflict',
  (select count(*) from shift_types where id in (current_setting('dbtest.staffing_1p')::uuid, current_setting('dbtest.staffing_2p')::uuid)) = 2);

-- ---------------------------------------------------------------------
-- Materialisation reads required_drivers directly off shift_templates --
-- no join, no precedence, never NULL.
-- ---------------------------------------------------------------------
select materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-01-01'::date, '2027-01-31'::date);

select pg_temp.expect_true('materialisation: the "Dinner (1P)" Shift materialises with required_drivers = 1',
  (select required_drivers from shift_instances where shift_type_id = current_setting('dbtest.staffing_1p')::uuid and date = '2027-01-04') = 1);
select pg_temp.expect_true('materialisation: the "Dinner (2P)" Shift materialises with required_drivers = 2',
  (select required_drivers from shift_instances where shift_type_id = current_setting('dbtest.staffing_2p')::uuid and date = '2027-01-18') = 2);
select pg_temp.expect_true('required_drivers is never NULL on a materialised instance any more (mandatory at Shift-creation time)',
  not exists (select 1 from shift_instances where shift_type_id in (current_setting('dbtest.staffing_1p')::uuid, current_setting('dbtest.staffing_2p')::uuid) and required_drivers is null));
select pg_temp.expect_true('required_drivers is never 0 anywhere (a real positive count only)',
  not exists (select 1 from shift_instances where required_drivers = 0));

do $$
declare
  v_first record;
  v_second record;
begin
  select * into v_first from materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-01-01'::date, '2027-01-31'::date);
  select * into v_second from materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-01-01'::date, '2027-01-31'::date);
  perform pg_temp.expect_true('repeated materialisation creates nothing new the second time (idempotent)', v_second.created_count = 0);
end $$;

-- missing_rota_rule_count/missing_payroll_rule_count are both gone from the
-- RPC's return shape entirely -- structural proof. Staffing can never be
-- "missing" on a materialised instance any more (required_drivers is
-- mandatory at Shift-creation time).
select pg_temp.expect_true('materialise_shift_instances: missing_rota_rule_count no longer exists in its return shape',
  not (
    (select proargnames from pg_proc where proname = 'materialise_shift_instances')
    && array['missing_rota_rule_count']
  ));
select pg_temp.expect_true('materialise_shift_instances: missing_payroll_rule_count no longer exists in its return shape',
  not (
    (select proargnames from pg_proc where proname = 'materialise_shift_instances')
    && array['missing_payroll_rule_count']
  ));

-- Source-text guard: materialise_shift_instances must never re-couple
-- itself to a rota-rule table again.
select pg_temp.expect_true('materialise_shift_instances: function body never references rota_rules_default/weekday/date',
  pg_get_functiondef('materialise_shift_instances(uuid, date, date)'::regprocedure) not ilike '%rota_rules_%');
select pg_temp.expect_true('materialise_shift_instances: function body never references shift_base_pay_rules',
  pg_get_functiondef('materialise_shift_instances(uuid, date, date)'::regprocedure) not ilike '%shift_base_pay_rules%');
select pg_temp.expect_true('materialise_shift_instances: function body never references driver_delivery_rates',
  pg_get_functiondef('materialise_shift_instances(uuid, date, date)'::regprocedure) not ilike '%driver_delivery_rates%');

-- ---------------------------------------------------------------------
-- Revise: staffing can change through the same versioned Shift history as
-- schedule changes -- the old period keeps its old required_drivers,
-- never rewritten; the new period owns the new value. No fake "staffing
-- override" row is ever created.
-- ---------------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('dbtest.staffing_1p')::uuid;
  v_old shift_templates%rowtype;
begin
  select * into v_old from shift_templates where shift_type_id = v_id and weekday = 0 and is_active;

  perform revise_shift(
    v_id, current_setting('dbtest.resort_a')::uuid, 'Dinner (1P)', '18:00'::time, '21:30'::time,
    array[0,1,2,3,4,5,6]::smallint[], 3, '2027-02-01'::date, null
  );

  perform pg_temp.expect_true('revise_shift: the pre-revision period keeps its OLD required_drivers, retired but unchanged',
    exists (select 1 from shift_templates where id = v_old.id and required_drivers = 1 and not is_active and effective_to = '2027-01-31'));
  perform pg_temp.expect_true('revise_shift: the new period owns the NEW required_drivers',
    not exists (select 1 from shift_templates where shift_type_id = v_id and is_active and required_drivers <> 3));
end $$;

-- ---------------------------------------------------------------------
-- Reactivate requires (and preserves) an explicit staffing requirement.
-- ---------------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('dbtest.staffing_2p')::uuid;
begin
  perform deactivate_shift(v_id, current_setting('dbtest.resort_a')::uuid, '2027-02-01'::date);

  perform pg_temp.expect_error('reactivate_shift: required_drivers = 0 is rejected (23514)',
    format('select reactivate_shift(%L::uuid, %L::uuid, %L::time, %L::time, array[0]::smallint[], 0, null, null)',
      v_id, current_setting('dbtest.resort_a'), '18:00', '21:30'),
    '23514');

  perform reactivate_shift(
    v_id, current_setting('dbtest.resort_a')::uuid, '18:00'::time, '21:30'::time,
    array[0]::smallint[], 4, '2027-02-15'::date, null
  );
  perform pg_temp.expect_true('reactivate_shift: the reactivated Shift carries the explicit new required_drivers',
    (select required_drivers from shift_templates where shift_type_id = v_id and is_active) = 4);
end $$;

-- ---------------------------------------------------------------------
-- Coverage states: only three, ever -- no service / uncovered / covered.
-- "Staffing not configured" no longer exists as a normal state because
-- required_drivers is mandatory at Shift-creation time.
-- ---------------------------------------------------------------------
select pg_temp.expect_true('coverage: no shift_instance at all for a date = "no service" (not this suite''s concern, verified structurally elsewhere)',
  not exists (select 1 from shift_instances where resort_id = current_setting('dbtest.resort_a')::uuid and shift_type_id = current_setting('dbtest.staffing_1p')::uuid and date = '2026-12-31'));
select pg_temp.expect_true('coverage: "uncovered" is a real configured requirement with fewer assignments than required',
  (select required_drivers from shift_instances where shift_type_id = current_setting('dbtest.staffing_1p')::uuid and date = '2027-01-04') > 0);

-- ---------------------------------------------------------------------
-- Security: manager permitted (exercised throughout this file); driver
-- sees nothing from shift_templates at all (base table -- broader coverage
-- in 30_security_rls_audit.sql).
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('shift_templates: invisible to a driver session', (select count(*) from shift_templates) = 0);
