import { describe, expect, it } from 'vitest';
import { formatOperationalClock } from '../../lib/operationalTime';
import { DriverCheckInError } from '../../repositories/errors';
import {
  CHECK_IN_CLOSED_TEXT,
  describeCheckInError,
  describeCheckInOpens,
  describeCheckedIn,
  getDriverCheckInState,
  nextCheckInBoundary,
  OPENS_LATER_HORIZON_MS,
  type CheckInWindowFields,
} from './driverCheckInUi';
import source from './driverCheckInUi.ts?raw';

const OPENS = '2030-01-07T16:30:00.000Z';
const CLOSES = '2030-01-07T20:30:00.000Z';
const shift = (over: Partial<CheckInWindowFields> = {}): CheckInWindowFields => ({ checkedInAt: null, checkInOpensAt: OPENS, checkInClosesAt: CLOSES, ...over });
const at = (iso: string) => new Date(iso);
const ms = (iso: string, delta: number) => new Date(Date.parse(iso) + delta);

describe('getDriverCheckInState', () => {
  it('before the window opens (within a day) -> opens_later with the server instant', () => {
    expect(getDriverCheckInState(shift(), ms(OPENS, -60_000))).toEqual({ kind: 'opens_later', opensAt: OPENS });
  });
  it('the window is INCLUSIVE at the opening instant: 1ms before is not open, exactly at opens is open', () => {
    expect(getDriverCheckInState(shift(), ms(OPENS, -1)).kind).toBe('opens_later');
    expect(getDriverCheckInState(shift(), at(OPENS)).kind).toBe('open');
  });
  it('the window is INCLUSIVE at the closing instant: exactly at closes is open, 1ms after is closed', () => {
    expect(getDriverCheckInState(shift(), at(CLOSES)).kind).toBe('open');
    expect(getDriverCheckInState(shift(), ms(CLOSES, 1)).kind).toBe('closed');
  });
  it('inside the window -> open', () => {
    expect(getDriverCheckInState(shift(), ms(OPENS, 3_600_000))).toEqual({ kind: 'open' });
  });
  it('a check-in always wins -- before, inside or after the window, and over every server hint', () => {
    const done = shift({ checkedInAt: '2030-01-07T17:00:00.000Z' });
    for (const now of [ms(OPENS, -9e7), at(OPENS), ms(CLOSES, 9e7)]) {
      for (const hint of [null, 'closed', 'too_early', 'unavailable'] as const) {
        expect(getDriverCheckInState(done, now, hint)).toEqual({ kind: 'checked_in', checkedInAt: '2030-01-07T17:00:00.000Z' });
      }
    }
  });
  it('a window further than 24h away shows nothing; exactly at the horizon shows opens_later', () => {
    expect(getDriverCheckInState(shift(), ms(OPENS, -OPENS_LATER_HORIZON_MS - 1)).kind).toBe('not_applicable');
    expect(getDriverCheckInState(shift(), ms(OPENS, -OPENS_LATER_HORIZON_MS)).kind).toBe('opens_later');
  });
  it('a server "closed" rejection shows closed even if the device clock thinks it is open', () => {
    expect(getDriverCheckInState(shift(), ms(OPENS, 1000), 'closed')).toEqual({ kind: 'closed' });
  });
  it('a server "too early" rejection shows opens_later even if the device clock thinks it is open', () => {
    expect(getDriverCheckInState(shift(), ms(OPENS, 1000), 'too_early')).toEqual({ kind: 'opens_later', opensAt: OPENS });
  });
  it('an "unavailable" rejection (cancelled / unpublished / attendance recorded) removes the control', () => {
    expect(getDriverCheckInState(shift(), ms(OPENS, 1000), 'unavailable')).toEqual({ kind: 'not_applicable' });
  });
  it('unusable window instants never produce a button', () => {
    expect(getDriverCheckInState(shift({ checkInOpensAt: 'nope' }), at(OPENS)).kind).toBe('not_applicable');
    expect(getDriverCheckInState(shift({ checkInClosesAt: '' }), at(OPENS)).kind).toBe('not_applicable');
  });
  it('does no window arithmetic of its own: no 30-minute offset, no timezone, no shift times', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b30\s*\*\s*60|\b1800000\b|Europe\/Zurich|timeZone|startTime|endTime/);
  });
});

describe('copy and formatting', () => {
  it('shows the server instants as 24h operational-time clock text, not device time', () => {
    // 2030-01-07 is winter (UTC+1) -- 16:30Z is 17:30 in Zurich; a summer instant is UTC+2.
    expect(describeCheckInOpens(OPENS)).toBe('Check-in opens at 17:30');
    expect(describeCheckedIn('2030-01-07T17:05:00.000Z')).toBe('Checked in at 18:05');
    expect(formatOperationalClock('2030-07-07T16:30:00.000Z')).toBe('18:30');
    expect(formatOperationalClock('2030-01-07T23:59:00.000Z')).toBe('00:59');
  });
  it('closed copy', () => expect(CHECK_IN_CLOSED_TEXT).toBe('Check-in window closed'));
});

describe('nextCheckInBoundary', () => {
  it('returns the earliest future opening, or just after the earliest future close', () => {
    const now = ms(OPENS, -1000);
    expect(nextCheckInBoundary([shift()], now)).toBe(Date.parse(OPENS));
    expect(nextCheckInBoundary([shift()], at(OPENS))).toBe(Date.parse(CLOSES) + 1);
  });
  it('ignores checked-in shifts, past windows, invalid instants, and an empty list', () => {
    expect(nextCheckInBoundary([shift({ checkedInAt: OPENS })], ms(OPENS, -1000))).toBeNull();
    expect(nextCheckInBoundary([shift()], ms(CLOSES, 5000))).toBeNull();
    expect(nextCheckInBoundary([shift({ checkInOpensAt: 'x', checkInClosesAt: 'y' })], at(OPENS))).toBeNull();
    expect(nextCheckInBoundary([], at(OPENS))).toBeNull();
  });
});

describe('describeCheckInError', () => {
  const err = (kind: ConstructorParameters<typeof DriverCheckInError>[0]) => new DriverCheckInError(kind, { operation: 'rota.checkInToShift' });
  it('uses the repository userMessage and never DB detail', () => {
    const d = describeCheckInError(err('check_in_closed'));
    expect(d.message).toBe('The check-in window for this shift has closed.');
    expect(JSON.stringify(d)).not.toMatch(/55006|check_in_closed|P0002/);
  });
  it('maps server rejections to a refetch and a display hint', () => {
    expect(describeCheckInError(err('check_in_closed'))).toMatchObject({ shouldRefresh: true, hint: 'closed' });
    expect(describeCheckInError(err('check_in_too_early'))).toMatchObject({ shouldRefresh: true, hint: 'too_early' });
    for (const kind of ['assignment_not_found', 'week_not_published', 'shift_cancelled', 'attendance_already_recorded'] as const) {
      expect(describeCheckInError(err(kind))).toMatchObject({ shouldRefresh: true, hint: 'unavailable' });
    }
  });
  it('a transient/unknown failure keeps the button and does not refetch', () => {
    expect(describeCheckInError(err('unknown'))).toMatchObject({ shouldRefresh: false, hint: null, message: 'Couldn’t check in. Please try again.' });
    expect(describeCheckInError(new Error('boom: PGRST301'))).toEqual({ message: 'Couldn’t check in. Please try again.', shouldRefresh: false, hint: null });
  });
  it('attendance wording never leaks to the driver', () => {
    expect(describeCheckInError(err('attendance_already_recorded')).message).not.toMatch(/attendance|absent|late|worked/i);
  });
});
