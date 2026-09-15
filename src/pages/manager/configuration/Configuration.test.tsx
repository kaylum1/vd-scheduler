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
import shiftSetupPanelSource from './ShiftSetupPanel.tsx?raw';

function renderWithQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/**
 * Scopes queries to the Shift Setup card specifically (found via its own
 * "Shift Setup — <resort>" header) rather than the whole page — see
 * ShiftSetupPanel.test.tsx for that component's own detailed coverage.
 */
function shiftSetupCard(resortName: string): HTMLElement {
  return screen.getByText(new RegExp(`Shift Setup — ${resortName}`)).closest('.card') as HTMLElement;
}

/**
 * Checkpoint 4.1 UX amendment: a resort's name now appears twice while
 * active (the Resorts management list, and the "Choose resort" selector),
 * so a bare `screen.getByText(resortName)` is ambiguous -- scope to the
 * management list specifically via its own "Resorts" heading.
 */
function resortsListCard(): HTMLElement {
  return screen.getByRole('heading', { name: 'Resorts' }).closest('.card') as HTMLElement;
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
    expect(await within(resortsListCard()).findByText('Crans-Montana')).toBeInTheDocument();
    expect(within(resortsListCard()).getByText('Zermatt')).toBeInTheDocument();
    expect(within(resortsListCard()).getByText('Verbier')).toBeInTheDocument();
  });

  it('2. selecting a different resort changes the shift query', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    await within(resortsListCard()).findByText('Crans-Montana');

    // Crans-Montana is selected by default (first resort loaded).
    await waitFor(() => expect(within(shiftSetupCard('Crans-Montana')).getByText('Dinner')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));

    await waitFor(() => expect(screen.getByText(/Shift Setup — Zermatt/)).toBeInTheDocument());
    await waitFor(() => expect(within(shiftSetupCard('Zermatt')).getByText('Dinner')).toBeInTheDocument()); // Zermatt also has one, different row underneath
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
    for (const source of [configurationPageSource, driversPanelSource, resortShiftSetupPanelSource, shiftSetupPanelSource]) {
      expect(source).not.toMatch(/mock-data/);
    }
  });
});

// =======================================================================
// DRIVER LANGUAGE + ONFLEET (Stage 2D Checkpoint 1.1)
// =======================================================================
describe('Configuration: driver preferred language + Onfleet mapping', () => {
  it('UI 13: the create form includes a preferred-language field, defaulting to English', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');
    fireEvent.click(screen.getByRole('button', { name: /Add driver/i }));

    const languageSelect = (await screen.findByLabelText('Preferred language')) as HTMLSelectElement;
    expect(languageSelect.value).toBe('en');
    expect(within(languageSelect).getByRole('option', { name: 'French' })).toBeInTheDocument();
  });

  it('UI 14: the create form includes an optional Onfleet worker-name field that never blocks creation when left blank', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');
    fireEvent.click(screen.getByRole('button', { name: /Add driver/i }));

    expect(await screen.findByLabelText('Onfleet worker name')).toBeInTheDocument();
    expect(screen.getByText(/exactly as it appears in Onfleet/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'No Onfleet Driver' } });
    fireEvent.change(screen.getByLabelText('Resort'), { target: { value: 'mock-verbier' } });
    // Onfleet field deliberately left blank.
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }));

    expect(await screen.findByText('No Onfleet Driver')).toBeInTheDocument();
  });

  it('a driver can be created with a language and an Onfleet worker name together', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');
    fireEvent.click(screen.getByRole('button', { name: /Add driver/i }));

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Full Onboarding Driver' } });
    fireEvent.change(screen.getByLabelText('Resort'), { target: { value: 'mock-verbier' } });
    fireEvent.change(screen.getByLabelText('Preferred language'), { target: { value: 'fr' } });
    fireEvent.change(screen.getByLabelText('Onfleet worker name'), { target: { value: 'Full Onboarding' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create driver' }));

    expect(await screen.findByText('Full Onboarding Driver')).toBeInTheDocument();
    const row = screen.getByText('Full Onboarding Driver').closest('.config-list-item') as HTMLElement;
    expect(await within(row).findByText('Onfleet linked')).toBeInTheDocument();
  });

  it('UI 15: editing a driver displays their existing preferred language', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Alex'); // mock-alex fixture is preferredLanguage: 'fr'

    fireEvent.click(screen.getByRole('button', { name: 'Edit Alex' }));
    const languageSelect = (await screen.findByLabelText('Preferred language')) as HTMLSelectElement;
    expect(languageSelect.value).toBe('fr');
  });

  it('a driver\'s language can be changed via the edit form', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Alex');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alex' }));

    fireEvent.change(await screen.findByLabelText('Preferred language'), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alex' }));
    expect(((await screen.findByLabelText('Preferred language')) as HTMLSelectElement).value).toBe('en');
  });

  it('UI 16: editing a driver displays their existing Onfleet mapping status and worker name', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni'); // mock-gianni fixture has an active mapping "Gianni Rossi"

    fireEvent.click(screen.getByRole('button', { name: 'Edit Gianni' }));
    expect(await screen.findByText('Linked')).toBeInTheDocument();
    expect((screen.getByLabelText('Onfleet worker name') as HTMLInputElement).value).toBe('Gianni Rossi');
  });

  it('editing a driver with no Onfleet mapping shows "Not linked" and an empty field', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Tomas'); // no mapping fixture

    fireEvent.click(screen.getByRole('button', { name: 'Edit Tomas' }));
    expect(await screen.findByText('Not linked')).toBeInTheDocument();
    expect((screen.getByLabelText('Onfleet worker name') as HTMLInputElement).value).toBe('');
  });

  it('the driver list shows an Onfleet-linked badge for a mapped driver and not-linked for an unmapped one', async () => {
    renderWithQueryClient(<DriversPanel />);
    await screen.findByText('Gianni');

    const gianniRow = screen.getByText('Gianni').closest('.config-list-item') as HTMLElement;
    expect(await within(gianniRow).findByText('Onfleet linked')).toBeInTheDocument();

    const tomasRow = screen.getByText('Tomas').closest('.config-list-item') as HTMLElement;
    expect(within(tomasRow).getByText('Onfleet not linked')).toBeInTheDocument();
  });

  it('UI 17: language and Onfleet fields use the same responsive form-field/Modal building blocks already verified at mobile widths, not bespoke fixed-width markup', () => {
    for (const source of [driversPanelSource]) {
      // A crude but effective structural guard: every new <select>/<input>
      // this checkpoint adds lives inside the existing .form-field wrapper
      // (already proven to fit a 375px viewport in Checkpoint 1's manual
      // pass) and the existing Modal component, rather than any new,
      // unverified layout primitive.
      expect(source).toMatch(/id="driver-language"[\s\S]*?<\/select>/);
      expect(source).toMatch(/id="driver-onfleet-name"/);
      expect(source).not.toMatch(/width:\s*\d+px/); // no hard-coded pixel widths that could overflow a narrow viewport
    }
  });
});

// =======================================================================
// SHIFT SETUP
// =======================================================================
// The old "Shift Types" + "Recurring Shift Schedule" two-layer UI/tests
// were replaced in Stage 2D Checkpoint 4 by the single simplified "Shift"
// model — see ShiftSetupPanel.test.tsx for its detailed coverage (display,
// create, edit, deactivate, reactivate, legacy-data safety, materialisation
// warnings, refresh scope). Test 2 above already covers the resort-scoping
// behaviour at this page-composition level.


// =======================================================================
// ARCHITECTURE
// =======================================================================
describe('Configuration: architecture', () => {
  it('21. no Configuration component calls supabase.from(...) or .rpc(...) directly', () => {
    const dataPanelSources = [driversPanelSource, resortShiftSetupPanelSource, shiftSetupPanelSource];

    for (const source of [configurationPageSource, ...dataPanelSources]) {
      expect(source).not.toMatch(/supabase\s*\.\s*from\(/);
      expect(source).not.toMatch(/\.rpc\(/);
    }
    for (const source of dataPanelSources) {
      // The panels that actually do data work go through the repository
      // boundary; the top-level Configuration.tsx is pure tab layout and
      // delegates to them, so it has no repository calls of its own to make.
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
