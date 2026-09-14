// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ShiftSetupPanel } from './ShiftSetupPanel';
import { resetRepositoriesForTesting } from '../../../repositories';
import { resetMockFixturesForTesting, mockShiftTemplates, nextMockShiftTemplateId } from '../../../repositories/mock/fixtures';
import { MockShiftConfigurationRepository } from '../../../repositories/mock/shiftConfiguration';
// Raw source text (Vite's `?raw` suffix) — used only by the architecture
// check (test 38) to prove this file never calls supabase.from(...)/.rpc(...)
// directly.
import shiftSetupPanelSource from './ShiftSetupPanel.tsx?raw';

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ShiftSetupPanel resortId="mock-crans" resortName="Crans-Montana" />
    </QueryClientProvider>
  );
}

function shiftSetupCard(): HTMLElement {
  return screen.getByText(/Shift setup — Crans-Montana/).closest('.card') as HTMLElement;
}

/**
 * Modal renders its own icon-only header dismiss button with
 * aria-label="Close" alongside a footer <Button>Close</Button> on the
 * "Done" screens -- both compute to the same accessible name, so a bare
 * `getByRole('button', { name: 'Close' })` is ambiguous. Scope to the
 * footer specifically, where the real primary action lives.
 */
function footerCloseButton(): HTMLElement {
  const dialog = screen.getByRole('dialog');
  const footer = dialog.querySelector('.modal-panel__footer') as HTMLElement;
  return within(footer).getByRole('button', { name: 'Close' });
}

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =======================================================================
// DISPLAY
// =======================================================================
describe('ShiftSetupPanel: display (manager-facing "Shift", not shift type/template)', () => {
  it('1. an active shift is displayed as one grouped Shift, not one row per weekday', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    // The baseline fixture has exactly one weekday (Monday) -- assert there
    // is exactly one card/title for it, not a per-weekday breakdown.
    expect(within(shiftSetupCard()).getAllByText('Dinner')).toHaveLength(1);
  });

  it('2. the standard time is displayed once', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    expect(within(shiftSetupCard()).getAllByText('18:00–21:30')).toHaveLength(1);
  });

  it('3. multiple weekdays are shown as a scannable chip row', async () => {
    await new MockShiftConfigurationRepository().createShift('mock-crans', {
      name: 'Weekend Lunch',
      startTime: '12:00',
      endTime: '14:30',
      weekdays: [5, 6],
      effectiveFrom: '2026-01-01',
    });
    renderPanel();
    await screen.findByText('Weekend Lunch');
    const card = within(shiftSetupCard()).getByText('Weekend Lunch').closest('.shift-setup-card') as HTMLElement;
    expect(card.querySelectorAll('.shift-template-row__day').length).toBe(7); // all 7 days rendered, scannable at a glance
    expect(card.querySelectorAll('.shift-template-row__day.is-active').length).toBe(2); // exactly Sat + Sun highlighted
  });

  it('4. the internal stable key is never shown', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    expect(within(shiftSetupCard()).queryByText('dinner')).not.toBeInTheDocument();
  });

  it('5. timezone is never shown in Shift Setup', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    expect(within(shiftSetupCard()).queryByText(/Europe\/Zurich/)).not.toBeInTheDocument();
  });

  it('6. pay is never shown', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    expect(within(shiftSetupCard()).queryByText(/CHF/)).not.toBeInTheDocument();
  });

  it('7. required drivers / headcount is never shown', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    expect(within(shiftSetupCard()).queryByText(/\d+\s*drivers?\b/i)).not.toBeInTheDocument();
  });

  it('8. high-value / premium is never shown', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    expect(within(shiftSetupCard()).queryByText(/high-value/i)).not.toBeInTheDocument();
    expect(within(shiftSetupCard()).queryByText(/premium/i)).not.toBeInTheDocument();
  });

  it('9. "shift type"/"template"/"key" terminology is never shown', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    const card = shiftSetupCard();
    expect(within(card).queryByText(/shift type/i)).not.toBeInTheDocument();
    expect(within(card).queryByText(/template/i)).not.toBeInTheDocument();
  });
});

// =======================================================================
// CREATE
// =======================================================================
describe('ShiftSetupPanel: Add Shift', () => {
  it('10/13. the Add Shift form contains only the approved fields -- no key, pay, headcount, or high-value', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /Add Shift/i }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Start time')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('End time')).toBeInTheDocument();
    expect(within(dialog).getByText('Repeats')).toBeInTheDocument();
    expect(within(dialog).getByText('Starts')).toBeInTheDocument();
    expect(within(dialog).getByText('Ends')).toBeInTheDocument();

    expect(within(dialog).queryByLabelText(/key/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/base pay/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/delivery rate/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/required drivers/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/high-value/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/timezone/i)).not.toBeInTheDocument();
  });

  it('11. selecting several weekdays and submitting invokes createShift exactly once, with the whole weekday set', async () => {
    const spy = vi.spyOn(MockShiftConfigurationRepository.prototype, 'createShift');
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /Add Shift/i }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Late Dinner' } });
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((label) => fireEvent.click(screen.getByRole('button', { name: label })));
    fireEvent.click(screen.getByRole('button', { name: 'Create Shift' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith('mock-crans', expect.objectContaining({ name: 'Late Dinner', weekdays: expect.arrayContaining([0, 1, 2, 3, 4, 5, 6]) }));
  });

  it('12. an empty weekday selection is rejected before any repository call', async () => {
    const spy = vi.spyOn(MockShiftConfigurationRepository.prototype, 'createShift');
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /Add Shift/i }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Breakfast' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Shift' }));

    expect(await screen.findByText('Select at least one day.')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('14. a successful create refreshes the list without a manual reload', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: /Add Shift/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Breakfast' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Shift' }));

    expect(await screen.findByText('Breakfast')).toBeInTheDocument();
  });
});

// =======================================================================
// EDIT
// =======================================================================
describe('ShiftSetupPanel: Edit Shift', () => {
  it('15/20. edit pre-fills the current schedule as one form, not per-weekday rows', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Dinner' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Dinner');
    expect(within(dialog).getByLabelText('Start time')).toHaveValue('18:00');
    expect(within(dialog).getByLabelText('End time')).toHaveValue('21:30');
    expect(within(dialog).getByRole('button', { name: 'Mon' })).toHaveAttribute('aria-pressed', 'true');
    // Only one start/end time pair exists in the whole form -- never a
    // per-weekday time field.
    expect(within(dialog).getAllByLabelText('Start time')).toHaveLength(1);
  });

  it('16. renaming the display name is supported', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Dinner' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Dinner Service' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('Dinner Service')).toBeInTheDocument();
  });

  it('17. changing the standard time is supported', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Dinner' }));
    fireEvent.change(await screen.findByLabelText('Start time'), { target: { value: '18:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('18:30–21:30')).toBeInTheDocument();
  });

  it('18/19. adding/removing weekdays is supported through one atomic reviseShift call', async () => {
    const spy = vi.spyOn(MockShiftConfigurationRepository.prototype, 'reviseShift');
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Dinner' }));

    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('button', { name: 'Sat' })); // add Saturday
    fireEvent.click(screen.getByRole('button', { name: 'Mon' })); // remove Monday
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith('mock-crans-dinner', 'mock-crans', expect.objectContaining({ weekdays: [5] }));
  });
});

// =======================================================================
// LEGACY DATA SAFETY
// =======================================================================
describe('ShiftSetupPanel: legacy inconsistent-schedule safety', () => {
  it('21/22. a shift with different times on different active days shows a review-required notice instead of guessing', async () => {
    // Fabricate exactly the pre-Checkpoint-4 state the simplified editor
    // cannot represent: two active templates for the same shift type with
    // genuinely different times -- never producible through create_shift/
    // revise_shift, only through the old per-weekday manual path.
    mockShiftTemplates.push({
      id: nextMockShiftTemplateId(),
      resortId: 'mock-crans',
      shiftTypeId: 'mock-crans-dinner',
      weekday: 5,
      startTime: '19:00',
      endTime: '23:00',
      requiredDrivers: null,
      basePayChf: null,
      deliveryRateChf: null,
      isPremium: null,
      effectiveFrom: '2024-01-01',
      effectiveTo: null,
      isActive: true,
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    renderPanel();
    await screen.findByText('Dinner');

    expect(await screen.findByText(/different times configured on different days/i)).toBeInTheDocument();
    expect(screen.getByText(/Review required before it can use the simplified editor/i)).toBeInTheDocument();
    // Never silently renders one of the two times as if it were authoritative.
    expect(screen.queryByText('18:00–21:30')).not.toBeInTheDocument();
    expect(screen.queryByText('19:00–23:00')).not.toBeInTheDocument();
    // Edit is disabled rather than opening a form that would misrepresent the data.
    expect(screen.getByRole('button', { name: 'Edit Dinner' })).toBeDisabled();
  });
});

// =======================================================================
// DEACTIVATE
// =======================================================================
describe('ShiftSetupPanel: Deactivate Shift', () => {
  it('23. deactivating requires a deliberate confirmation, not a single click', async () => {
    const spy = vi.spyOn(MockShiftConfigurationRepository.prototype, 'deactivateShift');
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

    await screen.findByRole('heading', { name: 'Deactivate Dinner?' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('24. confirming uses the atomic deactivateShift RPC', async () => {
    const spy = vi.spyOn(MockShiftConfigurationRepository.prototype, 'deactivateShift');
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Dinner?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith('mock-crans-dinner', 'mock-crans');
  });

  it('25. a deactivated shift remains visible through the Inactive filter, never hidden permanently', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Dinner?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));

    // Mock mode's preview_template_cancellation is unsupported -- the flow
    // still completes with an informational "Done" step (test 26).
    await screen.findByRole('heading', { name: 'Done' });
    fireEvent.click(footerCloseButton());

    // Default filter is "Active" -- the now-inactive shift must disappear from it.
    await waitFor(() => expect(screen.queryByText('Dinner')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Inactive' }));
    const dinnerCard = (await screen.findByText('Dinner')).closest('.shift-setup-card') as HTMLElement;
    expect(within(dinnerCard).getByText('Inactive')).toBeInTheDocument(); // the status pill, not the filter tab
  });

  it('26. reviewing already-generated shifts is a separate step from deactivation itself', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Dinner?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));

    // The shift is deactivated (see test 24) *before* this separate,
    // clearly-labelled review step is even attempted.
    expect(await screen.findByText(/Reviewing already-generated shifts needs Supabase mode/i)).toBeInTheDocument();
  });
});

// =======================================================================
// REACTIVATE
// =======================================================================
describe('ShiftSetupPanel: Reactivate Shift', () => {
  async function deactivateDinner() {
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Deactivate Dinner?' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deactivate' }));
    await screen.findByRole('heading', { name: 'Done' });
    fireEvent.click(footerCloseButton());
    fireEvent.click(screen.getByRole('tab', { name: 'Inactive' }));
    await screen.findByText('Dinner');
  }

  it('27. an inactive shift offers Reactivate', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    await deactivateDinner();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('28. Reactivate pre-fills the last-known schedule as a helpful starting point', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    await deactivateDinner();
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Dinner');
    expect(within(dialog).getByLabelText('Start time')).toHaveValue('18:00');
    expect(within(dialog).getByRole('button', { name: 'Mon' })).toHaveAttribute('aria-pressed', 'true');
    // REGRESSION (found via manual Stage 2D Checkpoint 4 testing): the
    // last-known schedule's effectiveTo is when it ENDED (the deactivation
    // date) -- Reactivate must not inherit that as the new period's end
    // date, or every reactivation would default to a shift that ends
    // immediately. It must default to open-ended, exactly like Add Shift.
    expect(within(dialog).getByLabelText('Continues until changed')).toBeChecked();
  });

  it('29/30. reactivating requires an effective date and uses one atomic reactivateShift call', async () => {
    const spy = vi.spyOn(MockShiftConfigurationRepository.prototype, 'reactivateShift');
    renderPanel();
    await screen.findByText('Dinner');
    await deactivateDinner();
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    await screen.findByLabelText('Name');

    const dateInput = screen.getByLabelText('Reactivates from') as HTMLInputElement;
    expect(dateInput.value).not.toBe(''); // always a real date, never blank
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reactivate' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][2]).toEqual(expect.objectContaining({ effectiveFrom: dateInput.value }));
  });

  it('31. reactivation retains the same logical Shift identity -- it reappears as Active, not as a duplicate', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    await deactivateDinner();
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    await screen.findByLabelText('Name');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reactivate' }));

    fireEvent.click(await screen.findByRole('tab', { name: 'Active' }));
    await waitFor(() => expect(screen.getAllByText('Dinner')).toHaveLength(1));
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getAllByText('Dinner')).toHaveLength(1); // still one Shift, not two
  });
});

// =======================================================================
// MATERIALISATION
// =======================================================================
describe('ShiftSetupPanel: Generate upcoming shifts', () => {
  it('32/33/34. missing Payroll/Rota Rule counts are shown as an informational notice, never a generation failure', async () => {
    vi.spyOn(MockShiftConfigurationRepository.prototype, 'materialiseShifts').mockResolvedValue({
      createdCount: 42,
      skippedExistingCount: 14,
      fromDate: '2026-01-01',
      toDate: '2026-02-28',
      missingPayrollRuleCount: 42,
      missingRotaRuleCount: 10,
    });

    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Generate upcoming shifts' }));

    expect(await screen.findByText(/42 shifts created/)).toBeInTheDocument();
    expect(screen.getByText(/14 already existed/)).toBeInTheDocument();
    expect(screen.getByText(/42 shifts have no Payroll Rule configured/)).toBeInTheDocument();
    expect(screen.getByText(/10 shifts have no Rota Rule configured/)).toBeInTheDocument();
    // Not a failure state -- no error notice/role=alert rendered for this outcome.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// =======================================================================
// REFRESH
// =======================================================================
describe('ShiftSetupPanel: Review schedule updates', () => {
  it('35/36. the preview shows only schedule fields (name/time), no pay/headcount/high-value remnants', async () => {
    vi.spyOn(MockShiftConfigurationRepository.prototype, 'previewTemplateRefresh').mockResolvedValue([
      {
        shiftInstanceId: 'si1',
        date: '2026-02-07',
        shiftTypeId: 'mock-crans-dinner',
        shiftKey: 'dinner',
        name: 'Dinner',
        currentTemplateId: 'old-tpl',
        newTemplateId: 'new-tpl',
        willChange: true,
        changedFields: { name: { old: 'Dinner', new: 'Dinner Service' } },
        assignmentCount: 1,
        timeWouldChange: false,
      },
    ]);

    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Review schedule updates' }));

    expect(await screen.findByText(/Name: Dinner → Dinner Service/)).toBeInTheDocument();
    expect(screen.queryByText(/Base pay/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Required drivers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/High-value/)).not.toBeInTheDocument();
  });

  it('37. a start/end time change still shows the availability-reopen warning', async () => {
    vi.spyOn(MockShiftConfigurationRepository.prototype, 'previewTemplateRefresh').mockResolvedValue([
      {
        shiftInstanceId: 'si1',
        date: '2026-02-07',
        shiftTypeId: 'mock-crans-dinner',
        shiftKey: 'dinner',
        name: 'Dinner',
        currentTemplateId: 'old-tpl',
        newTemplateId: 'new-tpl',
        willChange: true,
        changedFields: { start_time: { old: '18:00', new: '18:30' } },
        assignmentCount: 0,
        timeWouldChange: true,
      },
    ]);

    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Review schedule updates' }));

    expect(await screen.findByText(/reopen confirmed driver availability/i)).toBeInTheDocument();
  });
});

// =======================================================================
// ARCHITECTURE
// =======================================================================
describe('ShiftSetupPanel: architecture', () => {
  it('38. never calls supabase.from(...) or .rpc(...) directly -- only getRepositories()', () => {
    expect(shiftSetupPanelSource).not.toMatch(/supabase\s*\.\s*from\(/);
    expect(shiftSetupPanelSource).not.toMatch(/\.rpc\(/);
    expect(shiftSetupPanelSource).toMatch(/getRepositories\(\)/);
  });

  it('40. mock mode renders the full simplified Shift Setup UI with no network calls', async () => {
    renderPanel();
    expect(await screen.findByText('Dinner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Shift/i })).toBeInTheDocument();
  });
});
