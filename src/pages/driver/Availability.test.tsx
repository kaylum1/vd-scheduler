// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../App';
import { resetRepositoriesForTesting, getRepositories } from '../../repositories';
import {
  mockAvailabilitySubmissions,
  mockRotaPublications,
  resetMockFixturesForTesting,
} from '../../repositories/mock/fixtures';
import { MockAvailabilityRepository } from '../../repositories/mock/availability';
import { MockShiftConfigurationRepository } from '../../repositories/mock/shiftConfiguration';
import { startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
// Raw source text -- used only by the architecture check (test 29) to prove
// this page never calls supabase.from(...)/.rpc(...) directly.
import availabilityPageSource from './Availability.tsx?raw';

const thisMonday = toISODate(startOfWeek(getOperationalToday()));

async function renderAsDriver() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  );
  const driverTab = await screen.findByRole('tab', { name: 'Driver' });
  fireEvent.click(driverTab);
  window.location.hash = '/driver/availability';
  await screen.findByRole('heading', { name: 'Availability' });
}

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
  window.location.hash = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('AvailabilityPage (Stage 3, driver, live data)', () => {
  it('1. renders a real, live shift_instance dynamically -- name/time come from the repository, not a hard-coded label', async () => {
    await renderAsDriver();
    expect(await screen.findByText('Dinner')).toBeInTheDocument();
    expect(screen.getByText('18:00–21:30')).toBeInTheDocument();
  });

  it('2. a newly-created Shift with a name that has never existed before appears too -- no hard-coded Lunch/Dinner assumption', async () => {
    await new MockShiftConfigurationRepository().createShift('mock-crans', {
      name: 'Breakfast Rush',
      startTime: '07:00',
      endTime: '09:00',
      weekdays: [0],
      requiredDrivers: 1,
      effectiveFrom: '2024-01-01',
    });
    await renderAsDriver();
    expect(await screen.findByText('Breakfast Rush')).toBeInTheDocument();
  });

  it('3. only the driver\'s own resort\'s shifts are ever fetched -- never another resort\'s', async () => {
    const spy = vi.spyOn(MockAvailabilityRepository.prototype, 'listDriverVisibleShifts');
    await renderAsDriver();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // Gianni belongs to mock-crans -- every call must be scoped to it, never mock-zermatt.
    for (const call of spy.mock.calls) {
      expect(call[0]).toBe('mock-crans');
    }
  });

  it('4. clicking Available saves through the repository', async () => {
    const spy = vi.spyOn(MockAvailabilityRepository.prototype, 'setAvailability');
    await renderAsDriver();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /^(✓ )?Available$/ }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ status: 'available' })));
    expect(await screen.findByText('1 of 1 answered')).toBeInTheDocument();
  });

  it('5. clicking Unavailable saves through the repository', async () => {
    await renderAsDriver();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /^(✓ )?Unavailable$/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Unavailable/ })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('6. an unanswered shift shows "Not answered" -- never a stored third status', async () => {
    await renderAsDriver();
    await screen.findByText('Dinner');
    expect(screen.getByRole('button', { name: /^(✓ )?Available$/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /^(✓ )?Unavailable$/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('7/8. partial answers persist and the progress count is correct across two shifts', async () => {
    await new MockShiftConfigurationRepository().createShift('mock-crans', {
      name: 'Lunch',
      startTime: '12:00',
      endTime: '14:00',
      weekdays: [0],
      requiredDrivers: 1,
      effectiveFrom: '2024-01-01',
    });
    await renderAsDriver();
    await screen.findByText('Dinner');
    expect(await screen.findByText('0 of 2 answered')).toBeInTheDocument();

    const dinnerCard = screen.getByText('Dinner').closest('.avail-cell--row') as HTMLElement;
    fireEvent.click(within(dinnerCard).getByRole('button', { name: /^(✓ )?Available$/ }));

    expect(await screen.findByText('1 of 2 answered')).toBeInTheDocument();
    // Lunch remains genuinely unanswered -- not silently paired with Dinner's answer.
    const lunchCard = screen.getByText('Lunch').closest('.avail-cell--row') as HTMLElement;
    expect(within(lunchCard).getByRole('button', { name: /^(✓ )?Available$/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('9. Confirm is disabled while incomplete, with a clear reason shown', async () => {
    await renderAsDriver();
    await screen.findByText('Dinner');
    expect(screen.getByRole('button', { name: 'Confirm availability' })).toBeDisabled();
    expect(screen.getByText(/Answer all shifts before confirming/i)).toBeInTheDocument();
  });

  it('10/11. confirming succeeds once every shift is answered, and the confirmed state is shown', async () => {
    await renderAsDriver();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /^(✓ )?Available$/ }));
    await screen.findByText('1 of 1 answered');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm availability' }));

    expect(await screen.findByText('Availability confirmed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen availability' })).toBeInTheDocument();
  });

  it('12/13. reopening (available before publication) preserves prior answers and returns to an editable state', async () => {
    await renderAsDriver();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /^(✓ )?Available$/ }));
    await screen.findByText('1 of 1 answered');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm availability' }));
    await screen.findByText('Availability confirmed');

    fireEvent.click(screen.getByRole('button', { name: 'Reopen availability' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^(✓ )?Available$/ })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^(✓ )?Available$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Confirm availability' })).toBeInTheDocument();
  });

  it('14/17. a stale (system-reopened) confirmation shows "needs reconfirmation" -- whether the underlying cause was a time change or a new/reinstated shift', async () => {
    await renderAsDriver();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /^(✓ )?Available$/ }));
    await screen.findByText('1 of 1 answered');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm availability' }));
    await screen.findByText('Availability confirmed');

    // Simulate what the DB's shift_instances_reopen_stale_confirmations
    // trigger would have done for a genuine start_time change (mock mode
    // has no real trigger -- shift instances are generated fresh from
    // templates, never persisted -- so this fabricates the resulting
    // submission state directly, exactly the way other mock tests
    // fabricate a specific data state).
    const submission = mockAvailabilitySubmissions.find((s) => s.driverId === 'mock-gianni' && s.weekStart === thisMonday)!;
    submission.submittedAt = null;
    submission.reopenedReason = 'shift_time_changed';

    // Mock mode has no live trigger pushing this update to an already-
    // mounted page -- simulate the driver reopening the page fresh (a full
    // remount forces every query to refetch against the now-stale fixture).
    cleanup();
    await renderAsDriver();

    expect(await screen.findByText(/needs reconfirmation/i)).toBeInTheDocument();
    expect(screen.getByText(/scheduled shifts have changed/i)).toBeInTheDocument();
    // Stale means editable again, not locked.
    expect(screen.getByRole('button', { name: /^(✓ )?Available$/ })).toBeInTheDocument();
  });

  it('15. a Shift added after confirmation shows up unanswered, without silently pre-answering it', async () => {
    await renderAsDriver();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /^(✓ )?Available$/ }));
    await screen.findByText('1 of 1 answered');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm availability' }));
    await screen.findByText('Availability confirmed');

    await new MockShiftConfigurationRepository().createShift('mock-crans', {
      name: 'Late Addition',
      startTime: '10:00',
      endTime: '11:00',
      weekdays: [0],
      requiredDrivers: 1,
      effectiveFrom: '2024-01-01',
    });
    // Simulate the real DB's shift_added trigger reopening the stale
    // confirmation (mock mode has no live trigger -- see identityBridge/
    // fixtures doc comments for why mock tests fabricate this directly).
    const submission = mockAvailabilitySubmissions.find((s) => s.driverId === 'mock-gianni' && s.weekStart === thisMonday)!;
    submission.submittedAt = null;
    submission.reopenedReason = 'shift_added';

    // Simulate the driver returning to the page later, after the manager's
    // change -- a full remount forces every query to refetch.
    cleanup();
    await renderAsDriver();

    expect(await screen.findByText(/needs reconfirmation/i)).toBeInTheDocument();
    expect(await screen.findByText('Late Addition')).toBeInTheDocument();
    const newCard = screen.getByText('Late Addition').closest('.avail-cell--row') as HTMLElement;
    expect(within(newCard).getByRole('button', { name: /^(✓ )?Available$/ })).toHaveAttribute('aria-pressed', 'false');
    // The prior answer is retained, not wiped by the staleness event.
    const dinnerCard = screen.getByText('Dinner').closest('.avail-cell--row') as HTMLElement;
    expect(within(dinnerCard).getByRole('button', { name: /^(✓ )?Available$/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('16. required_drivers is never part of the driver-safe payload -- a staffing-only change has nothing to leak through', async () => {
    const shifts = await getRepositories().availability.listDriverVisibleShifts('mock-crans');
    expect(shifts.length).toBeGreaterThan(0);
    for (const shift of shifts) {
      expect(shift).not.toHaveProperty('requiredDrivers');
      expect(shift).not.toHaveProperty('isPremium');
    }
  });

  it('18. a published week is shown read-only -- locked, no toggles, no reopen', async () => {
    mockRotaPublications.push({
      resortId: 'mock-crans',
      weekStart: thisMonday,
      publishedAt: new Date().toISOString(),
      unpublishedAt: null,
    });
    await renderAsDriver();

    expect(await screen.findByText('Availability locked')).toBeInTheDocument();
    expect(screen.getByText(/rota for this week has been published/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(✓ )?Available$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen availability' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm availability' })).not.toBeInTheDocument();
  });

  it('19. multiple shifts the same day are answered independently', async () => {
    await new MockShiftConfigurationRepository().createShift('mock-crans', {
      name: 'Morning Prep',
      startTime: '08:00',
      endTime: '10:00',
      weekdays: [0],
      requiredDrivers: 1,
      effectiveFrom: '2024-01-01',
    });
    await renderAsDriver();
    await screen.findByText('Dinner');
    await screen.findByText('Morning Prep');

    const morningCard = screen.getByText('Morning Prep').closest('.avail-cell--row') as HTMLElement;
    fireEvent.click(within(morningCard).getByRole('button', { name: /^(✓ )?Available$/ }));

    await waitFor(() => expect(within(morningCard).getByRole('button', { name: /^(✓ )?Available$/ })).toHaveAttribute('aria-pressed', 'true'));
    const dinnerCard = screen.getByText('Dinner').closest('.avail-cell--row') as HTMLElement;
    expect(within(dinnerCard).getByRole('button', { name: /^(✓ )?Available$/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('20. a week with nothing scheduled shows a clean empty state, never a fabricated row', async () => {
    // Deactivate the only Shift at mock-crans so this week has none.
    await new MockShiftConfigurationRepository().deactivateShift('mock-crans-dinner', 'mock-crans', '2024-01-01');
    await renderAsDriver();

    expect(await screen.findByText('No shifts are scheduled for this week.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm availability' })).not.toBeInTheDocument();
  });

  it('21. a driver session only ever reads/writes its own driverId -- never another driver\'s', async () => {
    const listSpy = vi.spyOn(MockAvailabilityRepository.prototype, 'listAvailability');
    const setSpy = vi.spyOn(MockAvailabilityRepository.prototype, 'setAvailability');
    await renderAsDriver();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /^(✓ )?Available$/ }));

    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    for (const call of listSpy.mock.calls) expect(call[0].driverId).toBe('mock-gianni');
    for (const call of setSpy.mock.calls) expect(call[0].driverId).toBe('mock-gianni');
  });

  it('22. required drivers / headcount is never shown to the driver', async () => {
    await renderAsDriver();
    await screen.findByText('Dinner');
    expect(screen.queryByText(/\d+\s*drivers?\s*required/i)).not.toBeInTheDocument();
  });

  it('23. no High-value/Premium exposure anywhere on the page', async () => {
    await renderAsDriver();
    await screen.findByText('Dinner');
    expect(screen.queryByText(/high-value/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/premium/i)).not.toBeInTheDocument();
  });

  it('29. never calls supabase.from(...) or .rpc(...) directly -- only getRepositories()', () => {
    expect(availabilityPageSource).not.toMatch(/supabase\s*\.\s*from\(/);
    expect(availabilityPageSource).not.toMatch(/\.rpc\(/);
    expect(availabilityPageSource).toMatch(/getRepositories\(\)/);
  });
});
