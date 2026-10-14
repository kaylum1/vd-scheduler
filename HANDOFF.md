# Handoff — VD Scheduler & Payroll

**Written:** 2026-10-14, at the end of Manual Rota checkpoint MR-D (full verification + documentation + handoff).
**Branch:** `feature/manual-rota` (pushed; **no PR opened yet** — the user decides when).
**Purpose:** let a fresh Claude Code session (no memory of any conversation) understand exactly what exists, why, and what to do next. Read it fully before touching code.

**Exact next checkpoint: LIVE DRIVER MY ROTA — before the real Publish Rota UI.** See §N. Do not start it (or anything else listed in §K) without an explicit instruction.

---

## A. Project goal and working style

VD Scheduler & Payroll is a Supabase-backed scheduling / rota / payroll app for a ski-resort delivery-driver operation (resorts: Crans-Montana, Zermatt, Verbier). Two roles: **manager** (configures resorts, shifts, payroll rules; sees availability; assigns drivers) and **driver** (answers weekly availability; will see their assigned rota).

**Stack:** React 18 + TypeScript + Vite 5, TanStack Query, Supabase (Postgres + Auth + RLS + RPC + PostgREST), vitest 2 + Testing Library (jsdom). `src/repositories/index.ts` is the single factory that picks the **mock** or **Supabase** provider from `VITE_DATA_PROVIDER` (`.env.local`, gitignored).

**How the user works (replicate it):** a strict sequence of numbered checkpoints. Architecture review (report only) → explicit approval/amendments → implementation checkpoint with a detailed spec and a numbered stop-report → each ends with "DO NOT BEGIN X". Every checkpoint: full frontend + DB regression, a real-Supabase browser walkthrough for anything RLS/trigger/multi-role-sensitive, docs (`docs/business-rules.md`, `docs/db-testing.md`, this file), one isolated commit, report, **stop**.

**Standing rules:** never edit a committed migration (append-only; add a new one); never hand-edit `src/types/database.generated.ts` (`npm run db:types`); don't open PRs automatically; don't commit iCloud/filesystem workarounds or scratch smoke scripts; commit messages end with the `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` line; `.env.local` must end every session as `VITE_DATA_PROVIDER=mock`; there is no hosted/linked Supabase project (local only).

## B. Manager features (live, against real Supabase)

- **Configuration** → Drivers (create/edit/deactivate, preferred language), **Resorts** (create/deactivate/reactivate; deactivation blocked while anything operational depends on it), **Resort & Shift Setup** (one manager-facing "Shift": name, start/end, weekdays, effective period, required drivers; refresh/cancel previews), **Payroll Rules** (shift base pay + per-driver delivery rate, effective-dated, Change vs Correct).
- **Rota & Availability** (`#/manager/rota`): one resort selector + one week navigator shared by two live panels — the **Manual Rota** (assign / remove drivers on real shift instances, coverage, historical/published handling; §F) and the **Availability** panel (per-driver status and per-shift answers, read-only).
- **Still Stage 1.1 mock:** the manager **Dashboard** (§K).

## C. Driver features

- **Availability** (`#/driver/availability`, live): answer each shift independently, partial save, explicit Confirm / Reopen, publication lock enforced by RLS ("Availability locked"), "Needs reconfirmation" after a real change (§H trigger).
- **My Rota** (`#/driver/my-rota`): **still Stage 1.1 mock** — it shows fabricated data, not the manager's real assignments. This is the reason it is the next checkpoint (§N).

## D. Shift model

Manager-facing concept is a single **Shift** (stable `shift_types` identity + per-weekday `shift_templates` rows, Monday=0…Sunday=6). `required_drivers` lives on the Shift (mandatory, `>= 1`); a different staffing need is a separately-named Shift ("Dinner (1P)" vs "Dinner (2P)"). `materialise_shift_instances` snapshots times and `required_drivers` onto `shift_instances` (no rate/financial data on instances). Several shifts per day are normal and nothing may hard-code Lunch/Dinner or parse "(1P)/(2P)". `assembleShift()` collapses templates into a `ShiftRecord` and flags legacy-inconsistent data as "Review required". `is_premium` is an inert legacy column — no UI, do not resurrect.

## E. Availability model

One answer per (driver, shift_instance): `available` / `unavailable` — **no row = Not Submitted** (never stored). Per-week confirmation lives in `availability_submissions`; publication locks driver edits at the database. The load-bearing trigger `shift_instances_reopen_stale_confirmations()` reopens a confirmed week **only** for `shift_added`, `shift_reinstated`, `shift_time_changed` — never for `required_drivers`, name, pay, or cancellation changes. Do not weaken it. Manager visibility is plain authorised reads (no RPC).

## F. Manual Rota (complete — MR-A → MR-D)

**Rules (database owns them):**
- Writes only via `assign_driver(p_shift_instance_id, p_driver_id, p_confirm_availability_override default false, p_reason default null) → (assignment_id, availability_state)` and `unassign_driver(p_shift_instance_id, p_driver_id) → (assignment_id)`; both `SECURITY DEFINER` + `assert_active_manager()`. Managers keep **SELECT only** on `rota_assignments` (direct INSERT/UPDATE/DELETE revoked → 42501); drivers/anon cannot call them.
- The server re-reads availability itself at write time (stale-client safe). Unavailable or Not Submitted requires an explicit acknowledgement; Available assigns directly. `required_drivers` is a **minimum** — over-assignment is allowed (shown plainly as Covered, e.g. 3 / 2).
- Error contract: `42501` not manager · `P0002` not found · `23514` rule violation (inactive driver, other resort, cancelled shift, reason > 500) · `23505` duplicate · `55006` locked (DETAIL `historical_shift` | `attendance_recorded`) · `VD001` override required (DETAIL `unavailable` | `not_submitted`).
- Past shifts (before operational today, Europe/Zurich via `operational_today`) are blocked; **any** attendance row blocks unassign; published current/future weeks stay manager-editable and the `rota_publications` row is never touched; inactive assignees stay visible and removable but don't count toward coverage and can't be newly assigned.
- Optional override reason → `audit_log.context` (`operation`, `availability_state`, `availability_override`, `reason`), manager-visible only; there is no reason column on `rota_assignments`.

**Layers:** DB migrations `20261009100000_audit_log_context.sql`, `20261009100100_manual_rota_assignment_rpcs.sql` → repository (`RotaRepository`, `ManagerWeekRota`, pure builder `managerRotaModel.ts`, `lib/rotaCoverage.ts`, typed `AvailabilityOverrideRequiredError` / `RotaAssignmentError`, Supabase `rotaErrors.ts` is the only place that knows `VD001`) → UI (`ManualRotaPanel`, `ManualRotaShiftCard`, `AssignDriverDialog`, `AvailabilityBadge`, `useManagerWeekRota` with `staleTime: 0`, `rotaErrorMessages.ts`). The page owns resort/week; both panels receive props. An import-boundary test forbids Supabase in the React layer.

**UI behaviour:** Covered/Uncovered pill + `N / required active assigned`; Available-first candidate list with icon+text badges; ONE combined confirmation dialog (Not Submitted, Unavailable, already-covered, or any combination, plus optional reason ≤ 500) that **names the exact shift**; race-safe — every normal assign attempt handles the server's override-required error and opens the dialog for the state the *server* reports; Historical cards are read-only; a published week shows an info note, no Publish/Unpublish control, and manager edits never unpublish it; manager-facing error messages, never SQLSTATEs.

**MR-D verification (real local Supabase, real manager + real driver logins):** all flows passed — page load, shared resort/week switching, Available / Unavailable / Not Submitted, stale-client race (driver flips availability behind the page), coverage transitions, over-assignment, combined warning, remove, attendance guard, historical (UI read-only + direct RPC 55006), inactive assignee, published-week edit with untouched publication row and audit rows, driver privacy (13/13 REST checks: no base-table read, no RPC, no audit, own availability only, safe view leaks no co-driver/headcount), manager RPC-only writes (6/6), zero-shift weeks and Verbier, multiple shifts per day, duplicate / assignment-gone / attendance messages, mock-mode regression, 375px mobile walkthrough, keyboard/accessibility pass.
**MR-D fixes (tiny, found by the walkthrough):** (1) dialogs now name the shift; (2) the shared `Modal` now traps Tab/Shift+Tab, and returns focus to the opener on close (`Modal.test.tsx`).

## G. Payroll model (rates only — no payroll calculation yet)

`worked_shift_pay = MAX(shift base guarantee, delivery_total)`, only for `attendance.status = 'worked'`. Shift base pay belongs to the Shift (`shift_base_pay_rules`); delivery rate belongs to the driver (`driver_delivery_rates`); both effective-dated with GIST no-overlap exclusion; `shift_instances` owns **zero** financial data (rates are resolved at calculation time against the real date). `set_*_rate` = Change (schedule future, strict `effective_from > today` to replace a not-yet-started plan in place); `correct_*_rate` = Correct (fix amount of a still-open row, never dates; closed periods rejected 55006). A future finalisation guard on corrections is documented, not built (no `driver_shift_payroll` table). Late-delivery double pay is a documented future design only.

## H. Database / RLS / RPC conventions

- Every table RLS-enabled + FORCE. **RLS is the real security boundary**; manager policies are `is_active_manager()`-gated, driver policies own-row-only, availability writes additionally gated by `not shift_instance_week_is_published(...)`.
- **Atomic manager RPC pattern:** `SECURITY DEFINER`, `set search_path = public, pg_temp`, `perform assert_active_manager();`, `revoke execute … from public; grant … to authenticated` (and anon explicitly revoked where relevant). `#variable_conflict use_column` whenever a `RETURNS TABLE` column collides with a column name. PL/pgSQL `RAISE` uses bare `%` (not `%s`).
- **Effective-dating idiom:** `exclude using gist (key with =, daterange(effective_from, coalesce(effective_to,'infinity'),'[]') with &&) where (is_active)`.
- Key RPCs: shift lifecycle (`create/revise/deactivate/reactivate_shift`), materialisation/refresh/cancellation, resort lifecycle, payroll rate set/correct, availability (`week_availability_status`, `confirm_availability_week`, `reopen_availability_week`), Manual Rota (`assign_driver`, `unassign_driver`). Driver-safe views `driver_visible_shifts` / `driver_visible_assignments` (published weeks only; no driver identity, co-driver, headcount, pay, availability or reason columns).
- `audit_log.context jsonb` is populated from a transaction-local `app.audit_context` set and cleared by the RPCs (never leaks into a later write; malformed context stored as NULL, never fails a write).
- Deployment policy: no hosted project, so every migration only ever runs through a full local `supabase db reset`; `20260916090000_simplify_shift_staffing.sql` depends on a clean reset (accepted). Do a deployment-readiness review before the first persistent environment exists (`docs/db-testing.md`).

## I. Repository architecture

`src/repositories/`: `types.ts` (interfaces), `domain.ts` (domain types), `errors.ts`, `queryKeys.ts`, `index.ts` (factory), `mock/*` and `supabase/*` (parallel providers), `managerRotaModel.ts` (pure builder fed by both providers so they can't drift). React code talks to `getRepositories()` only — never Supabase. Mock provider fidelity is a real maintenance burden: it mirrors DB semantics where practical but has no persisted `shift_instances`, no DB triggers, and (for Manual Rota) no attendance, audit or cancelled shifts; tests that need trigger outcomes fabricate the resulting row. Mock instance ids are `${templateId}-${date}`.
**Two id spaces in mock mode:** the Stage 1.1 driver switcher uses `'gianni'`-style ids; repository mock fixtures use `'mock-gianni'`. `repositories/mock/identityBridge.ts` bridges by **name** and is used only by the live Availability page. Any new live driver page must reuse it in mock mode (Supabase mode ids are already real). Consider centralising it in `useAuth()` when Live Driver My Rota needs it.
Shared UI: `ResortSelector` + `useActiveResortSelection` (`components/ui/ResortSelector.tsx`), `Modal`/`ConfirmDialog`, `StatusPill`, `InlineNotice`.

## J. Test baselines (MR-D, from a clean reset)

```
npm run db:reset:test && npm run test:db   → 407 assertions, 0 failed, 14 files
npx vitest run (VITE_DATA_PROVIDER=mock)    → 548 passed, 37 files
npm run build                               → clean (tsc -b && vite build); only the pre-existing >500 kB chunk warning
```
DB groups: 00_core_schema 19 · 10_availability_publication 30 · 20_assignments_attendance_adjustments 14 · 30_security_rls_audit 35 · 35_driver_safe_views 8 · 40_materialisation_template_safety 35 · 50_language_onfleet 12 · 60_shift_staffing 21 · 70_atomic_shift_rpcs 27 · 80_resort_lifecycle 36 · 85_manual_rota_assignments 87 · 90_payroll_rate_foundations 29 · 95_payroll_rate_rpcs 31 · 97_payroll_rate_corrections 23.
**Count history:** PR #1 baseline 360 frontend / 320 DB → MR-A +87 DB (407) → MR-B/MR-C → 544 frontend → MR-D +4 (1 dialog-names-the-shift test, 3 `Modal` focus tests) = 548. DB unchanged in MR-D.
**Reproduce:** `npx supabase start` → `npm run db:reset:test` → `npm run test:db`; `cat .env.local` must say `mock` before `npx vitest run`. If `.env.local` is `supabase` the suite fails en masse — run `VITE_DATA_PROVIDER=mock npx vitest run` or revert the file. `src/repositories/supabase/resorts.integration.test.ts` talks to the live local stack with the anon key. After `db:reset:test`, run `npm run seed:local-users` to recreate the local logins (`manager@`, `gianni@`, `alex@vd-scheduler.local`; local dev password in `scripts/seed-local-test-users.mjs`).

## K. Known limitations (all deliberate and documented)

- **Dashboard** and **Driver My Rota** are still Stage 1.1 mock data (`src/mock-data/*`): the Dashboard can show an uncovered Verbier Dinner while the live rota correctly shows no shifts. Not to be papered over by mixing real shifts into mock pages.
- **No Publish Rota UI** (the real publish RPC/UI doesn't exist; the fake preview button was removed in MR-C). **No Auto-Rota.** **No Attendance UI** (the attendance guard exists in the DB). **No Onfleet integration, no payroll calculation.**
- **No same-driver overlap protection** — a driver can be assigned to overlapping shifts on the same day. **No confirmation on Remove.**
- **Mock revision-ID limitation:** a mock `reviseShift` that recreates a template changes mock instance ids, orphaning mock assignments (the real DB keeps instance identity).
- **Shared `rule_violation` SQLSTATE:** `23514` covers inactive driver / other resort / cancelled shift / over-long reason with no DETAIL, so the repository maps them to one `rule_violation` kind and relies on the DB's first-party message. Distinct kinds need a small DETAIL addition (new migration) — not done.
- **API `max_rows = 1000`:** the manager availability read returns shifts × drivers rows; page it before one resort-week could approach 1000.
- After a stale-data failure the assign dialog stays open (server message shown, refreshed week behind it); Cancel closes it.
- **iCloud:** this project lives on `~/Desktop`, which iCloud can evict (`node_modules` → ETIMEDOUT / vitest hangs). Check `find node_modules -flags +dataless | head`, re-materialise; never commit workarounds, never restructure the repo for it.
- Bundle-size warning (>500 kB) is cosmetic and pre-existing.

**Deferred review items (from the PR #1 review, untouched on purpose):** mock `identityBridge.ts` name matching; `describeShiftError` generic coverage gap; the required-driver RPC's generic-fallback error mapping; mock `reviseShift`'s effective-date semantic difference from the real RPC; `PayrollRulesPanel`'s unmemoized `categorizeRatePeriods`. Implement none unless asked or a genuine blocker.

## L. Environment / tooling notes

- `.env.local` toggling is the recurring footgun (§J). Supabase mode needs `VITE_SUPABASE_URL=http://127.0.0.1:54321` + the local publishable key; **Vite reads `.env.local` at server start**, so restart the dev server (`vd-scheduler-dev`, port 5173) after switching.
- `npm run db:reset:test` resets the local DB (no seed file — tests insert their own fixtures; a reset leaves empty tables). Local DB state after MR-D: reset + `seed:local-users` run, i.e. **reproducible and empty** — walkthrough fixtures are not kept (the walkthrough SQL was scratch and is not in the repo).
- DB tests run per file through `scripts/run-db-tests.mjs` (`docker exec psql`, each file in a rolled-back transaction).
- Mutation-check tests that guard important behaviour (revert the fix, confirm the test fails) — it has caught weak tests in MR-A and MR-D.

## M. Git history and status

- `origin/main` includes PR #1 (merge commit `76c6030`, "Merge pull request #1 from kaylum1/feature/payroll-staffing-and-availability").
- `feature/manual-rota` (branched from `main` after that merge), oldest → newest:
  ```
  c780cd3  Add manual rota assignment RPCs        (MR-A, DB)
  30f7432  Add manual rota repository             (MR-B)
  66e6f3d  Add live manual rota UI                (MR-C)
  <latest> Complete manual rota checkpoint        (MR-D: verification fixes + docs + this handoff)
  ```
  (the pre-Manual-Rota cleanup `728bde1` "Prepare manual rota foundation" is already on `main` via PR #1.)
- **No PR exists for `feature/manual-rota`.** Do not open one without being asked. When it is merged, branch the next checkpoint from the updated `main`; until then, branch from `feature/manual-rota` only if the user says so.

## N. Exact next checkpoint — LIVE DRIVER MY ROTA (before the real Publish Rota UI)

**Why this, why now:** Manual Rota is complete, so real manager assignments now exist in the database, but the driver's **My Rota** is still the Stage 1.1 mock — a driver cannot see any of them. Building Publish Rota first would let a manager "publish" a rota that drivers literally cannot see. Making My Rota live first gives Publish something real to publish *to*, lets the published-week rules (manager edits are visible immediately) be verified from the driver side, and is the lower-risk, read-only slice.

**Sketch (for the architecture review the user will ask for first — do not start before then):**
- Read only through the existing driver-safe views (`driver_visible_assignments` / `driver_visible_shifts`: published weeks only, no co-driver, no headcount, no pay) via a new driver-facing repository method on both providers; never reuse the manager `ManagerWeekRota` shapes (privacy boundary).
- Replace `src/pages/driver/MyRota.tsx` (Stage 1.1) and reuse the mock identity bridge (§I) for mock mode; decide whether to centralise it in `useAuth()`.
- Decide: week navigation, empty/unpublished states ("Once the manager publishes…"), how a manager's later edit to a published week appears, and whether any "changed since you last looked" signal is wanted (likely not in V1).
- Needs real-Supabase walkthrough with a real driver login plus REST privacy checks (the MR-D `privacy` script pattern: base table empty, no RPC, no co-driver leakage).

**After that (not started, do not begin):** real Publish Rota UI + RPC → live Dashboard → Attendance UI → Auto-Rota (design in `docs/business-rules.md` §H) → Onfleet → payroll calculation.
