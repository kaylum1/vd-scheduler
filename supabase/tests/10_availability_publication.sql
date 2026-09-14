-- Availability / publication invariants (Stage 2D Checkpoint 3.1).

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- ---------------------------------------------------------------------
-- Fixtures: one shift type operating every day, materialised for one
-- specific Monday-anchored week.
-- ---------------------------------------------------------------------
do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_shift_type_id uuid;
begin
  select shift_type_id into v_shift_type_id from create_shift(
    v_resort_id, 'Availability Test Shift', '17:00'::time, '21:00'::time,
    array[0,1,2,3,4,5,6]::smallint[], '2027-03-01'::date, null
  );
  perform set_config('dbtest.avail_shift_type', v_shift_type_id::text, false);
  -- 2027-03-01 is a Monday.
  perform materialise_shift_instances(v_resort_id, '2027-03-01'::date, '2027-03-07'::date);
  perform set_config('dbtest.avail_week_start', '2027-03-01', false);
end $$;

-- ---------------------------------------------------------------------
-- No availability row = Not Submitted: week_availability_status reports
-- every shift as missing when the driver has answered nothing.
-- ---------------------------------------------------------------------
do $$
declare
  v_status record;
begin
  select * into v_status from week_availability_status(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date);
  perform pg_temp.expect_equal('week_availability_status: 7 shifts scheduled for the week', v_status.total_shifts, 7);
  perform pg_temp.expect_equal('week_availability_status: no answers yet -> answered_count = 0 (no row = Not Submitted)', v_status.answered_count, 0);
  perform pg_temp.expect_equal('week_availability_status: state = incomplete when nothing answered', v_status.state, 'incomplete'::week_availability_state);
end $$;

-- ---------------------------------------------------------------------
-- Available / Unavailable are the only valid statuses.
-- ---------------------------------------------------------------------
do $$
declare
  v_shift_ids uuid[];
begin
  select array_agg(id order by date) into v_shift_ids from shift_instances
  where resort_id = current_setting('dbtest.resort_a')::uuid and shift_type_id = current_setting('dbtest.avail_shift_type')::uuid;
  perform set_config('dbtest.avail_shift_ids', array_to_string(v_shift_ids, ','), false);

  insert into availability (driver_id, resort_id, shift_instance_id, status)
  values (current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, v_shift_ids[1], 'available');
  insert into availability (driver_id, resort_id, shift_instance_id, status)
  values (current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, v_shift_ids[2], 'unavailable');
end $$;
select pg_temp.expect_true('availability: both available/unavailable rows were accepted',
  (select count(*) from availability where driver_id = current_setting('dbtest.driver_a_id')::uuid) = 2);

select pg_temp.expect_error('availability: an invalid status value is rejected (23514)',
  format('insert into availability (driver_id, resort_id, shift_instance_id, status) values (%L, %L, %L, %L)',
    current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_a'),
    (string_to_array(current_setting('dbtest.avail_shift_ids'), ','))[3], 'maybe'),
  '23514');

-- ---------------------------------------------------------------------
-- Cross-resort availability rejected: driver_a (resort_a) cannot answer
-- for a resort_b shift, and vice versa (the composite FK requires both
-- driver_id and resort_id to agree with the same drivers row).
-- ---------------------------------------------------------------------
select pg_temp.expect_error('availability: cross-resort driver/shift pairing rejected (23503)',
  format('insert into availability (driver_id, resort_id, shift_instance_id, status) values (%L, %L, %L, %L)',
    current_setting('dbtest.driver_a_id'), current_setting('dbtest.resort_b'),
    (string_to_array(current_setting('dbtest.avail_shift_ids'), ','))[3], 'available'),
  '23503');

-- ---------------------------------------------------------------------
-- Confirm Week: incomplete while unanswered shifts remain, complete once
-- every current active shift has an answer.
-- ---------------------------------------------------------------------
do $$
declare
  v_ids uuid[] := string_to_array(current_setting('dbtest.avail_shift_ids'), ',')::uuid[];
  v_result record;
  v_i int;
begin
  select * into v_result from confirm_availability_week(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date);
  perform pg_temp.expect_equal('confirm_availability_week: incomplete while unanswered shifts remain', v_result.result, 'incomplete'::confirm_week_result);

  for v_i in 3..7 loop
    insert into availability (driver_id, resort_id, shift_instance_id, status)
    values (current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, v_ids[v_i], 'available');
  end loop;

  select * into v_result from confirm_availability_week(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date);
  perform pg_temp.expect_equal('confirm_availability_week: confirmed once every shift is answered', v_result.result, 'confirmed'::confirm_week_result);
  perform pg_temp.expect_true('confirm_availability_week: submitted_at is stamped on confirmation', v_result.submitted_at is not null);
end $$;

-- ---------------------------------------------------------------------
-- Reopen: clears submitted_at, preserves the driver's answers.
-- ---------------------------------------------------------------------
do $$
declare
  v_result record;
  v_answer_count_before int;
  v_answer_count_after int;
begin
  select count(*) into v_answer_count_before from availability where driver_id = current_setting('dbtest.driver_a_id')::uuid;

  select * into v_result from reopen_availability_week(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date);
  perform pg_temp.expect_equal('reopen_availability_week: result = reopened', v_result.result, 'reopened'::reopen_week_result);
  perform pg_temp.expect_true('reopen_availability_week: reopened_at is stamped', v_result.reopened_at is not null);

  select count(*) into v_answer_count_after from availability where driver_id = current_setting('dbtest.driver_a_id')::uuid;
  perform pg_temp.expect_equal('reopen_availability_week: existing answers are untouched', v_answer_count_after, v_answer_count_before);

  -- Re-confirm so the remaining tests in this file see a normal confirmed state again.
  perform confirm_availability_week(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date);
end $$;

-- ---------------------------------------------------------------------
-- Stale confirmation invalidation: shift added, shift reinstated, shift
-- time changed all reopen a confirmed week; pay/staffing/high-value
-- changes do not.
-- ---------------------------------------------------------------------
do $$
declare
  v_extra_shift_type_id uuid;
begin
  -- A second shift type, unmaterialised, purely so an adhoc instance can be
  -- inserted for a date the first shift type already occupies (the unique
  -- identity is (resort_id, shift_type_id, date), so this needs its own
  -- shift_type_id, not a duplicate of the already-materialised one).
  select shift_type_id into v_extra_shift_type_id from create_shift(
    current_setting('dbtest.resort_a')::uuid, 'Availability Test Extra Shift', '12:00'::time, '13:00'::time,
    array[2]::smallint[], '2027-03-01'::date, null
  );
  perform set_config('dbtest.avail_extra_shift_type', v_extra_shift_type_id::text, false);

  -- shift_added: inserting a new active instance for the same resort/week
  -- reopens the confirmation.
  insert into shift_instances (resort_id, date, shift_type_id, shift_key, name, sort_order, start_time, end_time, status, origin)
  select resort_id, '2027-03-03', v_extra_shift_type_id, shift_key || '_extra', name, sort_order, start_time, end_time, 'active', 'adhoc'
  from shift_instances where shift_type_id = current_setting('dbtest.avail_shift_type')::uuid and date = '2027-03-01';

  perform pg_temp.expect_true('stale confirmation: adding a new active shift reopens the week (shift_added)',
    (select submitted_at is null and reopened_reason = 'shift_added'
     from availability_submissions where driver_id = current_setting('dbtest.driver_a_id')::uuid and week_start = current_setting('dbtest.avail_week_start')::date));

  perform confirm_availability_week(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date);
  -- The new adhoc shift has no answer yet, so this recomputes to
  -- 'incomplete' rather than actually confirming -- reflecting reality
  -- rather than fabricating a submission with a genuinely missing answer.
  perform pg_temp.expect_true('stale confirmation: the newly added shift is not silently pre-answered',
    (select answered_count < total_shifts from week_availability_status(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date)));
end $$;

-- Answer the extra shift and re-confirm, then test time-change reopening.
do $$
begin
  insert into availability (driver_id, resort_id, shift_instance_id, status)
  select current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, id, 'available'
  from shift_instances where shift_type_id = current_setting('dbtest.avail_extra_shift_type')::uuid and date = '2027-03-03' and origin = 'adhoc';

  perform confirm_availability_week(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date);
  perform pg_temp.expect_true('stale confirmation: week is confirmed again before the time-change test',
    (select submitted_at is not null from availability_submissions where driver_id = current_setting('dbtest.driver_a_id')::uuid and week_start = current_setting('dbtest.avail_week_start')::date));

  update shift_instances set start_time = '18:00' where shift_type_id = current_setting('dbtest.avail_shift_type')::uuid and date = '2027-03-01';
  perform pg_temp.expect_true('stale confirmation: a start_time change reopens the week (shift_time_changed)',
    (select submitted_at is null and reopened_reason = 'shift_time_changed'
     from availability_submissions where driver_id = current_setting('dbtest.driver_a_id')::uuid and week_start = current_setting('dbtest.avail_week_start')::date));

  perform confirm_availability_week(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date);
end $$;

-- shift_reinstated: cancel then reactivate an instance.
do $$
declare
  v_id uuid;
begin
  select id into v_id from shift_instances where shift_type_id = current_setting('dbtest.avail_extra_shift_type')::uuid and date = '2027-03-03' and origin = 'adhoc';
  update shift_instances set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'test' where id = v_id;

  perform pg_temp.expect_true('stale confirmation: cancelling a shift does NOT reopen the week (it can only reduce required answers)',
    (select submitted_at is not null from availability_submissions where driver_id = current_setting('dbtest.driver_a_id')::uuid and week_start = current_setting('dbtest.avail_week_start')::date));

  update shift_instances set status = 'active', cancelled_at = null, cancelled_reason = null, cancelled_by = null where id = v_id;

  perform pg_temp.expect_true('stale confirmation: reinstating a cancelled shift reopens the week (shift_reinstated)',
    (select submitted_at is null and reopened_reason = 'shift_reinstated'
     from availability_submissions where driver_id = current_setting('dbtest.driver_a_id')::uuid and week_start = current_setting('dbtest.avail_week_start')::date));

  perform confirm_availability_week(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date);
end $$;

-- pay/staffing/high-value changes do not reopen availability.
do $$
declare
  v_id uuid;
begin
  select id into v_id from shift_instances where shift_type_id = current_setting('dbtest.avail_shift_type')::uuid and date = '2027-03-01';
  update shift_instances set required_drivers = 5, base_pay_chf = 999, delivery_rate_chf = 50, is_premium = true where id = v_id;

  perform pg_temp.expect_true('stale confirmation: pay/staffing/high-value changes do NOT reopen the week',
    (select submitted_at is not null from availability_submissions where driver_id = current_setting('dbtest.driver_a_id')::uuid and week_start = current_setting('dbtest.avail_week_start')::date));
end $$;

-- ---------------------------------------------------------------------
-- Publication locks driver edits (resort-specific).
-- ---------------------------------------------------------------------
select pg_temp.as_postgres();
insert into rota_publications (resort_id, week_start, generation_source)
values (current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.avail_week_start')::date, 'manual');

-- Resolve the shift id as manager first (a driver has no SELECT grant on
-- the shift_instances base table at all -- it isn't RLS-filtered to zero
-- rows, it's simply not queryable directly).
do $$
declare
  v_shift_id uuid;
begin
  select id into v_shift_id from shift_instances where shift_type_id = current_setting('dbtest.avail_shift_type')::uuid and date = '2027-03-01';
  perform set_config('dbtest.avail_published_shift_id', v_shift_id::text, false);
end $$;

select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
do $$
declare
  v_before text;
  v_after text;
begin
  select status into v_before from availability
  where driver_id = current_setting('dbtest.driver_a_id')::uuid and shift_instance_id = current_setting('dbtest.avail_published_shift_id')::uuid;

  -- RLS on UPDATE filters rows via its USING clause rather than raising --
  -- a driver's write to a published week's availability silently matches
  -- zero rows (see availability_driver_update_own_unpublished), so the
  -- correct assertion is "nothing changed", not "an error was raised".
  update availability set status = 'unavailable'
  where driver_id = current_setting('dbtest.driver_a_id')::uuid and shift_instance_id = current_setting('dbtest.avail_published_shift_id')::uuid;

  select status into v_after from availability
  where driver_id = current_setting('dbtest.driver_a_id')::uuid and shift_instance_id = current_setting('dbtest.avail_published_shift_id')::uuid;

  perform pg_temp.expect_true('publication: a driver''s write to availability for a published week is silently blocked by RLS (row unchanged)',
    v_before = v_after and v_after = 'available', format('before=%s after=%s', v_before, v_after));
end $$;

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);
do $$
declare
  v_status record;
begin
  select * into v_status from week_availability_status(current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.avail_week_start')::date);
  perform pg_temp.expect_equal('publication: week_availability_status reports locked once published', v_status.state, 'locked'::week_availability_state);
end $$;

-- resort-specific: publishing resort_a's week does not lock resort_b.
do $$
declare
  v_status record;
begin
  select * into v_status from week_availability_status(current_setting('dbtest.driver_b_id')::uuid, current_setting('dbtest.avail_week_start')::date);
  perform pg_temp.expect_true('publication: publishing resort_a does not lock resort_b''s same-dated week',
    v_status.state <> 'locked');
end $$;

-- ---------------------------------------------------------------------
-- week_availability_status remains authoritative: a second, unpublished
-- week for a resort with real active shifts. We use a fresh week (no
-- confirm_availability_week call at all -- it would refuse to write
-- submitted_at while a shift is unanswered) and instead force
-- availability_submissions.submitted_at directly, bypassing the RPC, the
-- way a stale/corrupted row might look. week_availability_status must
-- still report incomplete: it is never allowed to trust that value.
-- ---------------------------------------------------------------------
do $$
declare
  v_second_week date := '2027-03-08'; -- the following Monday
  v_status record;
begin
  perform materialise_shift_instances(current_setting('dbtest.resort_a')::uuid, v_second_week, v_second_week + 6);

  perform pg_temp.as_postgres();
  insert into availability_submissions (driver_id, resort_id, week_start, submitted_at, shift_count_at_submission)
  values (current_setting('dbtest.driver_a_id')::uuid, current_setting('dbtest.resort_a')::uuid, v_second_week, now(), 7)
  on conflict (driver_id, week_start) do update set submitted_at = excluded.submitted_at;
  perform pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

  select * into v_status from week_availability_status(current_setting('dbtest.driver_a_id')::uuid, v_second_week);
  perform pg_temp.expect_equal('week_availability_status: never trusts a forced submitted_at -- still incomplete with 0 real answers',
    v_status.state, 'incomplete'::week_availability_state);
  perform pg_temp.expect_equal('week_availability_status: answered_count is recomputed from real availability rows, not the forced submission',
    v_status.answered_count, 0);
end $$;
