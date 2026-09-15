-- Materialisation / template refresh / cancellation / operational-timezone
-- invariants (Stage 2D Checkpoint 3.1).

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_shift_type_id uuid;
begin
  select shift_type_id into v_shift_type_id from create_shift(
    v_resort_id, 'Materialisation Test Shift', '17:00'::time, '21:00'::time,
    array[0,1,2,3,4,5,6]::smallint[], 1, '2027-07-05'::date, null -- 2027-07-05 is a Monday
  );
  perform set_config('dbtest.mat_shift_type', v_shift_type_id::text, false);
end $$;

-- ---------------------------------------------------------------------
-- Insert-only + idempotent: repeated calls over the same range never
-- modify an existing instance, and create nothing new the second time.
-- ---------------------------------------------------------------------
do $$
declare
  v_first record;
  v_second record;
begin
  select * into v_first from materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-07-05'::date, '2027-07-11'::date);
  perform pg_temp.expect_equal('materialise: creates exactly 7 instances for a full week', v_first.created_count, 7);

  update shift_instances set name = 'Manually Overridden Name' where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-05';

  select * into v_second from materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-07-05'::date, '2027-07-11'::date);
  perform pg_temp.expect_equal('materialise: a repeated call creates nothing new (idempotent)', v_second.created_count, 0);
  perform pg_temp.expect_equal('materialise: a repeated call reports the full set as already-existing', v_second.skipped_existing_count, 7);
  perform pg_temp.expect_true('materialise: insert-only -- a manual edit to an existing instance is never overwritten by a later call',
    (select name from shift_instances where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-05') = 'Manually Overridden Name');
end $$;

-- ---------------------------------------------------------------------
-- Effective template version selection: two sequential versions of the
-- same weekday, correct one picked per date.
-- ---------------------------------------------------------------------
do $$
declare
  v_shift_type_id uuid := current_setting('dbtest.mat_shift_type')::uuid;
begin
  -- Materialise the still-current week FIRST (mirroring reality: shifts
  -- get materialised under whichever template is active at the time),
  -- THEN revise -- a revision retires the old template row (is_active =
  -- false) immediately, so materialising after the fact would find no
  -- active template left to govern the earlier dates at all.
  perform materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-07-12'::date, '2027-07-18'::date);

  -- Revise the Monday slot's time starting 2027-07-19 (a later Monday);
  -- the earlier, already-materialised dates must keep their old time.
  perform revise_shift(
    v_shift_type_id, current_setting('dbtest.resort_a')::uuid, 'Materialisation Test Shift',
    '18:00'::time, '22:00'::time, array[0,1,2,3,4,5,6]::smallint[], 1, '2027-07-19'::date, null
  );
  perform materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-07-19'::date, '2027-07-19'::date);
end $$;
select pg_temp.expect_equal('effective template selection: a date before the revision uses the old time',
  (select start_time from shift_instances where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-12'), '17:00:00'::time);
select pg_temp.expect_equal('effective template selection: a date on/after the revision uses the new time',
  (select start_time from shift_instances where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-19'), '18:00:00'::time);

-- ---------------------------------------------------------------------
-- override/adhoc protection: an 'override' or 'adhoc' origin instance is
-- excluded from the refresh-eligible set even when its governing template
-- has since changed.
-- ---------------------------------------------------------------------
do $$
begin
  update shift_instances set origin = 'override' where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-13';
  update shift_instances set name = 'Adhoc Extra', origin = 'adhoc', template_id = null
  where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-14';
end $$;
select pg_temp.expect_true('override protection: an origin=override instance is excluded from preview_template_refresh',
  not exists (select 1 from preview_template_refresh(current_setting('dbtest.resort_a')::uuid, '2027-07-01'::date)
    where date = '2027-07-13' and shift_type_id = current_setting('dbtest.mat_shift_type')::uuid));
select pg_temp.expect_true('adhoc protection: an origin=adhoc instance is excluded from preview_template_refresh',
  not exists (select 1 from preview_template_refresh(current_setting('dbtest.resort_a')::uuid, '2027-07-01'::date)
    where date = '2027-07-14' and shift_type_id = current_setting('dbtest.mat_shift_type')::uuid));

-- ---------------------------------------------------------------------
-- Published/history/attendance protection: excluded from refresh even
-- though origin=template and a governing template exists.
-- ---------------------------------------------------------------------
do $$
begin
  insert into rota_publications (resort_id, week_start, generation_source)
  values (current_setting('dbtest.resort_a')::uuid, '2027-07-12', 'manual'); -- covers the 2027-07-12 week (Mon 07-12)

  insert into attendance (shift_instance_id, driver_id, resort_id, status)
  select id, current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, 'worked'
  from shift_instances where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-15';
end $$;
select pg_temp.expect_true('published protection: a published week''s instance is excluded from preview_template_refresh',
  not exists (select 1 from preview_template_refresh(current_setting('dbtest.resort_a')::uuid, '2027-07-01'::date)
    where date = '2027-07-12' and shift_type_id = current_setting('dbtest.mat_shift_type')::uuid));
select pg_temp.expect_true('attendance protection: an instance with recorded attendance is excluded from preview_template_refresh',
  not exists (select 1 from preview_template_refresh(current_setting('dbtest.resort_a')::uuid, '2027-07-01'::date)
    where date = '2027-07-15' and shift_type_id = current_setting('dbtest.mat_shift_type')::uuid));

-- ---------------------------------------------------------------------
-- Refresh preview/apply: schedule changes, still applies real schedule
-- changes and still reopens availability on a time change.
-- ---------------------------------------------------------------------
do $$
declare
  v_apply record;
begin
  perform revise_shift(
    current_setting('dbtest.mat_shift_type')::uuid, current_setting('dbtest.resort_a')::uuid, 'Materialisation Renamed',
    '18:00'::time, '22:00'::time, array[0,1,2,3,4,5,6]::smallint[], 1, '2027-07-19'::date, null
  );
  perform pg_temp.expect_true('refresh preview: a name change on the governing template shows up as will_change',
    exists (select 1 from preview_template_refresh(current_setting('dbtest.resort_a')::uuid, '2027-07-19'::date)
      where date = '2027-07-19' and shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and will_change));

  select * into v_apply from apply_template_refresh(current_setting('dbtest.resort_a')::uuid, '2027-07-19'::date);
  perform pg_temp.expect_true('refresh apply: at least one instance was updated', v_apply.updated_count >= 1);
  perform pg_temp.expect_equal('refresh apply: the name is actually applied to the instance',
    (select name from shift_instances where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-19'), 'Materialisation Renamed');
end $$;

-- Time refresh reopens availability (end-to-end, independent of the
-- Checkpoint 3 suite's own coverage of this same invariant).
do $$
declare
  v_shift_id uuid;
  v_apply record;
begin
  -- Only this single day, deliberately -- confirm_availability_week below
  -- requires every shift that week to be answered, and this test only
  -- answers one.
  perform materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-07-26'::date, '2027-07-26'::date);
  select id into v_shift_id from shift_instances where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-26';
  insert into availability (driver_id, resort_id, shift_instance_id, status)
  values (current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, v_shift_id, 'available');
  perform confirm_availability_week(current_setting('dbtest.driver_a_id')::uuid, '2027-07-26'::date); -- 2027-07-26 is a Monday

  -- Only one shift exists for driver_a that week in this fixture, so the
  -- single answer above is enough for confirm to succeed.
  perform pg_temp.expect_true('refresh + availability: week is confirmed before the time change',
    (select submitted_at is not null from availability_submissions where driver_id = current_setting('dbtest.driver_a_id')::uuid and week_start = '2027-07-26'));

  perform revise_shift(
    current_setting('dbtest.mat_shift_type')::uuid, current_setting('dbtest.resort_a')::uuid, 'Materialisation Renamed',
    '19:00'::time, '23:00'::time, array[0,1,2,3,4,5,6]::smallint[], 1, '2027-07-19'::date, null
  );
  select * into v_apply from apply_template_refresh(current_setting('dbtest.resort_a')::uuid, '2027-07-19'::date);
  perform pg_temp.expect_true('refresh + availability: a genuine start_time change reopens the previously-confirmed week',
    v_apply.reopened_submission_count >= 1, format('got %s', v_apply.reopened_submission_count));
end $$;

-- Schedule refresh does not own pay/high-value at all, and never tracks
-- over-assignment (structural). Staffing (required_drivers) IS in scope --
-- see the dedicated staffing-refresh block below -- surfaced through the
-- same generic changed_fields jsonb as name/time, not a dedicated output
-- column, so no new OUT parameter needed for it.
select pg_temp.expect_true('refresh scope: preview_template_refresh has no pay/high-value/over-assignment output columns',
  not exists (
    select 1 from pg_proc where proname = 'preview_template_refresh'
      and (proargnames && array['would_be_overassigned', 'current_base_pay_chf', 'new_base_pay_chf', 'current_is_premium', 'new_is_premium'])
  ));
select pg_temp.expect_true('refresh scope: apply_template_refresh has no overassigned-tracking output columns',
  not exists (
    select 1 from pg_proc where proname = 'apply_template_refresh'
      and (proargnames && array['overassigned_count', 'overassigned_shift_instance_ids'])
  ));

-- ---------------------------------------------------------------------
-- Staffing refresh (Stage 2D staffing simplification): a required_drivers
-- change on the governing Shift shows up in preview, changes nothing until
-- Apply, Apply updates the eligible future instance, and -- critically --
-- a staffing-ONLY change must never reopen already-confirmed availability
-- (only a genuine start/end time change does, per the block above).
-- ---------------------------------------------------------------------
do $$
declare
  v_staffing_shift_type uuid;
  v_apply record;
  v_before_confirmed boolean;
  v_after_confirmed boolean;
begin
  select shift_type_id into v_staffing_shift_type from create_shift(
    current_setting('dbtest.resort_a')::uuid, 'Staffing Refresh Test Shift', '17:00'::time, '21:00'::time,
    array[0]::smallint[], 1, '2027-08-02'::date, null -- 2027-08-02 is a Monday
  );
  perform materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, '2027-08-02'::date, '2027-08-02'::date);

  -- materialise_shift_instances covers every active Shift for the resort,
  -- not just this one (the still-active, open-ended "Materialisation Test
  -- Shift" also recurs on this Monday) -- answer for every shift_instance
  -- in the week so confirm_availability_week actually confirms.
  insert into availability (driver_id, resort_id, shift_instance_id, status)
  select current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, id, 'available'
  from shift_instances where resort_id = current_setting('dbtest.resort_a')::uuid and week_start = '2027-08-02';
  perform confirm_availability_week(current_setting('dbtest.driver_a_id')::uuid, '2027-08-02'::date);

  select submitted_at is not null into v_before_confirmed
  from availability_submissions where driver_id = current_setting('dbtest.driver_a_id')::uuid and week_start = '2027-08-02';
  perform pg_temp.expect_true('staffing refresh: week is confirmed before the staffing change', v_before_confirmed);

  perform revise_shift(
    v_staffing_shift_type, current_setting('dbtest.resort_a')::uuid, 'Staffing Refresh Test Shift',
    '17:00'::time, '21:00'::time, array[0]::smallint[], 2, '2027-08-02'::date, null
  );

  perform pg_temp.expect_true('staffing refresh: nothing changes on the instance before Apply',
    (select required_drivers from shift_instances where shift_type_id = v_staffing_shift_type and date = '2027-08-02') = 1);
  perform pg_temp.expect_true('staffing refresh: preview shows the required_drivers change (1 -> 2)',
    exists (select 1 from preview_template_refresh(current_setting('dbtest.resort_a')::uuid, '2027-08-02'::date)
      where shift_type_id = v_staffing_shift_type and will_change
        and changed_fields -> 'required_drivers' = jsonb_build_object('old', 1, 'new', 2)));

  select * into v_apply from apply_template_refresh(current_setting('dbtest.resort_a')::uuid, '2027-08-02'::date);
  perform pg_temp.expect_true('staffing refresh: Apply updates the instance to the new required_drivers',
    (select required_drivers from shift_instances where shift_type_id = v_staffing_shift_type and date = '2027-08-02') = 2);

  select submitted_at is not null into v_after_confirmed
  from availability_submissions where driver_id = current_setting('dbtest.driver_a_id')::uuid and week_start = '2027-08-02';
  perform pg_temp.expect_true('staffing refresh: a staffing-ONLY change does NOT reopen already-confirmed availability',
    v_after_confirmed, format('reopened_submission_count=%s', v_apply.reopened_submission_count));
  perform pg_temp.expect_equal('staffing refresh: reopened_submission_count is 0 for a staffing-only change', v_apply.reopened_submission_count, 0);
end $$;

-- ---------------------------------------------------------------------
-- Cancellation preview/apply: only the safe subset is ever cancelled.
-- ---------------------------------------------------------------------
do $$
begin
  -- Deactivate the shift entirely; templates end today (an early,
  -- deterministic date) so every future date needs a cancellation decision.
  perform deactivate_shift(current_setting('dbtest.mat_shift_type')::uuid, current_setting('dbtest.resort_a')::uuid, '2027-07-01'::date);
end $$;

select pg_temp.expect_true('cancellation preview: an unpublished, un-attended future instance is safe to cancel',
  (select is_safe_to_cancel from preview_template_cancellation(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.mat_shift_type')::uuid)
   where date = '2027-07-26'));
select pg_temp.expect_true('cancellation preview: a published instance is NOT safe to cancel',
  (select not is_safe_to_cancel from preview_template_cancellation(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.mat_shift_type')::uuid)
   where date = '2027-07-12'));
select pg_temp.expect_true('cancellation preview: an instance with recorded attendance is NOT safe to cancel',
  (select not is_safe_to_cancel from preview_template_cancellation(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.mat_shift_type')::uuid)
   where date = '2027-07-15'));

do $$
declare
  v_result record;
begin
  select * into v_result from apply_template_cancellation(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.mat_shift_type')::uuid, 'test_cancellation');
  perform pg_temp.expect_true('cancellation apply: at least one instance was cancelled', v_result.cancelled_count >= 1);
  perform pg_temp.expect_true('cancellation apply: the published instance was NOT cancelled',
    (select status from shift_instances where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-12') = 'active');
  perform pg_temp.expect_true('cancellation apply: the attended instance was NOT cancelled',
    (select status from shift_instances where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-15') = 'active');
  perform pg_temp.expect_true('cancellation apply: a safe instance WAS cancelled, with reason/actor/timestamp stamped',
    (select status = 'cancelled' and cancelled_reason = 'test_cancellation' and cancelled_by = current_setting('dbtest.manager_id')::uuid and cancelled_at is not null
     from shift_instances where shift_type_id = current_setting('dbtest.mat_shift_type')::uuid and date = '2027-07-26'));
end $$;

-- ---------------------------------------------------------------------
-- Operational timezone / Europe-Zurich / DST: operational_today resolves
-- in the resort's own timezone, and genuinely respects the CET/CEST
-- transition rather than using a fixed offset.
-- ---------------------------------------------------------------------
select pg_temp.expect_equal('operational_today: winter (CET, UTC+1) -- 22:30 UTC is still the same local day',
  operational_today(current_setting('dbtest.resort_a')::uuid, '2027-01-15 22:30:00+00'::timestamptz), '2027-01-15'::date);
select pg_temp.expect_equal('operational_today: winter (CET, UTC+1) -- 23:30 UTC has already rolled to the next local day',
  operational_today(current_setting('dbtest.resort_a')::uuid, '2027-01-15 23:30:00+00'::timestamptz), '2027-01-16'::date);
select pg_temp.expect_equal('operational_today: summer (CEST, UTC+2) -- 21:30 UTC is still the same local day',
  operational_today(current_setting('dbtest.resort_a')::uuid, '2027-07-15 21:30:00+00'::timestamptz), '2027-07-15'::date);
select pg_temp.expect_equal('operational_today: summer (CEST, UTC+2) -- 22:30 UTC has already rolled to the next local day',
  operational_today(current_setting('dbtest.resort_a')::uuid, '2027-07-15 22:30:00+00'::timestamptz), '2027-07-16'::date);
-- The same UTC clock time (22:30) is "still today" in winter (CET, +1h,
-- per the first pair of assertions above) but "already tomorrow" in summer
-- (CEST, +2h, per the second pair) -- together, proof this genuinely
-- resolves via Postgres tzdata/DST, not a fixed numeric offset.
select pg_temp.expect_equal('operational_today: falls back to Europe/Zurich when no resort_id is given',
  operational_today(null, '2027-01-15 22:30:00+00'::timestamptz), '2027-01-15'::date);
