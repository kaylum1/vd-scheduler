-- set_shift_base_pay_rate / set_driver_delivery_rate invariants (Stage 2D
-- Payroll Checkpoint B). Unlike the rest of this suite, these RPCs' own
-- business logic genuinely compares an input date against the resort's
-- real operational "today" (operational_today(), which reads now()) -- not
-- just a fixed 2027 anchor used for weekday math -- so the "already took
-- effect" vs "still a future plan" scenarios below deliberately use
-- current_date-relative arithmetic (evaluated in the same transaction the
-- RPCs themselves run in) rather than the suite's usual fixed calendar.
-- Precedent: docs/db-testing.md.

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_resort_id uuid := current_setting('dbtest.resort_a')::uuid;
  v_id uuid;
begin
  select shift_type_id into v_id from create_shift(
    v_resort_id, 'Rate RPC Shift', '18:00'::time, '21:30'::time,
    array[0]::smallint[], 1, (current_date - 90)::date, null
  );
  perform set_config('dbtest.rpc_shift_type', v_id::text, false);

  select shift_type_id into v_id from create_shift(
    current_setting('dbtest.resort_b')::uuid, 'Rate RPC Shift B', '18:00'::time, '21:30'::time,
    array[0]::smallint[], 1, (current_date - 90)::date, null
  );
  perform set_config('dbtest.rpc_shift_type_b', v_id::text, false);

  -- A second, otherwise-untouched shift type dedicated to the direct
  -- backdate-guard test below -- its current open row must still be the
  -- ONE original, truly-in-effect rate at the moment that test runs (not
  -- one already superseded by a later future-scheduled change).
  select shift_type_id into v_id from create_shift(
    v_resort_id, 'Rate RPC Shift Backdate', '18:00'::time, '21:30'::time,
    array[1]::smallint[], 1, (current_date - 90)::date, null
  );
  perform set_config('dbtest.rpc_shift_type_backdate', v_id::text, false);
end $$;

-- =======================================================================
-- SET_SHIFT_BASE_PAY_RATE
-- =======================================================================

-- 1. Initial rate succeeds (no existing rule at all).
do $$
declare
  v_result record;
begin
  select * into v_result from set_shift_base_pay_rate(
    current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.rpc_shift_type')::uuid, 30.00, (current_date - 30)::date
  );
  perform set_config('dbtest.rpc_base_rule1_id', v_result.rule_id::text, false);
  perform pg_temp.expect_true('set_shift_base_pay_rate: initial rate succeeds', v_result.base_pay_chf = 30.00 and v_result.effective_to is null);
end $$;

-- 2/3. Future rate change closes the old period correctly; history preserved.
do $$
declare
  v_result record;
begin
  select * into v_result from set_shift_base_pay_rate(
    current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.rpc_shift_type')::uuid, 35.00, (current_date + 10)::date
  );
  perform set_config('dbtest.rpc_base_rule2_id', v_result.rule_id::text, false);
  perform pg_temp.expect_true('set_shift_base_pay_rate: a future change creates a new open-ended row, not an in-place overwrite',
    v_result.rule_id <> current_setting('dbtest.rpc_base_rule1_id')::uuid and v_result.base_pay_chf = 35.00 and v_result.effective_to is null);
end $$;
select pg_temp.expect_true('set_shift_base_pay_rate: the historical row is preserved, closed the day before the new one starts -- never UPDATEd into the new value',
  (select base_pay_chf from shift_base_pay_rules where id = current_setting('dbtest.rpc_base_rule1_id')::uuid) = 30.00
  and (select effective_to from shift_base_pay_rules where id = current_setting('dbtest.rpc_base_rule1_id')::uuid) = (current_date + 9)::date);

-- 4. Overlap rejected/handled safely: backdating on/before the currently
-- REAL rate's own start is explicitly rejected (23514), not silently
-- allowed to rewrite it. Uses the dedicated shift type above so the
-- "current open row" is still the one truly-in-effect rate, not one
-- already superseded by test 2's future-scheduled change.
do $$
begin
  perform set_shift_base_pay_rate(
    current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.rpc_shift_type_backdate')::uuid, 30.00, (current_date - 30)::date
  );
end $$;
select pg_temp.expect_error('set_shift_base_pay_rate: backdating on/before an already-in-effect rate''s own start is rejected (23514)',
  format('select set_shift_base_pay_rate(%L::uuid, %L::uuid, 99, %L::date)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.rpc_shift_type_backdate'), (current_date - 30)::date),
  '23514');

-- 5. Negative amount rejected.
select pg_temp.expect_error('set_shift_base_pay_rate: a negative base pay is rejected (23514)',
  format('select set_shift_base_pay_rate(%L::uuid, %L::uuid, -1, %L::date)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.rpc_shift_type'), (current_date + 60)::date),
  '23514');

-- 6. Wrong-resort Shift rejected.
select pg_temp.expect_error('set_shift_base_pay_rate: a Shift belonging to a different resort is rejected (23503)',
  format('select set_shift_base_pay_rate(%L::uuid, %L::uuid, 40, %L::date)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.rpc_shift_type_b'), (current_date + 60)::date),
  '23503');

-- 7/8. Driver/anonymous rejected.
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error('set_shift_base_pay_rate: a driver cannot call it (42501)',
  format('select set_shift_base_pay_rate(%L::uuid, %L::uuid, 40, %L::date)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.rpc_shift_type'), (current_date + 60)::date),
  '42501');
select pg_temp.act_as('anon');
select pg_temp.expect_error('set_shift_base_pay_rate: anonymous cannot call it (42501)',
  format('select set_shift_base_pay_rate(%L::uuid, %L::uuid, 40, %L::date)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.rpc_shift_type'), (current_date + 60)::date),
  '42501');
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- 9. Audit created for both the insert and the historical-row close.
select pg_temp.expect_true('audit: set_shift_base_pay_rate''s new row produced an insert audit row',
  exists (select 1 from audit_log where table_name = 'shift_base_pay_rules' and row_id = current_setting('dbtest.rpc_base_rule2_id')::uuid and action = 'insert'));
select pg_temp.expect_true('audit: closing the historical row produced an update audit row (effective_to set)',
  exists (select 1 from audit_log where table_name = 'shift_base_pay_rules' and row_id = current_setting('dbtest.rpc_base_rule1_id')::uuid and action = 'update'));

-- Rate resolution (plain query, the same shape a future calculation engine
-- would use -- see docs/business-rules.md).
select pg_temp.expect_true('rate resolution: a lookup on an old (already-real) date resolves the historical row (30.00)',
  (select base_pay_chf from shift_base_pay_rules
   where shift_type_id = current_setting('dbtest.rpc_shift_type')::uuid and is_active
     and effective_from <= (current_date - 20)::date and (effective_to is null or effective_to >= (current_date - 20)::date)) = 30.00);
select pg_temp.expect_true('rate resolution: a lookup after the future change resolves the new row (35.00)',
  (select base_pay_chf from shift_base_pay_rules
   where shift_type_id = current_setting('dbtest.rpc_shift_type')::uuid and is_active
     and effective_from <= (current_date + 20)::date and (effective_to is null or effective_to >= (current_date + 20)::date)) = 35.00);

-- =======================================================================
-- SET_DRIVER_DELIVERY_RATE
-- =======================================================================

-- 10. Initial rate succeeds.
do $$
declare
  v_result record;
begin
  select * into v_result from set_driver_delivery_rate(current_setting('dbtest.driver_a_id')::uuid, 12.00, (current_date - 30)::date);
  perform set_config('dbtest.rpc_rate_rule1_id', v_result.rule_id::text, false);
  perform pg_temp.expect_true('set_driver_delivery_rate: initial rate succeeds', v_result.rate_chf = 12.00 and v_result.effective_to is null);
  perform pg_temp.expect_true('set_driver_delivery_rate: resort_id is resolved server-side from the driver, matching the driver''s own true resort',
    v_result.resort_id = current_setting('dbtest.resort_a')::uuid);
end $$;

-- 11/12. Future change closes the old period correctly; history preserved.
do $$
declare
  v_result record;
begin
  select * into v_result from set_driver_delivery_rate(current_setting('dbtest.driver_a_id')::uuid, 14.00, (current_date + 10)::date);
  perform set_config('dbtest.rpc_rate_rule2_id', v_result.rule_id::text, false);
  perform pg_temp.expect_true('set_driver_delivery_rate: a future change creates a new open-ended row, not an in-place overwrite',
    v_result.rule_id <> current_setting('dbtest.rpc_rate_rule1_id')::uuid and v_result.rate_chf = 14.00 and v_result.effective_to is null);
end $$;
select pg_temp.expect_true('set_driver_delivery_rate: the historical row is preserved, closed the day before the new one starts',
  (select rate_chf from driver_delivery_rates where id = current_setting('dbtest.rpc_rate_rule1_id')::uuid) = 12.00
  and (select effective_to from driver_delivery_rates where id = current_setting('dbtest.rpc_rate_rule1_id')::uuid) = (current_date + 9)::date);

-- 13. Different drivers independent.
do $$
declare
  v_result record;
begin
  select * into v_result from set_driver_delivery_rate(current_setting('dbtest.driver_b_id')::uuid, 20.00, (current_date - 30)::date);
  perform pg_temp.expect_true('set_driver_delivery_rate: a different driver''s rate is independent of driver_a''s',
    v_result.rate_chf = 20.00 and v_result.driver_id = current_setting('dbtest.driver_b_id')::uuid);
end $$;
select pg_temp.expect_true('set_driver_delivery_rate: driver_a''s current rate is unaffected by driver_b''s',
  (select rate_chf from driver_delivery_rates where driver_id = current_setting('dbtest.driver_a_id')::uuid and effective_to is null) = 14.00);

-- 14. Overlap rejected/handled safely (backdate guard).
select pg_temp.expect_error('set_driver_delivery_rate: backdating on/before an already-in-effect rate''s own start is rejected (23514)',
  format('select set_driver_delivery_rate(%L::uuid, 99, %L::date)', current_setting('dbtest.driver_b_id'), (current_date - 30)::date),
  '23514');

-- 15. Negative rate rejected.
select pg_temp.expect_error('set_driver_delivery_rate: a negative rate is rejected (23514)',
  format('select set_driver_delivery_rate(%L::uuid, -1, %L::date)', current_setting('dbtest.driver_a_id'), (current_date + 60)::date),
  '23514');

-- 16. resort_id can never be attributed to the wrong resort -- there is no
-- resort_id input to even attempt; it is always resolved from the driver's
-- own row (see test 10 above), which is a stronger guarantee than
-- "rejected" -- it is structurally impossible to misattribute.

-- 17. A driver cannot change their own (or anyone else's) rate.
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error('set_driver_delivery_rate: a driver cannot call it, even for themselves (42501)',
  format('select set_driver_delivery_rate(%L::uuid, 999, %L::date)', current_setting('dbtest.driver_a_id'), (current_date + 60)::date),
  '42501');

-- 18. Anonymous rejected.
select pg_temp.act_as('anon');
select pg_temp.expect_error('set_driver_delivery_rate: anonymous cannot call it (42501)',
  format('select set_driver_delivery_rate(%L::uuid, 12, %L::date)', current_setting('dbtest.driver_a_id'), (current_date + 60)::date),
  '42501');
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- 19. Audit created.
select pg_temp.expect_true('audit: set_driver_delivery_rate''s new row produced an insert audit row',
  exists (select 1 from audit_log where table_name = 'driver_delivery_rates' and row_id = current_setting('dbtest.rpc_rate_rule2_id')::uuid and action = 'insert'));
select pg_temp.expect_true('audit: closing driver_a''s historical rate row produced an update audit row',
  exists (select 1 from audit_log where table_name = 'driver_delivery_rates' and row_id = current_setting('dbtest.rpc_rate_rule1_id')::uuid and action = 'update'));

-- 20/21. Rate resolution: correct rule on an old date vs. after the future change.
select pg_temp.expect_true('rate resolution: a lookup on an old (already-real) date resolves driver_a''s historical rate (12.00)',
  (select rate_chf from driver_delivery_rates
   where driver_id = current_setting('dbtest.driver_a_id')::uuid and is_active
     and effective_from <= (current_date - 20)::date and (effective_to is null or effective_to >= (current_date - 20)::date)) = 12.00);
select pg_temp.expect_true('rate resolution: a lookup after the future change resolves driver_a''s new rate (14.00)',
  (select rate_chf from driver_delivery_rates
   where driver_id = current_setting('dbtest.driver_a_id')::uuid and is_active
     and effective_from <= (current_date + 20)::date and (effective_to is null or effective_to >= (current_date + 20)::date)) = 14.00);

-- ---------------------------------------------------------------------
-- A not-yet-real future plan can be freely corrected in place (no
-- redundant row) -- e.g. rescheduling an already-scheduled future change
-- before it ever takes effect.
-- ---------------------------------------------------------------------
do $$
declare
  v_before_count integer;
  v_after_count integer;
  v_result record;
begin
  select count(*) into v_before_count from shift_base_pay_rules where shift_type_id = current_setting('dbtest.rpc_shift_type')::uuid;
  -- The current open row (35.00 from current_date+10) hasn't taken effect
  -- yet -- correcting its amount/date is safe and must not add a new row.
  select * into v_result from set_shift_base_pay_rate(
    current_setting('dbtest.resort_a')::uuid, current_setting('dbtest.rpc_shift_type')::uuid, 36.00, (current_date + 15)::date
  );
  select count(*) into v_after_count from shift_base_pay_rules where shift_type_id = current_setting('dbtest.rpc_shift_type')::uuid;
  perform pg_temp.expect_true('set_shift_base_pay_rate: correcting a not-yet-real future plan updates it in place, no redundant row',
    v_after_count = v_before_count and v_result.base_pay_chf = 36.00 and v_result.effective_from = (current_date + 15)::date,
    format('before=%s after=%s', v_before_count, v_after_count));
end $$;

-- ---------------------------------------------------------------------
-- REGRESSION (found by manual testing during Payroll Checkpoint B): a rate
-- set effective TODAY is already the real, in-effect rate -- scheduling a
-- genuine future change on that same day must preserve it as the current
-- rate until the new one starts, never silently discard/replace it. A
-- boundary bug (`>=` instead of `>` when checking whether the current open
-- row "hasn't taken effect yet") previously let this fall into the
-- replace-in-place branch, discarding the CHF 12 row entirely.
-- ---------------------------------------------------------------------
do $$
declare
  v_shift_type uuid;
  v_today_result record;
  v_future_result record;
  v_rows integer;
begin
  select shift_type_id into v_shift_type from create_shift(
    current_setting('dbtest.resort_a')::uuid, 'Rate RPC Shift Today', '18:00'::time, '21:30'::time,
    array[2]::smallint[], 1, (current_date - 90)::date, null
  );

  -- Set today's rate (no p_effective_from -- defaults to today).
  select * into v_today_result from set_shift_base_pay_rate(current_setting('dbtest.resort_a')::uuid, v_shift_type, 30.00);
  perform pg_temp.expect_true('set_shift_base_pay_rate: a rate set with no explicit date defaults to today',
    v_today_result.effective_from = current_date);

  -- Schedule a genuine future change the SAME day.
  select * into v_future_result from set_shift_base_pay_rate(
    current_setting('dbtest.resort_a')::uuid, v_shift_type, 35.00, (current_date + 20)::date
  );

  select count(*) into v_rows from shift_base_pay_rules where shift_type_id = v_shift_type;
  perform pg_temp.expect_true('REGRESSION: a rate set today is preserved (never discarded) when a genuine future change is scheduled the same day',
    v_rows = 2, format('got %s row(s)', v_rows));
  perform pg_temp.expect_true('REGRESSION: today''s rate remains active and unchanged (still 30.00, still covers today)',
    (select base_pay_chf from shift_base_pay_rules where id = v_today_result.rule_id) = 30.00
    and (select effective_to from shift_base_pay_rules where id = v_today_result.rule_id) = (current_date + 19)::date);
  perform pg_temp.expect_true('REGRESSION: a lookup on today resolves 30.00 (the rate set today), not the future one',
    (select base_pay_chf from shift_base_pay_rules
     where shift_type_id = v_shift_type and is_active
       and effective_from <= current_date and (effective_to is null or effective_to >= current_date)) = 30.00);
end $$;
