// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import App from '../../App';
import { resetRepositoriesForTesting } from '../../repositories';
import { MockRotaRepository } from '../../repositories/mock/rota';
import {
  mockDrivers,
  mockRotaAssignments,
  mockRotaPublications,
  mockShiftTemplates,
  mockShiftTypes,
  resetMockFixturesForTesting,
} from '../../repositories/mock/fixtures';
import { addWeeks, parseISODate, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
// Raw source text for the architecture checks (32).
import pageSource from './MyRota.tsx?raw';
import hookSource from '../../components/driver-rota/useDriverWeekRota.ts?raw';
import dayComponentSource from '../../components/driver-rota/DriverRotaDay.tsx?raw';

const CRANS = 'mock-crans';
const thisMonday = toISODate(startOfWeek(getOperationalToday()));
const prevMonday = toISODate(addWeeks(parseISODate(thisMonday), -1));
const nextMonday = toISODate(addWeeks(parseISODate(thisMonday), 1));
const dinnerOn = (monday: string) => `mock-crans-dinner-tpl-${monday}`;
const lunchOn = (monday: string) => `mock-crans-lunch-tpl-${monday}`;

function publish(weekStart: string, resortId = CRANS) {
  mockRotaPublications.push({ resortId, weekStart, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
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

let queryClient: QueryClient;
async function renderMyRota() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Driver' }));
  window.location.hash = '/driver/my-rota';
  await screen.findByRole('heading', { name: 'My Rota' });
}

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('MyRotaPage (live Driver My Rota)', () => {
  it('19. shows "Loading your rota…" while the rota is being read', async () => {
    vi.spyOn(MockRotaRepository.prototype, 'getDriverWeekRota').mockReturnValue(new Promise(() => {}));
    await renderMyRota();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading your rota…');
  });

  it('20. a failed read shows an alert with a Retry, never the raw error -- and Retry recovers', async () => {
    const spy = vi.spyOn(MockRotaRepository.prototype, 'getDriverWeekRota').mockRejectedValueOnce(new Error('relation "driver_visible_assignments" PGRST301'));
    await renderMyRota();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load your rota');
    expect(alert.textContent).not.toMatch(/PGRST|relation|driver_visible/);

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Your rota for this week hasn’t been published yet.')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('21. a current, unpublished week says it has not been published yet -- with a "Not published" chip', async () => {
    assign(dinnerOn(thisMonday)); // a draft assignment must stay hidden
    await renderMyRota();
    expect(await screen.findByText('Your rota for this week hasn’t been published yet.')).toBeInTheDocument();
    expect(screen.getByText('Not published')).toBeInTheDocument();
    expect(screen.queryByText('Dinner')).not.toBeInTheDocument();
    expect(screen.queryByText("You don’t have any shifts assigned this week.")).not.toBeInTheDocument();
  });

  it('22. a PAST week that was never published says no rota was published (different copy from a current week)', async () => {
    await renderMyRota();
    await screen.findByText('Your rota for this week hasn’t been published yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('No rota was published for this week.')).toBeInTheDocument();
    expect(screen.queryByText('Your rota for this week hasn’t been published yet.')).not.toBeInTheDocument();
  });

  it('23. a published week with no own shifts says so -- a different state from unpublished', async () => {
    publish(thisMonday);
    assign(dinnerOn(thisMonday), 'mock-someone-else');
    await renderMyRota();
    expect(await screen.findByText('You don’t have any shifts assigned this week.')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.queryByText('Your rota for this week hasn’t been published yet.')).not.toBeInTheDocument();
  });

  it('24. a published week renders the driver\'s own shift: dynamic name, times, day heading, shift count', async () => {
    publish(thisMonday);
    assign(dinnerOn(thisMonday));
    await renderMyRota();

    const day = await screen.findByRole('region', { name: /Monday/i });
    expect(within(day).getByText('Dinner')).toBeInTheDocument();
    expect(within(day).getByText('18:00–21:30')).toBeInTheDocument();
    expect(screen.getByText('1 shift')).toBeInTheDocument();
  });

  it('25. several shifts on the same day are separate entries under ONE day heading, in time order', async () => {
    addLunch();
    publish(thisMonday);
    assign(dinnerOn(thisMonday));
    assign(lunchOn(thisMonday));
    await renderMyRota();

    const day = await screen.findByRole('region', { name: /Monday/i });
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1);
    const items = within(day).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Lunch12:00–14:00', 'Dinner18:00–21:30']);
    expect(screen.getByText('2 shifts')).toBeInTheDocument();
  });

  it('26. the chip reflects the REAL publication state: never "Published" for an unpublished current week', async () => {
    await renderMyRota();
    await screen.findByText('Not published');
    expect(screen.queryByText('Published')).not.toBeInTheDocument();
  });

  it('27. the fake "hours scheduled" badge is gone', async () => {
    publish(thisMonday);
    assign(dinnerOn(thisMonday));
    await renderMyRota();
    await screen.findByText('1 shift');
    expect(screen.queryByText(/hours/i)).not.toBeInTheDocument();
  });

  it('28. the fake driver/resort subtitle is gone', async () => {
    await renderMyRota();
    await screen.findByText('Not published');
    expect(document.querySelector('.page-header__subtitle')).toBeNull();
    // (The dev role switcher outside the page may name the resort; the page itself must not.)
    expect((document.querySelector('.page') as HTMLElement).textContent).not.toMatch(/Crans-Montana|Gianni/);
  });

  it('29. week navigation moves a week at a time and back to this week; each week is read separately', async () => {
    publish(nextMonday);
    assign(dinnerOn(nextMonday));
    const spy = vi.spyOn(MockRotaRepository.prototype, 'getDriverWeekRota');
    await renderMyRota();
    await screen.findByText('Your rota for this week hasn’t been published yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await screen.findByText('Dinner')).toBeInTheDocument();
    expect(spy).toHaveBeenLastCalledWith({ weekStart: nextMonday, driverId: 'mock-gianni' });

    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(await screen.findByText('Your rota for this week hasn’t been published yet.')).toBeInTheDocument();
  });

  it('30. a past published week is viewable, read-only (no action controls beyond navigation)', async () => {
    publish(prevMonday);
    assign(dinnerOn(prevMonday));
    await renderMyRota();
    await screen.findByText('Your rota for this week hasn’t been published yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    const day = await screen.findByRole('region', { name: /Monday/i });
    expect(within(day).getByText('Dinner')).toBeInTheDocument();
    expect(within(day).queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('button', { name: /assign|remove|publish|confirm|edit/i })).not.toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();
  });

  it('31. shows no manager data: no headcount, no colleagues, no availability, no pay', async () => {
    mockDrivers.push({ id: 'mock-maria', resortId: CRANS, fullName: 'Maria', isActive: true, preferredLanguage: 'en' });
    publish(thisMonday);
    assign(dinnerOn(thisMonday));
    assign(dinnerOn(thisMonday), 'mock-maria');
    await renderMyRota();
    await screen.findByText('Dinner');

    const page = document.querySelector('.page') as HTMLElement;
    expect(page.textContent).not.toMatch(/Maria|required|covered|uncovered|available|unavailable|CHF|pay|co-driver|override/i);
  });

  it('a manager removing then adding shifts on the PUBLISHED week shows on the next refetch -- no republish needed', async () => {
    addLunch();
    publish(thisMonday);
    assign(dinnerOn(thisMonday));
    await renderMyRota();
    await screen.findByText('Dinner');

    // The manager (a separate session) swaps Dinner for Lunch on the published week.
    assign(lunchOn(thisMonday));
    const idx = mockRotaAssignments.findIndex((a) => a.shiftInstanceId === dinnerOn(thisMonday));
    mockRotaAssignments.splice(idx, 1);

    // The driver returns to the app: the query is always stale, so it refetches on focus.
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(screen.queryByText('Dinner')).not.toBeInTheDocument());
    expect(screen.getByText('Lunch')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
  });

  it('keeps My Rota and Availability separate: no availability controls on My Rota, and Availability is still reachable', async () => {
    await renderMyRota();
    await screen.findByText('Not published');
    expect(screen.queryByRole('button', { name: /available|unavailable|confirm availability/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Availability' })).toBeInTheDocument();
  });

  it('32. the page, hook and day component never import Supabase or the manager surface, and read only through the repository', () => {
    for (const source of [pageSource, hookSource, dayComponentSource]) {
      expect(source).not.toMatch(/from\s+['"][^'"]*lib\/supabase[^'"]*['"]/);
      expect(source).not.toMatch(/from\s+['"]@supabase\//);
      expect(source).not.toMatch(/database\.generated/);
      expect(source).not.toMatch(/\.from\(\s*['"`]/);
      expect(source).not.toMatch(/\.rpc\(/);
      expect(source).not.toMatch(/rota_assignments|rota_publications|driver_visible/);
      expect(source).not.toMatch(/ManagerWeekRota|ManualRotaPanel|managerRotaKeys|getManagerWeekRota/);
      // The Stage 1.1 fake data this page used to depend on.
      expect(source).not.toMatch(/mock-data\/(drivers|resorts|shifts)/);
      expect(source).not.toMatch(/generateWeekShiftInstances|hoursScheduled|hours scheduled/i);
    }
    expect(hookSource).toMatch(/getRepositories\(\)\.rota\.getDriverWeekRota/);
    expect(hookSource).toMatch(/staleTime:\s*0/);
    expect(hookSource).toMatch(/refetchOnWindowFocus:\s*true/);
  });
});
