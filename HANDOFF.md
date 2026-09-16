# Handoff — VD Scheduler & Payroll

**Written:** 2026-09-16, end of session covering Stage 2D (Payroll Checkpoints A/B/B.1, Resort Lifecycle, Shift Setup simplification, Shift Staffing simplification) and Stage 3 (Driver Availability).

**Purpose:** let a fresh Claude Code session (no memory of this conversation) understand exactly what exists, why, and what to do next. Read this fully before touching code.

---

## 1. What this project is

VD Scheduler & Payroll — a Supabase-backed scheduling/rota/payroll app for a ski-resort delivery driver operation (multiple resorts: Crans-Montana, Zermatt, Verbier). Two roles: **manager** (configures resorts/shifts/payroll, will eventually assign/publish rotas) and **driver** (answers weekly availability, views their assigned rota, eventually logs attendance/deliveries).

**Stack:** React + TypeScript + Vite frontend, TanStack Query for data fetching, Supabase (Postgres + Auth + RLS + RPCs) for the real backend, with a parallel **mock repository provider** (`VITE_DATA_PROVIDER=mock`, in-memory fixtures) so the frontend test suite and local dev never require a running Supabase stack. `src/repositories/index.ts` is the single factory that picks mock vs Supabase based on `VITE_DATA_PROVIDER`.

**Two eras of code coexist deliberately:**
- **Stage 1.1**: the original UI-only prototype, driven by `src/mock-data/*` (hard-coded resort slugs like `'crans-montana'`, driver ids like `'gianni'`). Still powers the Manager Dashboard, the Manager "Rota (preview)" grid, and Driver "My Rota" — **none of these have been converted to live data yet**.
- **Stage 2+**: the real repository/domain layer (`src/repositories/domain.ts`, `types.ts`, `mock/*`, `supabase/*`) backed by real Supabase migrations, using real UUIDs. Configuration (Drivers, Resort & Shift Setup, Payroll Rules) and, as of this session, Driver Availability + the new manager Availability panel, are fully live on this layer.

This split is **intentional and documented** (see `docs/business-rules.md` §A's "Known temporary inconsistency" note, and §I's identity-bridge note) — do not try to unify it as a side effect of an unrelated task.

---

## 2. Original goal for this session block

The user drove this session through a sequence of explicit, numbered "STAGE X — CHECKPOINT Y" instructions, each following the same pattern:
1. **Architecture review first** (report-only, no code) when the checkpoint involved a product decision.
2. **Approval message** from the user, often amending the reviewed plan.
3. **Implementation checkpoint** with an extremely detailed spec (data model, RPC signatures, UI requirements, test requirements, a numbered "STOP CONDITION" report to return, and explicit "DO NOT BEGIN X" boundaries for the next checkpoint).

The throughline: build out the manager-facing Configuration area (Drivers, Resorts, Shifts, Payroll Rules) and the payroll rate model correctly from first principles, then simplify an over-engineered staffing-rules design that had been provisionally built, then make Driver Availability real. Every checkpoint was implemented, tested (frontend + DB + manual Supabase walkthrough), documented, and committed as its own isolated commit before moving to the next.

**The user has NOT yet asked for:** Manual Rota (assignment), Auto-Rota, Rota Publishing (the real RPC/UI — a fake preview button exists), Attendance, Onfleet integration, or Payroll calculation. Every checkpoint in this session ended with an explicit instruction not to start these. Do not start them unless explicitly asked in a new message.

---

## 3. What was completed, checkpoint by checkpoint

All of the following are **committed and merged into the local commit history** (not yet merged on GitHub — see §7 for PR status).

### 3.1 Simplify manager shift setup (commit `012ec24`)
Collapsed the old two-layer "Shift Types + Recurring Shift Schedule" UI into one manager-facing **"Shift"** concept: one name, one standard start/end time, the weekdays it runs, one effective period. Backend concepts (`shift_types` stable id/key, per-weekday `shift_templates` rows, Monday=0..Sunday=6 weekday integers) remain real but are never shown to the manager. Introduced the atomic RPC pattern used throughout the rest of the session:
- `create_shift` / `revise_shift` / `deactivate_shift` / `reactivate_shift`, all `SECURITY DEFINER`, `assert_active_manager()` gated, sharing an internal `_apply_shift_weekdays()` helper that reconciles a shift's weekday rows against a new selection in one transaction.
- `assembleShift()` (`src/repositories/assembleShift.ts`) — pure function collapsing a shift type's current (or last-known) templates into one `ShiftRecord`. Detects **legacy inconsistent data** (different times/weekdays on different templates, only possible from pre-simplification data) and refuses to guess — shows a "Review required" state instead of silently flattening it.

### 3.2 Add resort lifecycle management (commit `9c01e0a`)
Atomic `create_resort` / `deactivate_resort` / `reactivate_resort` RPCs. Deactivation is **blocked** if the resort has any operationally-active dependent (active drivers, active shifts, upcoming generated shift instances, a published week) — never cascades, never deletes. Introduced the **"Choose resort" segmented-pill selector** pattern (`resort-chooser segmented` CSS classes) reused by every later manager page that needs a resort picker (Shift Setup, Payroll Rules, and the new Availability panel).

### 3.3 Clarify resort selection in shift setup (commit `a7b4819`)
UX amendment: split "Resorts" (lifecycle management list) from "Choose resort" (the operational selector for Shift Setup underneath it) — a manual-testing finding that folding selection into the management list left it unclear which resort's shifts were being edited.

### 3.4 Payroll architecture reviews (report-only, no commits)
Two review-only exchanges (not implementation) established the authoritative payroll model **before any code was written**:
- **Formula:** `worked_shift_pay = MAX(shift base guarantee, delivery_total)` — never additive, only earned if `attendance.status = 'worked'`.
- **Ownership split:** shift base pay belongs to the **Shift** (`shift_base_pay_rules`, keyed by `shift_type_id`); delivery rate belongs to the **driver** (`driver_delivery_rates`, keyed by `driver_id`) — these are genuinely different owners, not a modeling accident.
- **`shift_instances` owns zero financial data** — not even a snapshot. Rates are resolved once, at actual payroll-calculation time (a future `driver_shift_payroll` table, not built yet), against the driver+shift's real date. This avoids a stale-pay-snapshot problem and a parallel payroll-refresh mechanism.
- Late-delivery double pay is a **documented future design** (PENDING/NORMAL/DOUBLE three-way state, never a `multiplier` defaulting to 1) — not implemented.

### 3.5 Correct payroll rate ownership (commit `47873ff`)
Implements the reviewed model:
- Renamed `payroll_rules` → `shift_base_pay_rules`, dropped its `delivery_rate_chf` column.
- New `driver_delivery_rates` table (driver-owned, effective-dated, same GIST-exclusion no-overlap idiom as everywhere else).
- Dropped `base_pay_chf`/`delivery_rate_chf` from `shift_instances` entirely (columns removed, not deprecated).
- `materialise_shift_instances` rewritten with **zero payroll-rate responsibility** — no join to either rate table, no `missing_payroll_rule_count`.

### 3.6 Add manager payroll rules configuration (commit `c409e59`)
- `set_shift_base_pay_rate` / `set_driver_delivery_rate` RPCs — atomic "create the Shift's first rate, or schedule a future change" logic. A genuine future change closes the current open-ended row (`effective_to = new_date - 1`) and inserts a fresh row; a not-yet-started future plan is corrected in place. **Known boundary-bug fix during this checkpoint:** the "is this row still just a future plan" check must use strict `>` on `effective_from > today`, not `>=` — using `>=` let a same-day rate get silently discarded when a later change was scheduled the same day. Fixed in both the RPC and the mock repository; regression-tested.
- `PayrollRulesRepository` (both providers), `PayrollRulesPanel.tsx` UI — "Choose resort" pattern reused, two sections (Shift base pay / Driver delivery rates), Current/Scheduled/History derived client-side from the flat rate list via `categorizeRatePeriods` (the one place that resolution logic lives).
- Also fixed a **Shift Setup bug** found during this checkpoint: a shift type with zero `shift_templates` rows (created outside the atomic RPCs) was incorrectly treated the same as "inconsistent data" — now correctly shows "No recurring schedule configured yet." with Edit enabled.
- **Environment-debugging incident** (see §6 below — read this before running the frontend suite after any manual Supabase testing).

### 3.7 Add payroll rate correction workflow (commit `e9fc691`)
Distinct **Correct** vs **Change** actions:
- **Change** (`set_*_rate`, unchanged from 3.6): schedules a future period, preserves history.
- **Correct** (`correct_shift_base_pay_rate` / `correct_driver_delivery_rate`, new): fixes a data-entry mistake in an existing, still-**open** rule (current or scheduled) — updates only the amount, **never** `effective_from`/`effective_to`. Rejects correcting an already-closed historical period (55006). Audit log (not Rate History) is what shows the before/after correction.
- Documented a **future finalisation guard** (not built — no `driver_shift_payroll` table exists yet): once payroll is calculated and finalised from a rate, a correction to that rate must eventually be rejected. This is a noted gap for whoever builds payroll calculation, not a bug today.

### 3.8 Simplify shift staffing model (commit `3f4d073`)
**This was itself preceded by a full architecture review** that reversed an earlier, more complex design (`rota_rules_default`/`rota_rules_weekday`/`rota_rules_date` — a 3-tier precedence system for staffing, built provisionally in an earlier Stage 2D checkpoint not covered by this handoff's commit range but present in migration history). The review found **no manager-facing UI/repository/RPC had ever been built against those three tables** — only raw-SQL test fixtures — so there was nothing real to migrate away from.

**Decision:** `required_drivers` lives directly on the Shift (`shift_templates.required_drivers`), mandatory (`>= 1`, no default) at Shift-creation time, exactly like start/end time. A different staffing requirement for the same service is simply a **separately-named Shift** (e.g. "Dinner (1P)" vs "Dinner (2P)") — never an override/precedence rule. `shift_templates_no_overlap`'s exclusion constraint is scoped per shift **type** (a stable identity per Shift), so two differently-named Shifts can freely share identical times/weekdays/dates — this is by design, no duplicate/overlap warning is built.

Implementation:
- `_apply_shift_weekdays` / `create_shift` / `revise_shift` / `reactivate_shift` all gained a required `p_required_drivers` parameter.
- `materialise_shift_instances` reads `required_drivers` straight off `shift_templates` — no join, no precedence, **no missing-staffing count of any kind** (structurally impossible now — mandatory at creation).
- `rota_rules_default`/`rota_rules_weekday`/`rota_rules_date` **dropped outright** (not deprecated) — migration `20260916090000_simplify_shift_staffing.sql`.
- `preview_template_refresh`/`apply_template_refresh` extended to include `required_drivers` in the diff (surfaced via the existing generic `changed_fields` jsonb, not a new output column) — **but a staffing-only change never reopens driver availability**, only a genuine start/end time change does. This distinction is load-bearing and re-verified in Stage 3 (§3.9).
- `is_premium`/High-value: left as an inert, nullable, never-populated legacy column on both `shift_templates` and `shift_instances`. Not part of the V1 product model. Do not build High-value UI unless explicitly asked.
- Coverage model simplified from three states (no-service / staffing-not-configured / uncovered-or-covered) back to two (no-service / uncovered-or-covered) — `coverageTone`/`coverageLabel` in `src/components/ui/StatusPill.tsx` still accept `required: number | null` and render `null` as a **defensive legacy fallback only** (unreachable for any Shift created since this checkpoint).
- Documented (not implemented) the **future Auto-Rota fairness algorithm**: weekend-first (Fri/Sat/Sun) then weekday (Mon–Thu) allocation phases, computed separately per resort per week; coverage always wins over fairness; availability is a hard constraint (only explicit "Available" counts); deterministic tie-breaking (fewest assignments in phase → fewest total → `drivers.created_at` → `drivers.id`, never randomness); a multi-driver Shift needs that many distinct drivers; existing manual assignments are preserved and counted before allocation. See `docs/business-rules.md` §H.

### 3.9 Add live driver availability (commit `cf875e5`, this session's main deliverable — Stage 3)
Made an **already-fully-built** backend (schema, RLS, RPCs, stale-invalidation trigger — all built in an earlier, pre-handoff Stage 2D checkpoint) real on the frontend for the first time. **No new migration was needed for this checkpoint** — see §4.3.

- **Driver Availability page** (`src/pages/driver/Availability.tsx`) — full rewrite, replaces the Stage 1.1 mock version entirely. Live `shift_instances` for the driver's own resort, grouped by day, answered independently per shift. Partial-save (answer one shift, leave, come back — persists). Explicit "Confirm availability" action, blocked while any current shift is unanswered. "Reopen availability" before publication, preserving all answers. Publication lock enforced **at the database** (RLS), not just a disabled button — driver sees "🔒 Availability locked" read-only. "Needs reconfirmation" state when a stale-invalidation trigger has fired (shift added/reinstated/time-changed) — re-verified live that a **staffing-only** (`required_drivers`) change does *not* trigger this, only a genuine time change does.
- **Manager Availability panel** (`src/components/availability/ManagerAvailabilityPanel.tsx`) — new, mounted at the top of `src/pages/manager/RotaAvailability.tsx`. Resort + week selection, one row per active driver showing `Not started` / `In progress` / `Confirmed` / `Needs reconfirmation` / `Locked`, expandable to that driver's actual per-shift answers. **Read-only — no assignment, Auto-Rota, or Publish control.** The pre-existing Stage 1.1 mock "Rota (preview)" grid was kept, but demoted under its own heading with an `InlineNotice` clarifying it's unrelated Stage 1.1 demo data, so it can never be mistaken for real state.
- **Repository additions** (`AvailabilityRepository` in `src/repositories/types.ts`): `getAvailabilitySubmission` (driver-facing, reads the raw `availability_submissions` row — distinct from `getWeekAvailabilityStatus`, which only reports pure answer completeness and deliberately never trusts `submitted_at`), `listAvailabilitySubmissionStatus` and `getResortWeekAvailability` (manager-facing, both implemented as plain authorized reads over tables the manager role already has full RLS `SELECT` on — no new RPC).
- **Two bugs found and fixed as part of this checkpoint** (see §6 for full detail — both are pre-existing, not introduced this session, but were blocking correct behaviour and are now fixed):
  1. `generateMockShiftInstancesForWeek` (mock provider) never actually filtered by weekday/effective-date — every Shift appeared on every day of every week in mock mode. Fixed.
  2. Mock-mode driver identity mismatch: the Stage 1.1 driver switcher and the repository-layer mock fixtures use two different id spaces (`'gianni'` vs `'mock-gianni'`) that only agree on **names**, not ids. Fixed via a new, narrowly-scoped bridge (`src/repositories/mock/identityBridge.ts`) used only by the live Availability page — `AuthContext` and Stage-1.1's `MyRota.tsx` were deliberately left untouched (see §6 for why).

---

## 4. Key architectural decisions to internalize

### 4.1 The atomic manager RPC pattern (used everywhere)
```sql
create function <name>(...)
returns table (...)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_active_manager();
  ...
end;
$$;
revoke execute on function <name>(...) from public;
grant execute on function <name>(...) to authenticated;
```
Any new manager write RPC should follow this exact shape. `#variable_conflict use_column` is needed whenever a `RETURNS TABLE` output column name collides with a bare column reference inside the function body — this has been a recurring, easy-to-miss bug across multiple checkpoints.

### 4.2 Effective-dating idiom (used by `shift_templates`, `shift_base_pay_rules`, `driver_delivery_rates`)
A GIST exclusion constraint prevents two active overlapping periods for the same key:
```sql
exclude using gist (
  <key_column> with =,
  daterange(effective_from, coalesce(effective_to, 'infinity'), '[]') with &&
) where (is_active)
```
Reconciling against the "current open row" (the row with `effective_to IS NULL`) always uses **strict `>`** on `effective_from > today` to decide "this hasn't started yet, replace in place" vs "this is real, close it and insert a new row" — see the boundary bug in §3.6.

### 4.3 RLS is the real security boundary — not the frontend
Every table has RLS enabled + `FORCE ROW LEVEL SECURITY`. Manager policies are broadly `is_active_manager()`-gated (manager can read/write everything). Driver policies are narrow: own-row-only, and for `availability` specifically, writes are additionally gated by `not shift_instance_week_is_published(shift_instance_id)` — **a published week's lock is enforced at the database, verified by inserting/updating directly against the table under a driver session, not just by observing the UI**. This is why the Stage 3 checkpoint needed **zero new migrations** — the manager-read-everything policies already covered the new `listAvailabilitySubmissionStatus`/`getResortWeekAvailability` repository methods without any new RPC.

### 4.4 The stale-availability-confirmation trigger (pre-existing, load-bearing)
`shift_instances_reopen_stale_confirmations()` (trigger on `shift_instances` insert/update) reopens a confirmed `availability_submissions` row (clears `submitted_at`, sets `reopened_reason`) **only** for:
- a new active shift added (`shift_added`)
- a cancelled shift reinstated (`shift_reinstated`)
- an active shift's `start_time`/`end_time` changing (`shift_time_changed`)

**Deliberately never** for: `required_drivers` changes, `is_premium` changes, any payroll/rate change, name/sort_order changes, or a shift being cancelled (cancellation can only reduce required answers). This exact distinction was re-verified end-to-end against real Supabase in the Stage 3 walkthrough (staffing-only change → still Confirmed; time change → Needs reconfirmation). **Do not weaken or "simplify" this trigger** — it's the single source of truth for what counts as "the driver's answer is no longer valid."

### 4.5 Mock provider fidelity is a real, ongoing maintenance burden
The mock provider (`src/repositories/mock/*`) is not a toy — the entire frontend test suite (351 tests) and the default local-dev experience run against it. It has **no persisted `shift_instances`** (generated fresh from templates on every read via `generateMockShiftInstancesForWeek`), so it **cannot simulate the DB trigger in §4.4** — tests that need a "stale" state fabricate the resulting `mockAvailabilitySubmissions` row directly (see that file's doc comment, and `Availability.test.tsx` tests 14/17 and 15 for the pattern). If you add a new DB trigger/invariant, ask whether the mock provider needs a parallel (simplified, documented-as-such) implementation or whether "not supported in mock mode" (the existing pattern for materialise/refresh/cancellation) is more honest.

### 4.6 Two id spaces in mock mode — read before touching `AuthContext` or driver pages
See §6.2. `useAuth().currentUser.driverId`/`resortId` in mock mode are **Stage 1.1 ids** (`'gianni'`, `'crans-montana'`) because `MyRota.tsx` (not yet converted to live data) depends on that. Any **new** live driver page must bridge through `src/repositories/mock/identityBridge.ts` (mock mode only; Supabase mode's `currentUser.driverId`/`resortId` are already real database ids and need no bridging).

---

## 5. Database schema/RLS state (as of `cf875e5`)

### Tables (all RLS-enabled + FORCE)
`resorts`, `drivers`, `driver_onfleet_mappings`, `app_users`, `shift_types`, `shift_templates`, `shift_instances`, `availability`, `availability_submissions`, `rota_publications`, `rota_assignments`, `attendance`, `payroll_adjustments`, `audit_log`, `shift_base_pay_rules`, `driver_delivery_rates`.

### Dropped this session
`payroll_rules` (renamed to `shift_base_pay_rules`), `rota_rules_default`, `rota_rules_weekday`, `rota_rules_date` (all three dropped outright, no data migration — confirmed nothing real depended on them).

### Key RPCs (all `SECURITY DEFINER`, manager- or driver-gated per §4.1/4.3)
- Shift lifecycle: `create_shift`, `revise_shift`, `deactivate_shift`, `reactivate_shift`, internal `_apply_shift_weekdays`.
- Materialisation/refresh: `materialise_shift_instances`, `preview_template_refresh`, `apply_template_refresh`, `preview_template_cancellation`, `apply_template_cancellation`.
- Resort lifecycle: `create_resort`, `deactivate_resort`, `reactivate_resort`.
- Payroll rates: `set_shift_base_pay_rate`, `set_driver_delivery_rate`, `correct_shift_base_pay_rate`, `correct_driver_delivery_rate`.
- Availability (pre-existing, unchanged this session): `week_availability_status`, `confirm_availability_week`, `reopen_availability_week`.
- Driver-safe views: `driver_visible_shifts`, `driver_visible_assignments` (both `security_invoker = false`, deliberately narrow projections — see migration `20260908094059_driver_safe_views.sql`).

### Migrations touched/added this session (chronological, newest last)
```
20260915115014_resort_lifecycle_management.sql
20260915140624_correct_payroll_rate_ownership.sql
20260915143319_add_payroll_rate_rpcs.sql
20260915164633_add_payroll_rate_correction_rpcs.sql
20260916090000_simplify_shift_staffing.sql
```
**No migration was added for the Driver Availability checkpoint (3.9)** — it was purely a frontend/repository-layer checkpoint against already-existing schema.

**Rule for future migrations:** never edit an already-applied/committed migration file. Always add a new one. `src/types/database.generated.ts` is auto-generated (`npm run db:types`) — never hand-edit it.

---

## 6. Known issues, deviations, and incidents (read before you hit the same wall)

### 6.1 `.env.local` toggling — the recurring footgun
`.env.local` (gitignored) controls `VITE_DATA_PROVIDER` (`mock` | `supabase`). Manual Supabase walkthroughs require setting it to `supabase`; **it must always be reverted to `mock` before running the frontend test suite again** — Vite/Vitest reads `.env.local` for test runs too, and a leftover `supabase` value makes `getRepositories()` return Supabase repositories, causing every test that expects mock behaviour to fail with a generic error. This bit an earlier checkpoint in this session hard (92 failures, root-caused via `git stash -u` + a temporary debug test file). **Current state: `.env.local` is correctly set to `mock`** (verified at the top of this handoff). If you do a manual Supabase walkthrough, revert it before finishing.

### 6.2 Mock-mode driver identity bridge (Stage 3, `identityBridge.ts`)
Discovered mid-checkpoint: `AppStateContext`'s driver switcher (`activeDriverId`, defaulting to `drivers[0].id` from `src/mock-data/drivers.ts`) feeds `useAuth().currentUser.driverId` directly. Those ids (`'gianni'`, `'alex'`, `'tomas'`) are **Stage 1.1 ids**, not the repository-layer mock fixture ids (`'mock-gianni'`, etc. — `src/repositories/mock/fixtures.ts`). A naive fix (making `AuthContext` resolve to the repository-layer id) was tried and **reverted** because it broke `MyRota.tsx`, which still depends on the Stage 1.1 id space directly. The actual fix: a new, narrow bridge (`resolveMockDriverIdentity`, matching by full **name** since both datasets deliberately share the same demo names) used only inside `Availability.tsx`'s `useDriverRepositoryIdentity()` hook. **If you convert `MyRota.tsx` (or any other still-Stage-1.1 driver page) to live data next, reuse this exact bridge** rather than re-deriving it, and consider whether it's time to centralize it (e.g., inside `useAuth()` itself) now that more than one page needs it — that was explicitly deferred this session to keep the change small.

### 6.3 Mock shift-instance weekday filtering bug (pre-existing, fixed this session)
`generateMockShiftInstancesForWeek` (`src/repositories/mock/shiftInstances.ts`) looped over all 7 weekdays × all active templates **without checking `template.weekday` or effective dates at all** — every Shift appeared on every day, in every week, in mock mode. This has been present since the function was created (an earlier, pre-handoff checkpoint) and silently affected `MockShiftConfigurationRepository.listShiftInstances` too, not just the new Availability code. **Fixed** in this session (now correctly filters by `template.weekday === weekday` and effective date range). Verified no existing test depended on the old (buggy) 7x-duplication behaviour before fixing.

### 6.4 Deferred/not-yet-done work explicitly out of scope
- Manager Dashboard and Manager "Rota (preview)" grid and Driver "My Rota" are **still Stage 1.1 mock data** — not a bug, a known, documented gap (see `docs/business-rules.md` §A).
- `is_premium`/High-value: inert columns, no UI, by product decision — do not resurrect without an explicit new instruction.
- Future payroll finalisation guard on rate corrections (§3.7) — no `driver_shift_payroll` table exists yet to guard against.
- Auto-Rota fairness algorithm — fully specified in `docs/business-rules.md` §H, **not implemented**.
- No `gh` CLI PR-description automation issue, but note: `gh auth login` was required mid-session (the sandboxed environment cannot self-authenticate `gh` by extracting git's own stored credential — this is a deliberate safety boundary, not a bug to work around).

### 6.5 Bundle size warning (cosmetic, not new)
`vite build` warns the main JS chunk is >500kB. Pre-existing, not addressed this session, not blocking.

---

## 7. Test and build status (verified fresh at the top of this session, before writing this file)

```
npx vitest run     → 351/351 passed (28 test files)
npm run test:db    → 315/315 assertions passed (13 DB regression groups)
npm run build      → clean (tsc -b && vite build), only the pre-existing bundle-size warning
```

DB regression groups (see `docs/db-testing.md` for the full description of each):
`00_core_schema` (19), `10_availability_publication` (30), `20_assignments_attendance_adjustments` (14), `30_security_rls_audit` (35), `35_driver_safe_views` (8), `40_materialisation_template_safety` (35), `50_language_onfleet` (12), `60_shift_staffing` (21), `70_atomic_shift_rpcs` (27), `80_resort_lifecycle` (31), `90_payroll_rate_foundations` (29), `95_payroll_rate_rpcs` (31), `97_payroll_rate_corrections` (23).

**To reproduce:** `npx supabase start` (if not running) → `npm run db:reset:test` → `npm run test:db`, and separately `npx vitest run` (make sure `.env.local` is `mock` first — see §6.1).

---

## 8. Git / PR status

- **Current local branch:** `feature/payroll-staffing-and-availability`, clean working tree.
- **Commits on this branch, not yet on `origin/main`** (oldest → newest):
  ```
  012ec24  Simplify manager shift setup
  9c01e0a  Add resort lifecycle management
  a7b4819  Clarify resort selection in shift setup
  47873ff  Correct payroll rate ownership
  c409e59  Add manager payroll rules configuration
  e9fc691  Add payroll rate correction workflow
  3f4d073  Simplify shift staffing model
  cf875e5  Add live driver availability
  ```
- **PR:** [#1 — "Manager shift/payroll simplification and live driver availability"](https://github.com/kaylum1/vd-scheduler/pull/1), open, not a draft, base `main`, head `feature/payroll-staffing-and-availability`, mergeable, **not yet reviewed/merged** as of this writing.
- `origin/main` is at `f902737` ("Add persistent database regression suite") — 8 commits behind this branch.
- **If starting a new checkpoint:** decide whether to branch from `feature/payroll-staffing-and-availability` (continuing the same PR) or wait for it to merge and branch from `main`. Ask the user if unclear — this wasn't specified.

---

## 9. Exact next steps

1. **Check PR #1's status first** — has it been reviewed/merged since this handoff was written? `gh pr view 1 --json state,mergeable`. If merged, start the next checkpoint from a fresh branch off `main`. If still open, ask the user whether to keep stacking commits on `feature/payroll-staffing-and-availability` or branch separately.
2. **Confirm `.env.local` is `mock`** before running anything (see §6.1) — `cat .env.local`.
3. **Wait for the user's next checkpoint instruction.** Based on the pattern established this session (see §2) and the explicit "next checkpoint" recommendation given at the end of the Stage 3 report, the most likely next request is **Manual Rota (assignment)**: a manager UI to assign specific drivers to specific shift_instances, using the availability data now live from Stage 3 (the manager's per-driver availability detail view built this session is a natural building block — surface it alongside an "Assign" action rather than rebuilding it). Do not start this or any other new checkpoint (Auto-Rota, Publish, Attendance, Onfleet, Payroll calculation) without an explicit instruction — the user has been precise and sequential about scope every single checkpoint this session, and each instruction has ended with an explicit "DO NOT BEGIN X" boundary.
4. **If asked to continue Driver Availability polish or fix a bug in it:** re-read §3.9, §4.4, §4.6, and §6.2–6.3 first — the mock-mode identity bridge and the weekday-filtering fix are easy to accidentally regress.
5. **If asked to convert another Stage-1.1 page to live data** (Dashboard, Manager Rota grid, or `MyRota.tsx`): reuse the identity-bridge pattern from §6.2 rather than re-inventing it, and check whether it's now worth centralizing.
6. **General working pattern observed this session** (replicate it): architecture review report-only when the user asks for one → wait for explicit approval/amendment → implement → run full frontend + DB regression suites → manual real-Supabase walkthrough via the browser tool for anything RLS/trigger/multi-role-sensitive → update `docs/business-rules.md` and `docs/db-testing.md` → isolated commit → stop and report using the exact numbered items the user's checkpoint message asked for.
