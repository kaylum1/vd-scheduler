-- Driver-safe view invariants (Stage 2D Checkpoint 3.1).
-- driver_visible_shifts / driver_visible_assignments are the ONLY way a
-- driver session can see shift/rota data at all -- these are security
-- boundaries, tested accordingly.

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_shift_type_id uuid;
  v_shift_instance_id uuid;
begin
  select shift_type_id into v_shift_type_id from create_shift(
    v_resort_id, 'Safe View Test Shift', '17:00'::time, '21:00'::time,
    array[0]::smallint[], 1, '2027-06-07'::date, null -- 2027-06-07 is a Monday
  );
  perform materialise_shift_instances(v_resort_id, '2027-06-07'::date, '2027-06-07'::date);

  select id into v_shift_instance_id from shift_instances where shift_type_id = v_shift_type_id and date = '2027-06-07';
  perform set_config('dbtest.safe_view_shift_id', v_shift_instance_id::text, false);
  perform set_config('dbtest.safe_view_shift_type', v_shift_type_id::text, false);
  perform set_config('dbtest.safe_view_week_start', '2027-06-07', false);

  insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source)
  values (v_shift_instance_id, current_setting('dbtest.driver_a_id')::uuid, v_resort_id, 'manual');
end $$;

-- ---------------------------------------------------------------------
-- driver_visible_shifts: never exposes pay/premium/headcount/internal
-- config columns (structural), and only shows the driver's own resort.
-- ---------------------------------------------------------------------
-- base_pay_chf/delivery_rate_chf are no longer even columns on
-- shift_instances (Stage 2D Payroll Checkpoint A) -- checking for their
-- absence from this view too would be vacuous; see 60_shift_staffing.sql
-- for that structural proof directly.
select pg_temp.expect_true('driver_visible_shifts: no premium/headcount/internal columns exist on the view at all',
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'driver_visible_shifts'
      and column_name in ('is_premium', 'required_drivers', 'template_id', 'origin', 'cancelled_reason', 'cancelled_by')
  ));

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('driver_visible_shifts: driver_a sees the shift in their own resort',
  exists (select 1 from driver_visible_shifts where id = current_setting('dbtest.safe_view_shift_id')::uuid));

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_b_user_id')::uuid);
select pg_temp.expect_true('driver_visible_shifts: driver_b (a different resort) does NOT see resort_a''s shift',
  not exists (select 1 from driver_visible_shifts where id = current_setting('dbtest.safe_view_shift_id')::uuid));

-- ---------------------------------------------------------------------
-- driver_visible_assignments: only the calling driver's own assignments,
-- only published weeks, no colleague identities exposed (no driver_id
-- column on the view at all).
-- ---------------------------------------------------------------------
select pg_temp.expect_true('driver_visible_assignments: no driver_id/colleague-identifying column exists on the view at all',
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'driver_visible_assignments'
      and column_name in ('driver_id', 'full_name', 'assigned_by')
  ));

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('driver_visible_assignments: an unpublished assignment does not appear yet, even for the assigned driver',
  not exists (select 1 from driver_visible_assignments where shift_instance_id = current_setting('dbtest.safe_view_shift_id')::uuid));

select pg_temp.as_postgres();
insert into rota_publications (resort_id, week_start, generation_source)
values (current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.safe_view_week_start')::date, 'manual');

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('driver_visible_assignments: the assigned driver sees their own assignment once the week is published',
  exists (select 1 from driver_visible_assignments where shift_instance_id = current_setting('dbtest.safe_view_shift_id')::uuid));

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_b_user_id')::uuid);
select pg_temp.expect_true('driver_visible_assignments: a different driver (not assigned) sees nothing for this shift -- no colleague visibility',
  not exists (select 1 from driver_visible_assignments where shift_instance_id = current_setting('dbtest.safe_view_shift_id')::uuid));

-- Also confirm zero rows overall for driver_b on this resort's assignments
-- (driver_b belongs to resort_b and was never assigned anything here).
select pg_temp.expect_true('driver_visible_assignments: driver_b has zero visible assignments in resort_a',
  (select count(*) from driver_visible_assignments) = 0);
