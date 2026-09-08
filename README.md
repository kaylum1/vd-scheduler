# VD Scheduler & Payroll — Stage 1.1: Frontend Shell (UX revision)

Application shell and visual structure for the Verbier / Zermatt / Crans-Montana
Delivery driver scheduling, availability, attendance and payroll platform.

**Scope of this stage:** frontend structure and mock interactions only. There is
no database, no authentication, no rota-generation algorithm, no payroll
calculation and no Onfleet CSV processing yet — those arrive in later stages.
Everything on screen is driven by static mock data in `src/mock-data/`.
Stage 1.1 locks the interaction model (see **Stage 1.1 changes** below) ahead
of the database/backend work.

## Stack

- Vite + React 18 + TypeScript
- Hand-authored CSS (`src/styles/`) with a small set of design tokens, rather
  than a utility framework — see **Notes on stack choices** below.
- A minimal hand-rolled hash router (`src/router.tsx`) — no routing library
  dependency for the small, flat route set this stage needs.

## Getting started

```bash
npm install
npm run dev
```

Then open the printed local URL (defaults to http://localhost:5173).

`npm run build` produces a production build; `npm run preview` serves it
locally.

By default (`VITE_DATA_PROVIDER=mock`) the app runs exactly as described
below — no backend, no login. To run it against the real local Supabase
backend and real authentication instead, see
[`docs/local-auth-setup.md`](docs/local-auth-setup.md).

Durable product/business-rule decisions (the kind not derivable from code
alone — coverage-state semantics, Onfleet mapping, published-rota override,
driver language, future modules) live in
[`docs/business-rules.md`](docs/business-rules.md).

## Project structure

```
src/
  types/            Domain types shared by every layer (Resort, Driver,
                     ShiftDefinition, ShiftInstance, AvailabilityEntry, ...).
                     Components only ever consume these shapes — no
                     component talks to storage or business logic directly.
                     isPremium stays in this model even though drivers never
                     see it rendered anywhere.
  mock-data/         Placeholder resorts, drivers, shift templates and a
                     deterministic mock rota/availability/payroll dataset.
                     This is the ONLY thing to swap out when a real backend
                     arrives — components should not need to change.
  lib/                View-model helpers shared across pages:
                       weekRows.ts — aligns a week's shifts into rows by
                         shift name (drives both the Manager Rota grid and
                         the Driver Availability grid).
                       rotaReadiness.ts — per-resort scheduling-readiness
                         snapshot used by the Dashboard's Next Week Status.
  state/             AppStateContext — a Stage 1 stand-in for authentication
                     (Manager/Driver role switch + "signed in" driver). This
                     is removed wholesale once real auth exists.
  router.tsx          Minimal hash router (path + navigate + <Link>).
  components/
    layout/           AppShell, TopBar, Sidebar, RoleSwitcher, PageHeader,
                       LoggedOutScreen — the chrome around every page.
    ui/                Card, Button, StatusPill, Badge, Avatar, EmptyState,
                       icons — shared presentational primitives.
    rota/              WeekNav (shared week navigator), ResortWeekSection ->
                       WeekGrid (aligned Mon–Sun grid, desktop; horizontal
                       day-scroll, mobile) -> DayColumn -> ShiftCard.
    availability/       WeekAvailabilityGrid + AvailabilityShiftCell — the
                       driver-facing counterpart to the rota grid, one week
                       at a time.
    dashboard/          TodayTomorrowPanel + NextWeekStatusPanel — the
                       Manager Dashboard's primary content.
  pages/
    manager/           Dashboard, RotaAvailability, Payroll, Configuration
    driver/             MyRota, Availability
```

## Interface states

There's no login yet, so the top bar has a **Manager / Driver** switch
(and, in Driver mode, a dropdown to pick which driver is "signed in") purely
to preview both interface states. This entire control is deleted once real
authentication is built.

- **Manager** — Dashboard, Rota & Availability, Payroll, Configuration
- **Driver** — My Rota, Availability

## Mock data / demo scenario

- Resorts: Crans-Montana, Zermatt, Verbier (Verbier intentionally has **no
  drivers yet**, to exercise the "no coverage" state throughout).
- Drivers: Gianni (Crans-Montana), Alex & Tomas (Zermatt).
- Standard shift: Dinner, 18:00–21:30, every resort/day, with Friday/Saturday
  marked internally as premium (higher required headcount). Premium is shown
  to managers only, as a small subtle dot on the shift cell — never as a
  driver-facing badge.
- Saturday additionally carries a Lunch shift (12:00–14:30) for
  Crans-Montana and Zermatt, to test a week with more than one shift per day.
- The demo week's assignments deliberately mix fully-filled (green),
  partially-filled (amber) and uncovered (red) shifts so every visual state
  is visible without clicking anything.
- Driver Availability now covers a small **archive window** (2 past weeks,
  read-only/locked) through the end of next month. Only the current week is
  published/locked by default; "next week" starts pre-confirmed (submitted)
  in the mock data so both the "open" and "submitted, reopenable" states are
  visible without clicking. Everything from the week after that onward is
  open and unsubmitted.

## Responsive behaviour

- Desktop (≥900px): fixed dark-teal sidebar, aligned Mon–Sun grid (Manager
  Rota and Driver Availability both use it) with one row per distinct shift
  name that week.
- Mobile (<900px): sidebar becomes a slide-in drawer behind the hamburger
  button; weekly grids switch to a horizontal scroll-snap row of day cards
  (with quick-jump day pills) instead of compressing seven columns.

## Stage 1.1 changes (UX revision, before database/backend work)

1. **No premium/high-earning indicators on any driver-facing screen.**
   `isPremium` stays in the domain model for the future fairness algorithm;
   My Rota and Availability never render it. Managers still see it, as a
   small subtle dot on a shift cell (Rota grid) or a text badge
   (Configuration) — never a driver-facing callout.
2. **Driver Availability redesigned around one week at a time.** A new
   `WeekAvailabilityGrid` lays Monday–Sunday out horizontally with every day
   given the same number of shift slots (via the shared `buildWeekRows`
   utility), so a Saturday with Lunch + Dinner sits in a two-row grid next to
   single-shift days, with visibly disabled empty cells elsewhere. Defaults
   to the current week if it's still open, otherwise the next open week.
   "Confirm Week" marks a week submitted; "Edit submission" reopens it as
   long as the rota isn't published yet; published weeks are read-only.
   Past/published weeks are reachable through a muted "History" strip rather
   than being part of the main scroll.
3. **Manager Dashboard reordered.** A compact Today/Tomorrow operational rota
   (per resort: shift, assigned drivers, red "No coverage" warnings) now
   leads the page, followed by a "Next Week Status" readiness section per
   resort (availability complete / drivers missing it / ready to generate /
   published / uncovered shifts). Recent Activity is demoted to a small
   secondary card.
4. **Manager Rota redesigned as an aligned grid.** Replaces the stacked-card
   layout with a real Monday–Sunday grid per resort — shift-name rows are
   generated from that week's actual data (never hard-coded Lunch/Dinner),
   so a week with only Dinner renders one row and a week with an extra
   Saturday Lunch renders two, aligned with Dinner every other day.
5. **Shared `WeekNav`** replaces the old plain week selector everywhere
   (Manager Rota, My Rota, Availability): strong styling for "This Week", a
   clear "Next Week" badge, muted "Archive" styling for past weeks, and a
   page-specific status chip (Published/Draft for Rota; Locked/Submitted/Open
   for Availability).
6. **Payroll period is now an arbitrary date range** (Start date / End date
   `<input type="date">`), with This Week / Last Week / This Month / Last
   Month shortcut buttons that fill them in. No calculation logic yet — the
   table is still the same sample data, with a note saying so.

## Notes on stack choices (flagged per project instructions)

Two deviations from the original brief, both pragmatic and easily reversed:

1. **Plain CSS instead of Tailwind.** Styling is hand-authored with CSS
   custom properties for the design tokens (colors, spacing, radii) in
   `src/styles/tokens.css`. This was built and screenshot-tested in an
   environment without registry access to install/compile Tailwind, so
   plain CSS was the only thing verifiable end-to-end. It's a straight
   swap if you'd rather move to Tailwind (or any other system) later —
   no component logic depends on it.
2. **A tiny hand-rolled router instead of `react-router-dom`.** This stage
   only needs a handful of flat routes, so `src/router.tsx` implements
   hash-based navigation (~50 lines) rather than adding a dependency I
   couldn't install and verify offline. `react-router-dom` can replace it
   directly if the route tree grows more complex in a later stage.

Everything else follows the brief as given. Flagging both here rather than
deciding silently, per the project's working instructions.

## Assumptions flagged for review

- How far back the availability "archive" should reach is unspecified — the
  mock data keeps 2 past weeks visible as history, easily changed via
  `ARCHIVE_WEEKS_BACK` in `src/mock-data/availability.ts`.
- Publish-window length (how many weeks ahead get published at once) is not
  yet specified — the mock data treats only the current week as published,
  with "next week" seeded as already-submitted-but-not-published so both
  states are visible on first load.
- Exact fairness weighting between "total shifts" and "premium/weekend
  shifts" is left for the scheduling-algorithm stage.
- "Ready to generate" on the Dashboard is a mock heuristic (availability
  complete + not yet published) — the real readiness rules belong to the
  scheduling service.
- Manager "override" and "add shift template" actions are visually present
  but intentionally inert (no modal/flow yet) — flagged in the UI copy
  where relevant ("Manage" on a shift cell shows a placeholder message).
