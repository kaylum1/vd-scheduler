-- Driver language / Onfleet mapping invariants (Stage 2D Checkpoint 3.1).

select pg_temp.act_as('authenticated', current_setting('dbtest.manager_id')::uuid);

do $$
declare
  v_driver_a2 uuid;
begin
  insert into drivers (resort_id, full_name) values (current_setting('dbtest.resort_a')::uuid, 'DB Test Driver A2') returning id into v_driver_a2;
  perform set_config('dbtest.driver_a2_id', v_driver_a2::text, false);
end $$;

-- ---------------------------------------------------------------------
-- preferred_language: defaults to 'en', en/fr accepted, invalid rejected.
-- ---------------------------------------------------------------------
select pg_temp.expect_equal('drivers.preferred_language: defaults to en',
  (select preferred_language from drivers where id = current_setting('dbtest.driver_a_id')::uuid), 'en');

do $$
begin
  update drivers set preferred_language = 'fr' where id = current_setting('dbtest.driver_a_id')::uuid;
end $$;
select pg_temp.expect_equal('drivers.preferred_language: fr is accepted',
  (select preferred_language from drivers where id = current_setting('dbtest.driver_a_id')::uuid), 'fr');

select pg_temp.expect_error('drivers.preferred_language: an unsupported language code is rejected (23503)',
  format('update drivers set preferred_language = %L where id = %L', 'de', current_setting('dbtest.driver_a_id')),
  '23503');

select pg_temp.expect_true('supported_languages: exactly en/fr are seeded',
  (select array_agg(code order by code) from supported_languages) = array['en', 'fr']);

-- ---------------------------------------------------------------------
-- Onfleet mapping: explicit only, at most one active identity per resort,
-- at most one active mapping per driver, manager-only.
-- ---------------------------------------------------------------------
do $$
begin
  perform set_driver_onfleet_mapping(current_setting('dbtest.driver_a_id')::uuid, 'onfleet-worker-1');
end $$;
select pg_temp.expect_true('set_driver_onfleet_mapping: creates one active mapping',
  (select count(*) from driver_onfleet_mappings where driver_id = current_setting('dbtest.driver_a_id')::uuid and is_active) = 1);

-- Replacing a mapping = atomically deactivate old + insert new, never two
-- simultaneously-active mappings for the same driver (max one active per
-- driver at a time).
do $$
begin
  perform set_driver_onfleet_mapping(current_setting('dbtest.driver_a_id')::uuid, 'onfleet-worker-1-replacement');
end $$;
select pg_temp.expect_equal('set_driver_onfleet_mapping: exactly one active mapping remains after replacing it',
  (select count(*) from driver_onfleet_mappings where driver_id = current_setting('dbtest.driver_a_id')::uuid and is_active), 1::bigint);
select pg_temp.expect_true('set_driver_onfleet_mapping: the old mapping is retained, deactivated (never deleted)',
  exists (select 1 from driver_onfleet_mappings where driver_id = current_setting('dbtest.driver_a_id')::uuid and onfleet_worker_id = 'onfleet-worker-1' and not is_active));
select pg_temp.expect_equal('set_driver_onfleet_mapping: the new mapping is active with the new worker id',
  (select onfleet_worker_id from driver_onfleet_mappings where driver_id = current_setting('dbtest.driver_a_id')::uuid and is_active), 'onfleet-worker-1-replacement');

-- An Onfleet identity can only be actively claimed by one mapping per
-- resort at a time -- no fuzzy matching, always an explicit, unique claim.
select pg_temp.expect_error('driver_onfleet_mappings: an Onfleet identity already actively claimed at this resort cannot be claimed again (23505)',
  format('insert into driver_onfleet_mappings (resort_id, driver_id, onfleet_worker_id) values (%L, %L, %L)',
    current_setting('dbtest.resort_a'), current_setting('dbtest.driver_a2_id'), 'onfleet-worker-1-replacement'),
  '23505');

select pg_temp.expect_error('set_driver_onfleet_mapping: a blank worker id is rejected (23514)',
  format('select set_driver_onfleet_mapping(%L::uuid, %L)', current_setting('dbtest.driver_a_id'), '   '),
  '23514');

-- Manager-only.
select pg_temp.act_as('authenticated', current_setting('dbtest.driver_a_user_id')::uuid);
select pg_temp.expect_error('set_driver_onfleet_mapping: a driver cannot call it (42501)',
  format('select set_driver_onfleet_mapping(%L::uuid, %L)', current_setting('dbtest.driver_a_id'), 'driver-attempt'),
  '42501');
select pg_temp.expect_true('driver_onfleet_mappings: invisible to a driver session',
  (select count(*) from driver_onfleet_mappings) = 0);
