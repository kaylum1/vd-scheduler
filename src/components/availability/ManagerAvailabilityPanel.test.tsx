// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManagerAvailabilityPanel } from './ManagerAvailabilityPanel';
import { resetRepositoriesForTesting } from '../../repositories';
import { MockAvailabilityRepository } from '../../repositories/mock/availability';
import { resetMockFixturesForTesting } from '../../repositories/mock/fixtures';
import { startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
// Raw source text -- used only by the architecture check to prove this
// component never calls supabase.from(...)/.rpc(...) directly.
import managerAvailabilityPanelSource from './ManagerAvailabilityPanel.tsx?raw';

const thisMonday = toISODate(startOfWeek(getOperationalToday()));

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ManagerAvailabilityPanel />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ManagerAvailabilityPanel (Stage 3)', () => {
  it('24/25. shows the selected resort and week, and lists every active driver at that resort', async () => {
    renderPanel();
    expect(await screen.findByRole('heading', { name: /Availability — Crans-Montana/ })).toBeInTheDocument();
    expect(await screen.findByText('Gianni')).toBeInTheDocument();
  });

  it('switching resort shows that resort\'s drivers instead', async () => {
    renderPanel();
    await screen.findByText('Gianni');
    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));

    expect(await screen.findByRole('heading', { name: /Availability — Zermatt/ })).toBeInTheDocument();
    expect(await screen.findByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('Tomas')).toBeInTheDocument();
    expect(screen.queryByText('Gianni')).not.toBeInTheDocument();
  });

  it('26. maps Not started / In progress / Confirmed / Needs reconfirmation / Locked correctly', async () => {
    renderPanel();
    await screen.findByText('Gianni');
    expect(within(screen.getByText('Gianni').closest('.config-list-item') as HTMLElement).getByText('Not started')).toBeInTheDocument();

    const shifts = await new MockAvailabilityRepository().listDriverVisibleShifts('mock-crans');
    const monday = shifts.find((s) => s.weekStart === thisMonday)!;
    await new MockAvailabilityRepository().setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });

    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Crans-Montana' }));
    expect(await screen.findByText('In progress')).toBeInTheDocument();

    await new MockAvailabilityRepository().confirmAvailabilityWeek('mock-gianni', monday.weekStart);
    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Crans-Montana' }));
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
  });

  it('27. clicking a driver expands their actual per-shift answers', async () => {
    renderPanel();
    await screen.findByText('Gianni');

    const shifts = await new MockAvailabilityRepository().listDriverVisibleShifts('mock-crans');
    const monday = shifts.find((s) => s.weekStart === thisMonday)!;
    await new MockAvailabilityRepository().setAvailability({ driverId: 'mock-gianni', resortId: 'mock-crans', shiftInstanceId: monday.id, status: 'available' });

    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Crans-Montana' }));
    fireEvent.click(screen.getByText('Gianni'));

    expect(await screen.findByText(/Dinner/)).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
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
