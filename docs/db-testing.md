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
| `35_driver_safe_views.sql` | `driver_visible_shifts` / `driver_visible_assignments` / `driver_visible_week_publications` — the driver-facing security boundary views. The publication view (Live Driver My Rota LD-A): own-resort-only visibility, draft / retracted weeks absent, exactly `resort_id` + `week_start`, anon rejected, drivers have no direct `rota_publications` read, manager access intact, "published but no own assignment", unpublished → published → manager add/remove → unpublish flow, and Driver Availability's publication lock still working |
| `40_materialisation_template_safety.sql` | Insert-only + idempotent materialisation, effective template selection, override/adhoc/published/attendance refresh protection, cancellation preview/apply, operational timezone + DST |
| `50_language_onfleet.sql` | `preferred_language`, Onfleet mapping uniqueness/atomicity |
| `60_shift_staffing.sql` | `required_drivers` mandatory on `shift_templates`/`create_shift`/`revise_shift`/`reactivate_shift`, two separately-named Shifts with different staffing and no overlap conflict, direct materialisation (no rota-rule join), history preservation across a staffing revision, and proof the old `rota_rules_*` tables/counts are gone entirely (Stage 2D staffing simplification, replacing the abandoned Checkpoint 3 Rota Rules design) |
| `70_atomic_shift_rpcs.sql` | `create_shift`/`revise_shift`/`deactivate_shift`/`reactivate_shift` atomicity, history preservation, security, audit (Stage 2D Checkpoint 3) |
| `80_resort_lifecycle.sql` | `create_resort`/`deactivate_resort`/`reactivate_resort` atomicity, dependency-blocked deactivation, history preservation, security, audit (Stage 2D Checkpoint 4.1) |
| `85_manual_rota_assignments.sql` | `assign_driver`/`unassign_driver` (Manual Rota MR-A): server-side availability-override acknowledgement (Unavailable / Not Submitted, incl. the stale-client race), optional reason in `audit_log.context`, audit-context isolation (cleared after each RPC, no leak into a later audited write, no leak after a failed statement, malformed context never fails a write), over-assignment, active/same-resort/duplicate/cancelled-shift rules, today-vs-past boundary (operational timezone), published-week edits leaving `rota_publications` untouched, attendance guard, inactive assignees, and the closed direct-write path (manager SELECT-only, driver/anon rejected) |
| `86_auto_rota.sql` | `apply_auto_rota` (Auto-Rota AR-A): manager-only (driver/anon denied, grants), the untrusted-plan contract (malformed -> 22023, identity, stale -> VD002), whole-plan validation (availability must be an explicit Available row for the exact shift, active same-resort driver, no duplicates, never over-assign, inactive assignments excluded from coverage, manual overrides counted), published/historical guards (incl. a resort whose operational date is not a Monday), atomic rollback incl. a forced write failure, `assignment_source = auto`/`assigned_by`, the audit context, the server-computed result, and the per-resort/week advisory lock (key function, and that apply / assign / unassign / publication insert-update-delete each take exactly their own lock). Real two-connection blocking is NOT provable inside one test transaction and was verified separately (see the AR-A report); `85_manual_rota_assignments.sql` runs unmodified as the proof that the re-created manual RPCs behave identically |
| `87_publish_rota.sql` | `publish_rota` (Publish Rota PB-A): manager-only (driver/anon denied, grants, SECURITY DEFINER + pinned search_path), request shape (22023 / P0002), inactive resort (23514 `resort_inactive`), no-shifts and historical guards (a wholly past week, a current week whose active shifts are all before today, resort-timezone based), the server-authoritative uncovered acknowledgement (`VD003` + count; active-driver-only coverage, never negative, cancelled/past shifts ignored; a stale prompt count is recomputed under the lock), zero-assignment publishing, idempotent already-published (no write, no audit), retracted-row republish by UPDATE, server-derived `generation_source` (recomputed on republish), the audit context, closure of direct manager INSERT/UPDATE/DELETE on `rota_publications` (SELECT kept), driver visibility (live, no snapshot, no colleagues, cross-resort), Availability lock, Auto-Rota `published_week` block, manual edits after publishing, and the per-resort/week advisory lock. Real two-connection blocking was verified separately with `psql` (see the PB-A report) |
| `88_record_attendance.sql` | `record_attendance` / `clear_attendance` (Attendance AT-A): manager-only (driver / anon / INACTIVE manager denied, grants, SECURITY DEFINER + pinned search_path), request shape (`22023` / `invalid_status` / `P0002`), the four statuses, shift + driver + resort derived only from the assignment, the composite FK (attendance for an unassigned or cross-resort pair impossible; deleting an assignment that has attendance refused), direct manager INSERT / UPDATE / DELETE closed with SELECT kept, the date + publication rules (past published allowed with no reason, today needs a published week, future blocked regardless, cancelled shift blocked, a past UNPUBLISHED week = historical backfill that REQUIRES a reason and is flagged in the audit without publishing anything, incl. a partially historical current week), inactive driver and inactive resort still recordable, create / correct-in-place (recorded_by follows the correcting manager) / idempotent same-status no-op (no write, no audit, a different reason is not a change), reason trimmed / 500 max / audit-only (never `notes`), the audit insert / update / delete contexts, `unassign_driver` blocked by attendance and allowed again after `clear_attendance` (a past assignment stays frozen), clear's required reason and idempotent already-clear, `clear` not gated on publication, and the week lock (proved on weeks nothing else locks). Real two-connection races (record vs unassign in both orders, clear vs unassign, record vs record, Publish vs record) were verified separately with `psql` (see the AT-A report) |
| `89_driver_check_in.sql` | Driver Check-in (Attendance AT-A2): `check_in_to_shift` (driver-only: manager, inactive driver and anon denied; another driver's and a missing assignment both `P0002`; the public RPC has no timestamp or driver argument; internal `_check_in` / `_check_in_window` not executable by clients), the `driver_check_ins` table (exactly id / assignment_id / checked_in_at, RLS forced, manager-only SELECT, no client INSERT / UPDATE / DELETE, FK RESTRICT, one row per assignment), the inclusive 30-minutes-before-start to scheduled-end window with **injected instants** at the exact microsecond boundaries (so no wall-clock flake), the window in the resort's own timezone (Zurich summer / winter, the spring-forward and fall-back days, a Tokyo resort), the gates (cancelled shift, unpublished week, attendance already recorded -- tested after the window so a driver is never told attendance exists outside it), idempotency (a repeat returns the original id and timestamp with `created = false`, before every gate, even after the window closed or attendance was recorded; one row, one audit insert), Lunch and Dinner independent, the audit context, the `unassign_driver` check-in guard (`check_in_recorded`, attendance keeps precedence, an unaffected assignment is still removable), check-in first then every attendance status, `clear_attendance` never deleting the check-in, the extended `driver_visible_assignments` (own `checked_in_at` and the server window equal to `_check_in_window`, only three columns appended, no attendance / identity / pay column, other drivers see nothing), and the week lock (on a week nothing else locks). Real two-connection races (check-in vs unassign in both orders, vs `record_attendance` in both orders, check-in vs check-in, `clear_attendance`, Publish then check-in) were verified separately with `psql` (see the AT-A2 report) |
| `90_payroll_rate_foundations.sql` | `shift_base_pay_rules`/`driver_delivery_rates` effective dating, overlap prevention, historical-safe resolution, security, audit (Stage 2D Payroll Checkpoint A) |
| `95_payroll_rate_rpcs.sql` | `set_shift_base_pay_rate`/`set_driver_delivery_rate` atomicity, historical-safe reconciliation against the current open period, backdate/overlap rejection, security, audit (Stage 2D Payroll Checkpoint B) |
| `97_payroll_rate_corrections.sql` | `correct_shift_base_pay_rate`/`correct_driver_delivery_rate` atomicity, same-day/historical/scheduled correction, in-place amount update (no new row, dates preserved), closed-period rejection, security, audit, regression proof that the ordinary future-change RPCs are unaffected (Stage 2D Payroll Checkpoint B.1) |

**Time-of-day caution:** "today" in the product is the resort's *operational* date (Europe/Zurich), not `current_date` (UTC in the test session). For roughly 1–2 hours every night the two differ, so any assertion that compares an RPC's date against `current_date` can fail only in that window (this happened in `95_payroll_rate_rpcs`, fixed in Auto-Rota AR-D). New date-dependent tests must use `operational_today(resort)` (as `85`/`86` do).

As of Attendance checkpoint AT-A2 this suite has **812 assertions** across 18 files (712 before AT-A2: 614 before AT-A, plus the 98-assertion `88_record_attendance.sql`; AT-A2 added the 100-assertion `89_driver_check_in.sql` and one migration, and changed no existing test). That number will keep changing as the suite grows — don't
chase a specific count; the point is that it stays genuinely comprehensive
and, unlike its scratchpad predecessor, that it survives.

## Deployment readiness (pre-launch, local-only today)

This project has no linked hosted Supabase project, no staging/production
database, and no CI/CD deployment workflow — every migration is only ever
applied via a full local `supabase db reset`. Some migrations rely on this:
notably `20260916090000_simplify_shift_staffing.sql` makes
`shift_templates.required_drivers`/`shift_instances.required_drivers`
`NOT NULL` with no backfill, which only works against an empty database.

**Before introducing the first persistent hosted Supabase environment**, the
full migration history must get a deployment-readiness review (backfills for
any NOT-NULL-without-default changes, idempotency under `supabase migration
up` rather than `db reset`) — do not assume any migration in this history is
safe to apply incrementally against existing data until that review happens.

## Adding a new group

Pick the next round-numbered file name in the table above's spirit, or a
new one for a new area. A group file only needs the assertions themselves
— `_harness.sql`/`_fixtures.sql`/`_epilogue.sql` are prepended/appended
for you. See any existing file for the idioms (`pg_temp.expect_error` for
a statement that must fail with a specific SQLSTATE, `pg_temp.expect_true`/
`expect_equal` for value checks, `pg_temp.act_as` to test RLS/RPC
authorization under a specific role).
