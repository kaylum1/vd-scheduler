-- Assignments / attendance / payroll adjustments invariants
-- (Stage 2D Checkpoint 3.1).

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_shift_type_id uuid;
  v_second_driver_a uuid;
begin
  select shift_type_id into v_shift_type_id from create_shift(
    v_resort_id, 'Assignments Test Shift', '09:00'::time, '13:00'::time,
    array[0]::smallint[], '2027-04-05'::date, null -- 2027-04-05 is a Monday
  );
  -- A real (non-NULL) required_drivers, so the over-assignment assertion
  -- below compares against a genuine configured number.
  insert into rota_rules_default (resort_id, shift_type_id, required_drivers, is_premium, effective_from)
  values (v_resort_id, v_shift_type_id, 1, false, '2027-04-01');
  perform materialise_shift_instances(v_resort_id, '2027-04-05'::date, '2027-04-05'::date);
  perform set_config('dbtest.assign_shift_id',
    (select id::text from shift_instances where shift_type_id = v_shift_type_id and date = '2027-04-05'), false);

  insert into drivers (resort_id, full_name) values (v_resort_id, 'DB Test Driver A2') returning id into v_second_driver_a;
  perform set_config('dbtest.driver_a2_id', v_second_driver_a::text, false);
end $$;

-- ---------------------------------------------------------------------
-- Multiple drivers may work one shift; the same driver twice is rejected.
-- ---------------------------------------------------------------------
do $$
begin
  insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source)
  values (current_setting('dbtest.assign_shift_id')::uuid, current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, 'manual');
  insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source)
  values (current_setting('dbtest.assign_shift_id')::uuid, current_setting('dbtest.driver_a2_id')::uuid, current_setting('dbtest.resort_a')::uuid, 'manual');
end $$;
select pg_temp.expect_true('rota_assignments: two different drivers may share one shift',
  (select count(*) from rota_assignments where shift_instance_id = current_setting('dbtest.assign_shift_id')::uuid) = 2);

select pg_temp.expect_error('rota_assignments: the same driver cannot be assigned to the same shift twice (23505)',
  format('insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source) values (%L, %L, %L, %L)',
    current_setting('dbtest.assign_shift_id'), current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), 'manual'),
  '23505');

select pg_temp.expect_error('rota_assignments: cross-resort driver/shift pairing rejected (23503)',
  format('insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source) values (%L, %L, %L, %L)',
    current_setting('dbtest.assign_shift_id'), current_setting('dbtest.driver_b_id'), current_setting('dbtest.resort_a'), 'manual'),
  '23503');

-- ---------------------------------------------------------------------
-- Under/over-assigned draft state is representable: nothing at the DB
-- level caps assignment count against required_drivers.
-- ---------------------------------------------------------------------
do $$
declare
  v_required int;
  v_assigned int;
begin
  select required_drivers into v_required from shift_instances where id = current_setting('dbtest.assign_shift_id')::uuid;
  select count(*) into v_assigned from rota_assignments where shift_instance_id = current_setting('dbtest.assign_shift_id')::uuid;
  perform pg_temp.expect_true('rota_assignments: an over-assigned shift (assignments > required_drivers) is representable, not blocked',
    v_assigned > v_required, format('required=%s assigned=%s', v_required, v_assigned));
end $$;

-- ---------------------------------------------------------------------
-- Attendance: valid statuses, duplicate rejection, cross-resort rejection.
-- ---------------------------------------------------------------------
do $$
begin
  insert into attendance (shift_instance_id, driver_id, resort_id, status)
  values (current_setting('dbtest.assign_shift_id')::uuid, current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, 'worked');
  insert into attendance (shift_instance_id, driver_id, resort_id, status)
  values (current_setting('dbtest.assign_shift_id')::uuid, current_setting('dbtest.driver_a2_id')::uuid, current_setting('dbtest.resort_a')::uuid, 'no_show');
end $$;
select pg_temp.expect_true('attendance: worked and no_show are both accepted',
  (select count(*) from attendance where shift_instance_id = current_setting('dbtest.assign_shift_id')::uuid) = 2);

select pg_temp.expect_error('attendance: an invalid status value is rejected (23514)',
  format('insert into attendance (shift_instance_id, driver_id, resort_id, status) values (%L, %L, %L, %L)',
    current_setting('dbtest.assign_shift_id'), current_setting('dbtest.driver_b_id'), current_setting('dbtest.resort_b'), 'late'),
  '23514');

select pg_temp.expect_error('attendance: the same driver cannot have two attendance rows for one shift (23505)',
  format('insert into attendance (shift_instance_id, driver_id, resort_id, status) values (%L, %L, %L, %L)',
    current_setting('dbtest.assign_shift_id'), current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), 'excused'),
  '23505');

select pg_temp.expect_error('attendance: cross-resort driver/shift pairing rejected (23503)',
  format('insert into attendance (shift_instance_id, driver_id, resort_id, status) values (%L, %L, %L, %L)',
    current_setting('dbtest.assign_shift_id'), current_setting('dbtest.driver_b_id'), current_setting('dbtest.resort_a'), 'worked'),
  '23503');

-- ---------------------------------------------------------------------
-- Payroll adjustments: valid types, positive amount, void (never delete).
-- ---------------------------------------------------------------------
do $$
declare
  v_id uuid;
begin
  insert into payroll_adjustments (driver_id, resort_id, date, type, amount_chf, description)
  values (current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, '2027-04-05', 'bonus', 20.00, 'test bonus')
  returning id into v_id;
  perform set_config('dbtest.adjustment_id', v_id::text, false);
end $$;
select pg_temp.expect_true('payroll_adjustments: a valid type (bonus) is accepted',
  exists (select 1 from payroll_adjustments where id = current_setting('dbtest.adjustment_id')::uuid));

select pg_temp.expect_error('payroll_adjustments: an invalid type is rejected (23514)',
  format('insert into payroll_adjustments (driver_id, resort_id, date, type, amount_chf) values (%L, %L, %L, %L, %L)',
    current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), '2027-04-05', 'gift', 10.00),
  '23514');

select pg_temp.expect_error('payroll_adjustments: amount_chf must be positive (23514)',
  format('insert into payroll_adjustments (driver_id, resort_id, date, type, amount_chf) values (%L, %L, %L, %L, %L)',
    current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), '2027-04-05', 'bonus', -5.00),
  '23514');
select pg_temp.expect_error('payroll_adjustments: amount_chf of exactly 0 is rejected (23514)',
  format('insert into payroll_adjustments (driver_id, resort_id, date, type, amount_chf) values (%L, %L, %L, %L, %L)',
    current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'), '2027-04-05', 'bonus', 0),
  '23514');

select pg_temp.expect_error('payroll_adjustments: voided_by without voided_at violates the void-consistency check (23514)',
  format('update payroll_adjustments set voided_by = %L where id = %L', current_setting('dbtest.manager_id'), current_setting('dbtest.adjustment_id')),
  '23514');

do $$
begin
  update payroll_adjustments set voided_at = now(), voided_by = current_setting('dbtest.manager_id')::uuid
  where id = current_setting('dbtest.adjustment_id')::uuid;
end $$;
select pg_temp.expect_true('payroll_adjustments: voiding sets voided_at/voided_by without deleting the row (correction = void, never delete)',
  exists (select 1 from payroll_adjustments where id = current_setting('dbtest.adjustment_id')::uuid and voided_at is not null));
