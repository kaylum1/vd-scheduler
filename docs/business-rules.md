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
- [`ShiftCard` vs `EmptyShiftCell`](../src/components/rota/ShiftCard.tsx) —
  `WeekGrid` renders `ShiftCard` only when a real shift exists for that
  row/day, `EmptyShiftCell` (neutral, dashed border, no text) otherwise.
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
[`ShiftCard.test.tsx`](../src/components/rota/ShiftCard.test.tsx).

**Known temporary inconsistency (not a bug to fix here):** Manager
Dashboard/Rota are still Stage 1.1's mock data (`src/mock-data/shifts.ts`),
which currently fabricates a Dinner shift for every resort every day —
including Verbier, which the *live* Configuration page (Stage 2D Checkpoint
1) correctly shows has zero configured shift types. This is why Verbier can
currently show "No shift types yet" in Configuration while the mock Rota
still shows a (fabricated, uncovered) Dinner shift. This is a mock/live data
source mismatch, not a presentation-logic bug, and is **not** to be papered
over by mixing real Supabase shifts into the mock rota. It resolves itself
naturally once Manager Rota is migrated to live data (a future checkpoint).

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

**Implemented:** nothing yet. This section is a recorded requirement only —
belongs to the future "real Manual Rota" checkpoint.

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

## H. Shift staffing simplification and future Auto-Rota direction

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

**F. Future Auto-Rota (design direction only — not implemented).** Will be
built entirely from `shift_instances`/`required_drivers`/dates/driver
resort/`availability`/`rota_assignments` — no Rota Rules, no High-value.
Both `availability` (`available`/`unavailable`/absence=Not Submitted) and
`rota_assignments` (`assignment_source` already anticipates `'manual'`/
`'auto'`, multiple distinct drivers per shift already supported) were
confirmed sufficient by inspection; no redesign is planned.

Allocation runs **per resort, per Monday–Sunday week**, in two independent
phases:
1. **Weekend first** (Fri/Sat/Sun) — balance weekend assignment counts as
   evenly as availability permits.
2. **Weekday second** (Mon–Thu) — balance weekday assignment counts
   separately; weekend and weekday fairness are never blended.

Within each phase: **coverage always wins over fairness** (an open position
is filled if anyone eligible is available, even if that makes the count
less even); **availability is a hard constraint** (only an explicit
"Available" answer counts — Not Submitted/Unavailable never assigned, never
guessed); **driver-resort is a hard constraint**; ties broken
**deterministically** (fewest assignments in the current phase, then fewest
total assignments this week, then `drivers.created_at`, then `drivers.id` —
never randomness, never display name). A multi-driver Shift (e.g. "Dinner
(2P)") needs that many **distinct** drivers, each counted independently.
**Existing manual assignments are preserved and counted** toward a driver's
fairness total before allocation begins — Auto-Rota only fills the
remaining open positions on a shift, never replaces or rebalances around a
manual assignment.

---

## I. Driver Availability

**Decided/Implemented:** Stage 3. Makes the availability architecture that
already existed at the schema/RPC level (`availability`,
`availability_submissions`, `week_availability_status`,
`confirm_availability_week`, `reopen_availability_week`, the stale-
invalidation trigger — all built in earlier checkpoints) real end to end:
a live driver-facing page and manager-facing visibility, both through the
repository layer. No Auto-Rota, no manual assignment, no attendance, no
Onfleet, no payroll calculation.

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
Rota, or Publish control exists in this manager view** — those remain
future checkpoints; the pre-existing Stage 1.1 mock Rota grid is kept
separate and clearly labelled as a preview, never blended with this live
panel.

**I. Future Auto-Rota's eligibility input (design constraint, not built).**
Auto-Rota (§H above) must be able to query, per shift_instance: which
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
(new, mounted inside `pages/manager/RotaAvailability.tsx` above the
still-mock Rota preview).

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
