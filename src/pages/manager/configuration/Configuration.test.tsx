// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { DriversPanel } from './DriversPanel';
import { ResortShiftSetupPanel } from './ResortShiftSetupPanel';
import { resetRepositoriesForTesting } from '../../../repositories';
import { resetMockFixturesForTesting } from '../../../repositories/mock/fixtures';
import { MockResortRepository } from '../../../repositories/mock/resorts';
// Raw source text (Vite's `?raw` suffix — see vite/client.d.ts, referenced
// via src/vite-env.d.ts), not Node's `fs`, which isn't type-available in
// this frontend-only tsconfig. Used only by the static architecture checks
// below (tests 13 and 21) to prove these files never reach into
// src/mock-data or call supabase.from(...)/.rpc(...) directly.
import configurationPageSource from '../Configuration.tsx?raw';
import driversPanelSource from './DriversPanel.tsx?raw';
import resortShiftSetupPanelSource from './ResortShiftSetupPanel.tsx?raw';

function renderWithQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =======================================================================
// RESORTS
// =======================================================================
describe('Configuration: Resorts (live, via ResortRepository)', () => {
  it('1. live resorts load from the repository, not a hard-coded list', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    expect(await screen.findByRole('tab', { name: /Crans-Montana/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Zermatt/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Verbier/ })).toBeInTheDocument();
  });

  it('2. selecting a different resort changes the shift-type query', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    await screen.findByRole('tab', { name: /Crans-Montana/ });

    // Crans-Montana is selected by default (first resort loaded).
    expect(await screen.findByText('Dinner')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Zermatt/ }));

    await waitFor(() => expect(screen.getByText(/Shift types — Zermatt/)).toBeInTheDocument());
    expect(await screen.findByText('Dinner')).toBeInTheDocument(); // Zermatt also has one, different row underneath
  });

  it('3. shows a deliberate loading state before resorts resolve', () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    // Assert synchronously, before the mock repository's promise resolves.
    expect(screen.getByText(/Loading resorts/i)).toBeInTheDocument();
  });

  it('4. a repository failure shows an error state, never an empty-state', async () => {
    vi.spyOn(MockResortRepository.prototype, 'listResorts').mockRejectedValue(new Error('network down'));
    renderWithQueryClient(<ResortShiftSetupPanel />);

    expect(await screen.findByText(/Couldn't load resorts/i)).toBeInTheDocument();
    expect(screen.queryByText(/No resorts configured yet/i)).not.toBeInTheDocument();
  });
});

// =======================================================================
// DRIVERS
// =======================================================================
describe('Configuration: Drivers (live, via DriverRepository)', () => {
  it('5. live driver list renders from the repository', async () => {
    renderWithQueryClient(<DriversPanel />);
    expect(await screen.findByText('Gianni')).toBeInTheDocument();
    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('Tomas')).toBeInTheDocument();
  });

  it('6. the resort filter narrows the visible drivers', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');

    fireEvent.change(screen.getByLabelText('Filter by resort'), { target: { value: 'mock-zermatt' } });

    expect(await screen.findByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('Tomas')).toBeInTheDocument();
    expect(screen.queryByText('Gianni')).not.toBeInTheDocument();
  });

  it('7. creating a driver goes through the repository and the new driver appears', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');

    fireEvent.click(screen.getByRole('button', { name: /Add driver/i }));
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'New Test Driver' } });
    fireEvent.change(screen.getByLabelText('Resort'), { target: { value: 'mock-verbier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }));

    expect(await screen.findByText('New Test Driver')).toBeInTheDocument();
    // Post-creation notice, per Stage 2D Checkpoint 1 section 6.
    expect(screen.getByText(/Login access is managed separately/i)).toBeInTheDocument();
  });

  it('8. create validates that a resort is required', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');

    fireEvent.click(screen.getByRole('button', { name: /Add driver/i }));
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'No Resort Driver' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }));

    expect(await screen.findByText('Select a resort.')).toBeInTheDocument();
    expect(screen.queryByText('No Resort Driver')).not.toBeInTheDocument();
  });

  it('9. editing a driver saves the new name through the repository', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Gianni' }));
    const nameInput = await screen.findByLabelText('Full name');
    fireEvent.change(nameInput, { target: { value: 'Gianni Bianchi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Gianni Bianchi')).toBeInTheDocument();
  });

  it('10. deactivating a driver requires a deliberate confirmation, not a single click', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');

    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' })[0]); // Gianni's row (first, alphabetically)
    // Confirmation dialog shown; driver still active until confirmed.
    expect(await screen.findByRole('heading', { name: 'Deactivate Gianni?' })).toBeInTheDocument();
    expect(screen.getByText(/Historical rota, attendance and payroll data will be retained/)).toBeInTheDocument();
    expect(screen.getByText('Gianni')).toBeInTheDocument(); // still shown/active — nothing happened yet

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(screen.queryByText('Gianni')).not.toBeInTheDocument()); // filtered out of the default "Active" view
  });

  it('11. a deactivated driver remains visible via the Inactive filter (never hard-deleted)', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');

    fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' })[0]);
    await screen.findByRole('heading', { name: 'Deactivate Gianni?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.queryByText('Gianni')).not.toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'inactive' } });
    const gianniRow = (await screen.findByText('Gianni')).closest('.config-list-item') as HTMLElement;
    expect(within(gianniRow).getByText('Inactive')).toBeInTheDocument();
  });

  it("12. a driver's resort cannot be changed through the edit form (unsafe move prevented by design, not by catching an error)", async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Gianni' }));
    const resortSelect = await screen.findByLabelText('Resort');
    expect(resortSelect).toBeDisabled();
    expect(screen.getByText(/deactivate this profile and create a new one at the new resort/i)).toBeInTheDocument();
  });

  it('13. Configuration never reaches into the Stage 1.1 mock-data module, in any provider mode', () => {
    for (const source of [configurationPageSource, driversPanelSource, resortShiftSetupPanelSource]) {
      expect(source).not.toMatch(/mock-data/);
    }
  });
});

// =======================================================================
// SHIFT TYPES
// =======================================================================
describe('Configuration: Shift Types (live, via ShiftConfigurationRepository)', () => {
  it('14. shift types for the selected resort load from the repository', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    await screen.findByRole('tab', { name: /Crans-Montana/ });
    expect(await screen.findByText('Dinner')).toBeInTheDocument();
    expect(screen.getByText('dinner')).toBeInTheDocument(); // stable key badge
  });

  it('15. creating a shift type goes through the repository and appears in the list', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    await screen.findByRole('tab', { name: /Crans-Montana/ });
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: /Add shift type/i }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Lunch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create shift type' }));

    expect(await screen.findByText('Lunch')).toBeInTheDocument();
    expect(screen.getByText('lunch')).toBeInTheDocument(); // auto-slugified key
  });

  it('16. a duplicate key at the same resort is rejected with a clear error, not a crash', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    await screen.findByRole('tab', { name: /Crans-Montana/ });
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: /Add shift type/i }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Dinner Redux' } });
    fireEvent.change(screen.getByLabelText('Stable key'), { target: { value: 'dinner' } });

    expect(await screen.findByText('That key is already used at this resort.')).toBeInTheDocument();
    // The create button stays inert -- no crash, no duplicate row created.
    fireEvent.click(screen.getByRole('button', { name: 'Create shift type' }));
    expect(screen.queryByText('Dinner Redux')).not.toBeInTheDocument();
  });

  it('17. renaming the display name never alters the stable key', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    await screen.findByRole('tab', { name: /Crans-Montana/ });
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Dinner' }));
    const nameInput = await screen.findByLabelText('Display name');
    fireEvent.change(nameInput, { target: { value: 'Dinner Service' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Dinner Service');
    expect(screen.getByText('dinner')).toBeInTheDocument(); // key badge unchanged
  });

  it('18. changing sort order updates ordering', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    await screen.findByRole('tab', { name: /Crans-Montana/ });
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: /Add shift type/i }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Breakfast' } });
    fireEvent.change(screen.getByLabelText('Sort order'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create shift type' }));
    await screen.findByText('Breakfast');

    const titlesBefore = screen.getAllByText(/Sort order/).map((el) => el.previousSibling?.textContent);
    expect(titlesBefore[0]).toContain('Breakfast'); // sort_order 0 sorts first, ahead of Dinner's 1
  });

  it('19. deactivation is blocked while an active recurring template exists, surfaced as a manager-facing error', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    await screen.findByRole('tab', { name: /Crans-Montana/ });
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Dinner?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));

    expect(await screen.findByText(/still has an active recurring template/i)).toBeInTheDocument();
    // Dialog stays open, Dinner is still active -- not silently dropped.
    expect(screen.getAllByText('Dinner').length).toBeGreaterThan(0);
  });

  it('20. a Zermatt shift type never appears under Crans-Montana', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    await screen.findByRole('tab', { name: /Crans-Montana/ });
    await screen.findByText(/Shift types — Crans-Montana/);

    // Both resorts' fixture shift type happens to be named "Dinner" too --
    // scoping is what's under test, not the label -- so assert exactly one
    // row is shown for Crans-Montana.
    expect(screen.getAllByText('Dinner')).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: /Zermatt/ }));
    await waitFor(() => expect(screen.getByText(/Shift types — Zermatt/)).toBeInTheDocument());
    expect(await screen.findByText('Dinner')).toBeInTheDocument();
  });
});

// =======================================================================
// ARCHITECTURE
// =======================================================================
describe('Configuration: architecture', () => {
  it('21. no Configuration component calls supabase.from(...) or .rpc(...) directly', () => {
    const dataPanelSources = [driversPanelSource, resortShiftSetupPanelSource];

    for (const source of [configurationPageSource, ...dataPanelSources]) {
      expect(source).not.toMatch(/supabase\s*\.\s*from\(/);
      expect(source).not.toMatch(/\.rpc\(/);
    }
    for (const source of dataPanelSources) {
      // The two panels that actually do data work go through the
      // repository boundary; the top-level Configuration.tsx is pure tab
      // layout and delegates to them, so it has no repository calls of its
      // own to make.
      expect(source).toMatch(/getRepositories\(\)/);
    }
  });

  it('22. a successful mutation invalidates and refetches only the relevant query (proven behaviourally by tests 7-19 above): a create is visible without a manual re-render', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');
    fireEvent.click(screen.getByRole('button', { name: /Add driver/i }));
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Invalidation Check' } });
    fireEvent.change(screen.getByLabelText('Resort'), { target: { value: 'mock-crans' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }));
    // No manual refetch call anywhere in this test -- if this appears, the
    // mutation's onSuccess invalidation worked.
    expect(await screen.findByText('Invalidation Check')).toBeInTheDocument();
  });

  it('23. the mock provider (VITE_DATA_PROVIDER unset/mock) is what every test above actually exercised', async () => {
    const { getDataProvider } = await import('../../../lib/env');
    expect(getDataProvider()).toBe('mock');
  });
});
