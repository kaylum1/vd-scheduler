/**
 * The ONE place the mock provider asks "what instant is it" for check-in and attendance
 * timestamps (so business logic never scatters `new Date()`). Production mock mode uses the
 * real clock; tests pin it with `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`,
 * the same pattern the rest of the mock tests already use for the operational date.
 */
export function mockNow(): Date {
  return new Date();
}
