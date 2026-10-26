import { describe, expect, it } from 'vitest';
import { mockCheckInWindow, zonedWallTimeToInstant } from './checkInWindow';

const win = (date: string, start: string, end: string, tz = 'Europe/Zurich') => {
  const w = mockCheckInWindow({ date, startTime: start, endTime: end }, tz);
  return { opens: w.opensAt.toISOString(), closes: w.closesAt.toISOString() };
};

// These expected instants are the ones the DATABASE produces (supabase/tests/89_driver_check_in.sql), so the mock cannot drift from it.
describe('mockCheckInWindow mirrors _check_in_window', () => {
  it('Zurich summer (CEST, UTC+2): 18:00-21:00 opens 15:30Z, closes 19:00Z', () => {
    expect(win('2027-06-14', '18:00', '21:00')).toEqual({ opens: '2027-06-14T15:30:00.000Z', closes: '2027-06-14T19:00:00.000Z' });
  });

  it('Zurich winter (CET, UTC+1): opens 16:30Z, closes 20:00Z', () => {
    expect(win('2027-01-11', '18:00', '21:00')).toEqual({ opens: '2027-01-11T16:30:00.000Z', closes: '2027-01-11T20:00:00.000Z' });
  });

  it('the SPRING-FORWARD day (2027-03-28) is CEST, the day before is still CET', () => {
    expect(win('2027-03-28', '18:00', '21:00')).toEqual({ opens: '2027-03-28T15:30:00.000Z', closes: '2027-03-28T19:00:00.000Z' });
    expect(win('2027-03-27', '18:00', '21:00')).toEqual({ opens: '2027-03-27T16:30:00.000Z', closes: '2027-03-27T20:00:00.000Z' });
  });

  it('the FALL-BACK day (2027-10-31) is CET, the day before is still CEST', () => {
    expect(win('2027-10-31', '18:00', '21:00')).toEqual({ opens: '2027-10-31T16:30:00.000Z', closes: '2027-10-31T20:00:00.000Z' });
    expect(win('2027-10-30', '18:00', '21:00')).toEqual({ opens: '2027-10-30T15:30:00.000Z', closes: '2027-10-30T19:00:00.000Z' });
  });

  it('follows the RESORT timezone, not Zurich: Asia/Tokyo (UTC+9) opens 08:30Z, closes 12:00Z', () => {
    expect(win('2027-06-14', '18:00', '21:00', 'Asia/Tokyo')).toEqual({ opens: '2027-06-14T08:30:00.000Z', closes: '2027-06-14T12:00:00.000Z' });
  });

  it('opens exactly 30 minutes before the start, including across midnight (a 00:10 start opens the previous evening)', () => {
    expect(win('2027-06-14', '00:10', '02:00')).toEqual({ opens: '2027-06-13T21:40:00.000Z', closes: '2027-06-14T00:00:00.000Z' });
  });

  it('accepts HH:MM:SS wall-clock strings as the database returns them', () => {
    expect(win('2027-06-14', '18:00:00', '21:00:00')).toEqual({ opens: '2027-06-14T15:30:00.000Z', closes: '2027-06-14T19:00:00.000Z' });
  });

  it('zonedWallTimeToInstant is the plain inverse of the zone offset', () => {
    expect(zonedWallTimeToInstant('2030-01-07', '18:00', 'Europe/Zurich').toISOString()).toBe('2030-01-07T17:00:00.000Z');
    expect(zonedWallTimeToInstant('2030-07-07', '18:00', 'Europe/Zurich').toISOString()).toBe('2030-07-07T16:00:00.000Z');
  });
});
