# Local authentication setup (Stage 2B)

VD Scheduler is a private staff application. There is no public sign-up —
`supabase/config.toml` disables it at the GoTrue level
(`[auth].enable_signup = false`), so accounts must be provisioned directly
against the local Supabase instance. This is exactly how a manager's future
account-provisioning workflow will work too (a privileged server-side
operation using the Admin API), just done manually for now. Confirmed with
a local smoke test: `POST /auth/v1/signup` returns `signup_disabled` while
`POST /auth/v1/token?grant_type=password` (normal sign-in) still works for
an already-provisioned account.

Note: `[auth.email].enable_signup` must stay `true` — on this Supabase CLI
version that flag is actually the email *provider* switch (setting it
`false` also disables password sign-in, not just sign-up). The real
"no self-signup" enforcement is the top-level `[auth].enable_signup =
false` alone, which blocks the `/signup` endpoint independently.

## 1. Start local Supabase

```bash
npx supabase start
```

## 2. Create the local test identities

```bash
npm run seed:local-users
```

This runs [`scripts/seed-local-test-users.mjs`](../scripts/seed-local-test-users.mjs),
which:

- refuses to run against anything other than a `localhost`/`127.0.0.1` API URL
- creates two resorts (Crans-Montana, Zermatt) and two drivers (Gianni,
  Alex) if they don't already exist
- creates three Supabase Auth users via the Admin API (using the
  service-role key, auto-discovered from `npx supabase status` — never
  hard-coded, never shipped to the browser) and links each to an
  `app_users` row
- is idempotent — safe to re-run any time, including after `supabase db
  reset` (which wipes the database but not the Auth users, so re-running
  the seed script re-links fresh `app_users`/`drivers` rows to the
  existing auth identities)

Resulting accounts (password is the same for all three — a shared
**local-only** fixture, not a real secret, since it only unlocks a
throwaway local container):

| Role    | Email                          | Password             | Linked to                |
| ------- | ------------------------------ | --------------------- | ------------------------- |
| manager | `manager@vd-scheduler.local`   | `vd-local-dev-2026`   | —                          |
| driver  | `gianni@vd-scheduler.local`    | `vd-local-dev-2026`   | Gianni · Crans-Montana     |
| driver  | `alex@vd-scheduler.local`      | `vd-local-dev-2026`   | Alex · Zermatt             |

Never reuse this password anywhere real, and never put a real password in
a migration or any other committed file — migrations run in contexts that
could reach a real environment; this script does not.

## 3. Point the frontend at Supabase mode

In `.env.local` (git-ignored):

```
VITE_DATA_PROVIDER=supabase
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_KEY from `npx supabase status`>
```

`VITE_DATA_PROVIDER=mock` (the default) skips all of this — no login is
required, and the existing Stage 1.1 Manager/Driver switch keeps working
exactly as before.

## 4. Password reset (local)

`site_url`/`additional_redirect_urls` in `supabase/config.toml` are set to
the Vite dev server (`http://localhost:5173`, `http://127.0.0.1:5173`), so
a real "forgot password" round trip works locally: request a reset from
the Login page, then open the email in Mailpit at
`http://127.0.0.1:54324` and follow the link.
