#!/usr/bin/env node
/**
 * LOCAL DEVELOPMENT ONLY -- never run this against a deployed project.
 *
 * Creates three local Supabase Auth test identities (one manager, two
 * drivers) plus their matching resorts/drivers/app_users rows, so real
 * Stage 2B authentication can be exercised end to end against the local
 * Supabase stack (VITE_DATA_PROVIDER=supabase).
 *
 * Public signup is disabled (supabase/config.toml: [auth].enable_signup =
 * false) -- these accounts are created the same way a manager's future
 * provisioning workflow will: via the Admin API with the service-role key.
 * That key is used ONLY here, in this standalone Node script (auto-
 * discovered from `supabase status`, never hard-coded) -- it never runs in
 * the browser and is never bundled into the frontend. It is also the
 * fixed, publicly-documented Supabase CLI local-development credential,
 * not a secret; this script still refuses to run against any non-
 * localhost API URL as a safety check.
 *
 * The password below is a shared LOCAL-ONLY fixture, not a real secret --
 * it only ever unlocks a throwaway local Postgres/GoTrue container that
 * `supabase db reset` can wipe at any time. Never reuse it, and never put
 * a real password in a migration or committed source file.
 *
 * Usage:
 *   npx supabase start        (if not already running)
 *   npm run seed:local-users
 *
 * Idempotent -- safe to re-run; existing users/rows are left alone.
 */

import { execFileSync } from 'node:child_process';

const LOCAL_TEST_PASSWORD = 'vd-local-dev-2026';

const TEST_IDENTITIES = [
  { email: 'manager@vd-scheduler.local', role: 'manager', driver: null },
  {
    email: 'gianni@vd-scheduler.local',
    role: 'driver',
    driver: { fullName: 'Gianni', resortSlug: 'crans-montana', resortName: 'Crans-Montana' },
  },
  {
    email: 'alex@vd-scheduler.local',
    role: 'driver',
    driver: { fullName: 'Alex', resortSlug: 'zermatt', resortName: 'Zermatt' },
  },
];

// Driver-only fixture (no auth login) -- deliberately left off
// TEST_IDENTITIES so it isn't given an app_users row, giving the
// Configuration "Login linked" / "No login" badge a real "No login" case to
// show locally. Verbier itself is ensured below with no drivers at all, per
// the Stage 2D Checkpoint 1 local dev-data spec.
const DRIVER_ONLY_FIXTURES = [{ fullName: 'Tomas', resortSlug: 'zermatt', resortName: 'Zermatt' }];
const EXTRA_RESORTS = [{ slug: 'verbier', name: 'Verbier' }];

// A couple of starter shift types per resort so Configuration's Shift Types
// tab isn't empty on a fresh local DB. Verbier is deliberately left with
// none, as a real empty-state case. Not exhaustive -- managers add more
// through the Configuration UI itself.
const SHIFT_TYPE_FIXTURES = [
  { resortSlug: 'crans-montana', key: 'lunch', name: 'Lunch', sortOrder: 1 },
  { resortSlug: 'crans-montana', key: 'dinner', name: 'Dinner', sortOrder: 2 },
  { resortSlug: 'zermatt', key: 'dinner', name: 'Dinner', sortOrder: 1 },
];

function getSupabaseStatus() {
  const raw = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

function makeAdminClient(apiUrl, serviceRoleKey) {
  return async function adminFetch(path, options = {}) {
    const res = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status}: ${body}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

async function main() {
  const status = getSupabaseStatus();
  const apiUrl = status.API_URL;
  const serviceRoleKey = status.SERVICE_ROLE_KEY;

  const host = new URL(apiUrl).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`Refusing to run against a non-local Supabase URL: ${apiUrl}`);
  }

  const adminFetch = makeAdminClient(apiUrl, serviceRoleKey);

  // 1. Ensure resorts exist (idempotent, keyed by slug).
  const resortIdBySlug = new Map();
  for (const identity of TEST_IDENTITIES) {
    if (!identity.driver) continue;
    const { resortSlug, resortName } = identity.driver;
    if (resortIdBySlug.has(resortSlug)) continue;

    const existing = await adminFetch(`/rest/v1/resorts?slug=eq.${resortSlug}&select=id`);
    let resortId = existing[0]?.id;
    if (!resortId) {
      const created = await adminFetch('/rest/v1/resorts', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ slug: resortSlug, name: resortName }),
      });
      resortId = created[0].id;
      console.log(`Created resort ${resortName} (${resortId})`);
    }
    resortIdBySlug.set(resortSlug, resortId);
  }

  // 1b. Ensure the remaining resorts exist even with no driver/login tied
  // to them (Verbier: possibly no drivers, per the Stage 2D dev-data spec).
  for (const { slug, name } of EXTRA_RESORTS) {
    if (resortIdBySlug.has(slug)) continue;
    const existing = await adminFetch(`/rest/v1/resorts?slug=eq.${slug}&select=id`);
    let resortId = existing[0]?.id;
    if (!resortId) {
      const created = await adminFetch('/rest/v1/resorts', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ slug, name }),
      });
      resortId = created[0].id;
      console.log(`Created resort ${name} (${resortId})`);
    }
    resortIdBySlug.set(slug, resortId);
  }

  // 2. Ensure each auth user + driver + app_users link exists.
  const { users: existingAuthUsers } = await adminFetch('/auth/v1/admin/users?per_page=200');

  for (const identity of TEST_IDENTITIES) {
    let authUser = existingAuthUsers.find((u) => u.email === identity.email);

    if (!authUser) {
      authUser = await adminFetch('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email: identity.email, password: LOCAL_TEST_PASSWORD, email_confirm: true }),
      });
      console.log(`Created auth user ${identity.email} (${authUser.id})`);
    } else {
      console.log(`Auth user ${identity.email} already exists (${authUser.id})`);
    }

    let driverId = null;
    if (identity.driver) {
      const resortId = resortIdBySlug.get(identity.driver.resortSlug);
      const existingDrivers = await adminFetch(
        `/rest/v1/drivers?resort_id=eq.${resortId}&full_name=eq.${encodeURIComponent(identity.driver.fullName)}&select=id`
      );
      if (existingDrivers[0]) {
        driverId = existingDrivers[0].id;
      } else {
        const created = await adminFetch('/rest/v1/drivers', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ resort_id: resortId, full_name: identity.driver.fullName }),
        });
        driverId = created[0].id;
        console.log(`Created driver ${identity.driver.fullName} (${driverId})`);
      }
    }

    const existingAppUser = await adminFetch(`/rest/v1/app_users?id=eq.${authUser.id}&select=id`);
    if (!existingAppUser[0]) {
      await adminFetch('/rest/v1/app_users', {
        method: 'POST',
        body: JSON.stringify({ id: authUser.id, role: identity.role, driver_id: driverId }),
      });
      console.log(`Linked app_users row for ${identity.email} (role=${identity.role})`);
    } else {
      console.log(`app_users row for ${identity.email} already exists`);
    }
  }

  // 3. Ensure driver-only fixtures exist (no auth user, no app_users row --
  // deliberately: this is what gives the "No login" badge a real case).
  for (const fixture of DRIVER_ONLY_FIXTURES) {
    const resortId = resortIdBySlug.get(fixture.resortSlug);
    const existingDrivers = await adminFetch(
      `/rest/v1/drivers?resort_id=eq.${resortId}&full_name=eq.${encodeURIComponent(fixture.fullName)}&select=id`
    );
    if (existingDrivers[0]) {
      console.log(`Driver-only fixture ${fixture.fullName} already exists (${existingDrivers[0].id})`);
    } else {
      const created = await adminFetch('/rest/v1/drivers', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ resort_id: resortId, full_name: fixture.fullName }),
      });
      console.log(`Created driver-only fixture ${fixture.fullName} (${created[0].id}, no login)`);
    }
  }

  // 4. Ensure starter shift types exist (idempotent, keyed by resort+key).
  for (const fixture of SHIFT_TYPE_FIXTURES) {
    const resortId = resortIdBySlug.get(fixture.resortSlug);
    const existing = await adminFetch(`/rest/v1/shift_types?resort_id=eq.${resortId}&key=eq.${fixture.key}&select=id`);
    if (existing[0]) {
      console.log(`Shift type ${fixture.name} (${fixture.resortSlug}) already exists (${existing[0].id})`);
    } else {
      const created = await adminFetch('/rest/v1/shift_types', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ resort_id: resortId, key: fixture.key, name: fixture.name, sort_order: fixture.sortOrder }),
      });
      console.log(`Created shift type ${fixture.name} (${fixture.resortSlug}, ${created[0].id})`);
    }
  }

  console.log(`\nLocal test identities ready. Password for all: ${LOCAL_TEST_PASSWORD}`);
  for (const identity of TEST_IDENTITIES) {
    console.log(`  ${identity.role.padEnd(7)} ${identity.email}`);
  }
  console.log(`\nDriver-only fixtures (no login):`);
  for (const fixture of DRIVER_ONLY_FIXTURES) {
    console.log(`  ${fixture.fullName} (${fixture.resortName})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
