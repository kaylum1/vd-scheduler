// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { AutoRotaError } from '../../repositories/errors';
import { managerRotaKeys } from '../../repositories/queryKeys';
import { driverNavItems, managerNavItems } from '../layout/nav-config';
import type { AutoRotaResult, AvailabilityStatus } from '../../repositories/domain';
// Raw source for the architecture checks (39, 40).
import panelSource from './ManualRotaPanel.tsx?raw';
import uiSource from './autoRotaUi.ts?raw';

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
function addShift(key: string, name: string, weekday: number, required: number, resortId = CRANS) {
  mockShiftTypes.push({ id: `mock-${resortId}-${key}`, resortId, key, name, sortOrder: 5, isActive: true });
  mockShiftTemplates.push({
    id: `mock-${resortId}-${key}-tpl`, resortId, shiftTypeId: `mock-${resortId}-${key}`, weekday,
    startTime: '12:00', endTime: '14:00', requiredDrivers: required, basePayChf: null, deliveryRateChf: null, isPremium: null,
    effectiveFrom: '2024-01-01', effectiveTo: null, isActive: true, updatedAt: '2024-01-01T00:00:00.000Z',
  });
}
const publish = (week = WEEK, resortId = CRANS) => mockRotaPublications.push({ resortId, weekStart: week, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });

const generateButton = () => screen.getByRole('button', { name: /^(Generate Rota|Generating…)$/ });
const dialog = () => screen.getByRole('dialog', { name: 'Generate rota?' });
const dinnerCard = () => screen.findByRole('article', { name: /^Dinner,/ });
async function openDialog() {
  await dinnerCard();
  await waitFor(() => expect(generateButton()).toBeEnabled());
  generateButton().focus();
  fireEvent.click(generateButton());
  return dialog();
}
async function confirmGenerate() {
  const d = await openDialog();
  fireEvent.click(within(d).getByRole('button', { name: 'Generate Rota' }));
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
const result = (over: Partial<AutoRotaResult> = {}): AutoRotaResult => ({
  resortId: CRANS, weekStart: WEEK, assignedCount: 0, remainingOpenSlots: 0, uncoveredShiftIds: [], skippedPastShiftCount: 0, runId: 'run-1', ...over,
});

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
  addDriver('mock-maria', 'Maria');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Generate Rota: placement and enablement', () => {
  it('1. a Generate Rota button sits in the Manual Rota card header', async () => {
    renderRota();
    await dinnerCard();
    const header = screen.getByRole('heading', { name: 'Manual Rota' }).closest('.card__header') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'Generate Rota' })).toBeInTheDocument();
  });

  it('2. there is no separate Auto-Rota page or navigation entry -- it lives inside Rota & Availability', () => {
    for (const items of [managerNavItems, driverNavItems]) {
      expect(items.map((item) => item.label).join('|')).not.toMatch(/auto|generate/i);
    }
  });

  it('3. enabled on a draft week with a shift still to fill', async () => {
    renderRota();
    await dinnerCard();
    expect(generateButton()).toBeEnabled();
    expect(screen.queryByText(/can’t run|can’t generate|no shifts to fill/i)).not.toBeInTheDocument();
  });

  it('4/5. disabled on a PUBLISHED week, with the reason as visible text wired to the button', async () => {
    publish();
    renderRota();
    await dinnerCard();
    expect(generateButton()).toBeDisabled();
    const reason = screen.getByText('Auto-Rota can’t run after this rota has been published.');
    expect(generateButton()).toHaveAttribute('aria-describedby', reason.id);
    // Manual Rota editing is NOT disabled just because Generate is.
    expect(screen.getByRole('button', { name: /Assign a driver/ })).toBeEnabled();
  });

  it('6/7. disabled on a wholly historical week, with the reason', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-14T10:00:00Z')); // the Monday AFTER the week
    renderRota();
    await dinnerCard();
    expect(generateButton()).toBeDisabled();
    expect(screen.getByText('Auto-Rota can’t generate a historical rota.')).toBeInTheDocument();
  });

  it('8. disabled for a week with no shifts at all, and the existing empty state stays', async () => {
    renderRota({ resortId: 'mock-verbier', weekStart: WEEK, resortName: 'Verbier' });
    expect(await screen.findByText('No shifts are scheduled for this week.')).toBeInTheDocument();
    expect(generateButton()).toBeDisabled();
    expect(screen.getByText('There are no shifts to fill this week.')).toBeInTheDocument();
  });

  it('9. TODAY is not historical: a week whose only shift is today still offers Generate', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-07T10:00:00Z')); // Monday: the Dinner is today
    renderRota();
    await dinnerCard();
    expect(generateButton()).toBeEnabled();
  });

  it('10. a partially historical current week (a past shift and a future one) keeps Generate enabled, and the dialog says past shifts are left alone', async () => {
    addShift('friday', 'Friday Lunch', 4, 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-09T10:00:00Z')); // Wednesday: Monday Dinner is past, Friday Lunch is ahead
    renderRota();
    await screen.findByRole('article', { name: /^Friday Lunch,/ });
    expect(generateButton()).toBeEnabled();
    fireEvent.click(generateButton());
    expect(within(dialog()).getByText('Past shifts will not be changed.')).toBeInTheDocument();
  });

  it('no resort selected: no Generate button at all', () => {
    renderRota({ resortId: null, weekStart: WEEK });
    expect(screen.queryByRole('button', { name: /Generate Rota/ })).not.toBeInTheDocument();
  });
});

describe('Generate Rota: confirmation', () => {
  it('11/12/13. opens ONE confirmation that names the resort and the week', async () => {
    renderRota();
    const d = await openDialog();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(d).getByText('Crans-Montana')).toBeInTheDocument();
    expect(within(d).getByText('7 – 13 Jan 2030')).toBeInTheDocument();
  });

  it('14/15/16. says what Auto-Rota will do: keep existing assignments, use only Available drivers, fill open positions by the fairness rules', async () => {
    renderRota();
    const d = await openDialog();
    expect(within(d).getByText('Keep all existing assignments')).toBeInTheDocument();
    expect(within(d).getByText('Only use drivers marked Available')).toBeInTheDocument();
    expect(within(d).getByText('Fill open positions using the rota fairness rules')).toBeInTheDocument();
    expect(within(d).queryByText('Past shifts will not be changed.')).not.toBeInTheDocument(); // nothing is past here
  });

  it('17. there is NO preview: no driver names, counts, table or fairness scores before applying', async () => {
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    answer(dinnerId(WEEK), 'mock-maria', 'available');
    renderRota();
    const d = await openDialog();
    expect(d.textContent).not.toMatch(/Gianni|Maria|\d+ assignments?|predict|preview|score|will be assigned/i);
    expect(within(d).queryByRole('table')).not.toBeInTheDocument();
  });

  it('28. accessible: a titled dialog, Cancel/Generate Rota named, Escape closes, and focus returns to the Generate button', async () => {
    renderRota();
    const d = await openDialog();
    expect(within(d).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Generate Rota' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(generateButton()).toHaveFocus();
  });

  it('18. Cancel performs no mutation', async () => {
    const spy = vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota');
    renderRota();
    const d = await openDialog();
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    expect(mockRotaAssignments).toHaveLength(0);
  });
});

describe('Generate Rota: generating', () => {
  it('19. Generate calls the repository once with the selected resort and week', async () => {
    const spy = vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota');
    renderRota();
    await confirmGenerate();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith({ resortId: CRANS, weekStart: WEEK });
  });

  it('20. while generating, both buttons are disabled, the labels say Generating…, and a second click does nothing', async () => {
    const run = deferred<AutoRotaResult>();
    const spy = vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota').mockImplementationOnce(() => run.promise);
    renderRota();
    const d = await openDialog();
    const confirm = within(d).getByRole('button', { name: 'Generate Rota' });
    fireEvent.click(confirm);

    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Generating…' })).toBeDisabled());
    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // The header button (behind the modal) reads Generating… and is disabled too.
    const generatingButtons = screen.getAllByRole('button', { name: 'Generating…', hidden: true });
    expect(generatingButtons).toHaveLength(2);
    for (const b of generatingButtons) expect(b).toBeDisabled();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Generating…' }));
    fireEvent.keyDown(document, { key: 'Escape' }); // cannot dismiss a run in flight
    expect(dialog()).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);

    run.resolve(result());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(generateButton()).toHaveTextContent('Generate Rota');
    expect(generateButton()).toBeEnabled();
  });

  it('21/27. on success the manager week is invalidated and re-read, and the REAL generated assignments appear', async () => {
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    answer(dinnerId(WEEK), 'mock-maria', 'available');
    const read = vi.spyOn(MockRotaRepository.prototype, 'getManagerWeekRota');
    const { client } = renderRota();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const c = await dinnerCard();
    expect(within(c).getByText('0 / 2 active assigned')).toBeInTheDocument();
    const readsBefore = read.mock.calls.length;

    await confirmGenerate();
    await screen.findByText('2 assignments added. All scheduled positions are covered.');

    expect(invalidate).toHaveBeenCalledWith({ queryKey: managerRotaKeys.week(CRANS, WEEK) });
    expect(invalidate).toHaveBeenCalledTimes(1); // only the selected week's manager rota -- nothing broader
    expect(read.mock.calls.length).toBeGreaterThan(readsBefore);
    const after = await dinnerCard();
    expect(within(after).getByText('2 / 2 active assigned')).toBeInTheDocument();
    expect(within(after).getByText('Covered')).toBeInTheDocument();
    expect(within(after).getByText('Gianni')).toBeInTheDocument();
    expect(within(after).getByText('Maria')).toBeInTheDocument();
    // Generated rows are ordinary assignments in the UI; the domain keeps their source.
    expect(mockRotaAssignments.every((a) => a.source === 'auto')).toBe(true);
  });
});

describe('Generate Rota: result wording', () => {
  const generateWith = async (r: AutoRotaResult) => {
    vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota').mockResolvedValueOnce(r);
    renderRota();
    await confirmGenerate();
  };

  it('22. assignments added and everything covered', async () => {
    await generateWith(result({ assignedCount: 8, remainingOpenSlots: 0 }));
    expect(await screen.findByText('8 assignments added. All scheduled positions are covered.')).toBeInTheDocument();
  });

  it('22. correct singular grammar', async () => {
    await generateWith(result({ assignedCount: 1, remainingOpenSlots: 0 }));
    expect(await screen.findByText('1 assignment added. All scheduled positions are covered.')).toBeInTheDocument();
  });

  it('23/26. partial coverage: positions remain uncovered -- a SUCCESS (status, not an alert)', async () => {
    await generateWith(result({ assignedCount: 8, remainingOpenSlots: 2 }));
    const notice = await screen.findByText('8 assignments added. 2 positions remain uncovered.');
    expect(notice.closest('.inline-notice')).toHaveClass('inline-notice--success');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('23. singular: "1 position remains uncovered"', async () => {
    await generateWith(result({ assignedCount: 3, remainingOpenSlots: 1 }));
    expect(await screen.findByText('3 assignments added. 1 position remains uncovered.')).toBeInTheDocument();
  });

  it('24. zero created and fully covered', async () => {
    await generateWith(result({ assignedCount: 0, remainingOpenSlots: 0 }));
    expect(await screen.findByText('No new assignments were needed. The rota is fully covered.')).toBeInTheDocument();
  });

  it('25/26. zero created with gaps left: informational, never an error state', async () => {
    await generateWith(result({ assignedCount: 0, remainingOpenSlots: 2 }));
    const notice = await screen.findByText('No assignments could be added. 2 positions remain uncovered.');
    expect(notice.closest('.inline-notice')).toHaveClass('inline-notice--info');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('real partial coverage: only Available drivers are used and the shift stays Uncovered -- Unavailable / Not Submitted are never assigned to fill the gap', async () => {
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    answer(dinnerId(WEEK), 'mock-maria', 'unavailable'); // Dinner needs 2; Maria is Unavailable
    renderRota();
    await confirmGenerate();
    expect(await screen.findByText('1 assignment added. 1 position remains uncovered.')).toBeInTheDocument();
    const c = await dinnerCard();
    expect(within(c).getByText('1 / 2 active assigned')).toBeInTheDocument();
    expect(within(c).getByText('Uncovered')).toBeInTheDocument();
    expect(within(c).getByRole('list', { name: /Drivers assigned to/ })).not.toHaveTextContent('Maria');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // no override dialog is opened for the gap
  });

  it('the notice can be dismissed', async () => {
    await generateWith(result({ assignedCount: 2, remainingOpenSlots: 0 }));
    await screen.findByText(/2 assignments added/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/2 assignments added/)).not.toBeInTheDocument();
  });
});

describe('Generate Rota: errors', () => {
  const fail = (kind: ConstructorParameters<typeof AutoRotaError>[0], code?: string) =>
    vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota').mockRejectedValueOnce(
      new AutoRotaError(kind, { operation: 'rota.generateAutoRota', code, cause: { code, details: kind, message: `db: ${kind}` } })
    );

  it('28. published_week is shown cleanly in an alert, with the rota still visible', async () => {
    fail('published_week', '55006');
    renderRota();
    await confirmGenerate();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This rota is published, so Auto-Rota can’t change it.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await dinnerCard()).toBeInTheDocument(); // the page is not replaced by an error screen
  });

  it('29. a published race: the week was published after it loaded -> the error is shown AND the week is refetched so it now reads Published', async () => {
    const read = vi.spyOn(MockRotaRepository.prototype, 'getManagerWeekRota');
    renderRota();
    await dinnerCard();
    expect(screen.queryByText(/This rota is published/)).not.toBeInTheDocument();
    publish(); // another session publishes between load and Generate
    const readsBefore = read.mock.calls.length;
    await confirmGenerate(); // the real mock repository now refuses with published_week

    expect(await screen.findByRole('alert')).toHaveTextContent('published');
    await screen.findByText('This rota is published. Manager assignment changes are visible immediately.');
    expect(read.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(generateButton()).toBeDisabled();
    expect(mockRotaAssignments).toHaveLength(0);
  });

  it('30/31. stale_plan (after the repository\'s own retry) is shown cleanly, the week is refetched, and the manager can simply click again', async () => {
    const read = vi.spyOn(MockRotaRepository.prototype, 'getManagerWeekRota');
    fail('stale_plan', 'VD002');
    renderRota();
    await dinnerCard();
    const readsBefore = read.mock.calls.length;
    await confirmGenerate();

    expect(await screen.findByRole('alert')).toHaveTextContent('The rota changed while it was being generated. Nothing was added — please try again.');
    expect(read.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(generateButton()).toBeEnabled();
    const spy = vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota');
    fireEvent.click(generateButton()); // retry is a manual action -- there is no hidden UI retry loop
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('32. an unexpected failure shows the generic message', async () => {
    vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota').mockRejectedValueOnce(new Error('TypeError: Failed to fetch https://x/rest/v1/rpc/apply_auto_rota'));
    renderRota();
    await confirmGenerate();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong. Please try again.');
    expect(alert.textContent).not.toMatch(/fetch|rpc|apply_auto_rota|https/);
  });

  it.each(['published_week', 'historical_week', 'historical_shift', 'stale_plan', 'permission_denied', 'resort_not_found', 'invalid_week', 'invalid_plan', 'unknown'] as const)(
    '33. %s never exposes SQLSTATEs, DETAIL tokens, constraint names or PostgREST text',
    async (kind) => {
      fail(kind, 'VD002');
      renderRota();
      await confirmGenerate();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).not.toMatch(/VD002|VD001|55006|42501|P0002|22023|stale_plan|published_week|historical_|plan_malformed|PGRST|constraint|db:|apply_auto_rota/i);
      expect(alert.textContent!.length).toBeGreaterThan(10);
    }
  );

  it('a failed generation leaves existing assignments untouched and the button usable for a retry', async () => {
    mockRotaAssignments.push({ id: 'seed', shiftInstanceId: dinnerId(WEEK), driverId: 'mock-maria', resortId: CRANS, source: 'manual', assignedAt: '2030-01-01T00:00:00Z' });
    fail('unknown');
    renderRota();
    await confirmGenerate();
    await screen.findByRole('alert');
    const c = await dinnerCard();
    expect(within(c).getByText('1 / 2 active assigned')).toBeInTheDocument();
    expect(mockRotaAssignments).toHaveLength(1);
    expect(generateButton()).toBeEnabled();
  });
});

describe('Generate Rota: notice and dialog lifecycle', () => {
  async function withNotice() {
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    answer(dinnerId(WEEK), 'mock-maria', 'available');
    const utils = renderRota();
    await confirmGenerate();
    await screen.findByText(/2 assignments added/);
    return utils;
  }

  it('34. the result notice clears when the week changes', async () => {
    const { rerenderWith } = await withNotice();
    rerenderWith({ resortId: CRANS, weekStart: NEXT_WEEK, resortName: 'Crans-Montana' });
    await waitFor(() => expect(screen.queryByText(/2 assignments added/)).not.toBeInTheDocument());
  });

  it('35. the result notice clears when the resort changes (a Crans result is never shown against Zermatt)', async () => {
    const { rerenderWith } = await withNotice();
    rerenderWith({ resortId: ZERMATT, weekStart: WEEK, resortName: 'Zermatt' });
    await waitFor(() => expect(screen.queryByText(/2 assignments added/)).not.toBeInTheDocument());
  });

  it('an error notice is cleared by a selection change too', async () => {
    vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota').mockRejectedValueOnce(new AutoRotaError('unknown', { operation: 'x' }));
    const { rerenderWith } = renderRota();
    await confirmGenerate();
    await screen.findByRole('alert');
    rerenderWith({ resortId: CRANS, weekStart: NEXT_WEEK, resortName: 'Crans-Montana' });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('36. an open confirmation closes when the selection changes -- it can never submit against a stale selection', async () => {
    const spy = vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota');
    const { rerenderWith } = renderRota();
    await openDialog();
    rerenderWith({ resortId: CRANS, weekStart: NEXT_WEEK, resortName: 'Crans-Montana' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
  });

  it('a result that arrives after the manager moved to another week is not shown there (the old week is still refreshed)', async () => {
    const run = deferred<AutoRotaResult>();
    vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota').mockImplementationOnce(() => run.promise);
    const { rerenderWith, client } = renderRota();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await confirmGenerate();
    rerenderWith({ resortId: CRANS, weekStart: NEXT_WEEK, resortName: 'Crans-Montana' });
    run.resolve(result({ assignedCount: 4 }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: managerRotaKeys.week(CRANS, WEEK) }));
    expect(screen.queryByText(/4 assignments added/)).not.toBeInTheDocument();
    // ...and the new week is not stuck in a "Generating…" state.
    await screen.findByRole('article', { name: /^Dinner,/ });
    expect(generateButton()).toHaveTextContent('Generate Rota');
  });
});

describe('Generate Rota: re-running and manual edits', () => {
  it('37. the button stays "Generate Rota" after a run; re-running when fully covered is a successful zero-created result', async () => {
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    answer(dinnerId(WEEK), 'mock-maria', 'available');
    renderRota();
    await confirmGenerate();
    await screen.findByText('2 assignments added. All scheduled positions are covered.');

    expect(generateButton()).toHaveTextContent('Generate Rota');
    expect(screen.queryByRole('button', { name: /regenerate|rebuild|reset/i })).not.toBeInTheDocument();
    expect(generateButton()).toBeEnabled();

    await confirmGenerate();
    expect(await screen.findByText('No new assignments were needed. The rota is fully covered.')).toBeInTheDocument();
    expect(mockRotaAssignments).toHaveLength(2);
  });

  it('38. remove a generated assignment -> the shift is Uncovered -> Generate again fills exactly that gap', async () => {
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    answer(dinnerId(WEEK), 'mock-maria', 'available');
    renderRota();
    await confirmGenerate();
    await screen.findByText(/2 assignments added/);

    const c = await dinnerCard();
    fireEvent.click(within(c).getByRole('button', { name: 'Remove Maria from Dinner' }));
    await waitFor(async () => expect(within(await dinnerCard()).getByText('1 / 2 active assigned')).toBeInTheDocument());
    expect(within(await dinnerCard()).getByText('Uncovered')).toBeInTheDocument();

    await confirmGenerate();
    expect(await screen.findByText('1 assignment added. All scheduled positions are covered.')).toBeInTheDocument();
    const again = await dinnerCard();
    expect(within(again).getByText('2 / 2 active assigned')).toBeInTheDocument();
    expect(within(again).getByText('Maria')).toBeInTheDocument();
  });

  it('manual edits after generation use the ordinary controls and are respected by the next run (no special rule for auto rows)', async () => {
    addDriver('mock-sam', 'Sam');
    answer(dinnerId(WEEK), 'mock-gianni', 'available');
    answer(dinnerId(WEEK), 'mock-maria', 'available');
    answer(dinnerId(WEEK), 'mock-sam', 'available');
    renderRota();
    await confirmGenerate();
    await screen.findByText(/2 assignments added/);

    let c = await dinnerCard();
    const generated = mockRotaAssignments.map((a) => a.driverId);
    const sam = generated.includes('mock-sam');
    const removable = sam ? 'Sam' : generated.includes('mock-maria') ? 'Maria' : 'Gianni';
    fireEvent.click(within(c).getByRole('button', { name: `Remove ${removable} from Dinner` }));
    await waitFor(async () => expect(within(await dinnerCard()).getByText('1 / 2 active assigned')).toBeInTheDocument());

    // The manager manually adds an Available driver instead of letting Auto-Rota refill.
    c = await dinnerCard();
    fireEvent.click(within(c).getByRole('button', { name: /Assign a driver/ }));
    const manualDriver = ['Gianni', 'Maria', 'Sam'].find((n) => !generated.map((id) => id.replace('mock-', '')).includes(n.toLowerCase()) || n === removable) as string;
    fireEvent.click(within(c).getByRole('button', { name: `Assign ${manualDriver} to Dinner` }));
    await waitFor(async () => expect(within(await dinnerCard()).getByText('2 / 2 active assigned')).toBeInTheDocument());

    await confirmGenerate();
    expect(await screen.findByText('No new assignments were needed. The rota is fully covered.')).toBeInTheDocument();
    expect(mockRotaAssignments.some((a) => a.source === 'manual')).toBe(true);
  });
});

describe('Generate Rota: architecture', () => {
  it('39. the panel and its helpers never import Supabase', () => {
    for (const source of [panelSource, uiSource]) {
      expect(source).not.toMatch(/from\s+['"][^'"]*lib\/supabase[^'"]*['"]/);
      expect(source).not.toMatch(/from\s+['"]@supabase\//);
      expect(source).not.toMatch(/database\.generated/);
      expect(source).not.toMatch(/\.from\(\s*['"`]/);
    }
  });

  it('40. React never calls apply_auto_rota, builds the planner, or knows SQLSTATEs', () => {
    for (const source of [panelSource, uiSource]) {
      expect(source).not.toMatch(/apply_auto_rota|\.rpc\(/);
      expect(source).not.toMatch(/autoRotaPlanner|buildAutoRotaPlan|autoRotaOrchestration/);
      expect(source).not.toMatch(/VD002|VD001|55006|42501|P0002|22023|\.details\b|\.code\b/);
      expect(source).not.toMatch(/rota_assignments/);
    }
    expect(panelSource).toMatch(/getRepositories\(\)\.rota\.generateAutoRota/);
  });
});
