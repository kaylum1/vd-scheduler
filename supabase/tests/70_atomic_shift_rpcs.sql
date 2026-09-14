-- Atomic manager shift-lifecycle RPC invariants (Stage 2D Checkpoint 3):
-- create_shift / revise_shift / deactivate_shift / reactivate_shift.

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_id uuid;
begin
  select shift_type_id into v_id from create_shift(
    v_resort_id, 'Atomic Test Shift', '09:00'::time, '13:00'::time,
    array[0,1,2,3,4,5,6]::smallint[], '2026-06-01'::date, null
  );
  perform set_config('dbtest.atomic_shift_type', v_id::text, false);
end $$;

select pg_temp.expect_true('create_shift(Mon..Sun) creates exactly 7 active templates, all succeed together',
  (select count(*) from shift_templates where shift_type_id = current_setting('dbtest.atomic_shift_type')::uuid and is_active) = 7);

-- ---------------------------------------------------------------------
-- Forced failure means complete rollback -- invalid weekday, empty set.
-- ---------------------------------------------------------------------
select pg_temp.expect_error('create_shift with an out-of-range weekday (9) fails and rolls back atomically (23514)',
  format('select create_shift(%L::uuid, %L, %L::time, %L::time, array[0,9]::smallint[], %L::date, null)',
    current_setting('dbtest.resort_a'), 'Atomic Should Not Exist', '09:00', '13:00', '2026-06-01'),
  '23514');
select pg_temp.expect_true('the failed create_shift left no shift_types row behind (atomic rollback confirmed)',
  not exists (select 1 from shift_types where resort_id = current_setting('dbtest.resort_a')::uuid and name = 'Atomic Should Not Exist'));

select pg_temp.expect_error('create_shift with an empty weekday array is rejected (23514)',
  format('select create_shift(%L::uuid, %L, %L::time, %L::time, array[]::smallint[], %L::date, null)',
    current_setting('dbtest.resort_a'), 'Atomic Empty Weekdays', '09:00', '13:00', '2026-06-01'),
  '23514');

-- ---------------------------------------------------------------------
-- Revise weekdays AND time together, atomically. From a date after the
-- shift's own start, so the pre-change rows are genuine history.
-- ---------------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('dbtest.atomic_shift_type')::uuid;
  v_old_monday shift_templates%rowtype;
begin
  select * into v_old_monday from shift_templates where shift_type_id = v_id and weekday = 0 and is_active;

  perform revise_shift(
    v_id, current_setting('dbtest.resort_a')::uuid, 'Atomic Test Shift', '10:00'::time, '14:00'::time,
    array[0,1,2,3,4,5]::smallint[], '2026-07-01'::date, null
  );

  perform pg_temp.expect_true('revise_shift atomically drops Sunday: exactly 6 active weekdays remain',
    (select count(*) from shift_templates where shift_type_id = v_id and is_active) = 6);
  perform pg_temp.expect_true('the dropped Sunday row is retired (is_active=false, effective_to set), not deleted',
    exists (select 1 from shift_templates where shift_type_id = v_id and weekday = 6 and not is_active and effective_to = '2026-06-30'));
  perform pg_temp.expect_true('revise_shift atomically changes the time on every retained weekday',
    (select count(*) from shift_templates where shift_type_id = v_id and is_active and start_time = '10:00' and end_time = '14:00') = 6);
  perform pg_temp.expect_true('the pre-revision Monday row is retained as unchanged history (old time, old effective_from)',
    exists (select 1 from shift_templates where id = v_old_monday.id and start_time = v_old_monday.start_time
      and end_time = v_old_monday.end_time and effective_from = v_old_monday.effective_from and not is_active
      and effective_to = '2026-06-30'));
  perform pg_temp.expect_true('stable shift_type_id is retained across the revision',
    exists (select 1 from shift_types where id = v_id and name = 'Atomic Test Shift'));
end $$;

-- ---------------------------------------------------------------------
-- Deactivate: ends every active weekday and the shift type, together.
-- ---------------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('dbtest.atomic_shift_type')::uuid;
begin
  perform deactivate_shift(v_id, current_setting('dbtest.resort_a')::uuid, '2026-08-15'::date);

  perform pg_temp.expect_true('deactivate_shift ends every active template (0 remain active)',
    (select count(*) from shift_templates where shift_type_id = v_id and is_active) = 0);
  perform pg_temp.expect_true('deactivate_shift retires templates with effective_to = the requested date',
    (select count(*) from shift_templates where shift_type_id = v_id and effective_to = '2026-08-15') = 6);
  perform pg_temp.expect_true('deactivate_shift marks the shift type itself inactive',
    (select is_active from shift_types where id = v_id) = false);
end $$;

-- ---------------------------------------------------------------------
-- Reactivate: same shift_type_id, brand-new rows, old rows untouched --
-- never resurrects a historical row.
-- ---------------------------------------------------------------------
do $$
declare
  v_id uuid := current_setting('dbtest.atomic_shift_type')::uuid;
  v_old_row_count int;
begin
  select count(*) into v_old_row_count from shift_templates where shift_type_id = v_id;

  perform reactivate_shift(
    v_id, current_setting('dbtest.resort_a')::uuid, '11:00'::time, '15:00'::time,
    array[0,2,4]::smallint[], '2026-09-01'::date, null
  );

  perform pg_temp.expect_true('reactivate_shift marks the shift type active again under the same id',
    (select is_active from shift_types where id = v_id) = true);
  perform pg_temp.expect_true('reactivate_shift creates exactly 3 fresh active templates',
    (select count(*) from shift_templates where shift_type_id = v_id and is_active) = 3);
  perform pg_temp.expect_true('reactivate_shift never flips an old historical row back to active (row count only grew by insertion)',
    (select count(*) from shift_templates where shift_type_id = v_id) = v_old_row_count + 3);
  perform pg_temp.expect_true('every previously-retired row is still retired, untouched',
    (select count(*) from shift_templates where shift_type_id = v_id and not is_active) = v_old_row_count);
end $$;

-- reactivate_shift rejects reactivating an already-active shift.
select pg_temp.expect_error('reactivate_shift rejects a shift that is already active (23514)',
  format('select reactivate_shift(%L::uuid, %L::uuid, %L::time, %L::time, array[0]::smallint[], null, null)',
    current_setting('dbtest.atomic_shift_type'), current_setting('dbtest.resort_a'), '09:00', '10:00'),
  '23514');

-- ---------------------------------------------------------------------
-- Security/audit: driver/anonymous rejected, manager allowed, audited.
-- ---------------------------------------------------------------------
select pg_temp.expect_true('create_shift is audited: an insert row exists for the new shift_types row',
  exists (select 1 from audit_log where table_name = 'shift_types' and row_id = current_setting('dbtest.atomic_shift_type')::uuid and action = 'insert'));
select pg_temp.expect_true('create_shift is audited: insert rows exist for its shift_templates rows',
  exists (select 1 from audit_log where table_name = 'shift_templates' and action = 'insert'
    and (after ->> 'shift_type_id')::uuid = current_setting('dbtest.atomic_shift_type')::uuid));
select pg_temp.expect_true('deactivate_shift is audited: an update row exists for the shift_types row going inactive',
  exists (select 1 from audit_log where table_name = 'shift_types' and row_id = current_setting('dbtest.atomic_shift_type')::uuid
    and action = 'update' and (after ->> 'is_active') = 'false'));

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error('create_shift rejects a driver caller (42501)',
  format('select create_shift(%L::uuid, %L, %L::time, %L::time, array[0]::smallint[], %L::date, null)',
    current_setting('dbtest.resort_a'), 'Driver Should Not Create', '09:00', '10:00', '2026-06-01'),
  '42501');
select pg_temp.expect_error('revise_shift rejects a driver caller (42501)',
  format('select revise_shift(%L::uuid, %L::uuid, %L, %L::time, %L::time, array[0]::smallint[], null, null)',
    current_setting('dbtest.atomic_shift_type'), current_setting('dbtest.resort_a'), 'x', '09:00', '10:00'),
  '42501');
select pg_temp.expect_error('deactivate_shift rejects a driver caller (42501)',
  format('select deactivate_shift(%L::uuid, %L::uuid, null)', current_setting('dbtest.atomic_shift_type'), current_setting('dbtest.resort_a')),
  '42501');
select pg_temp.expect_error('reactivate_shift rejects a driver caller (42501)',
  format('select reactivate_shift(%L::uuid, %L::uuid, %L::time, %L::time, array[0]::smallint[], null, null)',
    current_setting('dbtest.atomic_shift_type'), current_setting('dbtest.resort_a'), '09:00', '10:00'),
  '42501');

select pg_temp.act_as('anon');
select pg_temp.expect_error('create_shift rejects an anonymous caller (42501)',
  format('select create_shift(%L::uuid, %L, %L::time, %L::time, array[0]::smallint[], %L::date, null)',
    current_setting('dbtest.resort_a'), 'Anon Should Not Create', '09:00', '10:00', '2026-06-01'),
  '42501');

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('manager: create_shift/revise_shift/deactivate_shift/reactivate_shift are all callable (exercised above without error)',
  exists (select 1 from shift_types where id = current_setting('dbtest.atomic_shift_type')::uuid and is_active));
