# Handoff — VD Scheduler & Payroll

**Written:** 2026-10-20, at the end of Auto-Rota checkpoint AR-D (final verification). **Auto-Rota V1 is complete.**
**Branch:** `feature/auto-rota` (pushed; **no PR opened yet** — the user decides when). `main` already contains Manual Rota (PR #2) and Live Driver My Rota (PR #3).
**Purpose:** let a fresh Claude Code session (no memory of any conversation) understand exactly what exists, why, and what to do next. Read it fully before touching code.

**IMPLEMENTED (live, verified against real local Supabase):** Resort & Shift Setup · Payroll Rules configuration (rates only) · Driver Availability · Manual Rota · Driver My Rota · **Auto-Rota** (planner, atomic apply RPC, per-week lock, stale retry, Generate Rota UI).
**NOT YET IMPLEMENTED:** the real manager **Publish Rota** workflow · **Attendance** UI · live manager **Dashboard** · **Onfleet** integration · full **payroll calculation / finalisation** · overlap / daily-limit / rest rules · cross-week fairness · bulk Auto-Rota undo · **Partner Payments** (a documented future module, `docs/business-rules.md` §E).

**NEXT PRODUCT CHECKPOINT: MINIMAL PUBLISH ROTA** — see §O. Auto-Rota now generates a draft rota and Manual Rota lets the manager review and edit it; the missing operational step is letting the manager publish that draft, so Driver My Rota becomes visible to drivers and Availability locks. Do not start it (or anything in §K) without an explicit instruction.

---

## A. Project goal and working style

VD Scheduler & Payroll is a Supabase-backed scheduling / rota / payroll app for a ski-resort delivery-driver operation (resorts: Crans-Montana, Zermatt, Verbier). Two roles: **manager** (configures resorts, shifts and payroll rules; sees availability; builds the weekly rota by hand or with Auto-Rota) and **driver** (answers weekly availability; sees their own published rota).

**Stack:** React 18 + TypeScript + Vite 5, TanStack Query, Supabase (Postgres + Auth + RLS + RPC + PostgREST), vitest 2 + Testing Library (jsdom). `src/repositories/index.ts` is the single factory that picks the **mock** or **Supabase** provider from `VITE_DATA_PROVIDER` (`.env.local`, gitignored).

**How the user works (replicate it):** a strict sequence of numbered checkpoints. Architecture review (report only) → explicit approval/amendments → implementation checkpoint with a detailed spec and a numbered stop-report → each ends with "DO NOT BEGIN X". Every checkpoint: full DB + frontend regression, a real-Supabase browser walkthrough for anything RLS/trigger/multi-role-sensitive, docs (`docs/business-rules.md`, `docs/db-testing.md`, this file), one isolated commit, report, **stop**. Typical build: DB/security foundation → repository → UI → final verification + handoff.

**Standing rules:** never edit a committed migration (append-only; add a new one); never hand-edit `src/types/database.generated.ts` (`npm run db:types`); don't open PRs automatically; don't commit iCloud/filesystem workarounds or scratch scripts; commit messages end with the `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` line; `.env.local` must end every session as `VITE_DATA_PROVIDER=mock`; there is no hosted/linked Supabase project (local only).

## B. Manager features (live)

- **Configuration** → Drivers (create/edit/deactivate, preferred language), **Resorts** (create/deactivate/reactivate; deactivation blocked while anything operational depends on it), **Resort & Shift Setup** (one manager-facing "Shift": name, start/end, weekdays, effective period, required drivers; refresh/cancel previews), **Payroll Rules** (shift base pay + per-driver delivery rate, effective-dated, Change vs Correct).
- **Rota & Availability** (`#/manager/rota`): one resort selector + one week navigator shared by two live panels — the **Manual Rota** card (assign / remove drivers on real shift instances, coverage pills, historical/published handling, and the **Generate Rota** button in its header; §F, §F3) and the **Availability** panel (per-driver status and per-shift answers, read-only).
- **Still Stage 1.1 mock:** the manager **Dashboard** (§K). There is **no Publish control** anywhere — weeks are published only by writing `rota_publications` directly (used for testing).

## C. Driver features

- **Availability** (`#/driver/availability`, live): answer each shift independently, partial save, explicit Confirm / Reopen, publication lock enforced by RLS ("Availability locked"), "Needs reconfirmation" after a real change (§E trigger).
- **My Rota** (`#/driver/my-rota`, live): the driver's own **published** shifts for one Monday–Sunday week, read-only; distinguishes "not published yet" / "no rota was published" (past) / "published, nothing for you" / published with shifts; refetches on mount, week change and focus. Details §F2. **Until Publish exists, no driver sees any rota in real use.**

## D. Shift model

Manager-facing concept is a single **Shift** (stable `shift_types` identity + per-weekday `shift_templates` rows, Monday=0…Sunday=6). `required_drivers` lives on the Shift (mandatory, `>= 1`); a different staffing need is a separately-named Shift ("Dinner (1P)" vs "Dinner (2P)"). `materialise_shift_instances` snapshots times and `required_drivers` onto `shift_instances` (no rate/financial data on instances). `unique(resort, shift_type, date)`: two shifts on one day need two Shift types (e.g. Lunch and Dinner). Several shifts per day are normal and nothing may hard-code Lunch/Dinner or parse "(1P)/(2P)". `is_premium` is an inert legacy column — no UI, do not resurrect.

## E. Availability model

One answer per (driver, shift_instance): `available` / `unavailable` — **no row = Not Submitted** (never stored). Per-week confirmation lives in `availability_submissions`; publication locks driver edits at the database. The load-bearing trigger `shift_instances_reopen_stale_confirmations()` reopens a confirmed week **only** for `shift_added`, `shift_reinstated`, `shift_time_changed` — never for `required_drivers`, name, pay, or cancellation changes. Do not weaken it.

## F. Manual Rota (complete — MR-A → MR-D)

- Writes only via `assign_driver(shift, driver, confirm_override default false, reason default null) → (assignment_id, availability_state)` and `unassign_driver(shift, driver)`; both `SECURITY DEFINER` + `assert_active_manager()`; managers have **SELECT only** on `rota_assignments`. The server re-reads availability at write time; Unavailable / Not Submitted needs an explicit acknowledgement (`VD001`, DETAIL `unavailable` | `not_submitted`); `required_drivers` is a **minimum** (over-assignment allowed); past shifts blocked (`55006` `historical_shift`); any attendance row blocks unassign (`attendance_recorded`); a published current/future week stays manager-editable and its publication row is never touched; inactive assignees stay visible/removable but never count toward coverage and can't be newly assigned. Optional override reason → `audit_log.context`.
- Layers: migrations `…audit_log_context`, `…manual_rota_assignment_rpcs` → `RotaRepository` / `ManagerWeekRota` / `managerRotaModel.ts` / `lib/rotaCoverage.ts` / typed `AvailabilityOverrideRequiredError`, `RotaAssignmentError` / `rotaErrors.ts` (the only place that knows `VD001`) → `ManualRotaPanel`, `ManualRotaShiftCard`, `AssignDriverDialog` (names the shift), `AvailabilityBadge`, `useManagerWeekRota` (`staleTime: 0`). The shared `Modal` traps focus, closes on Escape and restores focus. An import-boundary test keeps Supabase out of the React layer.
- Since AR-A, `assign_driver` / `unassign_driver` also take the per-resort/week lock (§F3) — behaviour otherwise unchanged (`85_manual_rota_assignments` is the proof).

## F2. Live Driver My Rota (complete — LD-A → LD-D)

- **DB:** view `driver_visible_week_publications (resort_id, week_start)` — one row per currently published week of the caller's OWN resort (owner-executed, session-resolved, no input, anon rejected). Drivers' direct SELECT on `rota_publications` was **dropped** (it exposed `published_by`/`generation_source`); drivers use only the safe views. `driver_visible_assignments` (own, published, active shifts only) unchanged.
- **Repository:** `RotaRepository.getDriverWeekRota({ weekStart, driverId })` → `DriverWeekRota { weekStart, isPublished, shifts[] }`; pure builder `driverRotaModel.ts` shared by both providers; **Supabase never sends `driverId`** (two week-scoped view reads; the session is the identity). The mock has no default published week.
- **UI:** `pages/driver/MyRota.tsx`, `components/driver-rota/*`, `pages/driver/useDriverRepositoryIdentity.ts` (mock-mode identity bridge, shared with Availability), query `driverRotaKeys.week`, `staleTime: 0`, refetch on focus, no polling/realtime.

## F3. Auto-Rota (complete — AR-A → AR-D)

**Architecture: the planner proposes, the database decides.** A pure TypeScript planner chooses WHO fills each open position; one atomic SQL RPC re-validates every proposed pair under a lock and applies all or nothing. The fairness algorithm exists ONLY in TypeScript (so SQL and TS cannot drift); SQL enforces only safety invariants, so a disagreement can only cause a rejection, never an unsafe write.

- **Planner** (`lib/autoRotaPlanner.ts`, pure, no I/O/clock/randomness): `buildAutoRotaPlan({ week: ManagerWeekRota, operationalToday }) → AutoRotaPlan`. Eligible = active candidate, availability for that exact shift `available`, not already assigned (Unavailable / Not Submitted never; no override). Active existing assignments (manual or auto, incl. a manual override) are preserved, count toward coverage and fairness; inactive ones count toward neither. `openSlots = max(required − active, 0)`; never over-assigns; a driver at most once per shift. **Weekend (Fri–Sun) bucket first, then weekday (Mon–Thu)**; per slot the winner has the fewest assignments in that bucket → fewest in total → **weekly tie-break = FNV-1a 32-bit of `${weekStart}:${driverId}`** (`lib/autoRotaHash.ts`, fixed test vectors; rotates by week so equal ties don't always favour one driver) → `driverId`. Within a bucket the **most constrained shift goes first** (fewest eligible drivers), then date, sortOrder, startTime, name, id. Past shifts (before the operational today) are skipped, today is eligible; past assignments still seed the counters. No overlap, daily-maximum or rest rules (§K). Greedy heuristic, not a global optimum.
- **Apply RPC** (migration `20261019110000_auto_rota_apply.sql`): `apply_auto_rota(resort, week, plan jsonb) → (resort_id, week_start, assigned_count, remaining_open_slots, uncovered_shift_ids, skipped_past_shift_count, run_id)`. Manager-only SECURITY DEFINER; the plan is **untrusted** (`[{shift_instance_id, driver_id}]` and nothing else). Under the lock it rejects a published week (`55006 published_week`), a wholly past week (`historical_week`), a past shift (`historical_shift`), and re-validates EVERY pair (shift in this resort/week, active, today or later; driver active, same resort; an explicit `available` row for that exact shift; not already assigned; no duplicates; fits the shift's CURRENT open coverage). Malformed → `22023`; a plan the current state no longer permits → **`VD002` `stale_plan`** (nothing written). Rows are inserted as `assignment_source = 'auto'`, `assigned_by` = the manager, with audit context `{operation: 'auto_rota', run_id, resort_id, week_start, availability_state: 'available', availability_override: false, created_count, uncovered_after}` (never the plan). The result is computed from the DB after the insert.
- **Concurrency:** one transaction advisory lock per resort + week (`rota_week_lock`; keys = the resort UUID's four 32-bit words XOR-ed, and days since 2000-01-01) taken by `apply_auto_rota`, `assign_driver`, `unassign_driver` and a trigger on every `rota_publications` insert/update/delete (so any future Publish path serializes with generation). The apply also row-locks (`FOR SHARE`) the planned shifts, drivers and **availability rows** — a driver's Available→Unavailable change waits for the generation transaction. Verified with two real connections (§J).
- **Repository** `RotaRepository.generateAutoRota({ resortId, weekStart }) → AutoRotaResult` (both providers): read the week → plan → ONE apply call → return the **database's** result. `stale_plan` or `historical_shift` (midnight crossing) triggers exactly one fresh re-read and re-plan (`repositories/autoRotaOrchestration.ts`, shared); a second one surfaces as the typed error. `published_week`, `historical_week`, permission, malformed and unknown errors are never retried. Typed `AutoRotaError` kinds: `published_week`, `historical_week`, `historical_shift`, `stale_plan`, `permission_denied`, `resort_not_found`, `invalid_week`, `invalid_plan`, `unknown` (first-party `userMessage`; SQLSTATEs are mapped only in `supabase/rotaErrors.ts`). The mock uses the same planner/orchestration and refuses published/past weeks.
- **UI** (`ManualRotaPanel` header, `components/rota/autoRotaUi.ts`): **Generate Rota** button; enabled for an unpublished week with a shift today or later (partially historical weeks qualify); disabled with a visible, `aria-describedby`-linked reason for published / wholly historical / no-shift weeks. One confirmation dialog (shared `ConfirmDialog`) naming the resort and week — **no preview**. TanStack mutation → only `managerRotaKeys.week` is invalidated. Notices from the authoritative result: "N assignments added. All scheduled positions are covered." / "… M positions remain uncovered." / "No new assignments were needed. The rota is fully covered." / "No assignments could be added. M positions remain uncovered." (partial coverage is a success, never an error). Typed errors show as an inline alert; published/historical/stale also refetch the week (a publication race flips the page to Published and disables Generate). Notice + dialog reset when resort/week changes. Re-running is safe and additive; the button stays "Generate Rota".

## G. Payroll model (rates only — no payroll calculation yet)

`worked_shift_pay = MAX(shift base guarantee, delivery_total)`, only for `attendance.status = 'worked'`. Shift base pay belongs to the Shift (`shift_base_pay_rules`); delivery rate belongs to the driver (`driver_delivery_rates`); both effective-dated with GIST no-overlap; `shift_instances` owns **zero** financial data. `set_*_rate` = Change (schedule future, strict `effective_from > today` replaces a not-yet-started plan in place); `correct_*_rate` = Correct (fix amount of a still-open row, never dates). A future finalisation guard on corrections is documented, not built (no `driver_shift_payroll` table). Late-delivery double pay is a documented future design only.

## H. Database / RLS / RPC conventions

- Every table RLS-enabled + FORCE. **RLS is the real security boundary**; manager policies `is_active_manager()`-gated, driver policies own-row-only, availability writes gated by `not shift_instance_week_is_published(...)`.
- **Atomic manager RPC pattern:** `SECURITY DEFINER`, `set search_path = public, pg_temp`, `perform assert_active_manager();`, `revoke execute … from public, anon; grant … to authenticated`. `#variable_conflict use_column` when a `RETURNS TABLE` column collides with a column name. PL/pgSQL `RAISE` uses bare `%`.
- **"Today" is always the resort's operational date** (`operational_today`, Europe/Zurich), never `current_date`/the browser date (a test that used `current_date` failed for ~1–2 h every night when UTC and Zurich dates differ — fixed in `95_payroll_rate_rpcs`).
- `audit_log.context jsonb` comes from a transaction-local `app.audit_context` set and cleared by the RPCs (never leaks into a later write).
- Custom SQLSTATEs: `VD001` (assign needs override), `VD002` (stale Auto-Rota plan). Advisory locks: only `rota_week_lock`.
- Deployment policy: no hosted project; every migration only runs through a full local `supabase db reset`. Do a deployment-readiness review before the first persistent environment exists (`docs/db-testing.md`).

## I. Repository architecture

`src/repositories/`: `types.ts` (interfaces), `domain.ts`, `errors.ts`, `queryKeys.ts`, `index.ts` (factory), `mock/*` and `supabase/*` (parallel providers), pure builders `managerRotaModel.ts` / `driverRotaModel.ts` and the shared `autoRotaOrchestration.ts`; planner and hash live in `src/lib/`. React talks to `getRepositories()` only — never Supabase (import-boundary tests). The mock mirrors DB semantics where practical but has no persisted `shift_instances`, triggers, attendance, audit, locks or real concurrency. Mock instance ids are `${templateId}-${date}`. **Two id spaces in mock mode:** Stage 1.1 driver ids (`'gianni'`) vs repository fixtures (`'mock-gianni'`); `repositories/mock/identityBridge.ts` bridges by name (used by `useDriverRepositoryIdentity`). Driver-facing reads are separate read models and never reuse `ManagerWeekRota`.

## J. Test baselines (end of Auto-Rota, from a clean reset)

```
npm run db:reset:test && npm run test:db   → 524 assertions, 0 failed, 15 files
npx vitest run (VITE_DATA_PROVIDER=mock)    → 773 passed, 44 files
npm run build                               → clean (tsc -b && vite build); only the pre-existing >500 kB chunk warning
```
DB groups: 00_core_schema 19 · 10_availability_publication 30 · 20_assignments_attendance_adjustments 14 · 30_security_rls_audit 35 · 35_driver_safe_views 33 · 40_materialisation_template_safety 35 · 50_language_onfleet 12 · 60_shift_staffing 21 · 70_atomic_shift_rpcs 27 · 80_resort_lifecycle 36 · 85_manual_rota_assignments 87 · 86_auto_rota 92 · 90_payroll_rate_foundations 29 · 95_payroll_rate_rpcs 31 · 97_payroll_rate_corrections 23.
**Count history:** PR #1 360 / 320 → Manual Rota end 548 / 407 → Live Driver My Rota 589 / 432 → AR-A DB 524 → AR-B frontend 697 (+108) → AR-C 773 (+76); AR-D added no tests (it fixed a time-of-day flake in `95`).
**Reproduce:** `npx supabase start` → `npm run db:reset:test` → `npm run test:db`; `cat .env.local` must say `mock` before `npx vitest run` (if it says `supabase`, run `VITE_DATA_PROVIDER=mock npx vitest run`). After `db:reset:test`, run `npm run seed:local-users` for the local logins (`manager@`, `gianni@`, `alex@vd-scheduler.local`; password in `scripts/seed-local-test-users.mjs`).
**AR-D real-Supabase verification (all passed):** full manager workflow through the UI on a realistic draft week (fairness, scarcity-first, weekday fairness, multi-driver shift, existing manual / auto / inactive / override assignments, exact-shift availability, partial coverage, zero-eligible, re-run, remove/refill, manual edit then re-run, partially historical current week, wholly historical week, published week, a real publication race); repository-level races (stale availability with and without an alternative driver, a manual assignment between plan and apply — two applies at most, no stale driver assigned, no over-assignment); audit rows (one run id, eight context keys, no plan, no leak); security (driver and anon cannot call `apply_auto_rota`; a driver sees only their own availability, no audit/assignments); two-connection lock regression (assign waits, publication waits, a different week does not, a planned availability row update waits, a publish-first apply is rejected, a driver-flip-first apply is stale); mock-mode UI flow; 375px mobile; keyboard/focus.

## K. Known limitations (all deliberate and documented)

- The manager **Dashboard** is still Stage 1.1 mock data (it can show an uncovered Verbier Dinner while the live rota correctly shows no shifts). Not to be papered over by mixing real shifts into the mock page.
- **No Publish Rota workflow** — publishing is a direct `rota_publications` write used only for testing; **drivers never see a rota in real use until it exists.** No Attendance UI (the attendance guard exists in the DB). No Onfleet integration, no payroll calculation. No Partner Payments module.
- **Auto-Rota V1 scope:** no overlap protection, daily maximum or rest period (a driver may get several — even overlapping — shifts a day if Available for each); **fairness is per resort + week only** (no cross-week fairness); **no bulk undo / clear / regenerate-from-scratch** (a removed auto assignment can be re-added by a later run); the planner is a greedy heuristic, not a global optimum.
- **No confirmation on Remove** in Manual Rota.
- **Mock revision-ID limitation:** a mock `reviseShift` that recreates a template changes mock instance ids, orphaning mock assignments.
- **Shared `rule_violation` SQLSTATE:** `23514` covers inactive driver / other resort / cancelled shift / over-long reason with no DETAIL (mapped to one kind; distinct kinds need a new migration).
- **API `max_rows = 1000`:** the manager availability read returns shifts × drivers rows; page it before one resort-week could approach 1000.
- Driver My Rota refreshes on mount / week change / focus only (no push). Mock-mode My Rota reads "not published yet" until a test publishes.
- After a stale-data failure the manual assign dialog stays open (server message shown); Cancel closes it.
- Bundle-size warning (>500 kB) is cosmetic and pre-existing.
- **iCloud (recurring, real):** the project lives on `~/Desktop`; iCloud evicts `.git` objects, source files and `node_modules` files. Symptoms: `git checkout` hanging for minutes, vitest/tsc hanging, `ETIMEDOUT`, rollup "does not provide an export named VERSION" (a dataless file reads as empty). Check `find . -flags +dataless -type f | wc -l`; re-materialise with a parallel `cat`; for stubborn `node_modules` files run `npm ci` (local only). Never commit workarounds; moving the repo out of iCloud-synced storage is the user's call.

**Deferred review items (from the PR #1 review, untouched on purpose):** mock `identityBridge.ts` name matching; `describeShiftError` generic coverage gap; the required-driver RPC's generic-fallback error mapping; mock `reviseShift`'s effective-date difference from the real RPC; `PayrollRulesPanel`'s unmemoized `categorizeRatePeriods`. Implement none unless asked or a genuine blocker.

## L. Environment / tooling notes

- `.env.local` toggling is the recurring footgun. Supabase mode needs `VITE_SUPABASE_URL=http://127.0.0.1:54321` + the local publishable key; **Vite reads `.env.local` at server start**, so restart the dev server (`vd-scheduler-dev`, port 5173) after switching. Always restore `mock`.
- `npm run db:reset:test` resets the local DB (no seed file — tests insert their own fixtures). The normal local state is **reset + `seed:local-users`**: reproducible, with only the three logins, Crans-Montana/Zermatt/Verbier and the seeded drivers/shift types; walkthrough fixtures are scratch and never committed.
- DB tests run per file through `scripts/run-db-tests.mjs` (`docker exec psql`, each file in a rolled-back transaction). Real two-connection locking cannot be proven inside one test transaction; it is proven structurally in `86_auto_rota` and verified live with two `psql` sessions.
- Mutation-check tests that guard important behaviour (revert the fix, confirm the test fails) — it has caught weak tests repeatedly.

## M. Git history and status

- `origin/main` includes PR #1 (merge `76c6030`), PR #2 Manual Rota (`dd2ca93`) and PR #3 Live Driver My Rota (`cd9db7c`).
- `feature/auto-rota` (branched from `main` at `cd9db7c`), oldest → newest:
  ```
  c89a815  Add atomic auto-rota apply RPC     (AR-A: DB apply, week lock, publication trigger, 86_auto_rota)
  b55088d  Add deterministic auto-rota planner (AR-B: planner, FNV tie-break, repository, mock)
  6cb6438  Add auto-rota generation UI         (AR-C: Generate Rota button, dialog, notices)
  <latest> Complete auto-rota checkpoint        (AR-D: final verification, test fix, docs, this handoff)
  ```
- **No PR exists for `feature/auto-rota`.** Do not open one without being asked. After it is merged, branch the next checkpoint from the updated `main`.

## N. Local data and what NOT to assume

Real local use needs a Supabase stack, the seeded logins, shifts materialised for the weeks you look at, and drivers' availability answered; the app does not invent data. Before a rota can be generated there must be shift instances for the week (`materialise_shift_instances` / Resort & Shift Setup) and drivers marked Available for those exact shifts.

## O. Exact next checkpoint — MINIMAL PUBLISH ROTA

**Why:** the weekly loop is now: drivers submit availability → the manager generates a draft with Auto-Rota → reviews/edits it with Manual Rota. The missing step is **publishing**: nothing a manager builds is visible to drivers, and driver Availability does not lock, until `rota_publications` has a currently published row. Today that row can only be written by hand.

**What "minimal" should mean (for the architecture review the user will ask for first — do not build before approval):**
- One manager action to publish the selected resort + week and (probably) one to unpublish; a Draft/Published chip already exists on the Rota & Availability page (display only).
- A proper atomic RPC (e.g. `publish_rota` / `unpublish_rota`, manager-only, audited) instead of direct table writes. It **must take the per-resort/week lock** (`rota_week_lock`; the trigger on `rota_publications` already does so for any write path) so publish serializes with Auto-Rota and manual edits.
- Existing semantics to preserve: "currently published" = `published_at is not null and unpublished_at is null`; publishing locks driver Availability at the DB; a published week stays manager-editable in Manual Rota (publication row untouched), but **Auto-Rota is refused** (UI disables Generate; server returns `published_week`); drivers read only through `driver_visible_week_publications` / `driver_visible_assignments`.
- Decisions to put to the user: should publishing require full coverage or warn about uncovered shifts and/or unanswered availability; unpublish rules (what happens to the driver lock and confirmed availability); past weeks; a confirmation dialog; whether the Dashboard's fake "published" activity should wait for the live Dashboard.

**After Publish Rota:** Attendance UI → live Dashboard → payroll calculation/finalisation → Onfleet ingestion → the later enhancements in §K (overlap/rest rules, cross-week fairness, bulk Auto-Rota undo) and Partner Payments.
