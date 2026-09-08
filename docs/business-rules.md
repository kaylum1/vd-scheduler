# Product / business rules

Durable product decisions that aren't fully derivable from the code or
migrations alone — recorded here so a future session (Claude or human)
doesn't have to re-litigate them. Each entry says what's *decided*, and
separately, what's actually *implemented* as of the stage/checkpoint noted.
An entry existing here does not imply its UI exists yet — check the
"Implemented" line.

---

## A. "No shift scheduled" ≠ "uncovered shift"

**Decided:** Stage 2D Checkpoint 1.1.

A calendar date/cell with **no active `shift_instance`** is a normal,
expected no-service state. It must render as neutral/grey — e.g. "No
service scheduled" or a visually blank/disabled cell. It must **never**
render as:

- "No coverage"
- "No drivers assigned"
- "0/x covered"
- a closure warning

Red/uncovered styling is reserved for the narrower case: **an active real
shift exists, and assigned driver count < required_drivers.**

| Scenario | Rendering |
|---|---|
| No Dinner shift_instance exists Monday | Grey / neutral — "no service" |
| Dinner exists, required_drivers=1, assignments=0 | Red — "uncovered" |
| Dinner exists, required_drivers=1, assignments=1 | Green — "covered" |

**Why it matters:** conflating the two makes every resort with a lighter
schedule (or one not yet configured, like a brand-new resort) look like it's
in a permanent coverage crisis, which is misleading to a manager and would
train them to ignore real warnings.

**Implemented (Checkpoint 1.1 audit):** The relevant presentation code
already gets this right — no behavioural bug was found, only documentation
added to make the invariant explicit for future changes:

- [`coverageTone`/`coverageLabel`](../src/components/ui/StatusPill.tsx) —
  pure functions that render coverage for a shift *already known to exist*
  (`required` > 0, matching the DB's `required_drivers > 0` check). They are
  never called for a "no shift" cell.
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
