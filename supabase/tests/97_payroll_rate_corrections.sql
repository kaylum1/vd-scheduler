-- correct_shift_base_pay_rate / correct_driver_delivery_rate invariants
-- (Stage 2D Payroll Checkpoint B.1). Like 95_payroll_rate_rpcs.sql, these
-- RPCs' business logic reads the resort's real operational "today", so
-- same-day scenarios below use current_date-relative arithmetic rather
-- than the suite's usual fixed 2027 calendar. Precedent: docs/db-testing.md.

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_id uuid;
begin
  select shift_type_id into v_id from create_shift(
    current_setting('dbtest.resort_a')::uuid, 'Correction RPC Shift', '18:00'::time, '21:30'::time,
    array[3]::smallint[], (current_date - 90)::date, null
  );
  perform set_config('dbtest.corr_shift_type', v_id::text, false);
end $$;

-- =======================================================================
-- CORRECT_SHIFT_BASE_PAY_RATE
-- =======================================================================

-- Same-day correction: set today, immediately correct -- same row, same
-- effective_from, no new row created.
do $$
declare
  v_set record;
  v_corrected record;
  v_row_count integer;
begin
  select * into v_set from set_shift_base_pay_rate(current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.corr_shift_type')::uuid, 13.00);
  select * into v_corrected from correct_shift_base_pay_rate(
    current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.corr_shift_type')::uuid, v_set.rule_id, 12.00
  );
  perform pg_temp.expect_true('correct_shift_base_pay_rate: a same-day correction succeeds',
    v_corrected.rule_id = v_set.rule_id and v_corrected.base_pay_chf = 12.00);
  perform pg_temp.expect_true('correct_shift_base_pay_rate: effective_from/effective_to are preserved exactly (never touched)',
    v_corrected.effective_from = v_set.effective_from and v_corrected.effective_to is null);

  select count(*) into v_row_count from shift_base_pay_rules where shift_type_id = current_setting('dbtest.corr_shift_type')::uuid;
  perform pg_temp.expect_true('correct_shift_base_pay_rate: no new row was created -- the same row was updated in place',
    v_row_count = 1, format('got %s row(s)', v_row_count));
end $$;

-- A future scheduled rule can be corrected before it ever takes effect --
-- the current, already-real rule stays completely untouched.
do $$
declare
  v_scheduled record;
  v_corrected record;
  v_current_before numeric;
  v_current_after numeric;
begin
  select * into v_scheduled from set_shift_base_pay_rate(
    current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.corr_shift_type')::uuid, 14.00, (current_date + 30)::date
  );
  select base_pay_chf into v_current_before from shift_base_pay_rules
    where shift_type_id = current_setting('dbtest.corr_shift_type')::uuid and effective_to is not null;

  select * into v_corrected from correct_shift_base_pay_rate(
    current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.corr_shift_type')::uuid, v_scheduled.rule_id, 15.00
  );

  select base_pay_chf into v_current_after from shift_base_pay_rules
    where shift_type_id = current_setting('dbtest.corr_shift_type')::uuid and effective_to is not null;

  perform pg_temp.expect_true('correct_shift_base_pay_rate: a scheduled future rule can be corrected safely',
    v_corrected.rule_id = v_scheduled.rule_id and v_corrected.base_pay_chf = 15.00 and v_corrected.effective_from = v_scheduled.effective_from);
  perform pg_temp.expect_true('correct_shift_base_pay_rate: correcting the scheduled rule never touches the current (already-real) rule',
    v_current_before = v_current_after and v_current_before = 12.00);
end $$;

-- Overlap invariants remain intact: still exactly two rows for this shift
-- (the corrected current + the corrected scheduled), no stray extras, and
-- the exclusion constraint still holds across them.
select pg_temp.expect_true('correct_shift_base_pay_rate: overlap invariants remain intact -- exactly two periods exist, non-overlapping',
  (select count(*) from shift_base_pay_rules where shift_type_id = current_setting('dbtest.corr_shift_type')::uuid) = 2);

-- Attempting to correct an already-CLOSED historical period is rejected --
-- this is genuine history now, out of scope for correction.
do $$
declare
  v_closed_id uuid;
begin
  select id into v_closed_id from shift_base_pay_rules
    where shift_type_id = current_setting('dbtest.corr_shift_type')::uuid and effective_to is not null;
  perform pg_temp.expect_error('correct_shift_base_pay_rate: correcting an already-closed historical period is rejected (55006)',
    format('select correct_shift_base_pay_rate(%L::uuid, %L::uuid, %L::uuid, 99)',
      current_setting('dbtest.resort_a'), current_setting('dbtest.corr_shift_type'), v_closed_id),
    '55006');
end $$;

select pg_temp.expect_error('correct_shift_base_pay_rate: a negative amount is rejected (23514)',
  format('select correct_shift_base_pay_rate(%L::uuid, %L::uuid, (select id from shift_base_pay_rules where shift_type_id = %L::uuid and effective_to is null), -1)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.corr_shift_type'), current_setting('dbtest.corr_shift_type')),
  '23514');

-- Security: driver/anonymous rejected.
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error('correct_shift_base_pay_rate: a driver cannot call it (42501)',
  format('select correct_shift_base_pay_rate(%L::uuid, %L::uuid, (select id from shift_base_pay_rules limit 1), 10)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.corr_shift_type')),
  '42501');
select pg_temp.act_as('anon');
select pg_temp.expect_error('correct_shift_base_pay_rate: anonymous cannot call it (42501)',
  format('select correct_shift_base_pay_rate(%L::uuid, %L::uuid, %L::uuid, 10)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.corr_shift_type'), gen_random_uuid()),
  '42501');
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- Audit: the correction produced an update row showing the before/after amount.
select pg_temp.expect_true('audit: correct_shift_base_pay_rate produced an update row with the before/after amount (13 -> 12)',
  exists (
    select 1 from audit_log
    where table_name = 'shift_base_pay_rules' and action = 'update'
      and (before ->> 'base_pay_chf')::numeric = 13.00 and (after ->> 'base_pay_chf')::numeric = 12.00
  ));

-- Normal future-change RPC still behaves exactly as before (history
-- preserved, never rewritten) -- a direct regression guard that this
-- checkpoint's new RPCs didn't disturb Checkpoint B's own workflow.
do $$
declare
  v_id uuid;
  v_before numeric;
  v_after numeric;
begin
  select shift_type_id into v_id from create_shift(
    current_setting('dbtest.resort_a')::uuid, 'Correction Regression Shift', '18:00'::time, '21:30'::time,
    array[4]::smallint[], (current_date - 90)::date, null
  );
  perform set_shift_base_pay_rate(current_setting('dbtest.resort_a')::uuid, v_id, 20.00, (current_date - 30)::date);
  perform set_shift_base_pay_rate(current_setting('dbtest.resort_a')::uuid, v_id, 25.00, (current_date + 10)::date);

  select base_pay_chf into v_before from shift_base_pay_rules where shift_type_id = v_id and effective_to is not null;
  select base_pay_chf into v_after from shift_base_pay_rules where shift_type_id = v_id and effective_to is null;
  perform pg_temp.expect_true('regression: set_shift_base_pay_rate still preserves history (never rewrites the old row) after adding correction RPCs',
    v_before = 20.00 and v_after = 25.00);
end $$;

-- =======================================================================
-- CORRECT_DRIVER_DELIVERY_RATE
-- =======================================================================

-- Same-day correction.
do $$
declare
  v_set record;
  v_corrected record;
  v_row_count integer;
begin
  select * into v_set from set_driver_delivery_rate(current_setting('dbtest.driver_a_id')::uuid, 13.00);
  select * into v_corrected from correct_driver_delivery_rate(current_setting('dbtest.driver_a_id')::uuid, v_set.rule_id, 12.00);
  perform pg_temp.expect_true('correct_driver_delivery_rate: a same-day correction succeeds',
    v_corrected.rule_id = v_set.rule_id and v_corrected.rate_chf = 12.00);
  perform pg_temp.expect_true('correct_driver_delivery_rate: effective_from/effective_to are preserved exactly',
    v_corrected.effective_from = v_set.effective_from and v_corrected.effective_to is null);

  select count(*) into v_row_count from driver_delivery_rates where driver_id = current_setting('dbtest.driver_a_id')::uuid;
  perform pg_temp.expect_true('correct_driver_delivery_rate: no new row was created', v_row_count = 1, format('got %s row(s)', v_row_count));
end $$;

-- Scheduled future rate correction, current untouched.
do $$
declare
  v_scheduled record;
  v_corrected record;
  v_current_before numeric;
  v_current_after numeric;
begin
  select * into v_scheduled from set_driver_delivery_rate(current_setting('dbtest.driver_a_id')::uuid, 14.00, (current_date + 30)::date);
  select rate_chf into v_current_before from driver_delivery_rates
    where driver_id = current_setting('dbtest.driver_a_id')::uuid and effective_to is not null;

  select * into v_corrected from correct_driver_delivery_rate(current_setting('dbtest.driver_a_id')::uuid, v_scheduled.rule_id, 15.00);

  select rate_chf into v_current_after from driver_delivery_rates
    where driver_id = current_setting('dbtest.driver_a_id')::uuid and effective_to is not null;

  perform pg_temp.expect_true('correct_driver_delivery_rate: a scheduled future rate can be corrected safely',
    v_corrected.rate_chf = 15.00 and v_corrected.effective_from = v_scheduled.effective_from);
  perform pg_temp.expect_true('correct_driver_delivery_rate: correcting the scheduled rate never touches the current rate',
    v_current_before = v_current_after and v_current_before = 12.00);
end $$;

select pg_temp.expect_true('correct_driver_delivery_rate: overlap invariants remain intact -- exactly two periods exist',
  (select count(*) from driver_delivery_rates where driver_id = current_setting('dbtest.driver_a_id')::uuid) = 2);

do $$
declare
  v_closed_id uuid;
begin
  select id into v_closed_id from driver_delivery_rates
    where driver_id = current_setting('dbtest.driver_a_id')::uuid and effective_to is not null;
  perform pg_temp.expect_error('correct_driver_delivery_rate: correcting an already-closed historical period is rejected (55006)',
    format('select correct_driver_delivery_rate(%L::uuid, %L::uuid, 99)', current_setting('dbtest.driver_a_id'), v_closed_id),
    '55006');
end $$;

select pg_temp.expect_error('correct_driver_delivery_rate: a negative rate is rejected (23514)',
  format('select correct_driver_delivery_rate(%L::uuid, (select id from driver_delivery_rates where driver_id = %L::uuid and effective_to is null), -1)',
    current_setting('dbtest.driver_a_id'), current_setting('dbtest.driver_a_id')),
  '23514');

-- Security: a driver cannot correct their own (or anyone else's) rate.
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error('correct_driver_delivery_rate: a driver cannot call it, even for themselves (42501)',
  format('select correct_driver_delivery_rate(%L::uuid, (select id from driver_delivery_rates limit 1), 10)', current_setting('dbtest.driver_a_id')),
  '42501');
select pg_temp.act_as('anon');
select pg_temp.expect_error('correct_driver_delivery_rate: anonymous cannot call it (42501)',
  format('select correct_driver_delivery_rate(%L::uuid, %L::uuid, 10)', current_setting('dbtest.driver_a_id'), gen_random_uuid()),
  '42501');
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

select pg_temp.expect_true('audit: correct_driver_delivery_rate produced an update row with the before/after amount (13 -> 12)',
  exists (
    select 1 from audit_log
    where table_name = 'driver_delivery_rates' and action = 'update'
      and (before ->> 'rate_chf')::numeric = 13.00 and (after ->> 'rate_chf')::numeric = 12.00
  ));
