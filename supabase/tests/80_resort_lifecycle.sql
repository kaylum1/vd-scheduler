-- Resort lifecycle invariants (Stage 2D Checkpoint 4.1):
-- create_resort/deactivate_resort/reactivate_resort.

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- ---------------------------------------------------------------------
-- create_resort: slug generation, default timezone, security.
-- ---------------------------------------------------------------------
do $$
declare
  v_id uuid;
  v_slug text;
begin
  select resort_id, slug into v_id, v_slug from create_resort('DB Test New Resort!!');
  perform set_config('dbtest.new_resort_id', v_id::text, false);

  perform pg_temp.expect_equal('create_resort: generates a disambiguated, human-readable slug from the name',
    v_slug, 'db-test-new-resort');
  perform pg_temp.expect_equal('create_resort: defaults timezone to Europe/Zurich without being asked',
    (select timezone from resorts where id = v_id), 'Europe/Zurich');
  perform pg_temp.expect_true('create_resort: creates an active resort',
    (select is_active from resorts where id = v_id));
end $$;

-- Duplicate/conflicting name: handled cleanly by disambiguation, never rejected.
do $$
declare
  v_id2 uuid;
  v_slug2 text;
begin
  select resort_id, slug into v_id2, v_slug2 from create_resort('DB Test New Resort!!');
  perform pg_temp.expect_equal('create_resort: a duplicate name is disambiguated, not rejected',
    v_slug2, 'db-test-new-resort-2');
  perform pg_temp.expect_true('create_resort: the duplicate-named resort is a genuinely different row',
    v_id2 <> current_setting('dbtest.new_resort_id')::uuid);
end $$;

select pg_temp.expect_error('create_resort: rejects a blank name (23514)',
  format('select create_resort(%L)', '   '), '23514');

-- Manager permitted; internal key/id generated without any manager input
-- (structural: create_resort's only INPUT parameter is p_name -- its two
-- OUT parameters, resort_id/slug, are the RETURNS TABLE shape, not inputs).
select pg_temp.expect_true('create_resort: takes only a name as input -- no id/slug/timezone parameter exists',
  (select pg_get_function_identity_arguments('create_resort(text)'::regprocedure)) = 'p_name text');

-- ---------------------------------------------------------------------
-- Security: driver/anonymous rejected.
-- ---------------------------------------------------------------------
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error('create_resort: driver cannot create a resort (42501)',
  format('select create_resort(%L)', 'Driver Resort'), '42501');
select pg_temp.expect_error('deactivate_resort: driver cannot call it (42501)',
  format('select deactivate_resort(%L::uuid)', current_setting('dbtest.new_resort_id')), '42501');
select pg_temp.expect_error('reactivate_resort: driver cannot call it (42501)',
  format('select reactivate_resort(%L::uuid)', current_setting('dbtest.new_resort_id')), '42501');

select pg_temp.act_as('anon');
select pg_temp.expect_error('create_resort: anonymous cannot create a resort (42501)',
  format('select create_resort(%L)', 'Anon Resort'), '42501');

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

-- ---------------------------------------------------------------------
-- deactivate_resort: safe path (no dependents).
-- ---------------------------------------------------------------------
do $$
begin
  perform deactivate_resort(current_setting('dbtest.new_resort_id')::uuid);
  perform pg_temp.expect_true('deactivate_resort: succeeds for a resort with no dependents',
    not (select is_active from resorts where id = current_setting('dbtest.new_resort_id')::uuid));
end $$;

select pg_temp.expect_true('deactivate_resort: preserves the same resort row (same id, same slug) -- never deletes it',
  exists (select 1 from resorts where id = current_setting('dbtest.new_resort_id')::uuid and slug = 'db-test-new-resort'));

-- ---------------------------------------------------------------------
-- reactivate_resort: same identity restored.
-- ---------------------------------------------------------------------
do $$
begin
  perform reactivate_resort(current_setting('dbtest.new_resort_id')::uuid);
  perform pg_temp.expect_true('reactivate_resort: restores the exact same resort id to active',
    (select is_active from resorts where id = current_setting('dbtest.new_resort_id')::uuid));
end $$;

select pg_temp.expect_error('reactivate_resort: rejects a resort that is not actually inactive (P0002)',
  format('select reactivate_resort(%L::uuid)', current_setting('dbtest.new_resort_id')), 'P0002');
select pg_temp.expect_error('deactivate_resort: rejects a resort that is already inactive/not found (P0002)',
  format('select deactivate_resort(%L::uuid)', gen_random_uuid()), 'P0002');

-- ---------------------------------------------------------------------
-- deactivate_resort: unsafe dependencies block it, never cascade.
-- ---------------------------------------------------------------------
do $$
declare
  v_blocked_resort uuid;
begin
  select resort_id into v_blocked_resort from create_resort('DB Test Blocked Resort');
  perform set_config('dbtest.blocked_resort_id', v_blocked_resort::text, false);
end $$;

-- Blocked by an active driver.
do $$
begin
  insert into drivers (resort_id, full_name) values (current_setting('dbtest.blocked_resort_id')::uuid, 'Blocking Driver');
end $$;
select pg_temp.expect_error('deactivate_resort: blocked by an active driver (55006)',
  format('select deactivate_resort(%L::uuid)', current_setting('dbtest.blocked_resort_id')), '55006');
select pg_temp.expect_true('deactivate_resort: the blocked driver is untouched -- never silently deactivated',
  (select is_active from drivers where resort_id = current_setting('dbtest.blocked_resort_id')::uuid));
select pg_temp.expect_true('deactivate_resort: the resort itself is untouched while blocked -- still active',
  (select is_active from resorts where id = current_setting('dbtest.blocked_resort_id')::uuid));

do $$
begin
  update drivers set is_active = false where resort_id = current_setting('dbtest.blocked_resort_id')::uuid;
end $$;

-- Blocked by an active shift (shift_types). 2027-01-04 is a Monday
-- (weekday 0) -- see the shared calendar anchor used throughout this suite.
do $$
declare
  v_shift_type_id uuid;
begin
  select shift_type_id into v_shift_type_id from create_shift(
    current_setting('dbtest.blocked_resort_id')::uuid, 'Blocking Shift', '09:00'::time, '10:00'::time, array[0]::smallint[], '2026-12-01'::date, null
  );
  perform set_config('dbtest.blocking_shift_type_id', v_shift_type_id::text, false);
end $$;
select pg_temp.expect_error('deactivate_resort: blocked by an active shift (55006)',
  format('select deactivate_resort(%L::uuid)', current_setting('dbtest.blocked_resort_id')), '55006');
select pg_temp.expect_true('deactivate_resort: the blocking shift is untouched -- never silently ended',
  (select is_active from shift_types where id = current_setting('dbtest.blocking_shift_type_id')::uuid));

-- Materialise a future instance WHILE the shift is still active, then
-- deactivate the shift -- reproducing the real scenario Stage 2C's
-- insert-only safety model exists for: an already-generated future
-- instance outlives its own template's deactivation.
do $$
begin
  perform materialise_shift_instances(current_setting('dbtest.blocked_resort_id')::uuid, '2027-01-04'::date, '2027-01-04'::date);
  perform deactivate_shift(current_setting('dbtest.blocking_shift_type_id')::uuid, current_setting('dbtest.blocked_resort_id')::uuid, '2026-12-31'::date);
end $$;
select pg_temp.expect_true('setup: the future instance genuinely exists and is still active',
  exists (select 1 from shift_instances where resort_id = current_setting('dbtest.blocked_resort_id')::uuid and status = 'active' and date = '2027-01-04'));
select pg_temp.expect_error('deactivate_resort: blocked by an upcoming generated shift instance even after its own shift is deactivated (55006)',
  format('select deactivate_resort(%L::uuid)', current_setting('dbtest.blocked_resort_id')), '55006');

do $$
begin
  update shift_instances set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'test'
  where resort_id = current_setting('dbtest.blocked_resort_id')::uuid;
end $$;

-- Blocked by a published week.
do $$
begin
  insert into rota_publications (resort_id, week_start, generation_source)
  values (current_setting('dbtest.blocked_resort_id')::uuid, '2027-01-04', 'manual'); -- a Monday
end $$;
select pg_temp.expect_error('deactivate_resort: blocked by a published week (55006)',
  format('select deactivate_resort(%L::uuid)', current_setting('dbtest.blocked_resort_id')), '55006');

do $$
begin
  update rota_publications set unpublished_at = now()
  where resort_id = current_setting('dbtest.blocked_resort_id')::uuid;
end $$;

-- All dependents retired -- deactivation now succeeds.
do $$
begin
  perform deactivate_resort(current_setting('dbtest.blocked_resort_id')::uuid);
  perform pg_temp.expect_true('deactivate_resort: succeeds once every dependent has been retired',
    not (select is_active from resorts where id = current_setting('dbtest.blocked_resort_id')::uuid));
end $$;

-- ---------------------------------------------------------------------
-- Selectors: active-only vs historical resolution, and audit.
-- ---------------------------------------------------------------------
select pg_temp.expect_true('selectors: an inactive resort can still be resolved directly by id (historical/reporting context)',
  exists (select 1 from resorts where id = current_setting('dbtest.blocked_resort_id')::uuid));

-- The driver-scoped RLS policy (resorts_driver_select_active) only ever
-- exposes active resorts to a driver session, regardless of the driver's
-- own resort -- confirming Checkpoint 4.1 §5's "operational selectors show
-- active resorts only" holds even at the database row-visibility level.
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_true('selectors: a driver session never sees the now-inactive resort at all',
  not exists (select 1 from resorts where id = current_setting('dbtest.blocked_resort_id')::uuid));
select pg_temp.expect_true('selectors: a driver session still sees an active resort',
  exists (select 1 from resorts where id = current_setting('dbtest.resort_a')::uuid));
select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

select pg_temp.expect_true('audit: create_resort produced an insert row',
  exists (select 1 from audit_log where table_name = 'resorts' and row_id = current_setting('dbtest.blocked_resort_id')::uuid and action = 'insert'));
select pg_temp.expect_true('audit: deactivate_resort produced an update row (is_active -> false)',
  exists (select 1 from audit_log where table_name = 'resorts' and row_id = current_setting('dbtest.blocked_resort_id')::uuid
    and action = 'update' and (after ->> 'is_active') = 'false'));
select pg_temp.expect_true('audit: reactivate_resort produced an update row (is_active -> true)',
  exists (select 1 from audit_log where table_name = 'resorts' and row_id = current_setting('dbtest.new_resort_id')::uuid
    and action = 'update' and (after ->> 'is_active') = 'true'));
