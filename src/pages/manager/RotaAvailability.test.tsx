// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { RotaAvailabilityPage } from './RotaAvailability';
import { resetRepositoriesForTesting } from '../../repositories';
import { MockRotaRepository } from '../../repositories/mock/rota';
import { MockAvailabilityRepository } from '../../repositories/mock/availability';
import { mockRotaPublications, resetMockFixturesForTesting } from '../../repositories/mock/fixtures';
import { addDays, startOfWeek, toISODate } from '../../mock-data/date-utils';
import { getOperationalToday } from '../../lib/operationalTime';
import rotaAvailabilitySource from './RotaAvailability.tsx?raw';

const thisMonday = toISODate(startOfWeek(getOperationalToday()));
const nextMonday = toISODate(addDays(startOfWeek(getOperationalToday()), 7));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RotaAvailabilityPage />
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

describe('RotaAvailabilityPage: one shared resort + week context', () => {
  it('has exactly ONE resort selector and ONE week navigator for the whole page', async () => {
    renderPage();
    await screen.findByRole('article', { name: /^Dinner,/ });
    expect(screen.getAllByRole('tablist', { name: 'Choose resort' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Previous week' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Next week' })).toHaveLength(1);
  });

  it('shows the Manual Rota and the Availability panels together, for the same default resort', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Manual Rota' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /Availability — Crans-Montana/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Crans-Montana' })).toHaveAttribute('aria-selected', 'true');
  });

  it('changing the resort updates BOTH panels to that resort', async () => {
    const rotaRead = vi.spyOn(MockRotaRepository.prototype, 'getManagerWeekRota');
    const availabilityRead = vi.spyOn(MockAvailabilityRepository.prototype, 'listAvailabilitySubmissionStatus');
    renderPage();
    await screen.findByRole('heading', { name: /Availability — Crans-Montana/ });

    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));

    expect(await screen.findByRole('heading', { name: /Availability — Zermatt/ })).toBeInTheDocument();
    await waitFor(() => expect(rotaRead).toHaveBeenCalledWith({ resortId: 'mock-zermatt', weekStart: thisMonday }));
    await waitFor(() => expect(availabilityRead).toHaveBeenCalledWith('mock-zermatt', thisMonday));
    // The Availability panel now lists Zermatt's drivers.
    expect(await screen.findByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('Tomas')).toBeInTheDocument();
  });

  it('changing the week updates BOTH panels to that same week', async () => {
    const rotaRead = vi.spyOn(MockRotaRepository.prototype, 'getManagerWeekRota');
    const availabilityRead = vi.spyOn(MockAvailabilityRepository.prototype, 'listAvailabilitySubmissionStatus');
    renderPage();
    await screen.findByRole('heading', { name: /Availability — Crans-Montana/ });

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));

    await waitFor(() => expect(rotaRead).toHaveBeenCalledWith({ resortId: 'mock-crans', weekStart: nextMonday }));
    await waitFor(() => expect(availabilityRead).toHaveBeenCalledWith('mock-crans', nextMonday));
    // ...and "This week" returns both to the current week.
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    await waitFor(() => expect(rotaRead).toHaveBeenLastCalledWith({ resortId: 'mock-crans', weekStart: thisMonday }));
    await waitFor(() => expect(availabilityRead).toHaveBeenLastCalledWith('mock-crans', thisMonday));
  });

  it('returning to a week you already viewed re-reads it, so availability a driver changed in the meantime is current', async () => {
    const rotaRead = vi.spyOn(MockRotaRepository.prototype, 'getManagerWeekRota');
    renderPage();
    await screen.findByRole('article', { name: /^Dinner,/ });
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(rotaRead).toHaveBeenCalledWith({ resortId: 'mock-crans', weekStart: nextMonday }));
    const before = rotaRead.mock.calls.filter(([p]) => p.weekStart === thisMonday).length;

    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    // The cached copy shows immediately; a fresh read follows (the app-wide 30s staleTime does NOT apply here).
    await waitFor(() => expect(rotaRead.mock.calls.filter(([p]) => p.weekStart === thisMonday).length).toBe(before + 1));
  });

  it('fetches the manager rota for the selected week ONCE -- the page indicator and the panel share one query', async () => {
    const rotaRead = vi.spyOn(MockRotaRepository.prototype, 'getManagerWeekRota');
    renderPage();
    await screen.findByRole('article', { name: /^Dinner,/ });
    const callsForThisWeek = rotaRead.mock.calls.filter(([p]) => p.resortId === 'mock-crans' && p.weekStart === thisMonday);
    expect(callsForThisWeek).toHaveLength(1);
  });
});

describe('RotaAvailabilityPage: the Stage 1.1 mock preview is gone', () => {
  it('has no "Rota (preview)", no demo-data notice, and no mock resort sections', async () => {
    renderPage();
    await screen.findByRole('article', { name: /^Dinner,/ });
    expect(screen.queryByText(/Rota \(preview\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Stage 1\.1 demo data/)).not.toBeInTheDocument();
    expect(screen.queryByText(/future checkpoint/i)).not.toBeInTheDocument();
    // The old preview rendered one section per resort, all at once.
    expect(screen.queryByRole('heading', { name: 'Zermatt', level: 2 })).not.toBeInTheDocument();
  });

  it('has no fake "current week is published" logic and no dead Publish button', async () => {
    renderPage();
    await screen.findByRole('article', { name: /^Dinner,/ });
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    expect(rotaAvailabilitySource).not.toMatch(/isCurrentWeek|Publish rota|ResortWeekSection|mock-data\/resorts|Rota \(preview\)/);
  });

  it('shows the REAL publication state: Draft by default, Published once the week is published', async () => {
    const { unmount } = renderPage();
    await screen.findByRole('article', { name: /^Dinner,/ });
    const nav = document.querySelector('.week-nav') as HTMLElement;
    expect(await within(nav).findByText('Draft')).toBeInTheDocument();
    expect(within(nav).queryByText('Published')).not.toBeInTheDocument();
    unmount();

    mockRotaPublications.push({ resortId: 'mock-crans', weekStart: thisMonday, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    renderPage();
    await screen.findByRole('article', { name: /^Dinner,/ });
    const nav2 = document.querySelector('.week-nav') as HTMLElement;
    expect(await within(nav2).findByText('Published')).toBeInTheDocument();
    expect(screen.getByText(/This rota is published\./)).toBeInTheDocument();
  });

  it('the publication indicator follows the selected week (a different week is a Draft)', async () => {
    mockRotaPublications.push({ resortId: 'mock-crans', weekStart: thisMonday, publishedAt: '2030-01-01T00:00:00Z', unpublishedAt: null });
    renderPage();
    const nav = () => document.querySelector('.week-nav') as HTMLElement;
    expect(await within(nav()).findByText('Published')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await within(nav()).findByText('Draft')).toBeInTheDocument();
  });
});

describe('RotaAvailabilityPage: manager-only live rota', () => {
  it('lets the manager assign through the page, end to end, against the mock repository', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    const card = await screen.findByRole('article', { name: /^Dinner,/ });
    fireEvent.click(within(card).getByRole('button', { name: /Assign a driver/ }));
    fireEvent.click(within(card).getByRole('button', { name: 'Assign Gianni to Dinner' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Assign anyway' })); // Not Submitted -> confirm
    expect(await within(card).findByRole('button', { name: 'Remove Gianni from Dinner' })).toBeInTheDocument();
    expect(within(card).getByText('1 / 2 active assigned')).toBeInTheDocument();
  });
});

describe('RotaAvailabilityPage: Generate Rota (Auto-Rota)', () => {
  it('names the SELECTED resort and week in the confirmation, follows resort changes, and Generate does not touch the Availability panel\'s data', async () => {
    const availabilityRead = vi.spyOn(MockAvailabilityRepository.prototype, 'listAvailabilitySubmissionStatus');
    const generate = vi.spyOn(MockRotaRepository.prototype, 'generateAutoRota');
    renderPage();
    await screen.findByRole('heading', { name: /Availability — Crans-Montana/ });
    fireEvent.click(screen.getByRole('button', { name: 'Next week' })); // next week always has its Monday Dinner still ahead
    await screen.findByRole('article', { name: /^Dinner,/ });

    fireEvent.click(await screen.findByRole('button', { name: 'Generate Rota' }));
    const dialog = screen.getByRole('dialog', { name: 'Generate rota?' });
    expect(within(dialog).getByText('Crans-Montana')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // A different resort: the dialog names that one.
    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));
    await screen.findByRole('heading', { name: /Availability — Zermatt/ });
    const zermattButton = await screen.findByRole('button', { name: 'Generate Rota' });
    await waitFor(() => expect(zermattButton).toBeEnabled());
    fireEvent.click(zermattButton);
    expect(within(screen.getByRole('dialog', { name: 'Generate rota?' })).getByText('Zermatt')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    // Confirming runs ONE generation and re-reads only the manager rota -- availability answers are not part of it.
    fireEvent.click(screen.getByRole('button', { name: 'Generate Rota' }));
    const readsBefore = availabilityRead.mock.calls.length;
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Generate Rota' }));
    await screen.findByText(/No assignments could be added|No new assignments were needed|assignments? added/);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(availabilityRead.mock.calls.length).toBe(readsBefore);
    expect(screen.getAllByRole('button', { name: 'Generate Rota' })).toHaveLength(1); // one control on the whole page
  });

  it('a result notice does not follow the manager to another week', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Availability — Crans-Montana/ });
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Generate Rota' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Generate Rota' }));
    await screen.findByText(/No assignments could be added|No new assignments were needed|assignments? added/);

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(screen.queryByText(/No assignments could be added|No new assignments were needed|assignments? added/)).not.toBeInTheDocument());
  });
});
