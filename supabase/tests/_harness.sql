-- Persistent DB regression test harness (Stage 2D Checkpoint 3.1).
--
-- Prepended (by scripts/run-db-tests.mjs, via `npm run test:db`) to every
-- numbered test-group file in this directory, followed by _fixtures.sql and
-- then _epilogue.sql, all executed as ONE psql script against the local
-- Supabase Postgres instance. Never run this file by itself.
--
-- Committed to the repository (unlike the scratch-only SQL test files used
-- earlier in Stage 2D) specifically so this suite survives across sessions,
-- machines, and time -- see docs/db-testing.md.

begin;

-- One row per assertion made by any test-group file in this run.
create table pg_temp.results (name text, passed boolean, detail text);

-- SECURITY DEFINER so bookkeeping inserts always succeed regardless of
-- which role act_as() has switched the session to -- tests deliberately
-- run as authenticated/driver/manager/anon, none of which have (or should
-- have) any grant on this scratch table.
create function pg_temp.record_result(p_name text, p_passed boolean, p_detail text default null)
returns void language plpgsql security definer as $$
begin
  insert into pg_temp.results (name, passed, detail) values (p_name, p_passed, p_detail);
end;
$$;

-- Switches the current session to a given Postgres role and JWT identity,
-- so RLS/RPC authorization behaves exactly as it would for a real request.
-- p_user_id = null simulates anon (no sub claim at all).
create function pg_temp.act_as(p_role text, p_user_id uuid default null)
returns void language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claim.sub', coalesce(p_user_id::text, ''), true);
  perform set_config('request.jwt.claim.role', p_role, true);
end;
$$;

-- Back to the superuser (postgres) that owns every table -- needed for
-- fixture setup and for the final report, which must be able to read
-- pg_temp.results/audit_log/etc. regardless of whatever role a test left
-- the session in.
create function pg_temp.as_postgres()
returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
end;
$$;

-- Runs p_sql (which must fail) and records whether it failed with exactly
-- p_expected_sqlstate. Uses a nested BEGIN/EXCEPTION block, which Postgres
-- implicitly wraps in a savepoint -- so a single bad assertion never
-- aborts the whole file's transaction.
create function pg_temp.expect_error(p_name text, p_sql text, p_expected_sqlstate text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    perform pg_temp.record_result(p_name, false, 'expected error ' || p_expected_sqlstate || ' but none was raised');
  exception when others then
    if sqlstate = p_expected_sqlstate then
      perform pg_temp.record_result(p_name, true, null);
    else
      perform pg_temp.record_result(p_name, false, format('expected sqlstate %s, got %s (%s)', p_expected_sqlstate, sqlstate, sqlerrm));
    end if;
  end;
end;
$$;

create function pg_temp.expect_true(p_name text, p_condition boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  perform pg_temp.record_result(p_name, coalesce(p_condition, false), case when coalesce(p_condition, false) then null else coalesce(p_detail, 'condition was false/null') end);
end;
$$;

-- Convenience for plain value comparisons (IS NOT DISTINCT FROM, so NULL
-- vs NULL counts as a pass -- deliberately, since "both NULL" is itself a
-- meaningful assertion throughout this suite, e.g. "missing config stays
-- NULL"). p_actual/p_expected must be the same type.
create function pg_temp.expect_equal(p_name text, p_actual anyelement, p_expected anyelement)
returns void language plpgsql as $$
begin
  perform pg_temp.record_result(
    p_name,
    p_actual is not distinct from p_expected,
    case when p_actual is not distinct from p_expected then null
      else format('expected %s, got %s', p_expected, p_actual) end
  );
end;
$$;
