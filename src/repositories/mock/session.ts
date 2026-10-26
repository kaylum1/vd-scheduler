/**
 * Mock-only stand-in for the authenticated session, for the one driver action that takes NO
 * driver id in its contract (checkInToShift: the real database derives the driver from the
 * session). `null` = not an active driver (a manager, signed out, anon) and is denied.
 *
 * Nothing in the app sets this yet: the Driver Check-in UI (AT-C1) must call
 * `setMockActingDriver(...)` from the mock identity bridge when the mock driver switches.
 * Tests set it directly; `resetMockFixturesForTesting` clears it.
 */
let actingDriverId: string | null = null;

export function getMockActingDriverId(): string | null {
  return actingDriverId;
}

export function setMockActingDriver(driverId: string | null): void {
  actingDriverId = driverId;
}
