// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ManualRotaPanel } from './ManualRotaPanel';
import { resetRepositoriesForTesting } from '../../repositories';
import { MockRotaRepository } from '../../repositories/mock/rota';
import {
  mockAvailability,
  mockDrivers,
  mockRotaAssignments,
  mockRotaPublications,
  mockShiftTemplates,
  mockShiftTypes,
  resetMockFixturesForTesting,
} from '../../repositories/mock/fixtures';
import { RotaAssignmentError } from '../../repositories/errors';
import { managerRotaKeys } from '../../repositories/queryKeys';
import { addDays, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import type { AvailabilityStatus } from '../../repositories/domain';

// Far-from-today Mondays, so nothing depends on when the suite runs.
const FUTURE_WEEK = '2030-01-07';
const PAST_WEEK = '2025-01-06';
const CRANS = 'mock-crans';
const dinnerId = (week: string) => `mock-crans-dinner-tpl-${week}`;

function renderRota(props: { resortId: string | null; weekStart: string } = { resortId: CRANS, weekStart: FUTURE_WEEK }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (p: typeof props) => (
    <QueryClientProvider client={client}>
      <ManualRotaPanel {...p} />
    </QueryClientProvider>
  );
  const utils = render(tree(props));
  return { client, ...utils, rerenderWith: (p: typeof props) => utils.rerender(tree(p)) };
}

function addDriver(id: string, fullName: string, isActive = true, resortId = CRANS) {
  mockDrivers.push({ id, resortId, fullName, isActive, preferredLanguage: 'en' });
}
function answer(shiftInstanceId: string, driverId: string, status: AvailabilityStatus) {
  mockAvailability.push({ id: `ans-${shiftInstanceId}-${driverId}`, driverId, resortId: CRANS, shiftInstanceId, status, answeredAt: '2030-01-01T00:00:00Z' });
}
function seedAssignment(shiftInstanceId: string, driverId: string, assignedAt = '2030-01-01T10:00:00.000Z') {
  mockRotaAssignments.push({ id: `seed-${shiftInstanceId}-${driverId}`, shiftInstanceId, driverId, resortId: CRANS, source: 'manual', assignedAt });
}
/** Adds an extra Crans shift on `weekday` (Mon=0..Sun=6). */
function addShift(opts: { key: string; name: string; weekday: number; start: string; end: string; required: number; sortOrder?: number }) {
  mockShiftTypes.push({ id: `mock-crans-${opts.key}`, resortId: CRANS, key: opts.key, name: opts.name, sortOrder: opts.sortOrder ?? 5, isActive: true });
  mockShiftTemplates.push({
    id: `mock-crans-${opts.key}-tpl`, resortId: CRANS, shiftTypeId: `mock-crans-${opts.key}`, weekday: opts.weekday,
    startTime: opts.start, endTime: opts.end, requiredDrivers: opts.required, basePayChf: null, deliveryRateChf: null, isPremium: null,
    effectiveFrom: '2024-01-01', effectiveTo: null, isActive: true, updatedAt: '2024-01-01T00:00:00.000Z',
  });
}

const card = (name: RegExp | string) => screen.getByRole('article', { name: typeof name === 'string' ? new RegExp(`^${name},`) : name });
async function findCard(name: RegExp | string) {
  return screen.findByRole('article', { name: typeof name === 'string' ? new RegExp(`^${name},`) : name });
}
const openPicker = (c: HTMLElement) => fireEvent.click(within(c).getByRole('button', { name: /Assign a driver|Hide drivers/ }));
const clickAssign = (c: HTMLElement, driver: string, shift = 'Dinner') => fireEvent.click(within(c).getByRole('button', { name: `Assign ${driver} to ${shift}` }));

let assignSpy: MockInstance<MockRotaRepository['assignDriver']>;
let unassignSpy: MockInstance<MockRotaRepository['unassignDriver']>;

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
  addDriver('mock-maria', 'Maria');
  assignSpy = vi.spyOn(MockRotaRepository.prototype, 'assignDriver');
  unassignSpy = vi.spyOn(MockRotaRepository.prototype, 'unassignDriver');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =======================================================================
// RENDERING
// =======================================================================
describe('ManualRotaPanel: live shifts', () => {
  it('1. renders the real repository shifts, grouped under their day', async () => {
    renderRota();
    const c = await findCard('Dinner');
    expect(within(c).getByText('18:00–21:30')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Monday/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /7 Jan/ })).toBeInTheDocument();
  });

  it('2. shows shifts dynamically -- a newly configured Shift appears under its own name, with nothing hard-coded', async () => {
    addShift({ key: 'brunch', name: 'Brunch (3P)', weekday: 4, start: '10:00', end: '14:00', required: 3 });
    renderRota();
    await findCard('Dinner');
    const brunch = await findCard('Brunch \\(3P\\)');
    expect(within(brunch).getByText('0 / 3 active assigned')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Friday/ })).toBeInTheDocument();
    expect(screen.queryByText(/Lunch/)).not.toBeInTheDocument();
  });

  it('3. several shifts on one day render together, ordered by time', async () => {
    addShift({ key: 'lunch', name: 'Lunch (1P)', weekday: 0, start: '12:00', end: '14:00', required: 1, sortOrder: 0 });
    renderRota();
    await findCard('Dinner');
    const day = screen.getByRole('heading', { name: /Monday/ }).closest('section') as HTMLElement;
    const names = within(day).getAllByRole('article').map((a) => a.getAttribute('aria-label'));
    expect(names).toEqual(['Lunch (1P), 12:00–14:00', 'Dinner, 18:00–21:30']);
    expect(screen.getAllByRole('heading', { name: /Monday/ })).toHaveLength(1);
  });

  it('shows only days that actually have a shift -- no fabricated empty days', async () => {
    renderRota();
    await findCard('Dinner');
    for (const day of ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      expect(screen.queryByRole('heading', { name: new RegExp(day) })).not.toBeInTheDocument();
    }
  });

  it('never parses (1P)/(2P) out of a name: the requirement comes from requiredDrivers', async () => {
    addShift({ key: 'odd', name: 'Odd (1P)', weekday: 1, start: '09:00', end: '10:00', required: 4 });
    renderRota();
    const c = await findCard('Odd \\(1P\\)');
    expect(within(c).getByText('0 / 4 active assigned')).toBeInTheDocument();
  });

  it('4/5. shows required staffing and the active assigned count', async () => {
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    renderRota();
    const c = await findCard('Dinner');
    expect(within(c).getByText('1 / 2 active assigned')).toBeInTheDocument();
  });
});

// =======================================================================
// COVERAGE
// =======================================================================
describe('ManualRotaPanel: coverage (derived, active assignees only)', () => {
  it('6. zero active assigned of 2 required -> Uncovered', async () => {
    renderRota();
    const c = await findCard('Dinner');
    expect(within(c).getByText('Uncovered')).toBeInTheDocument();
    expect(within(c).queryByText('Covered')).not.toBeInTheDocument();
  });

  it('7. equal to required -> Covered', async () => {
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-maria');
    renderRota();
    const c = await findCard('Dinner');
    expect(within(c).getByText('Covered')).toBeInTheDocument();
    expect(within(c).getByText('2 / 2 active assigned')).toBeInTheDocument();
  });

  it('8. above required stays Covered, and is shown plainly as 3 / 2 -- not an error, not a new state', async () => {
    addDriver('mock-pat', 'Pat');
    for (const id of ['mock-gianni', 'mock-maria', 'mock-pat']) seedAssignment(dinnerId(FUTURE_WEEK), id);
    renderRota();
    const c = await findCard('Dinner');
    expect(within(c).getByText('3 / 2 active assigned')).toBeInTheDocument();
    expect(within(c).getByText('Covered')).toBeInTheDocument();
    expect(within(c).queryByText(/over-?covered|over-?assigned|exceed/i)).not.toBeInTheDocument();
  });

  it('9. an inactive assignee is still displayed -- labelled Inactive, with a Remove action, not silently dropped', async () => {
    addDriver('mock-gone', 'Gone', false);
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gone');
    renderRota();
    const c = await findCard('Dinner');
    const row = within(c).getByText('Gone').closest('li') as HTMLElement;
    expect(within(row).getByText('Inactive')).toBeInTheDocument();
    expect(within(row).getByText('Assigned')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Remove Gone from Dinner' })).toBeInTheDocument();
  });

  it('10. an inactive assignee does NOT satisfy staffing: required 2, one active + one inactive -> 1 / 2, Uncovered', async () => {
    addDriver('mock-gone', 'Gone', false);
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gone');
    renderRota();
    const c = await findCard('Dinner');
    expect(within(c).getByText('1 / 2 active assigned')).toBeInTheDocument();
    expect(within(c).getByText('Uncovered')).toBeInTheDocument();
    expect(within(c).getByText(/not counted toward coverage/)).toBeInTheDocument();
  });

  it('coverage uses the shared helper -- one source of truth, no recount in the component', async () => {
    const { default: panelSource } = await import('./ManualRotaPanel.tsx?raw');
    const { default: cardSource } = await import('./ManualRotaShiftCard.tsx?raw');
    expect(panelSource + cardSource).toMatch(/getShiftCoverage/);
    expect(cardSource).not.toMatch(/\.length\s*>=\s*shift\.requiredDrivers/);
  });
});

// =======================================================================
// CANDIDATES + AVAILABILITY
// =======================================================================
describe('ManualRotaPanel: assignment candidates', () => {
  it('11. only ACTIVE drivers of this resort are offered -- no inactive drivers, no other resorts\' drivers', async () => {
    addDriver('mock-gone', 'Gone', false);
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    const picker = within(c).getByRole('list', { name: /who can be assigned/ });
    expect(within(picker).getByText('Gianni')).toBeInTheDocument();
    expect(within(picker).getByText('Maria')).toBeInTheDocument();
    expect(within(picker).queryByText('Gone')).not.toBeInTheDocument();
    expect(within(picker).queryByText('Alex')).not.toBeInTheDocument();
  });

  it('12. a driver already assigned to the shift is not offered again', async () => {
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    const picker = within(c).getByRole('list', { name: /who can be assigned/ });
    expect(within(picker).queryByText('Gianni')).not.toBeInTheDocument();
    expect(within(picker).getByText('Maria')).toBeInTheDocument();
  });

  it('shows all three availability states with TEXT (never colour alone), and offers Available drivers first', async () => {
    addDriver('mock-pat', 'Pat');
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    answer(dinnerId(FUTURE_WEEK), 'mock-pat', 'unavailable');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    const rows = within(within(c).getByRole('list', { name: /who can be assigned/ })).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.driver-row__name')?.textContent)).toEqual(['Maria', 'Gianni', 'Pat']);
    expect(within(rows[0]).getByText('Available')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Not Submitted')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Unavailable')).toBeInTheDocument();
    // Each state carries its own icon too.
    for (const row of rows) expect(row.querySelector('.availability-badge svg')).not.toBeNull();
  });

  it('the picker summarises how many drivers are available, before it is opened', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    renderRota();
    const c = await findCard('Dinner');
    expect(within(c).getByRole('button', { name: /Assign a driver/ })).toHaveTextContent('1 available');
    expect(within(c).getByRole('button', { name: /Assign a driver/ })).toHaveAttribute('aria-expanded', 'false');
    openPicker(c);
    expect(within(c).getByRole('button', { name: /Hide drivers/ })).toHaveAttribute('aria-expanded', 'true');
  });
});

// =======================================================================
// ASSIGN FLOWS
// =======================================================================
describe('ManualRotaPanel: assigning', () => {
  it('13. an Available driver is assigned immediately -- no dialog -- and coverage updates without a reload', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    renderRota();
    const c = await findCard('Dinner');
    expect(within(c).getByText('0 / 2 active assigned')).toBeInTheDocument();
    openPicker(c);
    clickAssign(c, 'Maria');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await within(c).findByRole('button', { name: 'Remove Maria from Dinner' })).toBeInTheDocument();
    expect(assignSpy).toHaveBeenCalledWith({ shiftInstanceId: dinnerId(FUTURE_WEEK), driverId: 'mock-maria', confirmAvailabilityOverride: false, reason: null });
    expect(within(c).getByText('1 / 2 active assigned')).toBeInTheDocument();
    // ...and she is no longer offered as a candidate.
    expect(within(within(c).getByRole('list', { name: /who can be assigned/ })).queryByText('Maria')).not.toBeInTheDocument();
  });

  it('coverage goes Uncovered -> Covered -> (still) Covered as drivers are added, each step immediate', async () => {
    addDriver('mock-pat', 'Pat');
    for (const id of ['mock-gianni', 'mock-maria', 'mock-pat']) answer(dinnerId(FUTURE_WEEK), id, 'available');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);

    clickAssign(c, 'Gianni');
    await within(c).findByText('1 / 2 active assigned');
    expect(within(c).getByText('Uncovered')).toBeInTheDocument();

    clickAssign(c, 'Maria');
    await within(c).findByText('2 / 2 active assigned');
    expect(within(c).getByText('Covered')).toBeInTheDocument();

    // Already covered: a lightweight confirmation first.
    clickAssign(c, 'Pat');
    fireEvent.click(await screen.findByRole('button', { name: 'Assign anyway' }));
    await within(c).findByText('3 / 2 active assigned');
    expect(within(c).getByText('Covered')).toBeInTheDocument();
  });

  it('14. a Not Submitted driver opens the amber warning first -- nothing is assigned until confirmed', async () => {
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Gianni');

    const dialog = await screen.findByRole('dialog', { name: 'Assign Gianni?' });
    expect(within(dialog).getByText(/has not submitted availability for this shift/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/marked themselves unavailable/)).not.toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(mockRotaAssignments).toHaveLength(0);
  });

  it('every confirmation names the exact shift (name, day, time) and driver, since one page can hold many shifts', async () => {
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Gianni');
    const dialog = await screen.findByRole('dialog', { name: 'Assign Gianni?' });
    expect(within(dialog).getByText('Dinner — Monday 7 Jan, 18:00–21:30')).toBeInTheDocument();
  });

  it('15. an Unavailable driver opens the stronger warning', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-gianni', 'unavailable');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Gianni');

    const dialog = await screen.findByRole('dialog', { name: 'Assign Gianni?' });
    expect(within(dialog).getByText(/marked themselves unavailable for this shift/)).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('16. the reason is OPTIONAL -- confirming without typing one succeeds', async () => {
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Gianni');
    fireEvent.click(await screen.findByRole('button', { name: 'Assign anyway' }));

    expect(await within(c).findByRole('button', { name: 'Remove Gianni from Dinner' })).toBeInTheDocument();
    expect(assignSpy).toHaveBeenCalledWith({ shiftInstanceId: dinnerId(FUTURE_WEEK), driverId: 'mock-gianni', confirmAvailabilityOverride: true, reason: null });
  });

  it('17. the reason field is capped at 500 characters, with a live counter', async () => {
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Gianni');
    const reason = (await screen.findByLabelText('Reason (optional)')) as HTMLTextAreaElement;

    expect(reason).toHaveAttribute('maxLength', '500');
    expect(screen.getByText('0 / 500')).toBeInTheDocument();
    fireEvent.change(reason, { target: { value: 'abc' } });
    expect(screen.getByText('3 / 500')).toBeInTheDocument();
  });

  it('18. confirming an override retries through the repository with confirmAvailabilityOverride=true and the (trimmed) reason', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-gianni', 'unavailable');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Gianni');
    fireEvent.change(await screen.findByLabelText('Reason (optional)'), { target: { value: '  Confirmed by phone  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign anyway' }));

    expect(await within(c).findByRole('button', { name: 'Remove Gianni from Dinner' })).toBeInTheDocument();
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith({ shiftInstanceId: dinnerId(FUTURE_WEEK), driverId: 'mock-gianni', confirmAvailabilityOverride: true, reason: 'Confirmed by phone' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancelling the dialog assigns nothing and closes it', async () => {
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Gianni');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(mockRotaAssignments).toHaveLength(0);
  });

  it('Escape closes the dialog (keyboard accessible)', async () => {
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Gianni');
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

// =======================================================================
// RACE-SAFE OVERRIDE
// =======================================================================
describe('ManualRotaPanel: race-safe override (the server decides)', () => {
  it('19/20. a driver shown as Available who has since become Unavailable opens the UNAVAILABLE warning, taken from the server -- not the stale screen', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    const row = within(c).getByText('Maria').closest('li') as HTMLElement;
    expect(within(row).getByText('Available')).toBeInTheDocument();

    // The driver changes their answer AFTER the manager's screen loaded.
    mockAvailability.find((a) => a.driverId === 'mock-maria')!.status = 'unavailable';
    clickAssign(c, 'Maria');

    const dialog = await screen.findByRole('dialog', { name: 'Assign Maria?' });
    expect(within(dialog).getByText(/marked themselves unavailable for this shift/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Available/)).not.toBeInTheDocument();
    // The first attempt was a normal (unconfirmed) one and was refused; nothing is assigned.
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy.mock.calls[0][0]).toMatchObject({ confirmAvailabilityOverride: false });
    expect(mockRotaAssignments).toHaveLength(0);

    // Confirming then retries with the acknowledgement.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign anyway' }));
    expect(await within(c).findByRole('button', { name: 'Remove Maria from Dinner' })).toBeInTheDocument();
    expect(assignSpy).toHaveBeenLastCalledWith(expect.objectContaining({ driverId: 'mock-maria', confirmAvailabilityOverride: true }));
  });

  it('20b. a driver shown as Available whose answer was removed opens the NOT SUBMITTED warning', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    mockAvailability.length = 0;
    clickAssign(c, 'Maria');

    const dialog = await screen.findByRole('dialog', { name: 'Assign Maria?' });
    expect(within(dialog).getByText(/has not submitted availability/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/marked themselves unavailable/)).not.toBeInTheDocument();
  });

  it('confirming a Not Submitted warning still proceeds if the driver answered in the meantime (the acknowledgement covers it)', async () => {
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Gianni');
    await screen.findByText(/has not submitted availability/);

    // Meanwhile the driver answers "unavailable". The confirm carries the acknowledgement, so it proceeds;
    // the state recorded is whatever the SERVER read -- the UI never claims otherwise.
    answer(dinnerId(FUTURE_WEEK), 'mock-gianni', 'unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Assign anyway' }));
    expect(await within(c).findByRole('button', { name: 'Remove Gianni from Dinner' })).toBeInTheDocument();
  });
});

// =======================================================================
// OVER-ASSIGNMENT + COMBINED WARNING
// =======================================================================
describe('ManualRotaPanel: assigning above the requirement', () => {
  beforeEach(() => {
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-maria');
    addDriver('mock-pat', 'Pat');
  });

  it('21. an already-covered shift asks for a lightweight confirmation before adding another driver (no reason field for this alone)', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-pat', 'available');
    renderRota();
    const c = await findCard('Dinner');
    expect(within(c).getByText('Covered')).toBeInTheDocument();
    openPicker(c);
    clickAssign(c, 'Pat');

    const dialog = await screen.findByRole('dialog', { name: 'Assign Pat?' });
    expect(within(dialog).getByText(/already has the required coverage/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 \/ 2 drivers assigned/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Reason (optional)')).not.toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign anyway' }));
    expect(await within(c).findByText('3 / 2 active assigned')).toBeInTheDocument();
    expect(assignSpy).toHaveBeenCalledWith(expect.objectContaining({ driverId: 'mock-pat', confirmAvailabilityOverride: false }));
  });

  it('22. covered + Unavailable is ONE combined confirmation, not two sequential dialogs', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-pat', 'unavailable');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Pat');

    const dialogs = await screen.findAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(within(dialogs[0]).getByText(/already has the required coverage/)).toBeInTheDocument();
    expect(within(dialogs[0]).getByText(/marked themselves unavailable/)).toBeInTheDocument();
    expect(within(dialogs[0]).getByLabelText('Reason (optional)')).toBeInTheDocument();

    fireEvent.click(within(dialogs[0]).getByRole('button', { name: 'Assign anyway' }));
    await within(c).findByText('3 / 2 active assigned');
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith(expect.objectContaining({ driverId: 'mock-pat', confirmAvailabilityOverride: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('covered + Not Submitted is also one combined dialog', async () => {
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Pat');
    const dialogs = await screen.findAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(within(dialogs[0]).getByText(/already has the required coverage/)).toBeInTheDocument();
    expect(within(dialogs[0]).getByText(/has not submitted availability/)).toBeInTheDocument();
  });

  it('an inactive assignee does not make a shift "already covered" -- the coverage prompt only appears at the active count', async () => {
    mockRotaAssignments.length = 0;
    addDriver('mock-gone', 'Gone', false);
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gone');
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Maria');
    // 1 active of 2 required -> still needs staff -> assigned straight away.
    expect(await within(c).findByRole('button', { name: 'Remove Maria from Dinner' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// =======================================================================
// REMOVE
// =======================================================================
describe('ManualRotaPanel: removing', () => {
  it('23. Remove unassigns through the repository and coverage updates immediately', async () => {
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-maria');
    renderRota();
    const c = await findCard('Dinner');
    expect(within(c).getByText('Covered')).toBeInTheDocument();

    fireEvent.click(within(c).getByRole('button', { name: 'Remove Maria from Dinner' }));

    await waitFor(() => expect(within(c).getByText('1 / 2 active assigned')).toBeInTheDocument());
    expect(unassignSpy).toHaveBeenCalledWith({ shiftInstanceId: dinnerId(FUTURE_WEEK), driverId: 'mock-maria' });
    expect(within(c).getByText('Uncovered')).toBeInTheDocument();
    expect(within(c).queryByText('Maria')).not.toBeInTheDocument();
    expect(within(c).getByText('Gianni')).toBeInTheDocument();
  });

  it('an inactive assignee can be removed', async () => {
    addDriver('mock-gone', 'Gone', false);
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gone');
    renderRota();
    const c = await findCard('Dinner');
    fireEvent.click(within(c).getByRole('button', { name: 'Remove Gone from Dinner' }));
    await waitFor(() => expect(within(c).queryByText('Gone')).not.toBeInTheDocument());
    expect(within(c).getByText('No drivers assigned.')).toBeInTheDocument();
  });

  it('24. attendance recorded -> a clean manager message, the rota is unchanged', async () => {
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    unassignSpy.mockRejectedValue(new RotaAssignmentError('attendance_recorded', 'raw db text that must never be shown', { operation: 'rota.unassignDriver', code: '55006' }));
    renderRota();
    const c = await findCard('Dinner');
    fireEvent.click(within(c).getByRole('button', { name: 'Remove Gianni from Dinner' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This assignment can’t be removed because attendance has already been recorded.');
    expect(screen.queryByText(/raw db text|55006|VD001/)).not.toBeInTheDocument();
    expect(within(c).getByText('Gianni')).toBeInTheDocument();
    expect(within(c).getByText('1 / 2 active assigned')).toBeInTheDocument();
  });

  it('a stale "not assigned" failure explains itself and refreshes the rota', async () => {
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    renderRota();
    const c = await findCard('Dinner');
    // Someone else removes the assignment before this manager clicks Remove.
    mockRotaAssignments.length = 0;
    fireEvent.click(within(c).getByRole('button', { name: 'Remove Gianni from Dinner' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/);
    await waitFor(() => expect(within(c).queryByText('Gianni')).not.toBeInTheDocument());
  });

  it('an assign failure (duplicate) is explained, not shown as a generic error, and the rota refreshes', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-maria'); // assigned elsewhere meanwhile
    clickAssign(c, 'Maria');
    expect(await screen.findByRole('alert')).toHaveTextContent(/already assigned to this shift/);
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Remove Maria from Dinner' })).toBeInTheDocument());
  });

  it('a failure message can be dismissed', async () => {
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    unassignSpy.mockRejectedValue(new Error('network'));
    renderRota();
    const c = await findCard('Dinner');
    fireEvent.click(within(c).getByRole('button', { name: 'Remove Gianni from Dinner' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// =======================================================================
// HISTORICAL / TODAY
// =======================================================================
describe('ManualRotaPanel: operational dates', () => {
  it('25. a shift before the operational today is read-only: labelled Historical, no Assign or Remove controls, history still visible', async () => {
    seedAssignment(dinnerId(PAST_WEEK), 'mock-gianni');
    renderRota({ resortId: CRANS, weekStart: PAST_WEEK });
    const c = await findCard('Dinner');

    expect(within(c).getByText('Historical')).toBeInTheDocument();
    expect(within(c).getByText('Gianni')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /Assign/ })).not.toBeInTheDocument();
    expect(within(c).getByText('1 / 2 active assigned')).toBeInTheDocument();
  });

  it('26. a shift dated TODAY (operational) is fully editable', async () => {
    const today = getOperationalToday();
    const weekday = (today.getDay() + 6) % 7;
    addShift({ key: 'today', name: 'Today Shift', weekday, start: '11:00', end: '13:00', required: 1 });
    answer(`mock-crans-today-tpl-${toISODate(today)}`, 'mock-maria', 'available');
    renderRota({ resortId: CRANS, weekStart: toISODate(startOfWeek(today)) });

    const c = await findCard('Today Shift');
    expect(within(c).queryByText('Historical')).not.toBeInTheDocument();
    openPicker(c);
    clickAssign(c, 'Maria', 'Today Shift');
    expect(await within(c).findByRole('button', { name: 'Remove Maria from Today Shift' })).toBeInTheDocument();
  });

  it('a shift dated tomorrow is editable too', async () => {
    const tomorrow = addDays(getOperationalToday(), 1);
    addShift({ key: 'tomorrow', name: 'Tomorrow Shift', weekday: (tomorrow.getDay() + 6) % 7, start: '11:00', end: '13:00', required: 1 });
    renderRota({ resortId: CRANS, weekStart: toISODate(startOfWeek(tomorrow)) });
    const c = await findCard('Tomorrow Shift');
    expect(within(c).getByRole('button', { name: /Assign a driver/ })).toBeInTheDocument();
  });
});

// =======================================================================
// PUBLICATION
// =======================================================================
describe('ManualRotaPanel: published weeks', () => {
  it('27. a published week shows an informational note', async () => {
    mockRotaPublications.push({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    renderRota();
    await findCard('Dinner');
    expect(screen.getByText('This rota is published. Manager assignment changes are visible immediately.')).toBeInTheDocument();
  });

  it('a draft week shows no such note', async () => {
    renderRota();
    await findCard('Dinner');
    expect(screen.queryByText(/This rota is published/)).not.toBeInTheDocument();
  });

  it('28. a published week stays fully editable -- assign and remove both work, and it is not unpublished', async () => {
    mockRotaPublications.push({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Maria');
    fireEvent.click(await within(c).findByRole('button', { name: 'Remove Maria from Dinner' }));
    // Her assigned row goes; she is simply a candidate again.
    await waitFor(() => expect(within(c).queryByRole('button', { name: 'Remove Maria from Dinner' })).not.toBeInTheDocument());
    expect(within(c).getByRole('button', { name: 'Assign Maria to Dinner' })).toBeInTheDocument();

    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(unassignSpy).toHaveBeenCalledTimes(1);
    expect(mockRotaPublications).toEqual([{ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null }]);
    expect(screen.getByText(/This rota is published/)).toBeInTheDocument();
  });

  it('29. there is no Publish / Unpublish / Retract control anywhere; the only Auto-Rota control is Generate Rota, and it is disabled on a published week', async () => {
    mockRotaPublications.push({ resortId: CRANS, weekStart: FUTURE_WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    for (const name of [/publish/i, /unpublish/i, /retract/i, /balance/i, /regenerate/i, /optimi[sz]e/i, /smart|ai /i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Generate Rota' })).toBeDisabled();
  });
});

// =======================================================================
// LOADING / ERROR / EMPTY
// =======================================================================
describe('ManualRotaPanel: states', () => {
  it('30. a week with no shifts shows a neutral empty state -- never "Uncovered", never fabricated days', async () => {
    renderRota({ resortId: 'mock-verbier', weekStart: FUTURE_WEEK });
    expect(await screen.findByText('No shifts are scheduled for this week.')).toBeInTheDocument();
    expect(screen.queryByText(/Uncovered|Covered/)).not.toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Monday|Tuesday/ })).not.toBeInTheDocument();
  });

  it('31. shows a loading state while the rota is fetched', async () => {
    renderRota();
    expect(screen.getByRole('status')).toHaveTextContent('Loading rota…');
    await findCard('Dinner');
    expect(screen.queryByText('Loading rota…')).not.toBeInTheDocument();
  });

  it('32. a load failure shows a useful error with Retry, and Retry recovers', async () => {
    const read = vi.spyOn(MockRotaRepository.prototype, 'getManagerWeekRota');
    read.mockRejectedValueOnce(new Error('network down'));
    renderRota();

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the rota. Please try again.');
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await findCard('Dinner')).toBeInTheDocument();
  });

  it('with no resort chosen yet, asks for one and fetches nothing', () => {
    const read = vi.spyOn(MockRotaRepository.prototype, 'getManagerWeekRota');
    renderRota({ resortId: null, weekStart: FUTURE_WEEK });
    expect(screen.getByText('Choose a resort to see its rota.')).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it('follows the resort and week props', async () => {
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    const { rerenderWith } = renderRota();
    const first = await findCard('Dinner');
    expect(within(first).getByText('1 / 2 active assigned')).toBeInTheDocument();

    // Another Monday: a different shift instance, so Gianni's assignment is not there.
    rerenderWith({ resortId: CRANS, weekStart: '2030-01-14' });
    await waitFor(() => expect(within(card('Dinner')).getByText('0 / 2 active assigned')).toBeInTheDocument());

    // Another resort: that resort's own drivers.
    rerenderWith({ resortId: 'mock-zermatt', weekStart: FUTURE_WEEK });
    await waitFor(() => expect(within(card('Dinner')).getByText('0 / 2 active assigned')).toBeInTheDocument());
    openPicker(card('Dinner'));
    expect(within(card('Dinner')).getByText('Alex')).toBeInTheDocument();
    expect(within(card('Dinner')).queryByText('Gianni')).not.toBeInTheDocument();

    // A resort with no shifts at all: the neutral empty state.
    rerenderWith({ resortId: 'mock-verbier', weekStart: FUTURE_WEEK });
    expect(await screen.findByText('No shifts are scheduled for this week.')).toBeInTheDocument();
  });
});

// =======================================================================
// MUTATION BEHAVIOUR
// =======================================================================
describe('ManualRotaPanel: mutations', () => {
  it('33. while an assignment is running its button is disabled, and a second click cannot start a duplicate', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    let release!: () => void;
    assignSpy.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ assignmentId: 'x', availabilityState: 'available' }); }) as never
    );
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    const button = within(c).getByRole('button', { name: 'Assign Maria to Dinner' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent('Assigning…');
    expect(assignSpy).toHaveBeenCalledTimes(1);
    // Only THAT action is disabled -- the rest of the page stays usable.
    expect(within(c).getByRole('button', { name: 'Assign Gianni to Dinner' })).toBeEnabled();

    release();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('a running Remove is disabled and cannot be double-submitted', async () => {
    seedAssignment(dinnerId(FUTURE_WEEK), 'mock-gianni');
    let release!: () => void;
    unassignSpy.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ assignmentId: 'x' }); }) as never);
    renderRota();
    const c = await findCard('Dinner');
    const remove = within(c).getByRole('button', { name: 'Remove Gianni from Dinner' });
    fireEvent.click(remove);
    fireEvent.click(remove);
    await waitFor(() => expect(remove).toBeDisabled());
    expect(remove).toHaveTextContent('Removing…');
    expect(unassignSpy).toHaveBeenCalledTimes(1);
    release();
  });

  it('34. a successful assign or remove invalidates exactly this resort+week\'s manager rota query (nothing unrelated)', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    const { client } = renderRota();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const c = await findCard('Dinner');
    openPicker(c);
    clickAssign(c, 'Maria');
    fireEvent.click(await within(c).findByRole('button', { name: 'Remove Maria from Dinner' }));
    await waitFor(() => expect(unassignSpy).toHaveBeenCalled());
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));

    for (const call of invalidate.mock.calls) {
      expect(call[0]).toEqual({ queryKey: managerRotaKeys.week(CRANS, FUTURE_WEEK) });
    }
  });

  it('a FAILED assignment does not pretend success: the rota stays as it was, with the reason shown', async () => {
    answer(dinnerId(FUTURE_WEEK), 'mock-maria', 'available');
    renderRota();
    const c = await findCard('Dinner');
    openPicker(c);
    // Maria is deactivated AFTER the page loaded, so the server (mock) refuses the assignment.
    mockDrivers.find((d) => d.id === 'mock-maria')!.isActive = false;
    clickAssign(c, 'Maria');

    expect(await screen.findByRole('alert')).toHaveTextContent(/inactive/);
    expect(mockRotaAssignments).toHaveLength(0);
    expect(within(c).queryByRole('button', { name: 'Remove Maria from Dinner' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
