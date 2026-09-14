-- Shared fixtures for every test-group file (Stage 2D Checkpoint 3.1).
-- Prepended after _harness.sql by scripts/run-db-tests.mjs. Creates two
-- resorts (so every group can exercise cross-resort rejection without
-- redeclaring its own second resort), one manager, and one driver per
-- resort. A group file needing more specialised fixtures (extra drivers,
-- shift types, rules, published weeks, ...) creates them itself, reading
-- these ids back via current_setting('dbtest.*').
do $$
declare
  v_resort_a uuid;
  v_resort_b uuid;
  v_manager_id uuid := gen_random_uuid();
  v_driver_a_user_id uuid := gen_random_uuid();
  v_driver_b_user_id uuid := gen_random_uuid();
  v_driver_a_id uuid;
  v_driver_b_id uuid;
begin
  insert into resorts (slug, name, timezone) values ('dbtest-a', 'DB Test Resort A', 'Europe/Zurich')
  returning id into v_resort_a;
  insert into resorts (slug, name, timezone) values ('dbtest-b', 'DB Test Resort B', 'Europe/Zurich')
  returning id into v_resort_b;

  insert into auth.users (id, aud, role, email) values (v_manager_id, 'authenticated', 'authenticated', 'dbtest-manager@test.local');
  insert into app_users (id, role, driver_id, resort_id, is_active) values (v_manager_id, 'manager', null, null, true);

  insert into drivers (resort_id, full_name) values (v_resort_a, 'DB Test Driver A') returning id into v_driver_a_id;
  insert into auth.users (id, aud, role, email) values (v_driver_a_user_id, 'authenticated', 'authenticated', 'dbtest-driver-a@test.local');
  insert into app_users (id, role, driver_id, resort_id, is_active) values (v_driver_a_user_id, 'driver', v_driver_a_id, null, true);

  insert into drivers (resort_id, full_name) values (v_resort_b, 'DB Test Driver B') returning id into v_driver_b_id;
  insert into auth.users (id, aud, role, email) values (v_driver_b_user_id, 'authenticated', 'authenticated', 'dbtest-driver-b@test.local');
  insert into app_users (id, role, driver_id, resort_id, is_active) values (v_driver_b_user_id, 'driver', v_driver_b_id, null, true);

  perform set_config('dbtest.resort_a', v_resort_a::text, false);
  perform set_config('dbtest.resort_b', v_resort_b::text, false);
  perform set_config('dbtest.manager_id', v_manager_id::text, false);
  perform set_config('dbtest.driver_a_user_id', v_driver_a_user_id::text, false);
  perform set_config('dbtest.driver_a_id', v_driver_a_id::text, false);
  perform set_config('dbtest.driver_b_user_id', v_driver_b_user_id::text, false);
  perform set_config('dbtest.driver_b_id', v_driver_b_id::text, false);
end $$;
