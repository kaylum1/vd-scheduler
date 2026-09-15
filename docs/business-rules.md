# Product / business rules

Durable product decisions that aren't fully derivable from the code or
migrations alone — recorded here so a future session (Claude or human)
doesn't have to re-litigate them. Each entry says what's *decided*, and
separately, what's actually *implemented* as of the stage/checkpoint noted.
An entry existing here does not imply its UI exists yet — check the
"Implemented" line.

---

## A. Three coverage states — "no service", "staffing not configured", "uncovered"

**Decided:** Stage 2D Checkpoint 1.1 (states 1 and 3); extended to three
states in Stage 2D Checkpoint 3 once staffing moved out of Shift Setup.

A calendar date/cell with **no active `shift_instance`** is a normal,
expected no-service state. It must render as neutral/grey — e.g. "No
service scheduled" or a visually blank/disabled cell. It must **never**
render as:

- "No coverage"
- "No drivers assigned"
- "0/x covered"
- a closure warning

Since Stage 2D Checkpoint 3, staffing (`required_drivers`) is resolved from
`rota_rules_default`/`rota_rules_weekday`/`rota_rules_date` at
materialisation time, and a shift with **no applicable rota rule at all**
materialises with `required_drivers = NULL` — never a silently-guessed `1`.
This is a **second, distinct non-error state**, "staffing not configured":
a real shift exists, but nobody has said yet how many drivers it needs.
It must render as amber/"Needs Attention" (e.g. "Staffing not configured")
— **never** as a red "uncovered" shortfall (that would train managers to
treat a configuration gap as if it were a shift genuinely short-staffed),
and never as "0 drivers needed" (that would hide a real gap as if it were
intentional).

Red/uncovered styling is reserved for the narrowest case: **an active real
shift exists, `required_drivers` is a real configured number, and assigned
driver count < required_drivers.**

| Scenario | required_drivers | Rendering |
|---|---|---|
| No Dinner shift_instance exists Monday | n/a (no row) | Grey / neutral — "no service" |
| Dinner exists, no rota rule was ever configured | `NULL` | Amber — "Staffing not configured" |
| Dinner exists, required_drivers=1, assignments=0 | `1` | Red — "uncovered" |
| Dinner exists, required_drivers=1, assignments=1 | `1` | Green — "covered" |

**Why it matters:** conflating "no service" with "uncovered" makes every
resort with a lighter schedule (or one not yet configured, like a brand-new
resort) look like it's in a permanent coverage crisis. Conflating "staffing
not configured" with either of the other two either hides a real
configuration gap (as "no service") or misreports it as an urgent
under-staffing emergency (as "uncovered") when the actual problem is
upstream, in Rota Rules — both are misleading to a manager and would train
them to ignore or misdiagnose real warnings.

**Implemented:**

- [`coverageTone`/`coverageLabel`](../src/components/ui/StatusPill.tsx) —
  pure functions that render coverage for a shift *already known to exist*.
  `required: number | null` — `null` (Stage 2D Checkpoint 3) renders
  amber/"Staffing not configured"; a real number renders red/amber/green as
  before. Never called for a "no shift" cell.
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
- [`materialise_shift_instances`](../supabase/migrations/20260914160448_payroll_and_rota_rule_foundations.sql) —
  leaves `shift_instances.required_drivers` (and `base_pay_chf`/
  `delivery_rate_chf`/`is_premium`) `NULL` whenever no applicable rule
  exists, and reports how many via `missing_payroll_rule_count`/
  `missing_rota_rule_count` — never coalesces a missing rule to `0`/`1`/
  `false`. Nullability itself is the "not configured" signal; no separate
  status column was added.

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

**One shift, one time:** a Shift has exactly one start/end time across
every weekday it's currently active on. A service that genuinely needs a
different time on a different day is a **separate** Shift (e.g. "Weekend
Dinner"), never a per-weekday time on one Shift. The atomic RPCs
(`create_shift`/`revise_shift`/`reactivate_shift`) enforce this by
construction — they take one time for the whole weekday selection, so
there is no way to create per-weekday times through them.

**Legacy inconsistent data — never silently flattened:** the pre-
Checkpoint-4 UI *did* allow different times on different weekdays of the
same shift type (it wrote `shift_templates` rows one weekday at a time,
each with its own time). Data like that can still exist. When the
Checkpoint 4 UI assembles a shift type's current templates into one
"Shift" and finds they don't actually share one time (and/or one
effective period), it does **not** guess which row is authoritative — it
shows a review-required notice ("This shift has different times
configured on different days...") instead of a schedule, and disables
the simplified Edit form for it. See
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

**Implemented (Stage 2D Payroll Checkpoint A):** `shift_base_pay_rules`
(renamed from `payroll_rules`, `delivery_rate_chf` removed), `driver_delivery_rates`
(new, mirrors the same effective-dated/no-overlap/manager-only/audited
pattern). `shift_instances` no longer has `base_pay_chf`/`delivery_rate_chf`
at all (dropped, not just deprecated) and `materialise_shift_instances` has
zero payroll-rate responsibility — no join to either rate table, no
`missing_payroll_rule_count` (removed from its return shape entirely;
`missing_rota_rule_count` is retained, since staffing remains a genuine
materialisation/operational concern). `shift_templates.{base_pay_chf,
delivery_rate_chf,required_drivers,is_premium}` remain exactly as
deprecated/inert since Checkpoint 3 — untouched by that checkpoint, out of
scope.

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
