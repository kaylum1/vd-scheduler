# Database regression testing

Stage 2D Checkpoint 3.1 replaced the earlier, scratchpad-only SQL test files
(which lived outside the repo and did not survive between sessions) with a
**persistent, committed** regression suite in [`supabase/tests/`](../supabase/tests).
This is now the durable database regression baseline — update it whenever a
migration changes a behaviour it covers, and add to it whenever a new
migration introduces a new invariant worth protecting.

## Running it

```bash
npm run db:reset:test   # npx supabase db reset -- destructive, applies all
                         # migrations fresh. Run this first, or whenever you
                         # want the suite to reflect the current migrations.
npm run test:db         # runs every file in supabase/tests/ and reports a
                         # pass/fail total. Exits non-zero if anything fails.
```

`test:db` does **not** reset the database itself — it runs against
whatever schema is currently applied to your local Supabase Postgres
instance. Running it without a prior reset is fine day-to-day (it's
useful right after writing a new migration, before committing to a full
reset), but before trusting a "0 failed" result as a real regression
check, make sure `db:reset:test` has been run against the current
migrations at least once.

Requires Docker (the local Supabase Postgres instance runs in a
container) and the local stack to be up (`npx supabase start`, or simply
`npm run db:reset:test`, which starts it if needed).

## How it works

Every file in `supabase/tests/` is plain SQL, run via
[`scripts/run-db-tests.mjs`](../scripts/run-db-tests.mjs) against the
`supabase_db_*` Docker container. Files prefixed with `_` are shared
infrastructure, not test groups:

- **`_harness.sql`** — the test framework: `pg_temp.record_result`,
  `pg_temp.expect_true`, `pg_temp.expect_equal`, `pg_temp.expect_error`
  (asserts a statement fails with a specific SQLSTATE), `pg_temp.act_as`
  (switches the session to a given Postgres role + JWT identity, so
  RLS/RPC authorization behaves exactly as it would for a real request),
  and `pg_temp.as_postgres` (back to the superuser).
- **`_fixtures.sql`** — two resorts, one manager, and one driver per
  resort, available to every test group via `current_setting('dbtest.*')`.
  A group needing more (extra drivers, shift types, rules, published
  weeks, ...) creates them itself.
- **`_epilogue.sql`** — prints the group's pass/fail summary and rolls
  back the transaction. **Nothing a test group does ever persists**, pass
  or fail.

Every other `NNN_name.sql` file is one independently-runnable test group.
The runner concatenates `_harness.sql` + `_fixtures.sql` + that one file +
`_epilogue.sql` into a single script and runs it inside one
`BEGIN ... ROLLBACK`, in its own `docker exec ... psql` invocation. Groups
run serially, each in a fresh transaction — a bug in one group's fixtures
aborts only that group (reported as "FAILED TO RUN"), never cascades into
every other file's assertions as unrelated "transaction aborted" noise.

## Current groups

| File | Covers |
|---|---|
| `00_core_schema.sql` | Weekday convention, resort/driver/app_user identity rules, cross-resort composite FKs, stable shift identity, immutability/overlap guards |
| `10_availability_publication.sql` | Availability answers, Confirm/Reopen Week, stale-confirmation invalidation, publication locking, `week_availability_status` authority, direct-table identity/uniqueness/manager-visibility invariants (Stage 3) |
| `20_assignments_attendance_adjustments.sql` | Rota assignments, attendance, payroll adjustments (types, positivity, voiding) |
| `30_security_rls_audit.sql` | Anonymous/driver/manager RLS boundaries, RPC caller authorization, audit logging |
| `35_driver_safe_views.sql` | `driver_visible_shifts` / `driver_visible_assignments` — the driver-facing security boundary views |
| `40_materialisation_template_safety.sql` | Insert-only + idempotent materialisation, effective template selection, override/adhoc/published/attendance refresh protection, cancellation preview/apply, operational timezone + DST |
| `50_language_onfleet.sql` | `preferred_language`, Onfleet mapping uniqueness/atomicity |
| `60_shift_staffing.sql` | `required_drivers` mandatory on `shift_templates`/`create_shift`/`revise_shift`/`reactivate_shift`, two separately-named Shifts with different staffing and no overlap conflict, direct materialisation (no rota-rule join), history preservation across a staffing revision, and proof the old `rota_rules_*` tables/counts are gone entirely (Stage 2D staffing simplification, replacing the abandoned Checkpoint 3 Rota Rules design) |
| `70_atomic_shift_rpcs.sql` | `create_shift`/`revise_shift`/`deactivate_shift`/`reactivate_shift` atomicity, history preservation, security, audit (Stage 2D Checkpoint 3) |
| `80_resort_lifecycle.sql` | `create_resort`/`deactivate_resort`/`reactivate_resort` atomicity, dependency-blocked deactivation, history preservation, security, audit (Stage 2D Checkpoint 4.1) |
| `90_payroll_rate_foundations.sql` | `shift_base_pay_rules`/`driver_delivery_rates` effective dating, overlap prevention, historical-safe resolution, security, audit (Stage 2D Payroll Checkpoint A) |
| `95_payroll_rate_rpcs.sql` | `set_shift_base_pay_rate`/`set_driver_delivery_rate` atomicity, historical-safe reconciliation against the current open period, backdate/overlap rejection, security, audit (Stage 2D Payroll Checkpoint B) |
| `97_payroll_rate_corrections.sql` | `correct_shift_base_pay_rate`/`correct_driver_delivery_rate` atomicity, same-day/historical/scheduled correction, in-place amount update (no new row, dates preserved), closed-period rejection, security, audit, regression proof that the ordinary future-change RPCs are unaffected (Stage 2D Payroll Checkpoint B.1) |

As of Stage 3 (Driver Availability) this suite has **315 assertions**. That
number will keep changing as the suite grows — don't chase a specific
count; the point is that it stays genuinely comprehensive and, unlike its
scratchpad predecessor, that it survives.

## Adding a new group

Pick the next round-numbered file name in the table above's spirit, or a
new one for a new area. A group file only needs the assertions themselves
— `_harness.sql`/`_fixtures.sql`/`_epilogue.sql` are prepended/appended
for you. See any existing file for the idioms (`pg_temp.expect_error` for
a statement that must fail with a specific SQLSTATE, `pg_temp.expect_true`/
`expect_equal` for value checks, `pg_temp.act_as` to test RLS/RPC
authorization under a specific role).
