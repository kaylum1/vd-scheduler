# Product / business rules

Durable product decisions that aren't fully derivable from the code or
migrations alone — recorded here so a future session (Claude or human)
doesn't have to re-litigate them. Each entry says what's *decided*, and
separately, what's actually *implemented* as of the stage/checkpoint noted.
An entry existing here does not imply its UI exists yet — check the
"Implemented" line.

---

## A. Coverage states — "no service" and "uncovered"/"covered"

**Decided:** Stage 2D Checkpoint 1.1 (states 1 and 3); briefly extended to a
third "staffing not configured" state in Checkpoint 3 (`rota_rules_*`), then
**simplified back to two states** by the Stage 2D staffing simplification,
which made `required_drivers` mandatory on the Shift itself at creation
time — a materialised instance can never be missing it any more, so the
"not configured" state no longer arises in normal operation.

A calendar date/cell with **no active `shift_instance`** is a normal,
expected no-service state. It must render as neutral/grey — e.g. "No
service scheduled" or a visually blank/disabled cell. It must **never**
render as:

- "No coverage"
- "No drivers assigned"
- "0/x covered"
- a closure warning

Red/uncovered styling is reserved for: **an active real shift exists, and
assigned driver count < required_drivers** (always a real, positive,
mandatory number as of the staffing simplification).

| Scenario | required_drivers | Rendering |
|---|---|---|
| No Dinner shift_instance exists Monday | n/a (no row) | Grey / neutral — "no service" |
| Dinner exists, required_drivers=1, assignments=0 | `1` | Red — "uncovered" |
| Dinner exists, required_drivers=1, assignments=1 | `1` | Green — "covered" |

**Why it matters:** conflating "no service" with "uncovered" makes every
resort with a lighter schedule (or one not yet configured, like a brand-new
resort) look like it's in a permanent coverage crisis.

**Legacy defensive state:** `coverageTone`/`coverageLabel` still accept
`required: number | null` and render `null` as amber/"Staffing not
configured" — this is a defensive fallback for any pre-simplification data
that predates the mandatory constraint, never a normal state a manager
should expect to see on data created since. New Shifts can never produce it.

**Implemented:**

- [`coverageTone`/`coverageLabel`](../src/components/ui/StatusPill.tsx) —
  pure functions that render coverage for a shift *already known to exist*.
  Never called for a "no shift" cell.
- [`ManualRotaPanel`](../src/components/rota/ManualRotaPanel.tsx) — renders
  only the shift instances the repository returns, grouped by day (no
  fabricated empty days); a week with none shows the neutral "No shifts are
  scheduled for this week." and never "Uncovered". Coverage per shift comes
  from the shared [`getShiftCoverage`](../src/lib/rotaCoverage.ts) (active
  assignees only — see section K).
- [`TodayTomorrowPanel`](../src/components/dashboard/TodayTomorrowPanel.tsx) —
  renders "No shifts scheduled" (muted chip) when a resort has zero shifts
  that day, and only computes/renders "No coverage" per-shift for shifts
  that do exist.
- [`rotaReadiness`](../src/lib/rotaReadiness.ts)'s `uncoveredShifts` is
  filtered from the resort's actual generated shift instances, never
  inferred from an assumed/expected shift.
- [`materialise_shift_instances`](../supabase/migrations/20260916090000_simplify_shift_staffing.sql) —
  snapshots `required_drivers` directly from the governing Shift
  (`shift_templates`) at materialisation time. No rota-rule join, no
  precedence, no missing-staffing count of any kind — required_drivers is
  mandatory at Shift-creation time, so it can never be missing.

Tests: [`StatusPill.test.ts`](../src/components/ui/StatusPill.test.ts),
[`ManualRotaPanel.test.tsx`](../src/components/rota/ManualRotaPanel.test.tsx).

**Known temporary inconsistency (not a bug to fix here):** the Manager
**Dashboard** is still Stage 1.1's mock data (`src/mock-data/shifts.ts`), which
fabricates a Dinner shift for every resort every day — including Verbier, which
the *live* Configuration page and the *live* Manual Rota (Rota & Availability)
correctly show has no shifts. So the Dashboard can show an uncovered Verbier
Dinner while Manual Rota shows "No shifts are scheduled for this week." This is
a mock/live data source mismatch, not a presentation-logic bug, and is **not**
to be papered over by mixing real shifts into the mock page. The Manager Rota
(sections J–L) and Driver My Rota (section N) are now live; the Dashboard goes
live in a later checkpoint.

---

## B. Onfleet mapping is explicit, never fuzzy-matched

**Decided:** originally Stage 2A (`driver_onfleet_mappings` schema), UI
added Stage 2D Checkpoint 1.1.

A driver's display name and their Onfleet identity are **distinct
concepts** — `drivers.full_name == onfleet_worker_id` is never required or
assumed. The mapping is a separate, explicit, human-confirmed link
(`driver_onfleet_mappings`), entered by a manager typing the worker name
exactly as Onfleet shows it.

Rules:
- A driver may exist with **zero** Onfleet mappings — creation is never
  blocked on this.
- At most **one active mapping per driver** at a time (enforced by
  `driver_onfleet_mappings_driver_active_unique`). "Editing"/"replacing" a
  mapping means: deactivate the old one, create a new one — the old identity
  stays as inactive history, never overwritten in place.
- The same Onfleet identity can't be actively claimed by two drivers at the
  same resort at once (`driver_onfleet_mappings_active_identity_unique`,
  pre-existing since Stage 2A).
- Onfleet mappings are manager-only data — no driver-facing RLS policy
  exists on `driver_onfleet_mappings` at all.

**Future Onfleet CSV import (not implemented yet)** must keep obeying:
- never fuzzy-match a name to a driver;
- never silently guess an ambiguous or unmatched identity;
- an unmatched identity becomes an Exception / Needs Attention item — it
  must never cause other, valid rows in the same import to be discarded.

**Implemented (Checkpoint 1.1):** `driver_onfleet_mappings_driver_active_unique`
(migration `20260908194149_driver_language_and_onfleet.sql`),
`set_driver_onfleet_mapping()` RPC (atomic replace), repository methods
`listActiveOnfleetMappings`/`setOnfleetMapping`, and Configuration's
Create/Edit Driver Onfleet section + "Onfleet linked"/"not linked" list
badge. CSV import itself is **not** implemented.

---

## C. Published rota is not immutable to managers

**Decided:** Stage 2D Checkpoint 1.1 (recorded ahead of implementation).

Publication means:
- drivers can no longer edit their availability for that resort/week;
- drivers can see the published rota;
- automated scheduling must never silently rewrite a published week.

It does **not** mean a manager is locked out of it. An authorised manager
must be able to open a published shift and deliberately edit its
assignments — add/remove/change drivers — while the week stays published,
with the change audited. Automatically unpublishing the week on a manager
edit is explicitly the wrong behaviour.

Example: a driver said unavailable before publication; the rota published;
the driver later confirms by WhatsApp they can actually work. The manager
assigns them anyway. If the driver's recorded availability for that shift is
`unavailable`, the future UI should surface a warning first —
`"<Driver> marked themselves unavailable for this shift. Assign anyway?"`
— but must let the manager proceed.

The override should eventually carry an optional note/reason (e.g.
`"Driver confirmed availability by WhatsApp"`). Audit must retain: the
manager actor, the before/after assignment state, and the timestamp.

**Schema note (recorded, not built):** `audit_log` (Stage 2A) already
captures actor/before/after/timestamp generically for any audited table
update, which covers the actor/before/after/timestamp requirement above
without new schema. The one plausible future gap is a dedicated
free-text **override reason** on the assignment-edit operation — there's no
column for it today on `rota_assignments`, and it likely wants to live on
whatever RPC eventually performs "assign despite recorded unavailable"
(e.g. as a parameter written into a dedicated note field or into
`audit_log`'s existing structure), not as a speculative column added now.
No schema change is being made for this in Checkpoint 1.1 — flagged here
for the checkpoint that actually builds manual rota editing to decide against
the concrete UI it's building at that point.

**Implemented (database layer only — Manual Rota MR-A):** the rules above are
now enforced in the database by `assign_driver` / `unassign_driver` — see
section J. The unavailable-driver warning/override is DB-enforced, a manager
may edit assignments in a published current/future week without unpublishing
it, and every change is audited. The manager UI for this is implemented (MR-C,
section L). The optional override reason, which the schema note above left
open, lives in `audit_log.context`, not on `rota_assignments`.

---

## D. Driver preferred language

**Decided and implemented:** Stage 2D Checkpoint 1.1.

Every driver has a `preferred_language`, defaulting to `en`. V1 supports
`en` (English) and `fr` (French), listed in a `supported_languages`
reference table rather than a hard-coded `CHECK` constraint, so adding a
third language later is one `INSERT`, not a migration that rewrites the
`drivers` table.

It lives on the **driver profile**, not on `app_users` (the login/session
record), because:
- it may need to be set during onboarding, before any login exists;
- it must survive a login being replaced (account provisioning is
  deliberately separate from the driver record — see Stage 2B);
- a manager configures it as part of driver onboarding, not as an
  auth concern.

It is **not** used for any actual translation yet — the manager UI, and the
driver UI, both stay English-only for now. It becomes authoritative for
driver-UI localisation starting Stage 3.

**Implemented:** `supported_languages` table + `drivers.preferred_language`
(migration `20260908194149_driver_language_and_onfleet.sql`), domain/
repository/mock updates, and the Create/Edit Driver language picker in
Configuration.

---

## E. Future module: Partner Payments (separate from Driver Payroll)

**Decided:** Stage 2D Checkpoint 1.1 (roadmap item, not built).

A future manager module, **distinct from Driver Payroll**: handles the
payment/reconciliation workflow for restaurant/business partners, including
an Excel-spreadsheet-based workflow. The user already has an existing app
that implements this process — the future work here should **investigate
integrating with or reusing that existing app** rather than rebuilding the
logic from scratch.

Likely future manager navigation (not implemented):

```
Dashboard
Rota & Availability
Payroll
Partner Payments   <- new
Configuration
```

**Implemented:** nothing. No page, no navigation entry, no schema. This is
a roadmap placeholder only, so the requirement isn't lost between sessions.

---

## F. Manager terminology: "Shift", not shift type/template/key

**Decided:** Stage 2D Checkpoint 4.

Managers think and speak in terms of a single object, **"Shift"** (e.g.
"Dinner", "Lunch") — one name, one standard time window, the set of
weekdays it runs on, and one effective period. The backend concepts that
implement this — `shift_types` (stable identity + internal `key`),
per-weekday `shift_templates` rows, the Monday=0..Sunday=6 weekday integer,
resort timezone — remain real and necessary, but are never manager-facing
terminology or fields from Checkpoint 4 onward. The manager-facing Shift
Setup UI must never show "shift type", "template", "template version",
"weekday template", "stable key", or a raw weekday integer.

**One shift, one time, one staffing requirement:** a Shift has exactly one
start/end time and one `required_drivers` count across every weekday it's
currently active on. A service that genuinely needs a different time or a
different staffing level on a different day (or season) is a **separate**
Shift (e.g. "Weekend Dinner", or "Dinner (1P)" / "Dinner (2P)" — see
section H), never a per-weekday time or headcount on one Shift. The atomic
RPCs (`create_shift`/`revise_shift`/`reactivate_shift`) enforce this by
construction — they take one time and one staffing count for the whole
weekday selection, so there is no way to create per-weekday times or
headcounts through them.

**Legacy inconsistent data — never silently flattened:** the pre-
Checkpoint-4 UI *did* allow different times on different weekdays of the
same shift type (it wrote `shift_templates` rows one weekday at a time,
each with its own time), and pre-staffing-simplification data can have
different `required_drivers` values across weekdays too. Data like that can
still exist. When the current UI assembles a shift type's current templates
into one "Shift" and finds they don't actually share one time, one staffing
count, and one effective period, it does **not** guess which row is
authoritative — it shows a review-required notice ("This shift has
different times configured on different days...") instead of a schedule,
and disables the simplified Edit form for it. See
[`assembleShift`](../src/repositories/assembleShift.ts) and
[`ShiftSetupPanel`](../src/pages/manager/configuration/ShiftSetupPanel.tsx).
Resolving such a shift today requires direct database correction
(deliberately out of scope for the simplified UI); a future checkpoint may
add an in-UI resolution flow.

**Zero templates is a different, non-error state (fixed Stage 2D Payroll
Checkpoint B):** a shift type with **no** `shift_templates` rows at all
(e.g. one created directly, outside the atomic RPCs, before any schedule
was ever set) also gets `schedule: null` from `assembleShift`, but `
inconsistentWeekdays` is left empty for this case specifically — it is
"nothing configured yet", not "conflicting data". `ShiftSetupPanel` renders
this as a neutral "No recurring schedule configured yet." notice (never the
inconsistent-times wording) and leaves Edit enabled, since there is nothing
to silently flatten — a manager can configure the schedule fresh through the
normal Edit form. Only a genuinely inconsistent shift (`inconsistentWeekdays`
populated) still disables Edit and shows the review-required notice above.

**"Last known schedule" for an inactive Shift** (shown on its Inactive
card, and pre-filled as Reactivate's starting point) is reconstructed from
whichever `shift_templates` rows share the *latest* `updated_at` for that
shift type — not the latest `effective_to`. Two distinct retirement events
(e.g. a weekday dropped by an edit, then the whole Shift deactivated later
the same day) can coincidentally share an `effective_to` *calendar date*
while being genuinely different historical batches; `updated_at` (a real
instant, unique per transaction) is what tells them apart. This exact
scenario was found by manual testing during Checkpoint 4 and is covered by
a permanent regression test (see `mock/shiftConfiguration.test.ts` and
`ShiftSetupPanel.test.tsx`).

**Implemented:** `ShiftRecord`/`assembleShift` (repository layer),
`ShiftSetupPanel` (Add/Edit/Deactivate/Reactivate, replacing the old Shift
Types + Recurring Shift Schedule two-layer UI), the atomic
`create_shift`/`revise_shift`/`deactivate_shift`/`reactivate_shift` RPCs
(Stage 2D Checkpoint 3).

---

## G. Payroll: the base/delivery formula and rate ownership

**Decided:** Stage 2D Payroll Checkpoint A (architecture review + amendment),
correcting the provisional ownership model Checkpoint 3 established.

**A. Formula.** For a driver's worked shift:

```
if attendance = worked:
  delivery_total   = SUM(driver's delivery rate x each delivery's multiplier)
  worked_shift_pay = MAX(shift base guarantee, delivery_total)
else:
  worked_shift_pay = 0   -- no base guarantee; see E and the exceptions note below
```

**Never additive** — base and delivery earnings are never summed, only
compared. Example: Dinner base CHF 30, driver rate CHF 12/delivery — 0-2
completed deliveries pay CHF 30 (base wins); 3 deliveries pay CHF 36; 4 pay
CHF 48 (delivery wins). `payroll_adjustments` (expense/bonus/other-addition/
deduction) are applied after this per-driver result, entirely separate from
the formula itself.

**B. Shift base-pay ownership.** Belongs to the stable Shift
(`shift_type_id`, scoped to `resort_id`), effective-dated, in
`shift_base_pay_rules` (renamed from `payroll_rules` — see below). Different
Shifts may have different guarantees (e.g. Dinner CHF 30, Lunch a different
value).

**C. Driver delivery-rate ownership.** Belongs to the **driver**, not the
Shift, effective-dated, in `driver_delivery_rates`. All drivers happening to
share CHF 12 today is operational coincidence, never a hardcoded system
default — the schema has no permanent global rate anywhere.

**D. Multiple drivers, one shift.** Each attending driver's `worked_shift_pay`
is calculated **independently** — their own base comparison, their own
delivery total, from their own rate. Never one combined shift payout, never a
base guarantee shared/split between drivers.

**E. Attendance gates the base guarantee.** Only `attendance.status = 'worked'`
earns the Shift's base guarantee; `no_show`/`excused`/`cancelled` do not — an
excused absence does not automatically earn base pay (if management wants to
pay someone anyway despite not working, that is a `bonus`/`other_addition`
adjustment, never a change to attendance semantics). **Missing attendance**
(no row at all) will become a targeted "Attendance not recorded" payroll
exception once payroll calculation exists — it blocks only that one
driver+shift line, never the whole run, and never assumes worked or absent
from the published rota. This **supersedes** the earlier documented
published-rota-fallback-with-warning concept for payroll purposes specifically
(that concept predates base pay depending on attendance; it was never
implemented, so nothing is being changed in code by this decision, only the
documented rule). **Completed deliveries recorded for a driver marked
non-worked** are a data inconsistency, not a payroll decision either way — a
future "Needs Attention" exception, never silently paid and never silently
discarded.

**F. Late-delivery double pay (design truth only — not implemented).** An
Onfleet delivery whose **restaurant pickup** is scheduled at **21:20 or
later**, in the resort's own operational local time, becomes *eligible* for a
manager Normal/Double decision on the Dashboard (never automatic). The
eventual state model is three-way — **PENDING / NORMAL / DOUBLE** — not a
`multiplier` defaulting to `1`: an eligible late delivery with no manager
decision must never silently behave as Normal; it blocks that delivery's
contribution to payroll until resolved. A non-late delivery needs no manual
confirmation at all — normal (×1) is implicit. Doubling applies **only** to
that one delivery's own contribution to `delivery_total` — never the base
guarantee, never the whole shift, never other deliveries.

**G. Where financial snapshots live.** `shift_instances` is a purely
operational schedule/staffing/high-value record — it owns **no** financial
rate at all (see the Implemented note below). Both rates are resolved once,
at actual payroll-calculation time, against the driver+shift's real date,
inside the future `driver_shift_payroll` record (not built yet) — the
authoritative financial snapshot and eventual finalisation boundary. Changing
a rate afterward never alters an already-finalised `driver_shift_payroll` row;
a finalised pay period's lines become immutable independently of each other
(one unresolved exception never blocks every other correct line), and the
run they belong to is only "Finalised" once every required line is.

**H. Rate correction vs. rate change — two different operations.**
Effective dating protects historical **rate periods**; payroll finalisation
(§G, not built yet) will eventually protect actual historical **payroll**.
Those are not the same guarantee, and until a `driver_shift_payroll` line is
finalised, a genuine data-entry mistake in a rate must be correctable —
"I typed 13, I meant 12" was never a real CHF 13 period, so forcing it
through the ordinary future-change workflow (which would require the
manager to invent a start date *after* today and leave the erroneous value
sitting in history) is wrong. **Change** ("schedule a future rate") and
**Correct** ("fix a mistake in the currently-applicable rule") are
deliberately two separate manager actions, never conflated:
- **Change** creates a new, later-dated period and preserves the old one —
  exactly Checkpoint B's own workflow, unchanged.
- **Correct** updates the amount of an existing, still-*open* rule (either
  the current one or an already-scheduled future one) **in place** —
  `effective_from`/`effective_to` are never touched, so Rate History only
  ever shows genuine effective periods, never a fake one-day period
  invented to record a typo. A rate that is already real *today* (or
  earlier) can be corrected same-day — the manager is never forced to pick
  a future date just to fix a mistake. An already-*closed* historical
  period (a genuine past period, not the currently-open one) is out of
  scope for correction and is rejected.
- **Audit, not history, records a correction.** `audit_log`'s existing
  generic before/after capture (already attached to both rate tables) shows
  `CHF 13 → CHF 12` on the row; Rate History shows only the corrected
  period's own dates and final value, e.g. `CHF 12 from 15 Sep`, never a
  phantom `CHF 13 from 15 Sep → 15 Sep` entry.
- **Future finalisation guard (not built — no `driver_shift_payroll` exists
  yet, so nothing to enforce today):** once a `driver_shift_payroll` line
  has been calculated from a given rate/period and finalised, a correction
  that would alter that finalised financial history must be rejected — the
  financial snapshot remains authoritative once it exists; configuration
  corrections must never reach back into it. This is a straightforward
  additional check to add to the existing correction RPCs (query whether
  any finalised line depends on the target rule before allowing the
  UPDATE) — the correction workflow does not need replacing to add it.

**Implemented (Stage 2D Payroll Checkpoint A):** `shift_base_pay_rules`
(renamed from `payroll_rules`, `delivery_rate_chf` removed), `driver_delivery_rates`
(new, mirrors the same effective-dated/no-overlap/manager-only/audited
pattern). `shift_instances` no longer has `base_pay_chf`/`delivery_rate_chf`
at all (dropped, not just deprecated) and `materialise_shift_instances` has
zero payroll-rate responsibility — no join to either rate table, no
`missing_payroll_rule_count` in any form. `shift_templates.{base_pay_chf,
delivery_rate_chf}` remain deprecated/inert (nullable, never read). Note:
`shift_templates.required_drivers` was deprecated/inert at the time of this
checkpoint but was made authoritative again by the later Stage 2D staffing
simplification (section H) — `is_premium` remains inert/never-populated.

**Implemented (Stage 2D Payroll Checkpoint B — rate configuration):** the
atomic manager RPCs `set_shift_base_pay_rate`/`set_driver_delivery_rate` —
create-or-schedule a rate in one transaction, never overwriting an
already-real historical/in-effect period's own values (a genuine future
change closes the current open-ended row and inserts a fresh one; a
not-yet-started future plan is corrected in place instead); reject a
backdate attempt on/before an already-in-effect rule's own start (23514),
and reject any other overlap via the tables' own exclusion constraints
(23P01). `PayrollRulesRepository` (`listShiftBasePayRules`/
`setShiftBasePayRate`/`listDriverDeliveryRates`/`setDriverDeliveryRate`),
implemented for both providers. `Configuration → Payroll Rules`
(`PayrollRulesPanel`) — the real manager-facing page: the same "Choose
resort" selector pattern as Resort & Shift Setup, two clearly separated
sections (Shift base pay / Driver delivery rates), Current/Scheduled/History
categorised client-side from the flat rate list (`categorizeRatePeriods`,
the one place this resolution logic lives), "Not configured" shown as an
amber "Needs setup" state rather than a fabricated CHF 0, and a compact
formula explanation. No attendance/Onfleet/double-pay/payroll-calculation
controls anywhere on this page — those remain future Dashboard/Payroll
checkpoints' responsibility.

**Implemented (Stage 2D Payroll Checkpoint B.1 — rate correction):** the
atomic manager RPCs `correct_shift_base_pay_rate`/`correct_driver_delivery_rate`
— update ONLY the amount of an existing, still-open (current or scheduled)
rule row, identified by its own id (already known to the frontend, never
manager-typed); reject correcting an already-closed historical period
(55006); never touch `effective_from`/`effective_to`. `PayrollRulesRepository.
correctShiftBasePayRate`/`correctDriverDeliveryRate`, implemented for both
providers. `PayrollRulesPanel`'s Edit modal surfaces "Correct current rate"/
"Correct scheduled rate" as a clearly separate action from the "Schedule
Change" future-change form, opening a focused confirmation dialog ("Correct
base pay/delivery rate — `<name>`") with its own audit-oriented helper text.

---

## H. Shift staffing simplification and Auto-Rota direction

**Decided:** Stage 2D staffing simplification, replacing the abandoned
manager-facing "Rota Rules" system (`rota_rules_default`/`weekday`/`date` —
Checkpoint 3) before any UI/repository/RPC was ever built against it (only
raw-SQL test/fixture inserts existed anywhere in this codebase).

**A. Staffing lives on the Shift, not a separate rule system.**
`shift_templates.required_drivers` is authoritative again — mandatory
(>= 1, no default) at Shift-creation time, exactly like start/end time (see
section F). A different staffing requirement for the same service is simply
a **separately-named Shift**, e.g. "Dinner (1P)" (1 driver) and "Dinner
(2P)" (2 drivers) as two independent Shifts with their own date ranges —
**never** parsed from the name, never a precedence/override rule.
`shift_templates_no_overlap` is scoped per shift *type* (a stable identity
per Shift), so two differently-named Shifts may freely share identical
times/weekdays/dates with no conflict — this is by design, not a gap; no
duplicate/overlap warning is built for it (§B below).

**B. No duplicate/overlap warning (deliberately, for now).** Two Shifts
with genuinely identical or overlapping schedules can exist side by side —
sometimes deliberately (the "(1P)"/"(2P)" pattern above), sometimes an
accidental double-booking. V1 does not distinguish these or warn either
way; add complexity here only once there's evidence managers need it.

**C. `rota_rules_default`/`weekday`/`date` were dropped outright** (not
deprecated) — no data migration was needed since nothing real depended on
them. `missing_rota_rule_count` (and, from Payroll Checkpoint A,
`missing_payroll_rule_count`) no longer exist in any form: a materialised
instance can never be missing `required_drivers` any more, since it's
mandatory at Shift-creation time. See section A for the resulting
simplified two-state coverage model (no more "staffing not configured" as a
normal state).

**D. High-value/premium is not part of the V1 product model.**
`shift_templates.is_premium`/`shift_instances.is_premium` remain as inert,
nullable, never-populated legacy columns — no manager control, no driver
exposure, no fairness dependency. Left in place rather than dropped, to
avoid an unrelated column-removal migration.

**E. Template refresh includes staffing.** `preview_template_refresh`/
`apply_template_refresh` compare and can apply a `required_drivers` change
on the governing Shift to already-generated future instances, through the
same explicit preview → Apply flow as a schedule change (surfaced via the
same generic `changed_fields` diff, labelled "Drivers required" in the UI)
— never silently rewritten when the Shift is edited. **Critically, a
staffing-only change never reopens already-confirmed driver availability**
— that stays scoped to a genuine start/end time change, exactly as before
staffing was added to the refresh comparison. A driver who said "Available"
for a shift is still answering the same time window regardless of how many
colleagues are also asked to work it.

**F. Auto-Rota — IMPLEMENTED (V1 complete; database layer §O, planner + repository §P, Generate Rota UI §Q, summary and limitations §R).** It is
built entirely from `shift_instances`/`required_drivers`/dates/driver
resort/`availability`/`rota_assignments` — no Rota Rules, no High-value.
Both `availability` (`available`/`unavailable`/absence=Not Submitted) and
`rota_assignments` (`assignment_source` already anticipates `'manual'`/
`'auto'`, multiple distinct drivers per shift already supported) were
confirmed sufficient by inspection; no redesign is planned.

Allocation runs **per resort, per Monday–Sunday week**, in two independent
buckets — **weekend** (Fri/Sat/Sun) first, then **weekday** (Mon–Thu) — and
fairness is never blended across them. The approved algorithm, tie-break and shift
order (superseding the earlier `created_at` tie-break idea) are specified and
implemented in **section P**; the database half is section O. Availability is a
hard constraint (only an explicit "Available" counts; Not Submitted and
Unavailable are never assigned), driver-resort is a hard constraint, coverage
beats fairness, a multi-driver Shift needs that many **distinct** drivers, and
existing assignments are preserved and counted. No overlap, daily-maximum or
rest-period rules exist in V1.

---

## I. Driver Availability

**Decided/Implemented:** Stage 3. Makes the availability architecture that
already existed at the schema/RPC level (`availability`,
`availability_submissions`, `week_availability_status`,
`confirm_availability_week`, `reopen_availability_week`, the stale-
invalidation trigger — all built in earlier checkpoints) real end to end:
a live driver-facing page and manager-facing visibility, both through the
repository layer. (Scope of that checkpoint: no Auto-Rota, no manual assignment,
no attendance, no Onfleet, no payroll calculation — Manual Rota and Auto-Rota
have since been built.)

**A. One answer per (driver, shift_instance).** `availability.status` is
`'available'` or `'unavailable'` — a database CHECK constraint, only ever
those two values. **No row = Not Submitted.** This is never a third stored
status; the driver UI renders "Not answered" for it, purely a display
choice over an absent row.

**B. A week must be fully answered before it can be confirmed.**
`confirm_availability_week` recomputes completeness fresh from the
driver's resort's currently-active `shift_instances` every time (never
trusts `availability_submissions.submitted_at`) — if any currently-
scheduled shift lacks an answer, confirmation is refused
(`result = 'incomplete'`), never silently treated as "unavailable".

**C. A confirmed week may be reopened before publication.** Reopening
clears `submitted_at` and stamps `reopened_at`/`reopened_reason =
'driver_reopened'` — it never deletes or resets the driver's actual
answers, which remain exactly as they were.

**D. Publication locks driver changes -- enforced at the database, not the
UI.** Once a resort/week is published (`rota_publications`), RLS itself
(not just a disabled button) rejects a driver's INSERT/UPDATE/DELETE on
`availability` for that week's shifts
(`availability_driver_*_own_unpublished` policies, gated by
`shift_instance_week_is_published()`), and both
`confirm_availability_week`/`reopen_availability_week` return
`result = 'locked'` without writing anything. A driver may still always
**read** their own past answers, published or not.

**E. Confirmation staleness — the exact same distinction staffing already
required elsewhere in this document (see §H).** A confirmed submission
becomes stale (`submitted_at` cleared, `reopened_reason` set to a specific
cause) when, and **only** when:
- a new active shift is added to that resort/week (`shift_added`),
- a cancelled shift is reinstated (`shift_reinstated`), or
- an active shift's `start_time`/`end_time` changes (`shift_time_changed`).

It does **not** become stale for `required_drivers` changes, `is_premium`
(inert), or any payroll/rate change (base pay, driver delivery rate) — none
of those change what the driver actually agreed to work. This is enforced
by `shift_instances_reopen_stale_confirmations()` (a trigger on
`shift_instances`, not application code), and was already correct/tested
before this checkpoint — Stage 3 adds a driver-facing "Needs
reconfirmation" state that reads it, not new invalidation logic.

**F. Zero-shift weeks never demand a submission.** A resort/week with no
active shifts reports `state = 'no_shifts'` and the driver page shows a
plain empty state — never a fabricated row, never a blocked/confused
Confirm action. (The underlying RPC does not specifically forbid
confirming a trivially-complete 0-of-0 week if called directly — existing,
pre-Stage-3 behaviour, left unchanged — but the UI never offers that
action for an empty week in the first place.)

**G. Drivers only ever see their own resort's schedule, own answers.**
`driver_visible_shifts` (a driver-safe view, Checkpoint 4) never exposes
`required_drivers`/`is_premium`/pay/`template_id`/`origin` — a driver
answering "can I work this?" needs only name/date/start/end time, nothing
about how many colleagues are also needed. `availability`'s own RLS
(`availability_driver_select_own`) means a driver can never read another
driver's answers, confirmed or not, at the base-table level (not just
"filtered to zero rows via a view" — there is no other path at all for a
driver session).

**H. Manager visibility is read-only in this checkpoint.** The manager
sees, per driver at a chosen resort/week: `Not started` / `In progress` /
`Confirmed` / `Needs reconfirmation` / `Locked`, and can drill into one
driver's actual per-shift answers. This is composed from plain authorized
reads (the manager role already has full SELECT on `drivers`/
`shift_instances`/`availability`/`availability_submissions`/
`rota_publications`) — no new RPC or migration. **No assignment, Auto-
Rota, or Publish control exists in this manager view** — assignment lives in
the separate Manual Rota panel on the same page (section L), and the Stage 1.1
mock Rota preview that used to sit below it has been removed. As of MR-C this
panel is driven by `resortId`/`weekStart` props from the page and keeps no
selection state of its own.

**I. Auto-Rota's eligibility input (design constraint — now implemented, §P).**
Auto-Rota (§H above) queries, per shift_instance: which
drivers at that resort have `status = 'available'` — excluding both
`status = 'unavailable'` and "no row at all" identically (neither is ever
eligible). The repository/domain shapes built in this checkpoint
(`AvailabilityAnswer`, `DriverVisibleShift`) already support this query
shape directly; nothing further is needed to prepare for it.

**Implemented:** `AvailabilityRepository` (driver: `listDriverVisibleShifts`,
`listAvailability`, `setAvailability`, `getWeekAvailabilityStatus`,
`confirmAvailabilityWeek`, `reopenAvailabilityWeek`,
`getAvailabilitySubmission`; manager: `listAvailabilitySubmissionStatus`,
`getResortWeekAvailability`), implemented for both providers.
`pages/driver/Availability.tsx` (live, replacing the Stage 1.1 mock
version entirely) and `components/availability/ManagerAvailabilityPanel.tsx`
(new, mounted inside `pages/manager/RotaAvailability.tsx`).

**Known mock-mode limitation:** the mock provider has no persisted
`shift_instances` (they're generated fresh from templates on every read),
so it cannot simulate the DB's automatic stale-invalidation trigger. Tests
exercising a stale/needs-reconfirmation state fabricate the resulting
`availability_submissions` row directly (see
`repositories/mock/fixtures.ts`'s `mockAvailabilitySubmissions` doc
comment) — the trigger itself is a database concern, tested at that layer
(`supabase/tests/10_availability_publication.sql`), not re-implemented in
the mock provider.

**Known pre-existing inconsistency, bridged (not removed) by this
checkpoint:** the Stage 1.1 driver switcher (`mock-data/drivers.ts`, ids
like `"gianni"`) and the repository-layer mock fixtures
(`repositories/mock/fixtures.ts`, ids like `"mock-gianni"`) are two
separate datasets kept in sync only by sharing driver/resort **names**.
`AuthContext`'s mock-mode `currentUser.driverId`/`resortId` stay in the
Stage 1.1 id space (Stage 1.1's own `MyRota.tsx` still depends on that).
The live Availability page instead resolves its own id-space bridge via
`repositories/mock/identityBridge.ts`, scoped to that one page — see its
doc comment for why the translation couldn't live in `AuthContext` itself
without breaking `MyRota.tsx`. Supabase mode is entirely unaffected (real
`driver_id`/`resort_id` throughout, from `resolveCurrentUser()`).

---

## J. Manual Rota assignment — database rules (MR-A)

**Decided and implemented in the database (Manual Rota checkpoint MR-A).**
This section documents what the database guarantees; the repository / weekly
read model (MR-B, section K) and the manager UI (MR-C, section L) are built on
top of these rules and verified end to end in MR-D.

**Manual assignment is deliberately more permissive than Auto-Rota.**
A manager has information the system doesn't (a WhatsApp message, a phone
call), so manager control stays authoritative. Auto-Rota (§O–§P) treats
both Unavailable *and* Not Submitted as ineligible; manual
assignment may override either, after an explicit acknowledgement.

**Writes go through two atomic RPCs — and only through them.**
`assign_driver(p_shift_instance_id, p_driver_id, p_confirm_availability_override
default false, p_reason default null)` and `unassign_driver(p_shift_instance_id,
p_driver_id)`, both `SECURITY DEFINER` + `assert_active_manager()`. Managers
keep `SELECT` on `rota_assignments` (the weekly read model needs it) but have
**no** direct `INSERT`/`UPDATE`/`DELETE`: the grants are revoked and the
`FOR ALL` policy was replaced by a `SELECT`-only one, so no client path can
bypass the rules below. Drivers still have no base-table access at all (they
use `driver_visible_assignments`, unchanged). `anon` cannot execute either RPC.

**What a manager may do:** assign an Available driver; assign a Not Submitted
or Unavailable driver *after explicit acknowledgement*; assign more drivers than
`required_drivers` (a minimum, not a capacity — no DB headcount cap); edit a
**published** current/future week (the week stays published; `rota_publications`
is never touched; the change is audited).

**What a manager may not do:** assign an inactive driver; assign across resorts;
assign the same driver to the same shift twice (the existing
`unique(shift_instance_id, driver_id)` stays the authoritative guard); assign to
a cancelled shift; assign **or** unassign a shift dated before the resort's
operational today (Europe/Zurich via `operational_today`, never `current_date`;
today and future are editable); unassign a driver once **any** attendance row
exists for that driver+shift (attendance status is deliberately not inspected —
correcting recorded attendance is a separate, future, audited workflow).

**Availability override is server-side, never trusted from the client.** The RPC
reads the driver's *current* availability itself at write time (`available` /
`unavailable` / `not_submitted` = no row) and accepts no availability parameter.
If the state is not `available` and `p_confirm_availability_override` is false,
**nothing is inserted** and it raises SQLSTATE `VD001` with `DETAIL` = the
current state; the (future) client shows the matching warning and, only after the
manager confirms, retries with the flag set — and the server re-reads
availability again. This makes a stale page safe: a driver who flips to
Unavailable after the manager loaded the page cannot be silently assigned.

**Stable error contract** (the repository/UI key off SQLSTATE and `DETAIL`, not
message text): `42501` not a manager · `P0002` shift/driver/assignment not found
· `23514` business-rule rejection (cancelled shift, inactive driver, different
resort, reason > 500 chars) · `23505` already assigned · `55006` locked, with
`DETAIL` `historical_shift` or `attendance_recorded` · `VD001` override required,
`DETAIL` `unavailable` | `not_submitted`.

**Optional override reason → `audit_log.context`, not the assignment row.**
`p_reason` is optional (trimmed, empty = none, max 500). New nullable column
`audit_log.context jsonb`; the generic audit trigger copies the transaction-local
setting `app.audit_context` into it. Assign records `operation`,
`availability_state`, `availability_override` (true only when the manager
actually overrode Unavailable/Not Submitted) and `reason` when given; unassign
records `operation`. The RPC sets the context immediately before its single
audited write and clears it immediately after, a failed statement's
subtransaction rollback reverts it, and a malformed context is recorded as NULL
rather than ever failing a write — so a later unrelated audited write in the
same transaction can never inherit it (regression-tested). `audit_log` is
manager-readable only, so override reasons are never visible to drivers.

**Inactive assignees.** Deactivating a driver does not delete or rewrite their
existing assignment, and a manager can still unassign them. A *new* assignment
of an inactive driver is rejected. An inactive assignee does not count toward
coverage — see section K.

**Known, deliberately unaddressed:** nothing prevents one driver being assigned
to overlapping shifts on the same day. No overlap rule exists anywhere in the
schema; recorded as a possible future product decision/warning, not a blocker.

**Tests:** `supabase/tests/85_manual_rota_assignments.sql`.

---

## K. Manual Rota — repository and read model (MR-B)

**Implemented (data layer — MR-B).** The typed repository/domain layer for the
manager's weekly rota. The UI built on it is section L.

**Manager week read model** — `RotaRepository.getManagerWeekRota({ resortId,
weekStart })` → `ManagerWeekRota { isPublished, candidateDrivers, shifts[] }`
(`repositories/domain.ts`). Each shift carries `shiftInstanceId`, date, name,
`HH:MM` times, `requiredDrivers`, its `assignments[]`, and `availabilityByDriver`.
Assembled by one pure function (`repositories/managerRotaModel.ts`) fed by both
providers, so grouping/ordering/derivation cannot drift between them. The
Supabase provider uses at most five authorised reads (three in parallel, then
two filtered by the week's shift ids), never one per driver or shift; a week
with no service skips the second stage and returns a valid empty model. The
cache key is `managerRotaKeys.week(resortId, weekStart)`. *Scaling watch item:*
the availability read returns shifts × drivers rows and the API caps a response
at `max_rows = 1000` — comfortably above any current resort; page the read only
if one resort-week could approach it.

**Two driver concepts.** `candidateDrivers` = *active* drivers at the resort, the
only people to offer as new assignments. An existing assignment carries its own
resolved `driverName` / `isDriverActive`, so an assignee who has since been
deactivated is still shown (and removable), never dropped. Availability is
derived per exact shift instance: row `available`/`unavailable`, **no row =
`not_submitted`** (never a stored status, never inferred from week confirmation).
The model carries no audit context or override reason.

**Coverage is derived, never stored** (`lib/rotaCoverage.ts`): *active*
assignments `<` `required_drivers` → uncovered; `>=` → covered; above-required
stays covered. **An inactive assignee does not count** — e.g. required 2 with one
active and one inactive assignee is uncovered, so the manager sees the gap and
replaces them.

**Repository error contract — callers never see `VD001`, SQLSTATEs or PostgREST
shapes.** `assignDriver` / `unassignDriver` are RPC wrappers only (the adapter
never writes `rota_assignments` directly — tested). The Supabase adapter
(`supabase/rotaErrors.ts`) is the single place that translates the database's
contract (section J) into typed errors in `repositories/errors.ts`:
`AvailabilityOverrideRequiredError { availabilityState: 'unavailable' |
'not_submitted' }` (guard: `isAvailabilityOverrideRequired`) and
`RotaAssignmentError { kind }` with kinds `duplicate_assignment`,
`historical_shift`, `attendance_recorded`, `rule_violation`, `not_found`,
`assignment_not_found` (guard: `isRotaAssignmentError`). The override state is
read from the machine-readable `DETAIL`, never parsed from message text; an
unrecognised `DETAIL` falls back to a generic error rather than being mistaken
for a known state. The override flow reuses one method: call `assignDriver`
without `confirmAvailabilityOverride`; on `AvailabilityOverrideRequiredError`
show the matching warning and, only after the manager confirms, call it again
with `confirmAvailabilityOverride: true`. The caller never supplies an
availability state. *Known limit:* the database reports inactive driver, other
resort, cancelled shift and an over-long reason under one SQLSTATE (`23514`) with
no `DETAIL`, so they share `kind: 'rule_violation'` and are told apart only by the
database's first-party `userMessage`. Distinct kinds would need a small DETAIL
addition to the RPCs (a new migration) — deliberately not done.

**Mock provider differences** (documented in `repositories/mock/rota.ts`): it
reproduces the database's checks, order, typed errors and message text, but has
**no attendance** (the attendance guard is database-only), **no audit** (the
reason is accepted and discarded), and **no cancelled shifts**. Mock
shift-instance ids are `${templateId}-${date}` — stable across reads, but a mock
`reviseShift` that recreates the template changes them, orphaning mock
assignments; the real database keeps instance identity.

**Privacy boundary.** This model is manager-only (`required_drivers`, every
resort driver, everyone's availability). Driver pages keep their own safe
repositories/views; never reuse these shapes for them.

**Tests:** `lib/rotaCoverage.test.ts`, `repositories/managerRotaModel.test.ts`,
`repositories/supabase/{rota,rotaErrors,mappers}.test.ts`,
`repositories/mock/rota.test.ts`.

---

## L. Manual Rota — manager UI (MR-C)

**Implemented.** `Rota & Availability` (`pages/manager/RotaAvailability.tsx`) is
the manager's real weekly assignment screen, built only on `RotaRepository`
(section K) — never Supabase directly (import-boundary tested). It replaced the
Stage 1.1 mock "Rota (preview)", its fake "current week is published" logic,
and its dead Publish button; those components and their CSS are gone.

**One shared context.** The page owns exactly one resort and one week — a
single `ResortSelector` and a single `WeekNav` — and passes `resortId` /
`weekStart` to both `ManualRotaPanel` and `ManagerAvailabilityPanel`, so
changing either always updates both. The Draft/Published chip is the REAL
publication state of that resort + week, display only. The page's indicator and
the panel share one query (`managerRotaKeys.week`); that query uses
`staleTime: 0` (unlike the app's 30s default) so returning to a week re-reads
availability a driver may have changed.

**Shifts and coverage.** Real shift instances only, grouped by day (no
fabricated empty days), several per day, nothing hard-coded to Lunch/Dinner and
never parsing "(1P)/(2P)". Each card shows `N / required active assigned` plus a
Covered/Uncovered pill (text and border, not colour alone). Above the
requirement stays plain "Covered" (e.g. 3 / 2) — there is no "over-covered"
state. **An inactive assignee is shown, labelled Inactive, and is removable, but
does not count toward coverage** (required 2 with one active + one inactive
reads 1 / 2, Uncovered).

**Assigning.** "Assign a driver" lists only the resort's *active* drivers not
already on the shift, Available first, each with an icon + text availability
badge (Available / Not Submitted / Unavailable, with distinct border styles).
Available and the shift still needs staff → assigns immediately. Otherwise ONE
confirmation dialog covers every reason to pause: a Not Submitted warning
(amber), an Unavailable warning (stronger), a "this shift already has its
required coverage" notice, or any combination — never two sequential dialogs.
The reason is optional (≤ 500 chars, stored only in the audit trail).

**Race-safe.** Every normal assign attempt handles the server's typed
`AvailabilityOverrideRequiredError`: if a driver the screen showed as Available
has since become Unavailable / Not Submitted, the dialog opens for the state
the SERVER reports (not the stale screen), and confirming retries with the
acknowledgement. Remove calls `unassignDriver`; failures (historical shift,
attendance recorded, already removed, ...) show a clean manager message and
refresh stale data — never SQLSTATEs.

**Dates and publication.** A shift dated before the operational today
(Europe/Zurich, never the browser's date) is read-only and labelled Historical;
today and the future are editable. A published week shows an informational note
and stays fully editable — there is no Publish / Unpublish control, and a
manager edit never unpublishes it.

**Responsive.** Cards stack by day (no seven-column grid), so there is no
horizontal overflow at 375px; dialogs fit the viewport; controls are
touch-sized.

**The dialog names the shift.** Every confirmation dialog opens with the exact
shift it is about ("Dinner (2P) — Monday 26 Oct, 18:00–21:30"), because with
several shifts per day a bare "Assign Gianni?" is ambiguous. (Added in MR-D after
the real-Supabase walkthrough.) After a stale-data failure the dialog stays open
with the server's message and the refreshed week behind it; Cancel closes it.

**Keyboard and accessibility.** The shared `Modal` traps Tab / Shift+Tab inside
the dialog (aria-modal), closes on Escape, and returns focus to the control that
opened it (added in MR-D; tested in `components/ui/Modal.test.tsx`). Availability,
coverage and Inactive are never colour-only: each has an icon or text plus a
distinct border/underline. Assign / Remove buttons carry the driver and shift in
their accessible name; the candidate list toggle exposes `aria-expanded`.

**Known limitations (deliberate, not bugs):** nothing stops a driver being
assigned to overlapping shifts on the same day (section J); Remove has no
confirmation step; the availability read (shifts × drivers rows) is not
paginated and the API caps a response at `max_rows = 1000`, so it needs paging
before any one resort-week could approach that (section K); and the Dashboard is still Stage 1.1 mock data. (Driver My Rota, which was
also mock when this was written, is now live — section N.)

**Not part of that checkpoint (MR-C):** Auto-Rota (built later — §O–§R), Publish UI,
Attendance UI, live Driver My Rota (built later — §N), live Dashboard.

**Tests:** `components/rota/ManualRotaPanel.test.tsx`,
`pages/manager/RotaAvailability.test.tsx`,
`components/availability/ManagerAvailabilityPanel.test.tsx`,
`components/rota/manualRotaBoundary.test.ts`, `components/ui/Modal.test.tsx`.

---

## M. Driver-safe publication status (Live Driver My Rota, LD-A)

**Implemented in the database only** (migration `20261019100000_driver_safe_publication_status.sql`).
Driver My Rota (built in the next checkpoint, section N) needs to tell "this week is not published yet" apart from "this week
is published and I have no shifts", which `driver_visible_assignments` alone
cannot (both are zero rows).

**Drivers read publication state from `driver_visible_week_publications`.** It
returns one row per *currently published* week of the calling driver's *own*
resort — exactly `resort_id` and `week_start`, nothing else. A row means
published; no row means not published (draft, never published, or retracted).
"Currently published" is the schema's one existing predicate
(`published_at is not null and unpublished_at is null`) — no second publication
model. It is an owner-executed (`security_invoker = false`) view like the other
driver views and resolves the caller from the session
(`current_app_user()`: auth user → app_users → driver); it has no driver or
resort input, so nothing a client sends can widen it. `anon` cannot read it.

**Direct driver access to `rota_publications` is no longer part of the supported
privacy contract.** The driver SELECT policy was removed, so drivers get zero
rows from the base table (it carried `published_by`, `generation_source` and the
timestamps, which drivers have no need for). Managers are unchanged
(`rota_publications_manager_all`). Driver Availability is unaffected: its lock
comes from SECURITY DEFINER code (`week_availability_status`,
`confirm_availability_week`, `reopen_availability_week`,
`shift_instance_week_is_published`), none of which read the table as the driver.
`driver_visible_assignments` is unchanged (own assignments, published weeks,
active shifts); a manager's add/remove on a published week shows through it
immediately, and un-publishing makes both views go empty.

**Tests:** `supabase/tests/35_driver_safe_views.sql`.

---

## N. Live Driver My Rota

**Implemented.** `pages/driver/MyRota.tsx` is the driver's read-only view of
their OWN published rota for one operational week, replacing the Stage 1.1 mock
page (fake current-week "Published" chip, fake "hours scheduled" badge, and a
subtitle that was already blank against real data — all gone).

**Data.** One repository method, `RotaRepository.getDriverWeekRota({ weekStart,
driverId })`, returning `DriverWeekRota { weekStart, isPublished, shifts[] }`
with `DriverRotaShift { shiftInstanceId, date, shiftName, startTime, endTime }`
(`HH:MM`). It is built by one pure function shared by both providers
(`repositories/driverRotaModel.ts`): shifts sorted by date, start time, name;
an unpublished week is ALWAYS empty. The Supabase provider performs exactly two
week-scoped reads in parallel — `driver_visible_week_publications` (a row means
published) and `driver_visible_assignments` — and never reads
`rota_assignments` or `rota_publications`. **Identity is the authenticated
session:** both views resolve the driver themselves and have no driver column,
and the adapter never sends `driverId` (it exists on the contract only because
the mock provider has no session), so a client cannot request another driver's
rota. The mock provider derives the same shape from its fixtures; it seeds **no**
default published week (so normal mock development reads "not published yet",
and Driver Availability is not unexpectedly locked) — tests publish explicitly.

**Three situations, three messages** (plus a real chip: "Published" /
"Not published", text not colour):
- current or future week, not published — "Your rota for this week hasn’t been
  published yet."
- past week, not published — "No rota was published for this week."
- published, no shifts for this driver — "You don’t have any shifts assigned
  this week."
- published with shifts — day sections (only days with shifts; several shifts on
  one day are separate rows) with shift name and `HH:MM–HH:MM`, a "Today" tag,
  and a simple "N shift(s)" count.

**Weeks** use the app's Monday–Sunday operational week (Europe/Zurich) via the
shared `WeekNav` and date helpers; navigation is unbounded, past published weeks
stay viewable (read-only — there are no controls to act on), far-future weeks
simply read as unpublished.

**Freshness.** A manager may edit a published week after publication; the
manager's and driver's sessions are separate, so the query
(`driverRotaKeys.week(driverId, weekStart)`) is always stale (`staleTime: 0`) and
refetches on mount, week change and window/tab focus. No polling and no
realtime. An add or removal on a published week appears on the driver's next
refetch with no republish. Cancelled shifts and unpublished weeks never appear
(existing safe-view behaviour). A manager override is invisible to the driver —
no availability, reason or warning is shown on My Rota; availability is its own
page.

**Not part of this checkpoint:** a Publish workflow (the real Publish UI/RPC
does not exist yet; weeks were published directly in the database for
verification only), Auto-Rota, Attendance, the live Dashboard, payroll.

**Tests:** `repositories/driverRotaModel.test.ts`,
`repositories/supabase/rota.test.ts` and `repositories/mock/rota.test.ts`
(`getDriverWeekRota`), `pages/driver/MyRota.test.tsx`, and the import-boundary
test in `components/rota/manualRotaBoundary.test.ts`.

---

## O. Auto-Rota — database execution layer (AR-A)

**Implemented in the database** (migration `20261019110000_auto_rota_apply.sql`).
The planner and repository that call it are section P; the Generate Rota UI is
**not built yet**.

**Architecture.** A pure deterministic TypeScript planner will *propose* an
assignment plan; Postgres decides whether every proposed assignment is still safe
and applies it atomically. The database does **not** reproduce the fairness
algorithm, so a planner/SQL disagreement can only cause a rejection, never an
unsafe write. The submitted plan is **untrusted input**.

**`apply_auto_rota(p_resort_id, p_week_start, p_plan jsonb)`** — manager-only,
SECURITY DEFINER, all-or-nothing, one resort + one Monday–Sunday week. The plan is
`[{"shift_instance_id", "driver_id"}, …]` and nothing else: it may not carry an
availability state, a source, coverage or resort ids (extra fields are rejected);
the server sets `assignment_source = 'auto'` and `assigned_by` = the manager.
Under the week lock it re-reads fresh state and validates EVERY pair: the shift is
in this resort and week, active and dated today or later; the driver exists, is
active and belongs to the same resort; the driver has an **explicit Available row
for that exact shift** (Unavailable and Not Submitted are never eligible and there
is no override); the driver is not already assigned; no duplicate pairs; and the
rows for a shift fit its CURRENT open coverage = `required_drivers` minus
**active** assignments (inactive assignees stay stored but never count; an active
manual assignment — even one made over an Unavailable answer — or an existing
auto assignment does count). Auto-Rota therefore never over-assigns. Only then
does it insert every row, or none. A **published** week is rejected server-side
(`55006 published_week`) — Auto-Rota never changes a published rota, unlike
Manual Rota, which may edit one. A wholly past week is `historical_week`; a pair
targeting a past shift is `historical_shift`; shifts before the resort's
operational today are skipped (today is allowed).

**Error contract.** `42501` not a manager; `P0002` resort not found; `22023`
malformed request (not an array, bad/missing ids, extra fields, duplicates, more
than 1000 rows, a pair that cannot belong to this resort/week); `55006` with
DETAIL `published_week` / `historical_week` / `historical_shift`; **`VD002` with
DETAIL `stale_plan`** when the plan was well-formed but current state no longer
permits it (availability changed, driver inactive, shift cancelled, already
assigned, would over-assign). Partial coverage, "no eligible driver" and an empty
plan are **success**.

**Result (server-computed).** `assigned_count`, `remaining_open_slots`,
`uncovered_shift_ids` (today/future active shifts only), `skipped_past_shift_count`
and a `run_id`.

**Concurrency: one lock per resort + week.** `apply_auto_rota`, `assign_driver`,
`unassign_driver` and every `rota_publications` insert/update/delete (a trigger,
since there is no Publish RPC yet) take the same transaction-scoped advisory lock
`pg_advisory_xact_lock(key1, key2)`: `key1` = the resort UUID's four 32-bit words
XOR-ed, `key2` = `week_start` minus 2000-01-01 in days — deterministic, no text
hashing, different resort/weeks never serialize. A publish therefore waits for an
in-flight generation or is observed by the next one; a manual assign/unassign
cannot race an apply. The apply also row-locks (`FOR SHARE`) the planned shifts,
drivers and **availability rows**, so a driver's Available→Unavailable change
waits for the generation transaction instead of slipping between validation and
insert (verified with two real connections). `assign_driver` / `unassign_driver`
were re-created only to take the lock; their behaviour is unchanged.

**Audit.** Each inserted row's audit context is `{operation: 'auto_rota', run_id,
resort_id, week_start, availability_state: 'available', availability_override:
false, created_count, uncovered_after}` — never the plan — set immediately before
and cleared immediately after the bulk insert. `run_id` groups a run (a future
bulk-undo hook).

**Not in V1 (future work):** overlap / daily-maximum / rest-period rules,
cross-week fairness, bulk undo of a run.

**Tests:** `supabase/tests/86_auto_rota.sql` (and `85_manual_rota_assignments.sql`
as the regression proof for the re-created manual RPCs).

---

## P. Auto-Rota — planner and repository (AR-B)

**Implemented:** the pure planner (`lib/autoRotaPlanner.ts`), its tie-break hash
(`lib/autoRotaHash.ts`) and `RotaRepository.generateAutoRota` for both providers.
There is **no Generate Rota UI yet** — nothing in the manager screens calls it.

**The planner proposes; the database decides.** `buildAutoRotaPlan({ week:
ManagerWeekRota, operationalToday })` is pure (no I/O, no clock, no randomness) and
is the ONLY implementation of the fairness algorithm. `apply_auto_rota` (section O)
independently re-validates every proposed pair under a lock, so a planner/SQL
disagreement can only cause a rejection, never an unsafe write.

**Algorithm.** One resort + one Monday–Sunday week.
- *Eligible* for a NEW proposal: an active candidate whose availability for that
  exact shift is `available`, not already assigned to that shift. Unavailable and
  Not Submitted are never eligible; there is no override and nothing is inferred
  between shifts.
- *Existing assignments* are preserved and never removed. Active ones (manual or
  auto — even a manual override of an Unavailable answer) count toward coverage and
  the driver's fairness counters; inactive ones count toward neither and never make
  anyone eligible. Past shifts still seed the counters. `openSlots = max(required −
  active assignments, 0)`; Auto-Rota never over-assigns and never proposes the same
  driver twice for one shift.
- *Buckets and fairness.* Weekend (Fri/Sat/Sun) is planned first, then weekday
  (Mon–Thu). For a slot the winner is the eligible driver with the **fewest
  assignments in that bucket**, then the **fewest in total**, then the weekly
  tie-break, then `driverId` (lexical). Counters update after every pick. The total
  count only breaks ties — a heavy weekend load does not primarily compensate on a
  weekday. Fairness only chooses among the eligible: if one driver is the only
  option they get the slot (coverage beats fairness). Drivers have no per-driver
  capacity, so greedy always reaches the maximum possible coverage.
- *Shift order.* Within a bucket the most constrained shift goes first (fewest
  eligible drivers), then the canonical order date, `sortOrder`, `startTime`, name,
  id. This matters: Friday {A,B} and Saturday {A only}, each needing one — plain
  chronological order can give Friday to A and leave 2 / 0; scarcity-first gives
  Saturday to A and Friday to B, 1 / 1 (tested). It is a heuristic, not a global
  optimum.
- *History.* Shifts before the operational today are skipped (today is eligible);
  their assignments still count; past gaps are never reported. A wholly past week
  plans nothing (`weekIsHistorical`) and the database's `historical_week` is the
  authoritative verdict.
- *No* overlap, daily-maximum, rest-period or weekly-maximum rule; fairness is per
  resort/week only (no cross-week fairness).

**Weekly tie-break.** FNV-1a 32-bit over the UTF-8 bytes of
`${weekStart}:${driverId}`, compared as an unsigned integer ascending (integer math
via `Math.imul`), then `driverId`. Deterministic and stable across engines; it
ROTATES by week so equal-count ties do not always favour the same driver. Fixed
test vectors pin it — changing it changes every future plan.

**Repository flow (`generateAutoRota({ resortId, weekStart })`).** Read the week
(`getManagerWeekRota`) → plan → one `apply_auto_rota` call with ONLY
`{shift_instance_id, driver_id}` pairs → return the **database's** result
(`assignedCount`, `remainingOpenSlots`, `uncoveredShiftIds`,
`skippedPastShiftCount`, `runId`), never the planner's numbers. A `stale_plan`, or a
`historical_shift` (the operational day crossed midnight), discards the plan and
re-reads and re-plans **exactly once** (`autoRotaOrchestration.ts`, shared by both
providers); a second one surfaces as the typed error. `published_week`,
`historical_week`, permission, malformed and unknown errors are never retried.
Errors are a typed `AutoRotaError` (`published_week`, `historical_week`,
`historical_shift`, `stale_plan`, `permission_denied`, `resort_not_found`,
`invalid_week`, `invalid_plan`, `unknown`) with first-party `userMessage`s; partial
coverage, "no eligible driver" and "nothing to create" are successes. Re-running is
the V1 idempotency: given the state after a previous run the planner proposes
nothing.

**Mock provider.** Uses the same planner and the same retry orchestration, applies
the proposed rows to the mock assignment state (`source: 'auto'`, additive), and
refuses a published or wholly past week with the same typed errors. Being a mock it
has no transaction, lock or real concurrency (the stale path is never taken).

**Tests:** `lib/autoRotaPlanner.test.ts`, `lib/autoRotaHash.test.ts`,
`repositories/autoRotaOrchestration.test.ts`, `repositories/supabase/rota.test.ts`,
`repositories/supabase/rotaErrors.test.ts`, `repositories/mock/rota.test.ts`.

---

## Q. Auto-Rota — manager Generate Rota UI (AR-C)

**Implemented.** The Generate Rota control lives in the existing Manual Rota card
(header action) on Manager → Rota & Availability — there is no separate Auto-Rota
page. It is scoped to the resort + week selected on that page.

**Offered when** the selected week is NOT published and has at least one shift
dated today or later (today is not historical; a partially historical current
week qualifies). **Disabled, with the reason as visible text** (linked to the
button with `aria-describedby`): published — "Auto-Rota can’t run after this rota
has been published."; every shift in the past — "Auto-Rota can’t generate a
historical rota."; no shifts — "There are no shifts to fill this week." (the
existing "No shifts are scheduled for this week." state stays, and the UI never
calls the repository for such a week). Manual Rota editing is unaffected by
Generate being disabled.

**Flow.** One confirmation dialog (the shared `ConfirmDialog`/`Modal`, so focus is
trapped, Escape closes, focus returns to the button) that names the resort and the
week and says Auto-Rota keeps all existing assignments, only uses drivers marked
Available, and fills open positions using the rota fairness rules (plus "Past
shifts will not be changed." when the week has past shifts). **There is no
preview** — no predicted names, counts or fairness scores; the database result
AFTER generation is the authoritative outcome. Confirming calls
`RotaRepository.generateAutoRota({ resortId, weekStart })` through a TanStack
mutation; the UI never calls `apply_auto_rota`, builds the plan, or sees SQLSTATEs.
While generating, the button and the dialog's actions are disabled and read
"Generating…" (and the run cannot be dismissed); nothing else is frozen.

**Result.** On success only the selected week's `managerRotaKeys.week` query is
invalidated and re-read — the ordinary Manual Rota then shows the real generated
assignments (never fabricated in component state); Availability, payroll,
configuration and Driver My Rota are untouched. The notice, from the authoritative
result: "N assignments added. All scheduled positions are covered." / "… M
positions remain uncovered." / "No new assignments were needed. The rota is fully
covered." / "No assignments could be added. M positions remain uncovered."
(singular/plural handled). Leaving positions uncovered is a success, never an
error: it is a status notice (info tone when nothing was added), the coverage
pills stay authoritative, and Unavailable / Not Submitted drivers are never
assigned to fill a gap. Generated assignments look like any other assignment (the
domain keeps `source = auto`); the manager edits them with the normal controls.

**Re-running** is safe and additive: the button stays "Generate Rota". Removing a
generated assignment makes the shift Uncovered; generating again fills the
current gap by current availability and fairness; a manual edit is respected by
the next run; a fully covered week reports zero created.

**Errors** are the repository's typed `AutoRotaError` with its first-party
`userMessage`, shown in an inline alert while the rota stays visible. Published
(including a publish that happened after the page loaded), historical and a
stale plan that survived the repository's one retry also refetch the week, so the
manager sees the current state (a publish race flips the chip to Published and
disables Generate). There is no UI retry loop; the manager simply clicks again.

**Lifecycle.** The notice and an open dialog belong to the resort + week they were
produced for: changing either clears the notice and closes the dialog, and a
result arriving after the manager moved away is not shown on the new selection
(the old week's data is still refreshed).

**Tests:** `components/rota/GenerateRota.test.tsx`, `components/rota/autoRotaUi.test.ts`,
`pages/manager/RotaAvailability.test.tsx`, `components/rota/ManualRotaPanel.test.tsx`.

---

## R. Auto-Rota V1 — final status, verified behaviour and limitations (AR-D)

**Auto-Rota V1 is IMPLEMENTED and COMPLETE** (database apply §O, planner and
repository §P, manager UI §Q), verified end to end against real local Supabase
with real sessions, mock mode, 375px mobile and keyboard use.

**What it does (V1).** For one resort + Monday–Sunday week it proposes, with a pure
deterministic planner, who fills each OPEN position, and the database applies the
proposal atomically after re-validating every pair: only explicitly Available
drivers for the exact shift (never Unavailable / Not Submitted, no override);
weekend (Fri–Sun) bucket first, then weekday (Mon–Thu); most-constrained shift
first within a bucket; per slot fewest bucket assignments → fewest total →
weekly FNV-1a tie-break → `driverId`; active existing assignments (manual or
auto, including a manual override) preserved and counted, inactive ones ignored
(kept, never counted, never selected); never over-assigns and never repeats a
driver on a shift; partial coverage and "nobody eligible" are successes; past
shifts skipped (today allowed) while past assignments still count; a published
week is refused by the server; re-running is additive and idempotent; generated
rows are `source = auto`, audited with a run id, and are edited with the normal
Manual Rota controls. It is serialized per resort + week with Manual Rota edits
and publication writes, and a plan that went stale is re-read and re-planned once.

**Verified-in-use examples (real Supabase).** Friday {A,B} / Saturday {A only}:
Saturday goes to A and Friday to B; a lone driver Available for Saturday Lunch and
Unavailable for Saturday Dinner is assigned Lunch only; a required-2 shift gets two
distinct drivers (an inactive assignee does not count); a driver can hold two
shifts on one day.

**Known limitations — intentional V1 scope, not defects:**
- **No overlap, daily-maximum, rest-period or weekly-maximum rule.** A driver may
  receive several shifts the same day, even overlapping ones, if explicitly
  Available for each.
- **Fairness is per resort + week only** (no cross-week or cumulative fairness; the
  weekly tie-break rotation only spreads equal ties).
- **No bulk undo / "clear generated" / regenerate-from-scratch.** Removing a
  generated assignment is manual, and re-running refills open slots (so a removed
  auto assignment can be re-added by a later run).
- The planner is a greedy heuristic (scarcity-first), not a global optimum.
- **Nothing is visible to drivers until the week is published** (publishing is §S).
- The availability read is bounded by the API's 1000-row cap (shifts × drivers).


## S. Publish Rota V1 — IMPLEMENTED / COMPLETE (PB-A → PB-D)

**Status: Publish Rota V1 is IMPLEMENTED and COMPLETE.** The authoritative database
RPC (PB-A), the repository / error contract / mock provider (PB-B), the Manual Rota
Publish control (PB-C) and the final end-to-end verification (PB-D, below) are done
and green. The scheduling lifecycle is now: Resort & Shift Setup → Driver
Availability → Auto-Rota → Manual Rota review/edit → **Publish Rota** → Driver My Rota.

**V1 in one place:** publish-only (no unpublish / retract / make-draft, no
notifications, no auto-publish, no versions or snapshots); uncovered positions are
allowed but need an explicit, server-recounted acknowledgement; a week with zero
assignments is publishable the same way; a week with no active shift is not; a wholly
past week (or one whose every active shift is before today) is not, while a partially
historical week and "today" are; an inactive resort is refused; already published is
an idempotent success; drivers see the live assignments (no snapshot), so manager
edits after publishing show on their next refetch; Availability is locked and
Auto-Rota is blocked by the publication row itself; `generation_source` is derived by
the server and never shown in the UI.

**What publishing means.** One deliberate, server-validated act per resort +
Monday–Sunday week that (a) makes the week's assigned shifts visible to drivers,
(b) locks driver Availability for the week and (c) stops Auto-Rota generating it.
All three already derive from a currently-published `rota_publications` row, so
publishing is a single row write: nothing is snapshotted, and drivers keep seeing
the live assignments — a Manual Rota edit after publishing (allowed, §C) is
visible to drivers on their next refetch. No notifications, no auto-publish, no
new tables, versioning or snapshots.

**PB-A (database).** `publish_rota(p_resort_id, p_week_start, p_confirm_uncovered
default false)` is manager-only and SECURITY DEFINER, and is the **only**
application write path to `rota_publications`: managers keep SELECT, and direct
INSERT / UPDATE / DELETE is closed (the previous FOR ALL policy and grants are
gone). It takes the shared resort/week lock (the same one Auto-Rota apply and
manual assign/unassign use), so publish, Auto-Rota apply, manual edits and other
publishes serialize per resort + week (verified with real two-connection races).
Rules, in order:
- **Already published → idempotent success** (`already_published`): no write, no
  duplicate row, no extra audit event, the original `published_at`.
- Inactive resort → `23514 resort_inactive`; a week that ended before the resort's
  operational today, or whose active shifts are all before today →
  `55006 historical_week`; no active shift instance → `23514 no_shifts`. A partially
  historical or current week, and a shift dated today, are publishable.
- **Uncovered positions** (today/future active shifts: `required_drivers` minus
  assignments of ACTIVE drivers, never negative; past gaps ignored) are allowed but
  must be acknowledged: without `p_confirm_uncovered` the server raises `VD003` with
  the count in DETAIL and writes nothing. The count is recomputed under the lock on
  every call — a stale prompt can never publish against an outdated number. A week
  with zero assignments is publishable the same way.
- `generation_source` is derived on the server (`auto` if any assignment in that
  resort + week is auto, else `manual`; recomputed when a retracted row is
  republished) and is never supplied by the caller. A retracted row (the schema's
  `unpublished_at`) is republished by UPDATE because the table is unique per
  resort + week.
- Audited via the generic trigger plus a context (operation, resort, week,
  uncovered count, whether it was acknowledged, source, republished).
- **Publish-only in V1**: there is no unpublish / retract RPC or control.
- Availability confirmation is not part of publishing: a driver who has not
  confirmed Availability produces no special warning; the only acknowledgement is
  for uncovered positions.

**PB-B (repository).** `RotaRepository.publishRota({ resortId, weekStart,
confirmUncovered? })` → `PublishRotaResult { resortId, weekStart, publishedAt,
uncoveredSlots, alreadyPublished }` (no generation source, actor or row id). The
Supabase provider makes exactly one `publish_rota` call per invocation and neither
writes `rota_publications` nor counts coverage. Failures are typed and React never
sees SQLSTATEs: `PublishRotaConfirmationRequiredError` (`uncoveredSlots`; guard
`isPublishRotaConfirmationRequired`; the count is parsed from DETAIL only and an
invalid / missing count becomes `unknown`, never a made-up number) and
`PublishRotaError` with kind `historical_week`, `no_shifts`, `resort_inactive`,
`resort_not_found`, `invalid_week`, `permission_denied` or `unknown` (any
unexpected SQLSTATE / DETAIL combination). Already published is a normal result.
The mock provider mirrors the same guards, order, confirmation rule and typed
errors over `mockRotaPublications`, so a mock publish feeds the manager rota,
Driver My Rota, the Availability lock and the Auto-Rota block; it has no lock or
concurrency (that is the database's, tested in `87_publish_rota.sql`).

**PB-C (manager UI).** Inside the existing Manager → Rota & Availability → Manual
Rota card (no new page), the header holds **[Generate Rota] [Publish Rota]** for the
selected resort + week: **Publish Rota is the primary action, Generate Rota
secondary** (Publish is the final decision). On narrow screens both stay full-size
and share one row.
- **Enabled** only for a loaded, unpublished week with at least one shift dated the
  operational today (Europe/Zurich) or later: today and a partially historical week
  are allowed. Disabled, each with visible text tied to the control: already
  published (the control reads **Published**: "This rota has already been
  published."), no shifts ("There are no shifts to publish this week."), wholly past
  ("This rota can’t be published because the week is in the past."). It is also
  disabled while a Publish or a Generate call is running. The Draft/Published chip
  stays the authority; Generate's own reason ("Auto-Rota can’t run after this rota
  has been published.") is unchanged and there is no Publish-specific Generate logic.
- **Confirmation** (the shared accessible dialog): resort, week, and what publishing
  does — makes assigned shifts visible to drivers, locks driver availability for the
  week, stops Auto-Rota generation. It shows no coverage prediction before the server
  answers. The first call is `publishRota({ confirmUncovered: false })`.
- **Uncovered positions are the server's call.** If the repository raises the typed
  confirmation-required error, the same dialog switches to "N position(s) still
  uncovered" using the SERVER's count (correct singular/plural), the standing line
  "You can still publish this rota…", an extra "No drivers are assigned yet." when the
  loaded week has no active assignment, and **Publish anyway** (`confirmUncovered:
  true`). The confirmed call's result is authoritative: if the count changed, the
  manager is not asked a third time, and a publish with positions left reads as a
  warning-toned notice ("Rota published. N positions are still uncovered…"), never an
  error.
- **Already published** (for example another session got there first) is a success
  ("This rota is already published."); the week is refetched and flips to Published.
- **Pending / lifecycle.** While publishing, both header buttons and the dialog are
  disabled and the confirm button reads "Publishing…"; a second click cannot start a
  second call. Changing resort or week closes the dialog and clears the notice, and a
  result that arrives after the manager moved on is never shown on the new selection.
  Typed publish errors show first-party copy inline (alert); an unknown or network
  failure shows a generic message; the rota stays on screen and Publish stays usable.
  No SQLSTATE, VD003 or database text ever reaches the UI.
- **Refresh after a successful publish:** the manager rota for that resort + week, the
  manager Availability summary for that resort + week and the per-driver Availability
  detail queries for that week (the shared `availabilityKeys`); nothing for payroll,
  configuration, other weeks or other resorts, and no driver cache.
- **Publish only.** There is no unpublish, retract, republish or make-draft control
  or wording. After publishing, Generate is disabled, **manual Assign and Remove stay
  available** (today and future shifts, per the existing rules), a manual edit never
  unpublishes the week, and drivers see it on their next refetch without republishing.

**Focus after publishing (PB-D fix).** A successful publish turns the opener into the
disabled "Published" control, so the shared Modal's focus restore would drop focus to
the page body. After any successful result (published, published with uncovered
positions, already published) focus now moves to the result notice (a programmatically
focusable status region); Cancel, Escape and a failed publish still return focus to
the Publish Rota opener. The shared Modal itself is unchanged.

**PB-D verification (real local Supabase, real logins; scratch fixtures, nothing
committed).** Verified: the full Availability → Generate → manual edit → Publish →
Driver My Rota workflow through the UI (Availability locked, answers unchanged);
covered, uncovered (plural and singular), zero-assignment, zero-shift, wholly past,
partially historical, today, inactive-resort and already-published cases; the count
changing between the warning and the confirmation in both directions (the confirmed
call and its audit row use the current count, no third prompt); republish of a
retracted row (same row, `published_by` and `published_at` refreshed,
`generation_source` recomputed); `generation_source` auto / manual / zero-assignment;
driver visibility (own shifts, unassigned driver Published + empty, other-resort
driver nothing, no co-driver identity); post-publish assign / unassign visible to the
driver on refetch with the publication row and its audit untouched; Auto-Rota
blocked (`published_week`, nothing created); direct manager INSERT / UPDATE / DELETE
refused (`42501`), driver and anon refused; five two-connection races (Auto-Rota
first → Publish waits and publishes the finished draft; Publish first → Auto-Rota
refused; manual assign / unassign first → Publish reads the fresh coverage, asking for
confirmation with the fresh count when a gap appeared; two managers publishing → one
row, one audit insert, the second an idempotent success); audit contexts correct, not
leaking onto other tables or later writes; mock mode and 375px mobile (actions row,
disabled reasons, both dialogs, pending state, warning notice, published cards, no
horizontal overflow); keyboard operation, focus trap, Escape, focus return.

## T. Attendance — database foundation (AT-A) — UI / repository NOT implemented yet

**Status: only the authoritative database layer exists (AT-A). There is no repository
API, mock state or manager UI for Attendance yet, and Attendance is NOT complete.**
No payroll calculation exists or is implied.

**What it is.** Attendance records what actually happened to an ASSIGNED driver on a
Shift: operational truth that payroll will later consume. It is **manager-authoritative**
(drivers have no read and no write; anon none) because it affects pay. There is one row
per rota assignment, and **no row means "Not recorded"** — there is no persisted
pending / not-recorded status. Missing attendance will later be a payroll exception;
the published rota is **not** an attendance fallback (the old table comment that said
otherwise was corrected).

**Statuses (exactly four, unchanged).** `worked` — the driver worked this assigned
Shift. `no_show` — expected, did not work, absence not accepted. `excused` — did not
work, management accepted the absence. `cancelled` — **this driver** was stood down /
their attendance was cancelled and they did not work; it does **not** mean the Shift
Instance was cancelled (a separate concept). Later UI wording: "Cancelled (stood
down)". Downstream, only `worked` earns the Shift base guarantee; `no_show`, `excused`,
`cancelled` and no row do not (§G.E).

**Writes.** `record_attendance(p_assignment_id, p_status, p_reason default null)` and
`clear_attendance(p_assignment_id, p_reason)` are manager-only SECURITY DEFINER RPCs and
the only application write path; managers keep SELECT, direct INSERT / UPDATE / DELETE
is closed. The assignment id is the identity: the server derives shift, driver, resort
and week. A composite FK `attendance(shift_instance_id, driver_id) →
rota_assignments(…) ON DELETE RESTRICT` makes attendance for an unassigned pair
impossible and stops an assignment being deleted from under its attendance.

**When it may be recorded** (resort operational date, no start/end-time arithmetic;
the Shift need not have ended):
- **Future** shift → refused (`future_shift`), whatever the publication state.
- **Today** → the week must currently be Published (`week_not_published`): until it is
  live, today's assignments are still operationally editable.
- **Past, week Published** → allowed, no special reason.
- **Past, week NOT Published** (a missed Publish; a wholly past week can no longer be
  newly published) → a **historical backfill**: allowed but an explicit **reason is
  required** (`historical_backfill_reason_required`), and the audit flags
  `historical_backfill = true`. Recording never publishes the week or touches
  `rota_publications`.
- A **cancelled** Shift Instance refuses new attendance (`shift_cancelled`).
- The driver's active flag and the resort's active flag never block it (history stays
  correctable).
- Not supported in V1: someone who covered a past Shift without ever being assigned
  cannot be recorded, because assignment creation on past shifts is frozen. A future
  audited historical assignment / backfill workflow would be needed.

**Correction.** The first record inserts; a different status **updates the same row in
place** (the audit before-snapshot keeps the previous value); `recorded_by` and
`recorded_at` are set to the manager and time of the **latest** recording action. The
same status again is an idempotent success (`changed = false`: no write, no audit — a
different reason is audit metadata, not a change). The optional reason (trimmed, empty
= none, max 500) is stored **only in the audit context**, never in `attendance.notes`.

**Clear.** `clear_attendance` deletes the row to return the assignment to Not recorded
(a **required** reason, max 500), so one accidental entry can't block unassigning a
today assignment forever. Already Not recorded is an idempotent success (no write, no
audit). It is not gated on publication, date or Shift status (historical corrections
and removal of corrupt rows must stay possible) and does not touch the assignment,
publication, availability, the Shift or pay. After a clear, today's assignment can be
removed again under the normal Manual Rota rules; a past assignment stays frozen.

**Serialization.** Both RPCs take the existing `rota_week_lock(resort, week)` and re-read
the assignment: record vs `unassign_driver` — whoever locks first wins (attendance
first → the unassign is refused `attendance_recorded`; unassign first → the record is
`assignment_not_found`); record vs record and clear vs unassign serialize; Publish vs
record-today serialize and publication is read under the lock. The FK is the last
defence.

**Audit.** Generic row audit plus context: record — `operation record_attendance,
assignment_id, resort_id, week_start, previous_status, new_status, historical_backfill,
reason (when given)`; clear — `operation clear_attendance, assignment_id, resort_id,
week_start, previous_status, reason`.

**Deferred / not built:** `actual_start` / `actual_end` (reserved columns, not exposed
by the RPCs), repository / mock / read-model / UI (AT-B, AT-C), payroll calculation,
Onfleet, the live Dashboard, an audited historical-assignment workflow.

## U. Driver Check-in — database foundation (AT-A2) — UI / repository NOT implemented yet

**Status: only the authoritative database layer exists (AT-A2). There is no Check-in
button, repository method, mock state or manager display yet, and neither Driver Check-in
nor Attendance is complete.**

**Evidence vs truth.** A driver's **Check-in is operational evidence**; the manager's
**final Attendance (§T) is payroll truth**. Check-in never creates, implies or changes an
attendance row and has no pay meaning; payroll will read Attendance, not Check-in. All four
combinations are legal and the manager is never blocked: checked in + Worked / No show /
Excused / Cancelled, and not checked in + Worked / No show. A missing check-in is evidence,
not a blocker.

**What it records.** One immutable row per rota assignment in `driver_check_ins`
(`id`, `assignment_id` unique with FK `ON DELETE RESTRICT`, `checked_in_at`) written only
by `check_in_to_shift(p_assignment_id)` with the **server** time (read after the week lock
is held). The caller supplies neither a time nor a driver id. There is no location (no GPS,
geofence, IP, photo or device id): **a check-in proves only that the authenticated driver
invoked the app's check-in at that moment**. No check-out, no persisted late status or
minutes late, no clear-check-in workflow in V1.

**Who and when.** Only an **active driver** who owns the assignment: a manager cannot check
in on a driver's behalf, an inactive driver and anon are denied (`42501`), and another
driver's assignment is indistinguishable from a missing one (`P0002`, so assignment ids
cannot be probed). The week must be **currently Published** and the shift active. The
**window opens 30 minutes before the scheduled start and closes at the scheduled end, both
inclusive**, computed from the shift date, wall-clock times and the **resort's own timezone**
(absolute `timestamptz` comparison, so DST cannot shift the 30 minutes). A late check-in
inside the window is valid. Lunch and Dinner on one day each have their own check-in.

**Idempotency and Attendance.** A repeat call returns the **original** check-in (`created =
false`): no update, no second row, no second audit event — and it is checked before every
gate, so a legitimate retry still succeeds after the window closed or after Attendance was
recorded. If **no check-in exists and final Attendance already does**, a new check-in is
refused (`attendance_already_recorded`); the window is tested first so a driver is not told
attendance exists unless the window is open. If the check-in came first, any Attendance
status may follow, and `clear_attendance` **never deletes** the check-in.

**Unassign and serialization.** `unassign_driver` now also refuses when a check-in exists
(`55006` DETAIL `check_in_recorded`, distinct from `attendance_recorded`, which keeps
precedence); the FK is the final defence. If reality differs, the manager records / corrects
final Attendance. `check_in_to_shift` takes the existing `rota_week_lock` and re-reads, so
check-in vs unassign (check-in first → unassign refused; unassign first → check-in is
`assignment_not_found`, no orphan), check-in vs `record_attendance`, vs `clear_attendance`,
vs Publish and check-in vs check-in all serialize.

**Visibility.** Managers read `driver_check_ins` (SELECT only, no client write). Drivers have
no table access; they read **their own** `checked_in_at` and the **server-computed**
`check_in_opens_at` / `check_in_closes_at` through `driver_visible_assignments` (three
columns appended; the view is still session-filtered to the driver's own published, active
assignments). No colleague check-in, and no attendance status, ever reaches a driver. The
manager read model can embed `driver_check_ins(...)` and `attendance(...)` in the existing
assignments query with no extra round trip (AT-B).

**Audit.** Generic row audit plus context `operation driver_check_in, assignment_id,
shift_instance_id, driver_id, resort_id, week_start`; an idempotent repeat writes nothing.

**Error contract for AT-B:** `42501` permission_denied · `22023` invalid_request · `P0002`
assignment_not_found · `55006` + `week_not_published` / `shift_cancelled` /
`check_in_too_early` / `check_in_closed` / `attendance_already_recorded`; and, from Manual
Rota, `55006` + `check_in_recorded` on unassign.

**Deferred / not built:** repository, mock, read models and UI (AT-B, AT-C1 driver, AT-C2
manager), any lateness display or policy, check-out, a manager correction of a check-in,
location evidence, notifications, payroll calculation.
