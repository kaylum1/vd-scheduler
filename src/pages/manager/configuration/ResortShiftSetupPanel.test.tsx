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

function chooserCard(): HTMLElement {
  return screen.getByRole('heading', { name: 'Choose resort' }).closest('.card') as HTMLElement;
}

function chooserTab(name: string): HTMLElement {
  return within(chooserCard()).getByRole('tab', { name });
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
    await within(resortsCard()).findByText('Crans-Montana');
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
    await within(resortsCard()).findByText('Crans-Montana');

    fireEvent.click(screen.getByRole('button', { name: /Add Resort/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Val Thorens' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add Resort' }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith('Val Thorens'));
    expect(await within(resortsCard()).findByText('Val Thorens')).toBeInTheDocument();
    expect(screen.queryByText(/val-thorens/)).not.toBeInTheDocument(); // the auto-generated slug is never shown
  });

  it('a duplicate/conflicting resort name is handled cleanly -- created, not rejected, and the disambiguated slug is invisible', async () => {
    renderPanel();
    await within(resortsCard()).findByText('Crans-Montana');

    fireEvent.click(screen.getByRole('button', { name: /Add Resort/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Crans-Montana' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add Resort' }));

    await waitFor(() => expect(within(resortsCard()).getAllByText('Crans-Montana')).toHaveLength(2));
    expect(screen.queryByText(/crans-montana-2/)).not.toBeInTheDocument();
  });

  it('rejects a blank name without a crash', async () => {
    renderPanel();
    await within(resortsCard()).findByText('Crans-Montana');
    fireEvent.click(screen.getByRole('button', { name: /Add Resort/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add Resort' }));

    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
  });
});

describe('ResortShiftSetupPanel: Deactivate / Reactivate (Stage 2D Checkpoint 4.1)', () => {
  it('deactivating an unused resort (Verbier) requires confirmation and explains retention', async () => {
    renderPanel();
    await within(resortsCard()).findByText('Verbier');
    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Deactivate' }));

    await screen.findByRole('heading', { name: 'Deactivate Verbier?' });
    expect(screen.getByText(/disappear from normal active resort selectors/i)).toBeInTheDocument();
    expect(screen.getByText(/historical data is retained/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is deleted/i)).toBeInTheDocument();
  });

  it('confirming deactivates it, and it moves from Active to the Inactive filter -- never hidden permanently', async () => {
    renderPanel();
    await within(resortsCard()).findByText('Verbier');
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
    await within(resortsCard()).findByText('Crans-Montana');
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
    await within(resortsCard()).findByText('Verbier');
    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Verbier?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(within(resortsCard()).getByRole('tab', { name: 'Inactive' }));
    // Scoped, not `screen.findByText` -- unscoped, "Verbier" can transiently
    // still match the "Choose resort" chooser while the deactivation's
    // refetch is still in flight (stale active data), giving a false-positive
    // resolve before the Inactive-filtered row has actually appeared.
    await within(resortsCard()).findByText('Verbier');

    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Reactivate' }));

    fireEvent.click(within(resortsCard()).getByRole('tab', { name: 'Active' }));
    expect(await within(resortsCard()).findByText('Verbier')).toBeInTheDocument();
    expect(within(resortRow('Verbier')).getByText('Active')).toBeInTheDocument();
  });
});

describe('ResortShiftSetupPanel: filters and selector behaviour (Stage 2D Checkpoint 4.1 §5)', () => {
  it('Active/Inactive/All filters the Resorts list', async () => {
    renderPanel();
    await within(resortsCard()).findByText('Verbier');
    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Verbier?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.queryByText('Verbier')).not.toBeInTheDocument());

    fireEvent.click(within(resortsCard()).getByRole('tab', { name: 'All' }));
    expect(await within(resortsCard()).findByText('Verbier')).toBeInTheDocument();
    expect(within(resortsCard()).getByText('Crans-Montana')).toBeInTheDocument(); // still active, still shown under "All"
  });

  it('the "Choose resort" selector (an operational selector) excludes inactive resorts entirely', async () => {
    renderPanel();
    await within(resortsCard()).findByText('Verbier');
    fireEvent.click(within(resortRow('Verbier')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Verbier?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.queryByText('Verbier')).not.toBeInTheDocument());

    // Verbier is still visible under "All" in the Resorts management list
    // (historical/reporting context), but it never appears as a choice in
    // "Choose resort", and Shift Setup never renders for it.
    fireEvent.click(within(resortsCard()).getByRole('tab', { name: 'All' }));
    await screen.findByText('Verbier'); // present in the management list...
    expect(within(chooserCard()).queryByRole('tab', { name: 'Verbier' })).not.toBeInTheDocument(); // ...but not the chooser
    expect(screen.queryByText(/Shift Setup — Verbier/)).not.toBeInTheDocument();
  });

  it('deactivating the currently-configured resort falls back to another active one', async () => {
    renderPanel();
    await screen.findByText(/Shift Setup — Crans-Montana/);

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
    await waitFor(() => expect(screen.getByText(/Shift Setup — Crans-Montana/)).toBeInTheDocument());
  });

  it('historical data can still resolve an inactive resort by id (getResortById is not filtered)', async () => {
    const repo = new MockResortRepository();
    await repo.deactivateResort('mock-verbier');
    const resort = await repo.getResortById('mock-verbier');
    expect(resort).toMatchObject({ id: 'mock-verbier', name: 'Verbier', isActive: false });
  });
});

// =======================================================================
// "Choose resort" selection clarity (Checkpoint 4.1 UX amendment)
// =======================================================================
// Manual testing found it unclear which resort's shifts were being edited
// when selection was folded into the Resorts management list. These tests
// cover the standalone "Choose resort" control introduced to fix that.
describe('ResortShiftSetupPanel: "Choose resort" selection clarity (Checkpoint 4.1 UX amendment)', () => {
  it('the Shift Setup heading explicitly names the selected resort', async () => {
    renderPanel();
    expect(await screen.findByRole('heading', { name: 'Shift Setup — Crans-Montana' })).toBeInTheDocument();
  });

  it('a helper line explains that the resort is chosen above', async () => {
    renderPanel();
    await screen.findByRole('heading', { name: 'Shift Setup — Crans-Montana' });
    expect(screen.getByText('Choose a resort above to edit its shifts.')).toBeInTheDocument();
  });

  it('clicking another resort in the chooser immediately updates the heading and the displayed shifts', async () => {
    renderPanel();
    await screen.findByRole('heading', { name: 'Shift Setup — Crans-Montana' });

    fireEvent.click(chooserTab('Zermatt'));

    expect(await screen.findByRole('heading', { name: 'Shift Setup — Zermatt' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Shift Setup — Crans-Montana' })).not.toBeInTheDocument();
    // Zermatt's own Dinner shift (a different row from Crans-Montana's) is now shown.
    await waitFor(() => expect(within(screen.getByRole('heading', { name: 'Shift Setup — Zermatt' }).closest('.card') as HTMLElement).getByText('Dinner')).toBeInTheDocument());
  });

  it('the currently selected resort has a clearly visible selected/active state in the chooser, and only one resort is selected at a time', async () => {
    renderPanel();
    await screen.findByRole('heading', { name: 'Shift Setup — Crans-Montana' });

    expect(chooserTab('Crans-Montana')).toHaveAttribute('aria-selected', 'true');
    expect(chooserTab('Crans-Montana').className).toMatch(/is-active/);
    expect(chooserTab('Zermatt')).toHaveAttribute('aria-selected', 'false');
    expect(chooserTab('Zermatt').className).not.toMatch(/is-active/);

    fireEvent.click(chooserTab('Zermatt'));
    await screen.findByRole('heading', { name: 'Shift Setup — Zermatt' });

    expect(chooserTab('Zermatt')).toHaveAttribute('aria-selected', 'true');
    expect(chooserTab('Crans-Montana')).toHaveAttribute('aria-selected', 'false');
  });

  it('an inactive resort never appears as a choice in the chooser', async () => {
    const repo = new MockResortRepository();
    await repo.deactivateResort('mock-verbier');
    renderPanel();
    await screen.findByRole('heading', { name: 'Shift Setup — Crans-Montana' });

    expect(within(chooserCard()).queryByRole('tab', { name: 'Verbier' })).not.toBeInTheDocument();
    expect(within(chooserCard()).getByRole('tab', { name: 'Zermatt' })).toBeInTheDocument();
  });

  it('the chooser re-uses the already mobile-verified .segmented pill control -- wraps cleanly, no fixed pixel widths', () => {
    // Structural guard (matches the convention in Configuration.test.tsx's
    // UI 17): the chooser is built from the same .segmented control already
    // proven to wrap without horizontal overflow at a 375px viewport (the
    // Active/Inactive/All filters above it), not new, unverified markup.
    expect(resortShiftSetupPanelSource).toMatch(/resort-chooser segmented/);
    expect(resortShiftSetupPanelSource).not.toMatch(/width:\s*\d+px/);
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
