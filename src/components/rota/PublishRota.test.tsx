// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ManualRotaPanel } from './ManualRotaPanel';
import { getRepositories, resetRepositoriesForTesting } from '../../repositories';
import { MockRotaRepository } from '../../repositories/mock/rota';
import { MockAvailabilityRepository } from '../../repositories/mock/availability';
import {
  mockAvailability,
  mockDrivers,
  mockRotaAssignments,
  mockRotaPublications,
  mockShiftTemplates,
  mockShiftTypes,
  resetMockFixturesForTesting,
} from '../../repositories/mock/fixtures';
import { PublishRotaError, isAutoRotaError } from '../../repositories/errors';
import { availabilityKeys, managerRotaKeys } from '../../repositories/queryKeys';
import { managerNavItems } from '../layout/nav-config';
import type { AvailabilityStatus, PublishRotaResult } from '../../repositories/domain';
// Raw sources for the architecture checks.
import panelSource from './ManualRotaPanel.tsx?raw';
import uiSource from './publishRotaUi.ts?raw';
import hookSource from './usePublishRota.ts?raw';
import dialogSource from './PublishRotaDialog.tsx?raw';

// Monday 2030-01-07 week. The mock Crans Dinner (required 2) runs on Mondays.
const WEEK = '2030-01-07';
const NEXT_WEEK = '2030-01-14';
const CRANS = 'mock-crans';
const ZERMATT = 'mock-zermatt';
const dinnerId = (week: string) => `mock-crans-dinner-tpl-${week}`;

function renderRota(initial: { resortId: string | null; weekStart: string; resortName?: string } = { resortId: CRANS, weekStart: WEEK, resortName: 'Crans-Montana' }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (p: typeof initial) => (
    <QueryClientProvider client={client}>
      <ManualRotaPanel {...p} />
    </QueryClientProvider>
  );
  const utils = render(tree(initial));
  return { client, ...utils, rerenderWith: (p: typeof initial) => utils.rerender(tree(p)) };
}

function addDriver(id: string, fullName: string, resortId = CRANS) {
  mockDrivers.push({ id, resortId, fullName, isActive: true, preferredLanguage: 'en' });
}
function answer(shiftInstanceId: string, driverId: string, status: AvailabilityStatus, resortId = CRANS) {
  mockAvailability.push({ id: `ans-${shiftInstanceId}-${driverId}`, driverId, resortId, shiftInstanceId, status, answeredAt: '2030-01-01T00:00:00Z' });
}
function seed(shiftInstanceId: string, driverId: string, source: 'manual' | 'auto' = 'manual') {
  mockRotaAssignments.push({ id: `seed-${shiftInstanceId}-${driverId}`, shiftInstanceId, driverId, resortId: CRANS, source, assignedAt: '2030-01-01T10:00:00.000Z' });
}
function addShift(key: string, name: string, weekday: number, required: number, resortId = CRANS) {
  mockShiftTypes.push({ id: `mock-${resortId}-${key}`, resortId, key, name, sortOrder: 5, isActive: true });
  mockShiftTemplates.push({
    id: `mock-${resortId}-${key}-tpl`, resortId, shiftTypeId: `mock-${resortId}-${key}`, weekday,
    startTime: '12:00', endTime: '14:00', requiredDrivers: required, basePayChf: null, deliveryRateChf: null, isPremium: null,
    effectiveFrom: '2024-01-01', effectiveTo: null, isActive: true, updatedAt: '2024-01-01T00:00:00.000Z',
  });
}
const fillDinner = () => {
  seed(dinnerId(WEEK), 'mock-gianni');
  seed(dinnerId(WEEK), 'mock-maria');
};

const header = () => screen.getByRole('heading', { name: 'Manual Rota' }).closest('.card__header') as HTMLElement;
const publishButton = () => within(header()).getByRole('button', { name: /^(Publish Rota|Publishing…|Published)$/ });
const generateButton = () => within(header()).getByRole('button', { name: /^(Generate Rota|Generating…)$/ });
const dialog = () => screen.getByRole('dialog', { name: 'Publish rota?' });
const dinnerCard = () => screen.findByRole('article', { name: /^Dinner,/ });

async function openDialog() {
  await dinnerCard();
  await waitFor(() => expect(publishButton()).toBeEnabled());
  publishButton().focus();
  fireEvent.click(publishButton());
  return dialog();
}
/** Opens the dialog and confirms the first (plain) step. */
async function confirmFirst() {
  const d = await openDialog();
  fireEvent.click(within(d).getByRole('button', { name: 'Publish Rota' }));
}
/** First confirm, then "Publish anyway" once the server asks for acknowledgement. */
async function confirmAnyway() {
  await confirmFirst();
  const anyway = await screen.findByRole('button', { name: 'Publish anyway' });
  fireEvent.click(anyway);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const published = (over: Partial<PublishRotaResult> = {}): PublishRotaResult => ({
  resortId: CRANS, weekStart: WEEK, publishedAt: '2030-01-01T00:00:00Z', uncoveredSlots: 0, alreadyPublished: false, ...over,
});

let publishSpy: MockInstance<MockRotaRepository['publishRota']>;

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
  addDriver('mock-maria', 'Maria');
  publishSpy = vi.spyOn(MockRotaRepository.prototype, 'publishRota');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Publish Rota: placement, hierarchy and enablement', () => {
  it('1. a Publish Rota button sits in the Manual Rota header beside Generate Rota (Generate first)', async () => {
    renderRota();
    await dinnerCard();
    const buttons = within(header()).getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Generate Rota', 'Publish Rota']);
  });

  it('2. Publish is the primary action and Generate is secondary', async () => {
    renderRota();
    await dinnerCard();
    expect(publishButton()).toHaveClass('btn--primary');
    expect(generateButton()).toHaveClass('btn--secondary');
    expect(generateButton()).not.toHaveClass('btn--primary');
  });

  it('3. there is no separate Publish page or navigation entry', () => {
    expect(managerNavItems.map((item) => item.label).join('|')).not.toMatch(/publish/i);
  });

  it('no resort selected: no Publish button at all', () => {
    renderRota({ resortId: null, weekStart: WEEK });
    expect(screen.queryByRole('button', { name: /Publish/ })).not.toBeInTheDocument();
  });

  it('while the week is loading Publish is disabled without any warning text', () => {
    renderRota();
    expect(publishButton()).toBeDisabled();
    expect(screen.queryByText(/can’t be published|no shifts to publish|already been published/)).not.toBeInTheDocument();
  });

  it('4. enabled on a draft week with a shift ahead -- even with nothing assigned or covered', async () => {
    renderRota();
    await dinnerCard();
    expect(publishButton()).toBeEnabled();
    expect(publishButton()).toHaveTextContent('Publish Rota');
    expect(screen.queryByText(/can’t be published|no shifts to publish|already been published/)).not.toBeInTheDocument();
  });

  it('5. a partially historical current week stays publishable', async () => {
    addShift('friday', 'Friday Lunch', 4, 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-09T10:00:00Z')); // Wednesday: Monday Dinner is past, Friday Lunch is ahead
    renderRota();
    await screen.findByRole('article', { name: /^Friday Lunch,/ });
    expect(publishButton()).toBeEnabled();
  });

  it('10. TODAY is allowed: a week whose only shift is today is publishable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-07T10:00:00Z')); // Monday: the Dinner is today
    renderRota();
    await dinnerCard();
    expect(publishButton()).toBeEnabled();
  });

  it('6/7/11. a PUBLISHED week shows a disabled "Published" control with its reason as visible text wired to it', async () => {
    mockRotaPublications.push({ resortId: CRANS, weekStart: WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    renderRota();
    await dinnerCard();
    await waitFor(() => expect(publishButton()).toHaveTextContent('Published'));
    expect(publishButton()).toBeDisabled();
    const reason = screen.getByText('This rota has already been published.');
    expect(publishButton()).toHaveAttribute('aria-describedby', reason.id);
    // Generate keeps its OWN existing reason; there is no Publish-specific Generate logic.
    expect(generateButton()).toBeDisabled();
    expect(screen.getByText('Auto-Rota can’t run after this rota has been published.')).toBeInTheDocument();
  });

  it('8/11. disabled for a week with no shifts, with the reason', async () => {
    renderRota({ resortId: 'mock-verbier', weekStart: WEEK, resortName: 'Verbier' });
    expect(await screen.findByText('No shifts are scheduled for this week.')).toBeInTheDocument();
    expect(publishButton()).toBeDisabled();
    const reason = screen.getByText('There are no shifts to publish this week.');
    expect(publishButton()).toHaveAttribute('aria-describedby', reason.id);
  });

  it('9/11. disabled for a fully historical week, with the reason', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-14T10:00:00Z')); // the Monday AFTER the week
    renderRota();
    await dinnerCard();
    expect(publishButton()).toBeDisabled();
    expect(screen.getByText('This rota can’t be published because the week is in the past.')).toBeInTheDocument();
  });

  it('a week whose only remaining shifts passed is also disabled (current week, every shift before today)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-09T10:00:00Z')); // Wednesday; only the Monday Dinner exists
    renderRota();
    await dinnerCard();
    expect(publishButton()).toBeDisabled();
  });
});

describe('Publish Rota: the confirmation dialog', () => {
  it('12/13/14. opens ONE dialog that names the resort and the week', async () => {
    renderRota();
    const d = await openDialog();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(d).getByText('Crans-Montana')).toBeInTheDocument();
    expect(within(d).getByText('7 – 13 Jan 2030')).toBeInTheDocument();
  });

  it('15/16/17. says what publishing does: driver visibility, availability lock, Auto-Rota stop', async () => {
    renderRota();
    const d = await openDialog();
    expect(within(d).getByText('Publishing will:')).toBeInTheDocument();
    expect(within(d).getByText('Make assigned shifts visible to drivers')).toBeInTheDocument();
    expect(within(d).getByText('Lock driver availability for this week')).toBeInTheDocument();
    expect(within(d).getByText('Stop Auto-Rota generation')).toBeInTheDocument();
  });

  it('shows NO coverage prediction, driver list or table before the server responds', async () => {
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    seed(dinnerId(WEEK), 'mock-gianni');
    renderRota();
    const d = await openDialog();
    expect(d.textContent).not.toMatch(/Gianni|Maria|uncovered|\d+ positions?|\d+ assignments?/i);
    expect(within(d).queryByRole('table')).not.toBeInTheDocument();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('18. Cancel (and Escape) close the dialog without any repository call, returning focus to Publish Rota', async () => {
    renderRota();
    const d = await openDialog();
    expect(d).toHaveAccessibleName('Publish rota?');
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(publishButton()).toHaveFocus();

    await openDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(publishButton()).toHaveFocus();
  });
});

describe('Publish Rota: covered success', () => {
  it('19/20. the FIRST call is confirmUncovered=false; a covered week publishes, closes the dialog and shows a status notice', async () => {
    fillDinner();
    renderRota();
    await confirmFirst();
    const notice = await screen.findByText('Rota published. Drivers can now see their assigned shifts.');
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith({ resortId: CRANS, weekStart: WEEK, confirmUncovered: false });
    expect(mockRotaPublications).toHaveLength(1);
  });

  it('the header becomes Published and Generate stays disabled with its existing reason (after the refetch)', async () => {
    fillDinner();
    renderRota();
    await confirmFirst();
    await screen.findByText('Rota published. Drivers can now see their assigned shifts.');
    await waitFor(() => expect(publishButton()).toHaveTextContent('Published'));
    expect(publishButton()).toBeDisabled();
    expect(generateButton()).toBeDisabled();
    expect(screen.getByText('Auto-Rota can’t run after this rota has been published.')).toBeInTheDocument();
    expect(screen.getByText(/This rota is published\./)).toBeInTheDocument();
  });
});

describe('Publish Rota: query refresh', () => {
  it('21/22/23. a successful publish refreshes the manager rota, the Availability summary and the Availability detail of THAT resort/week only', async () => {
    fillDinner();
    const { client } = renderRota();
    const mgrKey = managerRotaKeys.week(CRANS, WEEK);
    const keep = [
      ['availability', 'managerSummary', CRANS, NEXT_WEEK],
      ['availability', 'managerSummary', ZERMATT, WEEK],
      ['availability', 'managerDetail', 'mock-gianni', NEXT_WEEK],
      managerRotaKeys.week(CRANS, NEXT_WEEK),
      ['payroll', 'rates'],
      ['configuration', 'shifts'],
    ];
    const refresh = [availabilityKeys.managerSummary(CRANS, WEEK), availabilityKeys.managerDetail('mock-gianni', WEEK), availabilityKeys.managerDetail('mock-alex', WEEK)];
    for (const key of [...keep, ...refresh]) client.setQueryData(key, { cached: true });

    await confirmFirst();
    await screen.findByText('Rota published. Drivers can now see their assigned shifts.');

    expect(client.getQueryState(mgrKey)?.dataUpdateCount).toBeGreaterThanOrEqual(2); // loaded, then refetched
    for (const key of refresh) expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    for (const key of keep) expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
  });

  it('a rejected publish refreshes nothing it should not (an unconfirmed attempt changes no state)', async () => {
    const { client } = renderRota();
    client.setQueryData(availabilityKeys.managerSummary(CRANS, WEEK), { cached: true });
    await confirmFirst(); // uncovered -> confirmation required, nothing published
    await screen.findByRole('button', { name: 'Publish anyway' });
    expect(client.getQueryState(availabilityKeys.managerSummary(CRANS, WEEK))?.isInvalidated).toBe(false);
    expect(mockRotaPublications).toEqual([]);
  });
});

describe('Publish Rota: server-authoritative uncovered flow', () => {
  it('24/25/27. the typed error switches the SAME dialog to a warning with the server\'s count (plural)', async () => {
    renderRota(); // required 2, nobody assigned -> 2 open
    await confirmFirst();
    const anyway = await screen.findByRole('button', { name: 'Publish anyway' });
    const d = dialog();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(d).getByText('2 positions are still uncovered.')).toBeInTheDocument();
    expect(within(d).getByText('You can still publish this rota. Drivers will see their assigned shifts, and availability will be locked.')).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(anyway).toBeInTheDocument();
    expect(within(d).queryByText('Publishing will:')).not.toBeInTheDocument();
    // The warning is TEXT inside a status region, not colour alone.
    expect(within(d).getByText('2 positions are still uncovered.').closest('[role="status"]')).not.toBeNull();
    expect(mockRotaPublications).toEqual([]);
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('26. singular grammar for exactly one open position', async () => {
    seed(dinnerId(WEEK), 'mock-gianni'); // required 2, one assigned
    renderRota();
    await confirmFirst();
    expect(await screen.findByText('1 position is still uncovered.')).toBeInTheDocument();
    expect(screen.queryByText('No drivers are assigned yet.')).not.toBeInTheDocument();
  });

  it('28. "Publish anyway" repeats the call with confirmUncovered=true, nothing else', async () => {
    renderRota();
    await confirmAnyway();
    await screen.findByText(/Rota published\./);
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy).toHaveBeenNthCalledWith(1, { resortId: CRANS, weekStart: WEEK, confirmUncovered: false });
    expect(publishSpy).toHaveBeenNthCalledWith(2, { resortId: CRANS, weekStart: WEEK, confirmUncovered: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockRotaPublications).toHaveLength(1);
  });

  it('29. if the server\'s count changed between the warning and the confirmation, the FINAL result is accepted without a third prompt', async () => {
    addDriver('mock-pat', 'Pat');
    renderRota(); // 2 open at the warning
    await confirmFirst();
    await screen.findByText('2 positions are still uncovered.');
    seed(dinnerId(WEEK), 'mock-gianni'); // someone fills a position meanwhile
    fireEvent.click(screen.getByRole('button', { name: 'Publish anyway' }));
    // 31. uncovered success is a warning-toned status, not an error, and uses the server's FINAL count
    const notice = await screen.findByText('Rota published. 1 position is still uncovered. Drivers can now see their assigned shifts.');
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(notice.closest('.inline-notice')).toHaveClass('inline-notice--warning');
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('30. a week with no assigned drivers adds "No drivers are assigned yet." to the server-triggered warning', async () => {
    renderRota();
    await confirmFirst();
    expect(await screen.findByText('No drivers are assigned yet.')).toBeInTheDocument();
    expect(publishSpy).toHaveBeenCalledTimes(1); // no separate server call or flow for it
  });

  it('Cancel from the warning publishes nothing, and reopening starts from the plain confirmation again', async () => {
    renderRota();
    await confirmFirst();
    await screen.findByRole('button', { name: 'Publish anyway' });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockRotaPublications).toEqual([]);
    expect(publishButton()).toHaveFocus();
    const d = await openDialog();
    expect(within(d).getByText('Publishing will:')).toBeInTheDocument();
    expect(within(d).queryByText(/still uncovered/)).not.toBeInTheDocument();
  });
});

describe('Publish Rota: already published (idempotent)', () => {
  it('32. an already-published result is a success, not an error', async () => {
    publishSpy.mockResolvedValueOnce(published({ alreadyPublished: true }));
    renderRota();
    await confirmFirst();
    const notice = await screen.findByText('This rota is already published.');
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('33. another session published first: the stale Draft screen succeeds, refetches, and flips to Published / Generate disabled', async () => {
    renderRota();
    await dinnerCard();
    await waitFor(() => expect(publishButton()).toBeEnabled());
    // ...meanwhile elsewhere:
    mockRotaPublications.push({ resortId: CRANS, weekStart: WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    fireEvent.click(publishButton());
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Publish Rota' }));

    await screen.findByText('This rota is already published.');
    await waitFor(() => expect(publishButton()).toHaveTextContent('Published'));
    expect(publishButton()).toBeDisabled();
    expect(generateButton()).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockRotaPublications).toHaveLength(1); // no duplicate
  });
});

describe('Publish Rota: pending, lifecycle and errors', () => {
  it('34. while publishing: header button busy/disabled, confirm reads "Publishing…", a second click makes no second call', async () => {
    const d1 = deferred<PublishRotaResult>();
    publishSpy.mockReturnValueOnce(d1.promise);
    renderRota();
    fillDinner();
    const dlg = await openDialog();
    const confirmBtn = within(dlg).getByRole('button', { name: 'Publish Rota' });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Publishing…' })).toBeDisabled());
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(publishButton()).toBeDisabled();
    expect(publishButton()).toHaveAttribute('aria-busy', 'true');
    expect(generateButton()).toBeDisabled(); // no conflicting action while publishing

    await act(async () => d1.resolve(published()));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('Generate Rota running disables Publish (no conflicting actions)', async () => {
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    renderRota();
    await dinnerCard();
    await waitFor(() => expect(generateButton()).toBeEnabled());
    const gate = deferred<unknown>();
    vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota').mockReturnValueOnce(gate.promise as never);
    fireEvent.click(generateButton());
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Generate rota?' })).getByRole('button', { name: 'Generate Rota' }));
    await waitFor(() => expect(publishButton()).toBeDisabled());
    await act(async () => gate.resolve({ resortId: CRANS, weekStart: WEEK, assignedCount: 0, remainingOpenSlots: 0, uncoveredShiftIds: [], skippedPastShiftCount: 0, runId: 'r' }));
  });

  it('35. the result notice belongs to its resort + week and 36. clears when the selection changes', async () => {
    fillDinner();
    const { rerenderWith } = renderRota();
    await confirmFirst();
    await screen.findByText('Rota published. Drivers can now see their assigned shifts.');
    rerenderWith({ resortId: CRANS, weekStart: NEXT_WEEK, resortName: 'Crans-Montana' });
    await screen.findByRole('article', { name: /^Dinner,/ });
    expect(screen.queryByText(/Rota published/)).not.toBeInTheDocument();
    // ...and the new week is a normal Draft with Publish available.
    await waitFor(() => expect(publishButton()).toBeEnabled());
  });

  it('37. changing the week or resort closes an open dialog (even mid-warning), so a confirm can never run against the old selection', async () => {
    const { rerenderWith } = renderRota();
    await confirmFirst();
    await screen.findByRole('button', { name: 'Publish anyway' });
    rerenderWith({ resortId: CRANS, weekStart: NEXT_WEEK, resortName: 'Crans-Montana' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await dinnerCard();
    await waitFor(() => expect(publishButton()).toBeEnabled());
    fireEvent.click(publishButton());
    expect(dialog()).toBeInTheDocument();
    rerenderWith({ resortId: ZERMATT, weekStart: NEXT_WEEK, resortName: 'Zermatt' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockRotaPublications).toEqual([]);
  });

  it('a result that arrives AFTER the manager moved on is not shown on the new selection (the old week is still refreshed)', async () => {
    const slow = deferred<PublishRotaResult>();
    publishSpy.mockReturnValueOnce(slow.promise);
    fillDinner();
    const { rerenderWith } = renderRota();
    await confirmFirst();
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Publishing…' })).toBeDisabled());
    rerenderWith({ resortId: CRANS, weekStart: NEXT_WEEK, resortName: 'Crans-Montana' });
    await screen.findByRole('article', { name: /^Dinner,/ });
    await act(async () => slow.resolve(published()));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Rota published/)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The new selection's own Publish control is not left stuck busy by the old call.
    await waitFor(() => expect(publishButton()).toBeEnabled());
  });

  it.each([
    ['historical_week', 'This rota can’t be published because the week is in the past.'],
    ['no_shifts', 'This rota can’t be published because there are no shifts this week.'],
    ['resort_inactive', 'This rota can’t be published because this resort is inactive.'],
    ['permission_denied', 'You don’t have permission to publish this rota.'],
    ['unknown', 'Couldn’t publish the rota. Please try again.'],
  ] as const)('38. a %s failure is shown inline as an alert with first-party copy, leaving the rota intact and Publish usable', async (kind, text) => {
    seed(dinnerId(WEEK), 'mock-gianni');
    publishSpy.mockRejectedValueOnce(new PublishRotaError(kind, { operation: 'rota.publishRota', code: '55006', cause: { details: 'internal' } }));
    renderRota();
    await confirmFirst();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 40. no raw database detail
    expect(document.body.textContent).not.toMatch(/55006|VD003|23514|42501|P0002|22023|internal|rota_publications|SQLSTATE/);
    // the rota stays visible, still a draft, and the action is still there
    expect(within(await dinnerCard()).getByText('Gianni')).toBeInTheDocument();
    expect(screen.queryByText('Published')).not.toBeInTheDocument();
    expect(publishButton()).toHaveTextContent('Publish Rota');
  });

  it('39. an unknown/network failure shows the generic copy, never the raw message, and the manager can retry', async () => {
    publishSpy.mockRejectedValueOnce(new Error('fetch failed: ECONNRESET 10.0.0.1'));
    fillDinner();
    renderRota();
    await confirmFirst();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t publish the rota. Please try again.');
    expect(document.body.textContent).not.toMatch(/ECONNRESET|fetch failed/);
    await waitFor(() => expect(publishButton()).toBeEnabled());

    await confirmFirst(); // retry succeeds
    await screen.findByText('Rota published. Drivers can now see their assigned shifts.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a stale-screen failure (week became unpublishable) refetches the week', async () => {
    seed(dinnerId(WEEK), 'mock-gianni');
    publishSpy.mockRejectedValueOnce(new PublishRotaError('no_shifts', { operation: 'rota.publishRota' }));
    const { client } = renderRota();
    await dinnerCard();
    const before = client.getQueryState(managerRotaKeys.week(CRANS, WEEK))?.dataUpdateCount ?? 0;
    await confirmFirst();
    await screen.findByRole('alert');
    await waitFor(() => expect(client.getQueryState(managerRotaKeys.week(CRANS, WEEK))?.dataUpdateCount).toBeGreaterThan(before));
  });
});

describe('Publish Rota: what it changes elsewhere (through the shared repository state, never component state)', () => {
  const driverRota = (driverId: string) => new MockRotaRepository().getDriverWeekRota({ weekStart: WEEK, driverId });
  const manager = () => new MockRotaRepository().getManagerWeekRota({ resortId: CRANS, weekStart: WEEK });

  it('A-D. Draft -> Published for the manager; the assigned driver sees their own shift; an unassigned same-resort driver sees Published + empty', async () => {
    seed(dinnerId(WEEK), 'mock-gianni'); // Maria has no assignment
    expect(await driverRota('mock-gianni')).toMatchObject({ isPublished: false, shifts: [] });
    expect((await manager()).isPublished).toBe(false);

    renderRota();
    await confirmFirst(); // 1 open position -> warning
    fireEvent.click(await screen.findByRole('button', { name: 'Publish anyway' }));
    await screen.findByText(/Rota published\./);

    expect((await manager()).isPublished).toBe(true);
    const gianni = await driverRota('mock-gianni');
    expect(gianni.isPublished).toBe(true);
    expect(gianni.shifts.map((s) => s.shiftInstanceId)).toEqual([dinnerId(WEEK)]);
    expect(await driverRota('mock-maria')).toEqual({ weekStart: WEEK, isPublished: true, shifts: [] });
  });

  it('E. driver Availability becomes locked, without touching any availability answer', async () => {
    fillDinner();
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    const availability = new MockAvailabilityRepository();
    expect((await availability.getWeekAvailabilityStatus('mock-gianni', WEEK)).state).not.toBe('locked');
    const answersBefore = JSON.stringify(mockAvailability);

    renderRota();
    await confirmFirst();
    await screen.findByText('Rota published. Drivers can now see their assigned shifts.');

    expect((await availability.getWeekAvailabilityStatus('mock-gianni', WEEK)).state).toBe('locked');
    await expect(
      availability.setAvailability({ driverId: 'mock-gianni', resortId: CRANS, shiftInstanceId: dinnerId(WEEK), status: 'unavailable' })
    ).rejects.toMatchObject({ code: '42501' });
    expect(JSON.stringify(mockAvailability)).toBe(answersBefore);
  });

  it('F. Auto-Rota is blocked for the published week', async () => {
    renderRota();
    await confirmAnyway();
    await screen.findByText(/Rota published\./);
    const error = await getRepositories().rota.generateAutoRota({ resortId: CRANS, weekStart: WEEK }).catch((e) => e);
    expect(isAutoRotaError(error, 'published_week')).toBe(true);
  });

  it('45/46/G. a published week stays editable: Assign still works, and Remove still works; the week stays published and drivers see the change live', async () => {
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    renderRota();
    await confirmAnyway(); // zero assignments -> warning -> Publish anyway
    await screen.findByText(/Rota published\./);
    await waitFor(() => expect(publishButton()).toHaveTextContent('Published'));

    let c = await dinnerCard();
    expect(within(c).getByRole('button', { name: /Assign a driver/ })).toBeEnabled();
    fireEvent.click(within(c).getByRole('button', { name: /Assign a driver/ }));
    fireEvent.click(within(c).getByRole('button', { name: 'Assign Gianni to Dinner' }));
    await waitFor(async () => expect(within(await dinnerCard()).getByText('1 / 2 active assigned')).toBeInTheDocument());
    expect((await driverRota('mock-gianni')).shifts).toHaveLength(1); // visible to the driver without republishing

    c = await dinnerCard();
    fireEvent.click(within(c).getByRole('button', { name: 'Remove Gianni from Dinner' }));
    await waitFor(async () => expect(within(await dinnerCard()).getByText('0 / 2 active assigned')).toBeInTheDocument());
    expect((await driverRota('mock-gianni')).shifts).toEqual([]);

    // Never auto-unpublished, never re-prompted.
    expect(publishButton()).toHaveTextContent('Published');
    expect((await manager()).isPublished).toBe(true);
    expect(mockRotaPublications).toHaveLength(1);
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it('44. Generate is disabled after the refreshed Published state', async () => {
    fillDinner();
    renderRota();
    await dinnerCard();
    await waitFor(() => expect(generateButton()).toBeEnabled()); // enabled while Draft
    await confirmFirst();
    await screen.findByText('Rota published. Drivers can now see their assigned shifts.');
    await waitFor(() => expect(generateButton()).toBeDisabled());
  });
});

describe('Publish Rota: focus after the dialog closes', () => {
  const noticeRegion = (text: string | RegExp) => screen.getByText(text).closest('.manual-rota__publish-notice') as HTMLElement;

  it('after a successful publish focus moves to the result notice -- not to the now-disabled Published button, not to the page body', async () => {
    fillDinner();
    renderRota();
    await confirmFirst();
    const notice = await screen.findByText('Rota published. Drivers can now see their assigned shifts.');
    await waitFor(() => expect(publishButton()).toHaveTextContent('Published'));
    expect(publishButton()).toBeDisabled();
    await waitFor(() => expect(document.activeElement).toBe(noticeRegion('Rota published. Drivers can now see their assigned shifts.')));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(publishButton());
    expect(document.activeElement?.contains(notice)).toBe(true);
    expect(notice.closest('[role="status"]')).not.toBeNull(); // still announced as a status
  });

  it('the same holds after "Publish anyway" (an uncovered, warning-toned result)', async () => {
    renderRota();
    await confirmAnyway();
    await screen.findByText(/Rota published\. 2 positions are still uncovered\./);
    await waitFor(() => expect(document.activeElement).toBe(noticeRegion(/Rota published\. 2 positions/)));
  });

  it('and after an already-published success', async () => {
    publishSpy.mockResolvedValueOnce(published({ alreadyPublished: true }));
    renderRota();
    await confirmFirst();
    await screen.findByText('This rota is already published.');
    await waitFor(() => expect(document.activeElement).toBe(noticeRegion('This rota is already published.')));
  });

  it('Cancel and Escape (no publication) still return focus to the Publish Rota opener', async () => {
    renderRota();
    const d = await openDialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(publishButton()).toHaveFocus();
    await openDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(publishButton()).toHaveFocus();
  });

  it('a FAILED publish leaves focus on the (still enabled) Publish Rota opener so the manager can retry', async () => {
    publishSpy.mockRejectedValueOnce(new PublishRotaError('unknown', { operation: 'rota.publishRota' }));
    renderRota();
    await confirmFirst();
    await screen.findByRole('alert');
    expect(publishButton()).toBeEnabled();
    expect(publishButton()).toHaveFocus();
  });

  it('focus is not pulled onto a notice for a result that belongs to another selection', async () => {
    const slow = deferred<PublishRotaResult>();
    publishSpy.mockReturnValueOnce(slow.promise);
    fillDinner();
    const { rerenderWith } = renderRota();
    await confirmFirst();
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Publishing…' })).toBeDisabled());
    rerenderWith({ resortId: CRANS, weekStart: NEXT_WEEK, resortName: 'Crans-Montana' });
    await screen.findByRole('article', { name: /^Dinner,/ });
    await act(async () => slow.resolve(published()));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('.manual-rota__publish-notice')).toBeNull();
  });
});

describe('Publish Rota: the whole V1 lifecycle in mock mode', () => {
  it('Availability -> Generate -> manual edit -> Publish -> driver sees it -> Availability locked -> Auto-Rota blocked -> manual edits still live', async () => {
    addDriver('mock-pat', 'Pat');
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    answer(dinnerId(WEEK), 'mock-maria', 'available');
    answer(dinnerId(WEEK), 'mock-pat', 'available');
    const driverRota = (driverId: string) => new MockRotaRepository().getDriverWeekRota({ weekStart: WEEK, driverId });
    const availability = new MockAvailabilityRepository();

    // Draft: nothing visible to drivers, Availability still editable.
    expect(await driverRota('mock-gianni')).toMatchObject({ isPublished: false, shifts: [] });
    expect((await availability.getWeekAvailabilityStatus('mock-gianni', WEEK)).state).not.toBe('locked');

    renderRota();
    // Generate Rota (secondary action) fills the open positions.
    await dinnerCard();
    await waitFor(() => expect(generateButton()).toBeEnabled());
    fireEvent.click(generateButton());
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Generate rota?' })).getByRole('button', { name: 'Generate Rota' }));
    await screen.findByText(/2 assignments added\. All scheduled positions are covered\./);

    // Manual review/edit: swap one generated driver for the third.
    const generated = mockRotaAssignments.map((a) => a.driverId);
    const spare = ['mock-gianni', 'mock-maria', 'mock-pat'].find((id) => !generated.includes(id)) as string;
    const dropped = generated[0];
    const name = (id: string) => ({ 'mock-gianni': 'Gianni', 'mock-maria': 'Maria', 'mock-pat': 'Pat' })[id] as string;
    fireEvent.click(within(await dinnerCard()).getByRole('button', { name: `Remove ${name(dropped)} from Dinner` }));
    await waitFor(async () => expect(within(await dinnerCard()).getByText('1 / 2 active assigned')).toBeInTheDocument());
    fireEvent.click(within(await dinnerCard()).getByRole('button', { name: /Assign a driver/ }));
    fireEvent.click(within(await dinnerCard()).getByRole('button', { name: `Assign ${name(spare)} to Dinner` }));
    await waitFor(async () => expect(within(await dinnerCard()).getByText('2 / 2 active assigned')).toBeInTheDocument());

    // Publish Rota (primary action): covered, so no warning.
    await confirmFirst();
    await screen.findByText('Rota published. Drivers can now see their assigned shifts.');
    await waitFor(() => expect(publishButton()).toHaveTextContent('Published'));
    expect(generateButton()).toBeDisabled();

    // Driver: Published + exactly their own assignment.
    const assigned = mockRotaAssignments.map((a) => a.driverId);
    const unassigned = ['mock-gianni', 'mock-maria', 'mock-pat'].find((id) => !assigned.includes(id)) as string;
    expect((await driverRota(assigned[0])).isPublished).toBe(true);
    expect((await driverRota(assigned[0])).shifts).toHaveLength(1);
    expect(await driverRota(unassigned)).toEqual({ weekStart: WEEK, isPublished: true, shifts: [] });

    // Availability locked; Auto-Rota blocked; manual edits still live for the driver.
    expect((await availability.getWeekAvailabilityStatus('mock-gianni', WEEK)).state).toBe('locked');
    expect(isAutoRotaError(await getRepositories().rota.generateAutoRota({ resortId: CRANS, weekStart: WEEK }).catch((e) => e), 'published_week')).toBe(true);
    fireEvent.click(within(await dinnerCard()).getByRole('button', { name: `Remove ${name(assigned[0])} from Dinner` }));
    await waitFor(async () => expect(within(await dinnerCard()).getByText('1 / 2 active assigned')).toBeInTheDocument());
    expect((await driverRota(assigned[0])).shifts).toEqual([]);
    expect(publishButton()).toHaveTextContent('Published');
  });
});

describe('Publish Rota: no unpublish, accessibility and architecture', () => {
  it('43. there is no Unpublish / Retract / Republish / Reopen / Make draft control or wording, draft or published', async () => {
    const pattern = /unpublish|retract|republish|publish again|make draft|reopen rota/i;
    const { unmount } = renderRota();
    await dinnerCard();
    fireEvent.click(publishButton());
    expect(document.body.textContent).not.toMatch(pattern);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    unmount();

    mockRotaPublications.push({ resortId: CRANS, weekStart: WEEK, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    renderRota();
    await dinnerCard();
    await waitFor(() => expect(publishButton()).toHaveTextContent('Published'));
    expect(document.body.textContent).not.toMatch(pattern);
    for (const source of [panelSource, uiSource, hookSource, dialogSource]) expect(source).not.toMatch(/unpublish|retract|republish/i);
  });

  it('accessible: keyboard-operable button, titled dialog, Tab stays inside, status vs alert semantics', async () => {
    renderRota();
    const d = await openDialog();
    expect(publishButton().tagName).toBe('BUTTON');
    expect(d).toHaveAttribute('aria-modal', 'true');
    const confirmBtn = within(d).getByRole('button', { name: 'Publish Rota' });
    confirmBtn.focus();
    fireEvent.keyDown(confirmBtn, { key: 'Tab' });
    expect(d.contains(document.activeElement)).toBe(true);
    fireEvent.click(confirmBtn);
    // The same labelled dialog swaps to the warning (announced via its status region); it is still the only dialog.
    await screen.findByRole('button', { name: 'Publish anyway' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(dialog()).toHaveAccessibleName('Publish rota?');
    expect(within(dialog()).getByRole('status')).toHaveTextContent('2 positions are still uncovered.');
  });

  it('41/42. the panel, hook, dialog and helper never import Supabase, call publish_rota, or know SQLSTATEs', () => {
    for (const source of [panelSource, uiSource, hookSource, dialogSource]) {
      expect(source).not.toMatch(/from\s+['"][^'"]*lib\/supabase[^'"]*['"]/);
      expect(source).not.toMatch(/from\s+['"]@supabase\//);
      expect(source).not.toMatch(/database\.generated/);
      expect(source).not.toMatch(/\.from\(\s*['"`]/);
      expect(source).not.toMatch(/publish_rota|\.rpc\(|rota_publications/);
      expect(source).not.toMatch(/VD003|VD002|VD001|55006|23514|42501|P0002|22023|\.details\b|\.code\b/);
    }
    expect(hookSource).toMatch(/getRepositories\(\)\.rota\.publishRota/);
    expect(hookSource).toMatch(/isPublishRotaConfirmationRequired/);
  });
});
