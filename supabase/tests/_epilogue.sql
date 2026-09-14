-- Report + rollback (Stage 2D Checkpoint 3.1). Appended after a test-group
-- file by scripts/run-db-tests.mjs. Lines are prefixed with sentinels the
-- runner greps for, so they survive being interleaved with whatever other
-- statement output the group file itself produced.
select pg_temp.as_postgres();

select '__DBTEST_SUMMARY__ ' || count(*) filter (where passed) || ' ' || count(*) filter (where not passed) || ' ' || count(*)
from pg_temp.results;

select '__DBTEST_FAIL__ ' || name || ' | ' || coalesce(detail, '(no detail)')
from pg_temp.results where not passed order by name;

rollback;
