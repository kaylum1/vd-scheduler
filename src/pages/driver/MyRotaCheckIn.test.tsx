// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../App';
import { resetRepositoriesForTesting } from '../../repositories';
import { MockRotaRepository } from '../../repositories/mock/rota';
import { mockCheckInWindow } from '../../repositories/mock/checkInWindow';
import { setMockActingDriver } from '../../repositories/mock/session';
import { DriverCheckInError } from '../../repositories/errors';
import {
  mockAttendance,
  mockDriverCheckIns,
  mockDrivers,
  mockRotaAssignments,
  mockRotaPublications,
  mockShiftTemplates,
  mockShiftTypes,
  resetMockFixturesForTesting,
} from '../../repositories/mock/fixtures';
import { addWeeks, parseISODate, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { formatOperationalClock, getOperationalToday } from '../../lib/operationalTime';
import pageSource from './MyRota.tsx?raw';
import controllerSource from '../../components/driver-rota/useDriverCheckIn.ts?raw';
import componentSource from '../../components/driver-rota/DriverShiftCheckIn.tsx?raw';

const CRANS = 'mock-crans';
const thisMonday = toISODate(startOfWeek(getOperationalToday()));
const nextMonday = toISODate(addWeeks(parseISODate(thisMonday), 1));
const dinnerOn = (monday: string) => `mock-crans-dinner-tpl-${monday}`;
const lunchOn = (monday: string) => `mock-crans-lunch-tpl-${monday}`;
const DINNER = mockCheckInWindow({ date: thisMonday, startTime: '18:00', endTime: '21:30' }, 'Europe/Zurich');
const LUNCH = mockCheckInWindow({ date: thisMonday, startTime: '12:00', endTime: '14:00' }, 'Europe/Zurich');
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

function publish(weekStart: string) {
  mockRotaPublications.push({ resortId: CRANS, weekStart, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
}
function assign(shiftInstanceId: string, driverId = 'mock-gianni') {
  mockRotaAssignments.push({ id: `a-${shiftInstanceId}-${driverId}`, shiftInstanceId, driverId, resortId: CRANS, source: 'manual', assignedAt: '2030-01-01T00:00:00Z' });
}
function addLunch() {
  mockShiftTypes.push({ id: 'mock-crans-lunch', resortId: CRANS, key: 'lunch', name: 'Lunch', sortOrder: 0, isActive: true });
  mockShiftTemplates.push({
    id: 'mock-crans-lunch-tpl', resortId: CRANS, shiftTypeId: 'mock-crans-lunch', weekday: 0,
    startTime: '12:00', endTime: '14:00', requiredDrivers: 1, basePayChf: null, deliveryRateChf: null, isPremium: null,
    effectiveFrom: '2024-01-01', effectiveTo: null, isActive: true, updatedAt: '2024-01-01T00:00:00.000Z',
  });
}
const setNow = (d: Date) => vi.setSystemTime(d);

let queryClient: QueryClient;
async function renderMyRota() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Driver' }));
  window.location.hash = '/driver/my-rota';
  await screen.findByRole('heading', { name: 'My Rota' });
}
const shiftItem = async (name: string) => {
  const day = await screen.findByRole('region', { name: /Monday/i });
  return within(day).getByText(name).closest('li') as HTMLElement;
};
const checkInButton = (li: HTMLElement) => within(li).getByRole('button', { name: /check in/i });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(ms(DINNER.opensAt, -3_600_000));
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.location.hash = '';
});

describe('Driver My Rota -- Check in', () => {
  beforeEach(() => {
    publish(thisMonday);
    assign(dinnerOn(thisMonday));
  });

  it('A. before the window: informational text with the server instant, no button', async () => {
    await renderMyRota();
    const li = await shiftItem('Dinner');
    expect(within(li).getByText(`Check-in opens at ${formatOperationalClock(DINNER.opensAt)}`)).toBeInTheDocument();
    expect(within(li).queryByRole('button')).toBeNull();
  });

  it('B. inside the window: a primary Check in button; one tap checks in with the SERVER time, no confirmation', async () => {
    setNow(ms(DINNER.opensAt, 60_000));
    const spy = vi.spyOn(MockRotaRepository.prototype, 'checkInToShift');
    await renderMyRota();
    const li = await shiftItem('Dinner');
    expect(checkInButton(li)).toHaveClass('btn--primary');

    fireEvent.click(checkInButton(li));
    await waitFor(() => expect(within(li).getByText(/^Checked in at \d\d:\d\d$/)).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ assignmentId: `a-${dinnerOn(thisMonday)}-mock-gianni` });
    expect(Object.keys(spy.mock.calls[0][0])).toEqual(['assignmentId']);
    expect(within(li).getByText(`Checked in at ${formatOperationalClock(ms(DINNER.opensAt, 60_000))}`)).toBeInTheDocument();
    expect(within(li).queryByRole('button')).toBeNull();
    expect(mockDriverCheckIns).toHaveLength(1);
    expect(within(li).getByRole('status')).toHaveTextContent('Checked in successfully.');
  });

  it('C. the exact opening and closing instants are both open; one millisecond after closing is closed (no button)', async () => {
    setNow(DINNER.opensAt);
    await renderMyRota();
    let li = await shiftItem('Dinner');
    expect(checkInButton(li)).toBeInTheDocument();
    act(() => setNow(DINNER.closesAt));
    fireEvent.focus(window);
    await waitFor(() => expect(checkInButton(li)).toBeInTheDocument());
    act(() => setNow(ms(DINNER.closesAt, 1)));
    fireEvent.focus(window);
    li = await shiftItem('Dinner');
    await waitFor(() => expect(within(li).getByText('Check-in window closed')).toBeInTheDocument());
    expect(within(li).queryByRole('button')).toBeNull();
  });

  it('D. pending: disabled "Checking in…" with aria-busy, and a second tap makes no second call', async () => {
    setNow(ms(DINNER.opensAt, 60_000));
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    const real = MockRotaRepository.prototype.checkInToShift;
    const spy = vi.spyOn(MockRotaRepository.prototype, 'checkInToShift').mockImplementation(async function (this: MockRotaRepository, p) {
      await gate;
      return real.call(this, p);
    });
    setMockActingDriver('mock-gianni');
    await renderMyRota();
    const li = await shiftItem('Dinner');
    const button = checkInButton(li);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent('Checking in…');
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => release(undefined));
    await waitFor(() => expect(within(li).getByText(/^Checked in at/)).toBeInTheDocument());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('E. an already-existing check-in (created=false) is a normal success with the ORIGINAL time', async () => {
    setNow(ms(DINNER.opensAt, 60_000));
    const original = ms(DINNER.opensAt, 5_000).toISOString();
    vi.spyOn(MockRotaRepository.prototype, 'checkInToShift').mockResolvedValue({
      checkIn: { checkInId: 'c1', assignmentId: `a-${dinnerOn(thisMonday)}-mock-gianni`, shiftInstanceId: dinnerOn(thisMonday), checkedInAt: original },
      created: false,
    });
    await renderMyRota();
    const li = await shiftItem('Dinner');
    fireEvent.click(checkInButton(li));
    await waitFor(() => expect(within(li).getByText(`Checked in at ${formatOperationalClock(original)}`)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(li).getByRole('status')).toHaveTextContent('');
  });

  it('F. a shift already checked in on load shows "Checked in at" and never offers the button again', async () => {
    setNow(ms(DINNER.opensAt, 3_600_000));
    mockDriverCheckIns.push({ id: 'c0', assignmentId: `a-${dinnerOn(thisMonday)}-mock-gianni`, checkedInAt: ms(DINNER.opensAt, 120_000).toISOString() } as never);
    await renderMyRota();
    const li = await shiftItem('Dinner');
    expect(within(li).getByText(`Checked in at ${formatOperationalClock(ms(DINNER.opensAt, 120_000))}`)).toBeInTheDocument();
    expect(within(li).queryByRole('button')).toBeNull();
  });

  it('G. a server "window closed" rejection: per-shift alert with the repository message, a refetch, and the display follows the server', async () => {
    setNow(ms(DINNER.opensAt, 60_000));
    vi.spyOn(MockRotaRepository.prototype, 'checkInToShift').mockRejectedValue(new DriverCheckInError('check_in_closed', { operation: 'rota.checkInToShift', code: '55006' }));
    const read = vi.spyOn(MockRotaRepository.prototype, 'getDriverWeekRota');
    await renderMyRota();
    const li = await shiftItem('Dinner');
    const before = read.mock.calls.length;
    fireEvent.click(checkInButton(li));
    expect(await within(li).findByRole('alert')).toHaveTextContent('The check-in window for this shift has closed.');
    expect(within(li).getByText('Check-in window closed')).toBeInTheDocument();
    expect(within(li).queryByRole('button')).toBeNull();
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
    expect(document.body.textContent).not.toMatch(/55006|check_in_closed|P0002/);
  });

  it('H. a "too early" rejection (device clock ahead) shows the opening time, not a stuck button; a transient failure keeps the button and retries', async () => {
    setNow(ms(DINNER.opensAt, 60_000));
    const spy = vi
      .spyOn(MockRotaRepository.prototype, 'checkInToShift')
      .mockRejectedValueOnce(new DriverCheckInError('unknown', { operation: 'rota.checkInToShift' }))
      .mockRejectedValueOnce(new DriverCheckInError('check_in_too_early', { operation: 'rota.checkInToShift', code: '55006' }));
    await renderMyRota();
    const li = await shiftItem('Dinner');
    fireEvent.click(checkInButton(li));
    expect(await within(li).findByRole('alert')).toHaveTextContent('Couldn’t check in. Please try again.');
    expect(checkInButton(li)).toBeEnabled();
    fireEvent.click(checkInButton(li));
    await waitFor(() => expect(within(li).getByText(/^Check-in opens at/)).toBeInTheDocument());
    expect(within(li).getByRole('alert')).toHaveTextContent('Check-in isn’t open for this shift yet.');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('I. Lunch and Dinner are independent: checking in to one, or failing one, does not touch the other', async () => {
    addLunch();
    assign(lunchOn(thisMonday));
    setNow(ms(LUNCH.opensAt, 60_000));
    await renderMyRota();
    const lunch = await shiftItem('Lunch');
    const dinner = await shiftItem('Dinner');
    expect(checkInButton(lunch)).toBeInTheDocument();
    expect(within(dinner).getByText(/^Check-in opens at/)).toBeInTheDocument();
    fireEvent.click(checkInButton(lunch));
    await waitFor(() => expect(within(lunch).getByText(/^Checked in at/)).toBeInTheDocument());
    expect(within(dinner).getByText(/^Check-in opens at/)).toBeInTheDocument();
    expect(within(dinner).queryByText(/^Checked in at/)).toBeNull();
    expect(mockDriverCheckIns).toHaveLength(1);
  });

  it('J. a late result for a previous week never leaks into the week now on screen; only that week\'s query is refreshed', async () => {
    setNow(ms(DINNER.opensAt, 60_000));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = MockRotaRepository.prototype.checkInToShift;
    vi.spyOn(MockRotaRepository.prototype, 'checkInToShift').mockImplementation(async function (this: MockRotaRepository, p) {
      await gate;
      return real.call(this, p);
    });
    await renderMyRota();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.click(checkInButton(await shiftItem('Dinner')));
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await screen.findByText('Your rota for this week hasn’t been published yet.');
    await act(async () => release());
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['driver-rota', 'mock-gianni', thisMonday] });
    for (const call of invalidate.mock.calls) expect(call[0]).toEqual({ queryKey: ['driver-rota', 'mock-gianni', thisMonday] });
    expect(screen.queryByText(/Checked in/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('K. without an acting driver the real mock denies the tap and the UI shows the repository message', async () => {
    setNow(ms(DINNER.opensAt, 60_000));
    await renderMyRota();
    const li = await shiftItem('Dinner');
    setMockActingDriver(null);
    fireEvent.click(checkInButton(li));
    expect(await within(li).findByRole('alert')).toHaveTextContent('You can’t check in to this shift.');
    expect(mockDriverCheckIns).toHaveLength(0);
  });

  it('L. the driver never sees attendance, other drivers, location claims, lateness or pay -- and check-in creates no attendance', async () => {
    mockDrivers.push({ id: 'mock-maria', resortId: CRANS, fullName: 'Maria', isActive: true, preferredLanguage: 'en' });
    assign(dinnerOn(thisMonday), 'mock-maria');
    setNow(ms(DINNER.opensAt, 60_000));
    await renderMyRota();
    const li = await shiftItem('Dinner');
    fireEvent.click(checkInButton(li));
    await waitFor(() => expect(within(li).getByText(/^Checked in at/)).toBeInTheDocument());
    const text = (document.querySelector('.page') as HTMLElement).textContent ?? '';
    expect(text).not.toMatch(/attendance|present|absent|late|on time|arrived|location|GPS|Maria|CHF|pay|worked/i);
    expect(mockAttendance).toHaveLength(0);
    // Maria (another driver) has no check-in as a result.
    expect(mockDriverCheckIns.every((c) => c.assignmentId.endsWith('mock-gianni'))).toBe(true);
  });

  it('M. a week more than a day away shows no check-in area at all', async () => {
    publish(nextMonday);
    assign(dinnerOn(nextMonday));
    await renderMyRota();
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    const li = await shiftItem('Dinner');
    expect(within(li).queryByText(/check/i)).toBeNull();
    expect(within(li).queryByRole('button')).toBeNull();
  });

  it('N. architecture: one repository call with only the assignment id; no window arithmetic, polling or per-shift timers in React', () => {
    expect(controllerSource).toMatch(/checkInToShift\(\{ assignmentId \}\)/);
    expect(controllerSource).toMatch(/invalidateQueries\(\{ queryKey: weekKey \}\)/);
    expect(controllerSource.match(/invalidateQueries/g)).toHaveLength(2);
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const src of [pageSource, controllerSource, componentSource].map(code)) {
      expect(src).not.toMatch(/setInterval|refetchInterval|Intl\.|Europe\/Zurich|getTimezoneOffset|toLocale/);
      expect(src).not.toMatch(/p_driver_id|driverId:\s*driverId[^}]*checkIn/);
    }
    expect(code(componentSource)).not.toMatch(/useEffect|setTimeout/);
    expect(pageSource.match(/useCheckInClock\(/g)).toHaveLength(1);
  });
});
