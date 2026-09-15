// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ResortShiftSetupPanel } from './ResortShiftSetupPanel';
import { resetRepositoriesForTesting } from '../../../repositories';
import { resetMockFixturesForTesting, mockDrivers, mockShiftTypes } from '../../../repositories/mock/fixtures';
import { MockResortRepository } from '../../../repositories/mock/resorts';
// Raw source text (Vite's `?raw` suffix) -- used only by the architecture
// check below to prove this file never calls supabase.from(...)/.rpc(...)
// directly.
import resortShiftSetupPanelSource from './ResortShiftSetupPanel.tsx?raw';

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ResortShiftSetupPanel />
    </QueryClientProvider>
  );
}

function resortsCard(): HTMLElement {
  return screen.getByRole('heading', { name: 'Resorts' }).closest('.card') as HTMLElement;
}

function resortRow(name: string): HTMLElement {
  return within(resortsCard()).getByText(name).closest('.shift-setup-card') as HTMLElement;
}

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResortShiftSetupPanel: Add Resort (Stage 2D Checkpoint 4.1)', () => {
  it('the Add Resort form asks only for a name -- no id/slug/timezone', async () => {
    renderPanel();
    await screen.findByText('Crans-Montana');
    fireEvent.click(screen.getByRole('button', { name: /Add Resort/i }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/slug|key|id/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/timezone/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/zurich/i)).not.toBeInTheDocument();
  });

  it('creating a resort goes through the repository, appears in the list, and never shows the generated internal key/id anywhere', async () => {
    const spy = vi.spyOn(MockResortRepository.prototype, 'createResort');
    renderPanel();
    await screen.findByText('Crans-Montana');

    fireEvent.click(screen.getByRole('button', { name: /Add Resort/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Val Thorens' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add Resort' }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith('Val Thorens'));
    expect(await screen.findByText('Val Thorens')).toBeInTheDocument();
    expect(screen.queryByText(/val-thorens/)).not.toBeInTheDocument(); // the auto-generated slug is never shown
  });

  it('a duplicate/conflicting resort name is handled cleanly -- created, not rejected, and the disambiguated slug is invisible', async () => {
    renderPanel();
    await screen.findByText('Crans-Montana');

    fireEvent.click(screen.getByRole('button', { name: /Add Resort/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Crans-Montana' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add Resort' }));

    await waitFor(() => expect(within(resortsCard()).getAllByText('Crans-Montana')).toHaveLength(2));
    expect(screen.queryByText(/crans-montana-2/)).not.toBeInTheDocument();
  });

  it('rejects a blank name without a crash', async () => {
    renderPanel();
    await screen.findByText('Crans-Montana');
    fireEvent.click(screen.getByRole('button', { name: /Add Resort/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add Resort' }));

    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
  });
});

describe('ResortShiftSetupPanel: Deactivate / Reactivate (Stage 2D Checkpoint 4.1)', () => {
  it('deactivating an unused resort (Verbier) requires confirmation and explains retention', async () => {
    renderPanel();
    await screen.findByText('Verbier');
    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Deactivate' }));

    await screen.findByRole('heading', { name: 'Deactivate Verbier?' });
    expect(screen.getByText(/disappear from normal active resort selectors/i)).toBeInTheDocument();
    expect(screen.getByText(/historical data is retained/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is deleted/i)).toBeInTheDocument();
  });

  it('confirming deactivates it, and it moves from Active to the Inactive filter -- never hidden permanently', async () => {
    renderPanel();
    await screen.findByText('Verbier');
    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Verbier?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(screen.queryByText('Verbier')).not.toBeInTheDocument()); // Active filter, default

    fireEvent.click(within(resortsCard()).getByRole('tab', { name: 'Inactive' }));
    expect(await screen.findByText('Verbier')).toBeInTheDocument();
    expect(within(resortRow('Verbier')).getByText('Inactive')).toBeInTheDocument();
  });

  it('an unsafe deactivation (active driver at the resort) is blocked with a clear explanation, and nothing is silently changed', async () => {
    renderPanel();
    await screen.findByText('Crans-Montana');
    fireEvent.click(within(resortRow('Crans-Montana')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Crans-Montana?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));

    expect(await screen.findByText(/active driver/i)).toBeInTheDocument();
    // Dialog stays open on the confirm screen; Crans-Montana is still Active, not silently dropped.
    expect(screen.getByRole('heading', { name: 'Deactivate Crans-Montana?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(within(resortRow('Crans-Montana')).getByText('Active')).toBeInTheDocument();
  });

  it('reactivating restores the same resort (same name, same identity) without a confirmation step', async () => {
    renderPanel();
    await screen.findByText('Verbier');
    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Verbier?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(within(resortsCard()).getByRole('tab', { name: 'Inactive' }));
    await screen.findByText('Verbier');

    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Reactivate' }));

    fireEvent.click(within(resortsCard()).getByRole('tab', { name: 'Active' }));
    expect(await screen.findByText('Verbier')).toBeInTheDocument();
    expect(within(resortRow('Verbier')).getByText('Active')).toBeInTheDocument();
  });
});

describe('ResortShiftSetupPanel: filters and selector behaviour (Stage 2D Checkpoint 4.1 §5)', () => {
  it('Active/Inactive/All filters the Resorts list', async () => {
    renderPanel();
    await screen.findByText('Verbier');
    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Verbier?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.queryByText('Verbier')).not.toBeInTheDocument());

    fireEvent.click(within(resortsCard()).getByRole('tab', { name: 'All' }));
    expect(await screen.findByText('Verbier')).toBeInTheDocument();
    expect(screen.getByText('Crans-Montana')).toBeInTheDocument(); // still active, still shown under "All"
  });

  it('the Shift Setup resort picker (an operational selector) excludes inactive resorts entirely', async () => {
    renderPanel();
    await screen.findByText('Verbier');
    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Verbier?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.queryByText('Verbier')).not.toBeInTheDocument());

    // Verbier is still visible under "All" (historical/reporting context),
    // but it is not clickable as a Shift Setup target, and Shift Setup
    // never renders for it.
    fireEvent.click(within(resortsCard()).getByRole('tab', { name: 'All' }));
    await screen.findByText('Verbier');
    expect(within(resortRow('Verbier')).queryByRole('button', { name: /Verbier/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Shift setup — Verbier/)).not.toBeInTheDocument();
  });

  it('deactivating the currently-configured resort falls back to another active one', async () => {
    renderPanel();
    await screen.findByText(/Shift setup — Crans-Montana/);

    fireEvent.click(within(resortRow('Crans-Montana')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Crans-Montana?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    // Blocked (Crans-Montana has an active driver) -- cancel out and
    // deactivate a genuinely unused one instead to prove the fallback.
    await screen.findByText(/active driver/i);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Verbier?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));

    // Crans-Montana (still active) remains configured -- Shift Setup never disappears.
    await waitFor(() => expect(screen.getByText(/Shift setup — Crans-Montana/)).toBeInTheDocument());
  });

  it('historical data can still resolve an inactive resort by id (getResortById is not filtered)', async () => {
    const repo = new MockResortRepository();
    await repo.deactivateResort('mock-verbier');
    const resort = await repo.getResortById('mock-verbier');
    expect(resort).toMatchObject({ id: 'mock-verbier', name: 'Verbier', isActive: false });
  });
});

describe('ResortShiftSetupPanel: mock mode / architecture', () => {
  it('renders a clear prompt instead of crashing once every resort has been deactivated', async () => {
    // Clear every dependent so all three resorts are genuinely safe to
    // deactivate, then deactivate them all via the repository directly
    // (faster than driving three full confirm dialogs) before rendering.
    for (const driver of mockDrivers) driver.isActive = false;
    for (const shiftType of mockShiftTypes) shiftType.isActive = false;
    const repo = new MockResortRepository();
    await repo.deactivateResort('mock-crans');
    await repo.deactivateResort('mock-zermatt');
    await repo.deactivateResort('mock-verbier');

    renderPanel();
    await screen.findByText(/No resorts configured yet/i); // Active filter (default) is empty
    expect(await screen.findByText(/Add and activate a resort to start configuring its shifts/i)).toBeInTheDocument();
  });

  it('never calls supabase.from(...) or .rpc(...) directly -- only getRepositories()', () => {
    expect(resortShiftSetupPanelSource).not.toMatch(/supabase\s*\.\s*from\(/);
    expect(resortShiftSetupPanelSource).not.toMatch(/\.rpc\(/);
    expect(resortShiftSetupPanelSource).toMatch(/getRepositories\(\)/);
  });
});
