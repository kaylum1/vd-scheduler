# Handoff — VD Scheduler & Payroll

**Written:** 2026-10-19, at the end of the Live Driver My Rota checkpoint (LD-A database signal + LD-B/C/D repository, page, verification).
**Branch:** `feature/live-driver-rota` (pushed; **no PR opened yet** — the user decides when). Manual Rota is already merged to `main` (PR #2).
**Purpose:** let a fresh Claude Code session (no memory of any conversation) understand exactly what exists, why, and what to do next. Read it fully before touching code.

**IMPLEMENTED (live, real Supabase):** Driver Availability · Manual Rota · Driver My Rota · Configuration (drivers, resorts, shifts, payroll rate rules).
**NOT YET IMPLEMENTED:** real manager **Publish Rota** workflow · **Auto-Rota** · **Attendance** · live manager **Dashboard** · full payroll calculation / finalisation · Onfleet ingestion.
**Exact next checkpoint: AUTO-ROTA** (explicitly part of the main V1 plan), then a **minimal Publish Rota**, then the remaining operational/payroll work. See §N. Do not start it (or anything else in §K) without an explicit instruction.

---

## A. Project goal and working style

VD Scheduler & Payroll is a Supabase-backed scheduling / rota / payroll app for a ski-resort delivery-driver operation (resorts: Crans-Montana, Zermatt, Verbier). Two roles: **manager** (configures resorts, shifts, payroll rules; sees availability; assigns drivers) and **driver** (answers weekly availability; will see their assigned rota).

**Stack:** React 18 + TypeScript + Vite 5, TanStack Query, Supabase (Postgres + Auth + RLS + RPC + PostgREST), vitest 2 + Testing Library (jsdom). `src/repositories/index.ts` is the single factory that picks the **mock** or **Supabase** provider from `VITE_DATA_PROVIDER` (`.env.local`, gitignored).

**How the user works (replicate it):** a strict sequence of numbered checkpoints. Architecture review (report only) → explicit approval/amendments → implementation checkpoint with a detailed spec and a numbered stop-report → each ends with "DO NOT BEGIN X". Every checkpoint: full frontend + DB regression, a real-Supabase browser walkthrough for anything RLS/trigger/multi-role-sensitive, docs (`docs/business-rules.md`, `docs/db-testing.md`, this file), one isolated commit, report, **stop**.

**Standing rules:** never edit a committed migration (append-only; add a new one); never hand-edit `src/types/database.generated.ts` (`npm run db:types`); don't open PRs automatically; don't commit iCloud/filesystem workarounds or scratch smoke scripts; commit messages end with the `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` line; `.env.local` must end every session as `VITE_DATA_PROVIDER=mock`; there is no hosted/linked Supabase project (local only).

## B. Manager features (live, against real Supabase)

- **Configuration** → Drivers (create/edit/deactivate, preferred language), **Resorts** (create/deactivate/reactivate; deactivation blocked while anything operational depends on it), **Resort & Shift Setup** (one manager-facing "Shift": name, start/end, weekdays, effective period, required drivers; refresh/cancel previews), **Payroll Rules** (shift base pay + per-driver delivery rate, effective-dated, Change vs Correct).
- **Rota & Availability** (`#/manager/rota`): one resort selector + one week navigator shared by two live panels — the **Manual Rota** (assign / remove drivers on real shift instances, coverage, historical/published handling; §F) and the **Availability** panel (per-driver status and per-shift answers, read-only).
- **Still Stage 1.1 mock:** the manager **Dashboard** (§K). There is **no Publish control** anywhere yet — weeks are published only by writing `rota_publications` directly (testing).

## C. Driver features

- **Availability** (`#/driver/availability`, live): answer each shift independently, partial save, explicit Confirm / Reopen, publication lock enforced by RLS ("Availability locked"), "Needs reconfirmation" after a real change (§H trigger).
- **My Rota** (`#/driver/my-rota`, **live**): the driver's own published shifts for one Monday–Sunday week, read-only. Tells apart "not published yet" / "no rota was published" (past) / "published, nothing for you" / published with shifts; real "Published"/"Not published" chip; several shifts per day; past published weeks viewable; always-stale query (refetches on mount, week change, focus) so manager edits to a published week appear without republishing. Details in §F2.

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

## F2. Live Driver My Rota (complete)

- **DB (LD-A, migration `20261019100000_driver_safe_publication_status.sql`):** new view `driver_visible_week_publications (resort_id, week_start)` — one row per currently published week of the caller's OWN resort (owner-executed, session-resolved, no driver/resort input, anon rejected). Drivers' direct SELECT policy on `rota_publications` was **dropped** (it exposed `published_by`/`generation_source`); drivers now use only the two safe views. Availability's lock is SECURITY DEFINER code and unaffected. `driver_visible_assignments` unchanged.
- **Repository:** `RotaRepository.getDriverWeekRota({ weekStart, driverId })` → `DriverWeekRota { weekStart, isPublished, shifts: DriverRotaShift[] }` (`DriverRotaShift { shiftInstanceId, date, shiftName, startTime, endTime }`, HH:MM). Pure builder `repositories/driverRotaModel.ts` shared by both providers (sorted date/start/name; unpublished ⇒ always empty). The old all-history `listDriverVisibleAssignments` was removed. **Supabase never sends `driverId`** — two parallel week-scoped view reads; identity is the session. The mock uses `driverId` (no session) and has **no default published week** (dev mock shows "not published yet"; tests publish explicitly).
- **UI:** `pages/driver/MyRota.tsx`, `components/driver-rota/{useDriverWeekRota,DriverRotaDay}`, shared `pages/driver/useDriverRepositoryIdentity.ts` (extracted from Availability; mock-mode identity bridge). Query key `driverRotaKeys.week(driverId, weekStart)`, `staleTime: 0`, `refetchOnWindowFocus: true`; no polling/realtime. A small `white-space: nowrap` on `.week-nav__relation` stops "This Week" wrapping at 375px.
- **Verified against real local Supabase** (real manager/driver logins, publish done directly in the DB because no Publish UI exists): unpublished (even with a hidden draft assignment), published-with-shifts (two shifts same day), published-none, far-future, past never-published, past published, cancelled shift hidden, second same-resort driver sees only their own shifts, manager remove+add on the published week shows after focus refetch with the publication row untouched, REST privacy checks (no base-table access, no unsafe columns, no co-driver/other-resort data, `assign_driver` denied), 375px mobile incl. error + Retry, keyboard/semantics, Driver Availability still locked/editable correctly.

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
Driver-facing reads are separate read models (`DriverWeekRota` + `driverRotaModel.ts`) and never reuse `ManagerWeekRota`; an import-boundary test keeps driver pages/components off Supabase and the manager surface.
Shared UI: `ResortSelector` + `useActiveResortSelection` (`components/ui/ResortSelector.tsx`), `Modal`/`ConfirmDialog`, `StatusPill`, `InlineNotice`.

## J. Test baselines (end of Live Driver My Rota, from a clean reset)

```
npm run db:reset:test && npm run test:db   → 432 assertions, 0 failed, 14 files
npx vitest run (VITE_DATA_PROVIDER=mock)    → 589 passed, 39 files
npm run build                               → clean (tsc -b && vite build); only the pre-existing >500 kB chunk warning
```
DB groups: 00_core_schema 19 · 10_availability_publication 30 · 20_assignments_attendance_adjustments 14 · 30_security_rls_audit 35 · 35_driver_safe_views 33 · 40_materialisation_template_safety 35 · 50_language_onfleet 12 · 60_shift_staffing 21 · 70_atomic_shift_rpcs 27 · 80_resort_lifecycle 36 · 85_manual_rota_assignments 87 · 90_payroll_rate_foundations 29 · 95_payroll_rate_rpcs 31 · 97_payroll_rate_corrections 23.
**Count history:** PR #1 baseline 360 frontend / 320 DB → Manual Rota end (MR-D) 548 frontend / 407 DB → LD-A +25 DB (35_driver_safe_views 8→33, one migration) → Live Driver My Rota +41 frontend (builder 7, Supabase adapter 10, mock adapter 9, page 16 = 42, minus the obsolete `listDriverVisibleAssignments` mock test that was replaced) = 589 / 432.
**Reproduce:** `npx supabase start` → `npm run db:reset:test` → `npm run test:db`; `cat .env.local` must say `mock` before `npx vitest run`. If `.env.local` is `supabase` the suite fails en masse — run `VITE_DATA_PROVIDER=mock npx vitest run` or revert the file. `src/repositories/supabase/resorts.integration.test.ts` talks to the live local stack with the anon key. After `db:reset:test`, run `npm run seed:local-users` to recreate the local logins (`manager@`, `gianni@`, `alex@vd-scheduler.local`; local dev password in `scripts/seed-local-test-users.mjs`).

## K. Known limitations (all deliberate and documented)

- The manager **Dashboard** is still Stage 1.1 mock data (`src/mock-data/*`): it can show an uncovered Verbier Dinner while the live rota correctly shows no shifts. Not to be papered over by mixing real shifts into the mock page. (Driver My Rota is now live.)
- **No Publish Rota UI** (the real publish RPC/UI doesn't exist; the fake preview button was removed in MR-C) — publishing is a direct `rota_publications` write, used only for testing. Until Publish exists, drivers never see a rota in real use. **No Auto-Rota.** **No Attendance UI** (the attendance guard exists in the DB). **No Onfleet integration, no payroll calculation.**
- **No same-driver overlap protection** — a driver can be assigned to overlapping shifts on the same day. **No confirmation on Remove.**
- **Mock revision-ID limitation:** a mock `reviseShift` that recreates a template changes mock instance ids, orphaning mock assignments (the real DB keeps instance identity).
- **Shared `rule_violation` SQLSTATE:** `23514` covers inactive driver / other resort / cancelled shift / over-long reason with no DETAIL, so the repository maps them to one `rule_violation` kind and relies on the DB's first-party message. Distinct kinds need a small DETAIL addition (new migration) — not done.
- **API `max_rows = 1000`:** the manager availability read returns shifts × drivers rows; page it before one resort-week could approach 1000.
- Driver My Rota refreshes on mount / week change / focus only — there is no push; a driver with the app open sees a manager's edit on the next focus or navigation. The dev mock provider has no default published week, so mock-mode My Rota always reads "not published yet" until a test publishes one.
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

- `origin/main` includes PR #1 (merge `76c6030`) and PR #2 — Manual Rota (merge `dd2ca93`: MR-A `c780cd3`, MR-B `30f7432`, MR-C `66e6f3d`, MR-D `19fdc5a`).
- `feature/live-driver-rota` (branched from `main` at `dd2ca93`), oldest → newest:
  ```
  02cccf8  Add driver-safe publication status   (LD-A, DB: publication view, driver table access removed)
  <latest> Add live driver rota                 (repository, page, tests, verification, docs, this handoff)
  ```
- **No PR exists for `feature/live-driver-rota`.** Do not open one without being asked. When it is merged, branch the next checkpoint from the updated `main`.
- **iCloud warning (recurring, real):** the project is under `~/Desktop`; iCloud evicts `.git` objects and `node_modules` files. Symptoms: `git checkout` hanging for many minutes, vitest/tsc hanging, `ETIMEDOUT`, rollup "does not provide an export named VERSION" (a dataless file reads as empty). Check `find . -flags +dataless -type f | wc -l`; re-materialise with a parallel `cat`; for stubborn `node_modules` files run `npm ci` (local only). Never commit workarounds; the real fix (moving the repo out of iCloud-synced storage) is the user's call.

## M2. Auto-Rota progress (in flight on `feature/auto-rota`)

- **AR-A (database/security layer) is done:** migration `20261019110000_auto_rota_apply.sql` — `apply_auto_rota(resort, week, plan jsonb)` (manager-only, atomic, untrusted plan, stale → `VD002`), the per-resort/week advisory lock shared by apply / `assign_driver` / `unassign_driver` / `rota_publications` writes, `supabase/tests/86_auto_rota.sql`. DB baseline is now **524**. Details: `docs/business-rules.md` §O.
- **Not built yet:** the TypeScript planner (AR-B), the repository `generateAutoRota` with one stale-plan retry (AR-B), the Generate Rota UI (AR-C), verification/handoff (AR-D). Approved planner decisions: per-week rotating hash tie-break (`weekStart + driverId`, `driverId` final), weekend group then weekday group, within a group fewest-eligible-drivers first then date/sort_order/start_time/name/id, skip past shifts (today allowed), fairness per resort/week only, no predicted-count preview.

## N. Exact next checkpoint — AUTO-ROTA

**Decided:** Auto-Rota is part of the main V1 plan and is the next product feature; after it comes a **minimal Publish Rota**, then the remaining operational/payroll work (Attendance, live Dashboard, payroll calculation/finalisation, Onfleet ingestion). **None of Auto-Rota is built — do not describe it as implemented.**

**Why Auto-Rota next:** the manual path (Manual Rota → Driver My Rota) now works end to end against real Supabase, so the remaining large gap in the core scheduling loop is generating a good rota instead of hand-assigning every shift.

**Where the design already lives (read before the architecture review the user will ask for first):**
- `docs/business-rules.md` §H.F: weekend-first (Fri/Sat/Sun) then weekday (Mon–Thu) allocation, computed per resort per week; coverage beats fairness; availability is a HARD constraint (only explicit "Available" counts — Not Submitted and Unavailable are ineligible, unlike manual assignment); deterministic tie-breaking (fewest assignments in phase → fewest total → `drivers.created_at` → `drivers.id`, never randomness); a multi-driver Shift needs that many DISTINCT drivers; existing manual assignments are preserved and counted before allocation; no High-value/premium concept.
- `rota_assignments.assignment_source` already allows `'auto'`; `assign_driver`/`unassign_driver` (§F) are the manual write path and own the assignment rules (active driver, same resort, duplicate, past dates, attendance guard) — an Auto-Rota writer should reuse those invariants rather than re-implement them.
- Known gaps it will meet: no same-driver overlap protection (§K), no Publish workflow yet, the `max_rows = 1000` availability read.
- Open product questions for the architecture review: preview-then-apply vs apply directly, regenerate semantics when manual assignments exist, how coverage shortfalls are reported, and whether auto-assigned rows are visually distinguished in Manual Rota.

