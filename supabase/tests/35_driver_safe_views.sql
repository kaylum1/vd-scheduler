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

  -- Seeded as the database owner: an authenticated manager has no direct
  -- write access to rota_assignments since Manual Rota MR-A (the RPCs are the
  -- only client write path -- see 85_manual_rota_assignments.sql). This file
  -- tests the driver-facing VIEW, not the write path.
  perform pg_temp.as_postgres();
  insert into rota_assignments (shift_instance_id, driver_id, resort_id, assignment_source)
  values (v_shift_instance_id, current_setting('dbtest.driver_a_id')::uuid, v_resort_id, 'manual');
  perform pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
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

-- =====================================================================
-- driver_visible_week_publications (Live Driver My Rota, LD-A).
--
-- The driver-safe publication signal: one row (resort_id, week_start) per
-- CURRENTLY published week of the caller's OWN resort, nothing else. A row
-- means published; no row means not published -- which is exactly what lets
-- Driver My Rota tell "not published yet" from "published, no shifts for me".
-- Drivers no longer have ANY direct read of rota_publications.
--
-- State on entry (seeded above): resort_a / 2027-06-07 is published, and
-- driver_a is assigned to the shift in it. All other weeks below are new.
-- Weeks: 06-07 published (above) | 06-14 draft (no row) | 06-21 retracted |
--        06-28 published, driver_a has NO assignment | 07-05 assignment flows.
-- =====================================================================

-- ----- visibility -----------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('publication view: a driver sees a currently published week of their own resort',
  exists (select 1 from driver_visible_week_publications
          where resort_id = current_setting('dbtest.resort_a')::uuid and week_start = '2027-06-07'));

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_b_user_id')::uuid);
select pg_temp.expect_true('publication view: a driver in ANOTHER resort does not see that week',
  (select count(*) from driver_visible_week_publications) = 0);

select pg_temp.as_postgres();
-- 06-21: published, then retracted (the schema's own unpublish semantics: unpublished_at set).
insert into rota_publications (resort_id, week_start, generation_source, published_at, unpublished_at)
values (current_setting('dbtest.resort_a')::uuid, '2027-06-21', 'manual', now() - interval '1 hour', now());
-- 06-28: published, and driver_a has no assignment in it (the central case this view exists for).
insert into rota_publications (resort_id, week_start, generation_source)
values (current_setting('dbtest.resort_a')::uuid, '2027-06-28', 'manual');
-- Another resort publishes the same week 06-07: neither driver may see the other's.
insert into rota_publications (resort_id, week_start, generation_source)
values (current_setting('dbtest.resort_b')::uuid, '2027-06-07', 'manual');

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('publication view: a draft week (no publication row) is absent',
  not exists (select 1 from driver_visible_week_publications where week_start = '2027-06-14'));
select pg_temp.expect_true('publication view: a retracted (unpublished) week is absent',
  not exists (select 1 from driver_visible_week_publications where week_start = '2027-06-21'));
select pg_temp.expect_true('publication view: two published weeks of the own resort are both visible when queried without a filter',
  (select array_agg(week_start order by week_start) from driver_visible_week_publications)
    = array['2027-06-07', '2027-06-28']::date[]);

-- ----- identity: the session decides, nothing can be supplied ----------
select pg_temp.expect_true('publication view: driver_a sees ONLY their own resort''s weeks (never resort_b''s identical week)',
  (select count(*) from driver_visible_week_publications) = 2
  and (select bool_and(resort_id = current_setting('dbtest.resort_a')::uuid) from driver_visible_week_publications));

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_b_user_id')::uuid);
select pg_temp.expect_true('publication view: driver_b sees ONLY resort_b''s week and cannot inspect resort_a''s publication state',
  (select count(*) from driver_visible_week_publications) = 1
  and (select bool_and(resort_id = current_setting('dbtest.resort_b')::uuid) from driver_visible_week_publications));
-- Asking for resort_a explicitly (the only "input" a client has is a WHERE clause) still returns nothing.
select pg_temp.expect_true('publication view: filtering for another resort''s id returns nothing -- there is no input that can widen the view',
  not exists (select 1 from driver_visible_week_publications where resort_id = current_setting('dbtest.resort_a')::uuid));

-- ----- columns: only what Driver My Rota needs -------------------------
select pg_temp.expect_true('publication view: exposes exactly resort_id and week_start and nothing else',
  (select array_agg(column_name::text order by column_name)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'driver_visible_week_publications')
  = array['resort_id', 'week_start']);
select pg_temp.expect_true('publication view: no publication id / published_by / generation_source / timestamps / manager identity',
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'driver_visible_week_publications'
      and column_name in ('id', 'published_by', 'generation_source', 'published_at', 'unpublished_at', 'created_at', 'updated_at')
  ));
select pg_temp.expect_true('publication view: no assignment / headcount / pay / availability columns',
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'driver_visible_week_publications'
      and column_name in ('driver_id', 'assignment_id', 'required_drivers', 'is_premium', 'base_pay_chf', 'delivery_rate_chf', 'status', 'reason')
  ));

-- ----- anon and direct base-table access --------------------------------
select pg_temp.act_as('anon');
select pg_temp.expect_error('publication view: anon cannot read it (42501)',
  'select count(*) from driver_visible_week_publications', '42501');
select pg_temp.expect_error('publication: anon cannot read rota_publications (42501)',
  'select count(*) from rota_publications', '42501');

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('publication: a driver can no longer read rota_publications directly (zero rows, though their resort has published weeks)',
  (select count(*) from rota_publications) = 0);
select pg_temp.expect_error('publication: a driver cannot write rota_publications either (42501)',
  format('insert into rota_publications (resort_id, week_start, generation_source) values (%L::uuid, %L::date, %L)',
    current_setting('dbtest.resort_a'), '2027-08-02', 'manual'),
  '42501');

-- ----- manager access is unchanged ---------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select pg_temp.expect_true('publication: the manager still reads rota_publications for every resort (draft/retracted/published, all columns)',
  (select count(*) from rota_publications where week_start in ('2027-06-07', '2027-06-21', '2027-06-28')) = 4
  and exists (select 1 from rota_publications where week_start = '2027-06-21' and unpublished_at is not null and generation_source = 'manual'));

-- ----- published, zero own assignments: the case this view exists for -----
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('published week with NO own assignment: the publication row is present while driver_visible_assignments has zero rows for that week',
  exists (select 1 from driver_visible_week_publications where week_start = '2027-06-28')
  and not exists (select 1 from driver_visible_assignments where week_start = '2027-06-28'));

-- ----- unpublished assignment, then publish, then manager edits, then unpublish -----
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
do $$
declare
  v_resort uuid := current_setting('dbtest.resort_a')::uuid;
  v_type_1 uuid;
  v_type_2 uuid;
begin
  -- 2027-07-05 is a Monday (4 weeks after 2027-06-07). Two shifts that day.
  select shift_type_id into v_type_1 from create_shift(v_resort, 'Pub Flow Lunch', '12:00'::time, '14:00'::time, array[0]::smallint[], 1, '2027-07-05'::date, null);
  select shift_type_id into v_type_2 from create_shift(v_resort, 'Pub Flow Dinner', '18:00'::time, '21:30'::time, array[0]::smallint[], 1, '2027-07-05'::date, null);
  perform materialise_shift_instances(v_resort, '2027-07-05'::date, '2027-07-05'::date);
  perform set_config('dbtest.pub_flow_lunch', (select id::text from shift_instances where shift_type_id = v_type_1 and date = '2027-07-05'), false);
  perform set_config('dbtest.pub_flow_dinner', (select id::text from shift_instances where shift_type_id = v_type_2 and date = '2027-07-05'), false);

  -- The week is NOT published yet. Assign driver_a to the lunch through the real RPC.
  perform assign_driver(current_setting('dbtest.pub_flow_lunch')::uuid, current_setting('dbtest.driver_a_id')::uuid, true);
end $$;

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('unpublished week with an assignment: the driver sees NOTHING -- no assignment row and no publication row',
  not exists (select 1 from driver_visible_assignments where week_start = '2027-07-05')
  and not exists (select 1 from driver_visible_week_publications where week_start = '2027-07-05'));

-- Publish it (manager, direct row write -- there is no publish RPC yet).
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
insert into rota_publications (resort_id, week_start, generation_source)
values (current_setting('dbtest.resort_a')::uuid, '2027-07-05', 'manual');

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('after publishing: the own assignment AND the publication row both appear',
  exists (select 1 from driver_visible_assignments where shift_instance_id = current_setting('dbtest.pub_flow_lunch')::uuid)
  and exists (select 1 from driver_visible_week_publications where week_start = '2027-07-05'));

-- Manager edits the PUBLISHED week: add, then remove. No republish.
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select assign_driver(current_setting('dbtest.pub_flow_dinner')::uuid, current_setting('dbtest.driver_a_id')::uuid, true);

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('manager adds an assignment after publication: it shows immediately and the publication row is still present',
  exists (select 1 from driver_visible_assignments where shift_instance_id = current_setting('dbtest.pub_flow_dinner')::uuid)
  and (select count(*) from driver_visible_assignments where week_start = '2027-07-05') = 2
  and exists (select 1 from driver_visible_week_publications where week_start = '2027-07-05'));

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
select unassign_driver(current_setting('dbtest.pub_flow_dinner')::uuid, current_setting('dbtest.driver_a_id')::uuid);

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('manager removes an assignment after publication: it disappears immediately and the publication row remains',
  not exists (select 1 from driver_visible_assignments where shift_instance_id = current_setting('dbtest.pub_flow_dinner')::uuid)
  and exists (select 1 from driver_visible_assignments where shift_instance_id = current_setting('dbtest.pub_flow_lunch')::uuid)
  and exists (select 1 from driver_visible_week_publications where week_start = '2027-07-05'));

-- Unpublish (the existing semantics: unpublished_at set -- there is no unpublish RPC to call).
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
update rota_publications set unpublished_at = now()
 where resort_id = current_setting('dbtest.resort_a')::uuid and week_start = '2027-07-05';

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('after unpublishing: the publication row AND every assignment row disappear for the driver',
  not exists (select 1 from driver_visible_week_publications where week_start = '2027-07-05')
  and not exists (select 1 from driver_visible_assignments where week_start = '2027-07-05'));

-- ----- Driver Availability does not depend on the removed direct access -----
select pg_temp.expect_equal('availability: week_availability_status still reports locked for a published week (driver session, no direct rota_publications read)',
  (select state from week_availability_status(current_setting('dbtest.driver_a_id')::uuid, '2027-06-07'::date)),
  'locked'::week_availability_state);
select pg_temp.expect_true('availability: a draft week is not locked for the driver',
  (select state from week_availability_status(current_setting('dbtest.driver_a_id')::uuid, '2027-06-14'::date)) <> 'locked');
select pg_temp.expect_true('availability: the publication helper behind the driver availability write policies still resolves for a driver session (published true, unpublished false)',
  shift_instance_week_is_published(current_setting('dbtest.safe_view_shift_id')::uuid)
  and not shift_instance_week_is_published(current_setting('dbtest.pub_flow_lunch')::uuid));
