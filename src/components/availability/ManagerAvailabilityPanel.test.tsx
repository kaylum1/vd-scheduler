// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManagerAvailabilityPanel } from './ManagerAvailabilityPanel';
import { resetRepositoriesForTesting } from '../../repositories';
import { MockAvailabilityRepository } from '../../repositories/mock/availability';
import { resetMockFixturesForTesting } from '../../repositories/mock/fixtures';
import { addDays, parseISODate, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
// Raw source text -- used only by the architecture checks to prove this
// component never calls supabase.from(...)/.rpc(...) directly, and keeps no
// resort/week selection of its own.
import managerAvailabilityPanelSource from './ManagerAvailabilityPanel.tsx?raw';

const thisMonday = toISODate(startOfWeek(getOperationalToday()));

type PanelProps = React.ComponentProps<typeof ManagerAvailabilityPanel>;

function renderPanel(props: PanelProps = { resortId: 'mock-crans', weekStart: thisMonday }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (p: PanelProps) => (
    <QueryClientProvider client={client}>
      <ManagerAvailabilityPanel {...p} />
    </QueryClientProvider>
  );
  const utils = render(tree(props));
  return { ...utils, rerenderWith: (p: PanelProps) => utils.rerender(tree(p)) };
}

async function mondayShift() {
  const shifts = await new MockAvailabilityRepository().listDriverVisibleShifts('mock-crans');
  return shifts.find((s) => s.weekStart === thisMonday)!;
}

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ManagerAvailabilityPanel (prop-driven: resort + week come from the page)', () => {
  it('24/25. shows the supplied resort, and lists every active driver at that resort', async () => {
    renderPanel();
    expect(await screen.findByRole('heading', { name: /Availability — Crans-Montana/ })).toBeInTheDocument();
    expect(await screen.findByText('Gianni')).toBeInTheDocument();
  });

  it('follows the resort prop -- a different resort shows that resort\'s drivers instead', async () => {
    const { rerenderWith } = renderPanel();
    await screen.findByText('Gianni');

    rerenderWith({ resortId: 'mock-zermatt', weekStart: thisMonday });

    expect(await screen.findByRole('heading', { name: /Availability — Zermatt/ })).toBeInTheDocument();
    expect(await screen.findByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('Tomas')).toBeInTheDocument();
    expect(screen.queryByText('Gianni')).not.toBeInTheDocument();
  });

  it('follows the week prop -- a different week is queried and shown', async () => {
    const monday = await mondayShift();
    await new MockAvailabilityRepository().setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });
    const { rerenderWith } = renderPanel();
    expect(await screen.findByText('In progress')).toBeInTheDocument();

    // Next week: Gianni has answered nothing there.
    rerenderWith({ resortId: 'mock-crans', weekStart: toISODate(addDays(parseISODate(thisMonday), 7)) });
    expect(await screen.findByText('Not started')).toBeInTheDocument();
  });

  it('keeps NO selection state of its own: no resort selector and no week navigation inside the panel', async () => {
    renderPanel();
    await screen.findByText('Gianni');
    expect(screen.queryByRole('tablist', { name: 'Choose resort' })).not.toBeInTheDocument();
    expect(screen.queryByText('Choose resort')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous week' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next week' })).not.toBeInTheDocument();
    // It may READ the shared resorts query (to show the resort's name) but must
    // not render a selector/week nav or hold selection state of its own.
    expect(managerAvailabilityPanelSource).not.toMatch(/<ResortSelector|<WeekNav|useActiveResortSelection/);
  });

  it('with no resort chosen yet, asks the manager to choose one (and fetches nothing)', () => {
    renderPanel({ resortId: null, weekStart: thisMonday });
    expect(screen.getByText('Choose a resort to see driver availability.')).toBeInTheDocument();
  });

  it('26. maps Not started / In progress / Confirmed correctly', async () => {
    const { unmount } = renderPanel();
    await screen.findByText('Gianni');
    expect(within(screen.getByText('Gianni').closest('.config-list-item') as HTMLElement).getByText('Not started')).toBeInTheDocument();
    unmount();

    const monday = await mondayShift();
    await new MockAvailabilityRepository().setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });
    const second = renderPanel();
    expect(await screen.findByText('In progress')).toBeInTheDocument();
    second.unmount();

    await new MockAvailabilityRepository().confirmAvailabilityWeek('mock-gianni', monday.weekStart);
    renderPanel();
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
  });

  it('27. clicking a driver expands their actual per-shift answers', async () => {
    const monday = await mondayShift();
    await new MockAvailabilityRepository().setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });
    renderPanel();

    fireEvent.click(await screen.findByText('Gianni'));

    expect(await screen.findByText(/Dinner/)).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('an expanded driver collapses when the resort or week changes (it belongs to one resort + week)', async () => {
    const monday = await mondayShift();
    await new MockAvailabilityRepository().setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });
    const { rerenderWith } = renderPanel();
    fireEvent.click(await screen.findByText('Gianni'));
    expect(await screen.findByText(/Dinner/)).toBeInTheDocument();

    rerenderWith({ resortId: 'mock-zermatt', weekStart: thisMonday });
    await screen.findByText('Alex');
    expect(screen.queryByText(/Dinner ·/)).not.toBeInTheDocument();
    rerenderWith({ resortId: 'mock-crans', weekStart: thisMonday });
    await screen.findByText('Gianni');
    expect(screen.getByRole('button', { name: /Gianni/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows a loading state, then an error message if the query fails', async () => {
    vi.spyOn(MockAvailabilityRepository.prototype, 'listAvailabilitySubmissionStatus').mockRejectedValue(new Error('boom'));
    renderPanel();
    expect(screen.getByText('Loading availability…')).toBeInTheDocument();
    expect(await screen.findByText(/Couldn't load availability/)).toBeInTheDocument();
  });

  it('shows the empty state for a resort with no active drivers', async () => {
    renderPanel({ resortId: 'mock-verbier', weekStart: thisMonday });
    expect(await screen.findByText('No active drivers at this resort.')).toBeInTheDocument();
  });

  it('28. no assignment/Auto-Rota/Publish controls are rendered by this panel', async () => {
    renderPanel();
    await screen.findByText('Gianni');
    expect(screen.queryByRole('button', { name: /assign/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /auto-rota/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
  });

  it('29. never calls supabase.from(...) or .rpc(...) directly -- only getRepositories()', () => {
    expect(managerAvailabilityPanelSource).not.toMatch(/supabase\s*\.\s*from\(/);
    expect(managerAvailabilityPanelSource).not.toMatch(/\brpc\(/);
    expect(managerAvailabilityPanelSource).toMatch(/getRepositories\(\)/);
  });

  it('does not show a driver at a different resort even when both resorts have data', async () => {
    renderPanel();
    await screen.findByText('Gianni');
    expect(screen.queryByText('Alex')).not.toBeInTheDocument();
    expect(screen.queryByText('Tomas')).not.toBeInTheDocument();
  });
});
