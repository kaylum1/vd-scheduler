-- Core schema invariants (Stage 2D Checkpoint 3.1).
-- Weekday convention, resort/driver/app_user identity rules, cross-resort
-- composite FKs, stable shift identity, and the immutability/overlap
-- guards established across Stage 2A-2D.

select pg_temp.expect_true('smoke: fixtures produced two distinct resorts',
  current_setting('dbtest.resort_a') <> current_setting('dbtest.resort_b'));

-- ---------------------------------------------------------------------
-- Weekday convention: Monday = 0 .. Sunday = 6 (app_weekday).
-- ---------------------------------------------------------------------
select pg_temp.expect_equal('app_weekday: Monday is 0', app_weekday('2027-01-04'::date), 0::smallint);
select pg_temp.expect_equal('app_weekday: Tuesday is 1', app_weekday('2027-01-05'::date), 1::smallint);
select pg_temp.expect_equal('app_weekday: Wednesday is 2', app_weekday('2027-01-06'::date), 2::smallint);
select pg_temp.expect_equal('app_weekday: Thursday is 3', app_weekday('2027-01-07'::date), 3::smallint);
select pg_temp.expect_equal('app_weekday: Friday is 4', app_weekday('2027-01-08'::date), 4::smallint);
select pg_temp.expect_equal('app_weekday: Saturday is 5', app_weekday('2027-01-09'::date), 5::smallint);
select pg_temp.expect_equal('app_weekday: Sunday is 6', app_weekday('2027-01-10'::date), 6::smallint);

-- ---------------------------------------------------------------------
-- Resort uniqueness.
-- ---------------------------------------------------------------------
select pg_temp.expect_error('resorts: duplicate slug rejected (23505)',
  format('insert into resorts (slug, name, timezone) values (%L, %L, %L)', 'dbtest-a', 'Duplicate', 'Europe/Zurich'),
  '23505');

-- ---------------------------------------------------------------------
-- A driver belongs to exactly one resort, permanently.
-- ---------------------------------------------------------------------
select pg_temp.expect_error('drivers: resort_id cannot be changed after creation (23514)',
  format('update drivers set resort_id = %L where id = %L', current_setting('dbtest.resort_b'), current_setting('dbtest.driver_a_id')),
  '23514');

select pg_temp.expect_true('drivers: no auth_user_id column exists -- app_users is the sole auth<->driver mapping',
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'drivers' and column_name = 'auth_user_id'
  ));

-- ---------------------------------------------------------------------
-- app_users is the sole auth -> driver mapping; at most one login per
-- driver (app_users_driver_id_unique).
-- ---------------------------------------------------------------------
do $$
declare
  v_second_login uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, email) values (v_second_login, 'authenticated', 'authenticated', 'dbtest-second-login@test.local');
  perform pg_temp.expect_error('app_users: at most one login per driver (23505)',
    format('insert into app_users (id, role, driver_id, resort_id, is_active) values (%L, %L, %L, null, true)',
      v_second_login, 'driver', current_setting('dbtest.driver_a_id')),
    '23505');
end $$;

-- ---------------------------------------------------------------------
-- Cross-resort composite FKs make a mismatched driver<->resort pairing
-- impossible at the DB level (driver_onfleet_mappings picked as the
-- representative example of the (driver_id, resort_id) composite-FK
-- pattern reused throughout: availability, rota_assignments, attendance,
-- payroll_adjustments).
-- ---------------------------------------------------------------------
select pg_temp.expect_error('composite FK: driver_onfleet_mappings rejects driver_a paired with resort_b (23503)',
  format('insert into driver_onfleet_mappings (resort_id, driver_id, onfleet_worker_id) values (%L, %L, %L)',
    current_setting('dbtest.resort_b'), current_setting('dbtest.driver_a_id'), 'onfleet-worker-x'),
  '23503');

-- ---------------------------------------------------------------------
-- Stable shift identity: UNIQUE(resort_id, shift_type_id, date). Set up a
-- minimal shift type + template + one materialised instance to exercise it.
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_shift_type_id uuid;
begin
  select shift_type_id into v_shift_type_id from create_shift(
    v_resort_id, 'Core Schema Test Shift', '09:00'::time, '11:00'::time,
    array[0]::smallint[], 1, '2027-02-01'::date, null
  );
  perform set_config('dbtest.core_schema_shift_type', v_shift_type_id::text, false);

  perform materialise_shift_instances(v_resort_id, '2027-02-01'::date, '2027-02-01'::date); -- a Monday
end $$;

select pg_temp.expect_error('shift_instances: UNIQUE(resort_id, shift_type_id, date) rejects a raw duplicate insert (23505)',
  format(
    'insert into shift_instances (resort_id, date, shift_type_id, shift_key, name, sort_order, start_time, end_time, required_drivers, status, origin) ' ||
    'select resort_id, date, shift_type_id, shift_key, name, sort_order, start_time, end_time, required_drivers, ''active'', ''adhoc'' ' ||
    'from shift_instances where resort_id = %L and shift_type_id = %L and date = %L',
    current_setting('dbtest.resort_a'), current_setting('dbtest.core_schema_shift_type'), '2027-02-01'
  ),
  '23505');

-- ---------------------------------------------------------------------
-- shift_instances.date is immutable.
-- ---------------------------------------------------------------------
select pg_temp.expect_error('shift_instances: date is immutable (23514)',
  format('update shift_instances set date = %L where resort_id = %L and shift_type_id = %L and date = %L',
    '2027-02-02', current_setting('dbtest.resort_a'), current_setting('dbtest.core_schema_shift_type'), '2027-02-01'),
  '23514');

-- ---------------------------------------------------------------------
-- shift_templates_no_overlap: no two active versions of the same shift
-- type + weekday may have overlapping effective-date ranges.
-- ---------------------------------------------------------------------
select pg_temp.expect_error('shift_templates: overlapping active periods for the same shift type + weekday rejected (23P01)',
  format(
    'insert into shift_templates (resort_id, shift_type_id, weekday, start_time, end_time, required_drivers, effective_from) values (%L, %L, 0, %L, %L, 1, %L)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.core_schema_shift_type'), '06:00', '07:00', '2027-02-10'
  ),
  '23P01');

-- ---------------------------------------------------------------------
-- shift_types: key and resort_id are immutable after creation.
-- ---------------------------------------------------------------------
select pg_temp.expect_error('shift_types: key is immutable (23514)',
  format('update shift_types set key = %L where id = %L', 'renamed-key', current_setting('dbtest.core_schema_shift_type')),
  '23514');
select pg_temp.expect_error('shift_types: resort_id is immutable (23514)',
  format('update shift_types set resort_id = %L where id = %L', current_setting('dbtest.resort_b'), current_setting('dbtest.core_schema_shift_type')),
  '23514');

-- ---------------------------------------------------------------------
-- shift_types: deactivation blocked while an active template remains
-- (direct table UPDATE, bypassing the deactivate_shift RPC that retires
-- templates first -- proves the guard itself, not just the RPC's order).
-- ---------------------------------------------------------------------
select pg_temp.expect_error('shift_types: direct deactivation blocked while an active template remains (55006)',
  format('update shift_types set is_active = false where id = %L', current_setting('dbtest.core_schema_shift_type')),
  '55006');
