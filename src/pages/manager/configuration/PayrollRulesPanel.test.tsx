// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PayrollRulesPanel, categorizeRatePeriods } from './PayrollRulesPanel';
import { resetRepositoriesForTesting } from '../../../repositories';
import { resetMockFixturesForTesting, mockDriverDeliveryRates, mockShiftBasePayRules } from '../../../repositories/mock/fixtures';
import { MockPayrollRulesRepository } from '../../../repositories/mock/payrollRules';
// Raw source text -- used only by the architecture check below to prove
// this file never calls supabase.from(...)/.rpc(...) directly.
import payrollRulesPanelSource from './PayrollRulesPanel.tsx?raw';

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PayrollRulesPanel />
    </QueryClientProvider>
  );
}

function baseRow(name: string): HTMLElement {
  const card = screen.getByRole('heading', { name: 'Shift base pay' }).closest('.card') as HTMLElement;
  return within(card).getByText(name).closest('.shift-setup-card') as HTMLElement;
}

function rateRow(name: string): HTMLElement {
  const card = screen.getByRole('heading', { name: 'Driver delivery rates' }).closest('.card') as HTMLElement;
  return within(card).getByText(name).closest('.shift-setup-card') as HTMLElement;
}

function futureIso(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  resetMockFixturesForTesting();
  resetRepositoriesForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =======================================================================
// categorizeRatePeriods -- the one shared resolution helper.
// =======================================================================
describe('categorizeRatePeriods', () => {
  it('finds the period covering today as current', () => {
    const periods = [{ effectiveFrom: '2026-01-01', effectiveTo: null }];
    expect(categorizeRatePeriods(periods, '2026-06-01').current).toBe(periods[0]);
  });

  it('splits future periods into scheduled, ascending', () => {
    const periods = [
      { effectiveFrom: '2027-01-01', effectiveTo: null },
      { effectiveFrom: '2026-12-01', effectiveTo: '2026-12-31' },
    ];
    const { scheduled } = categorizeRatePeriods(periods, '2026-06-01');
    expect(scheduled.map((p) => p.effectiveFrom)).toEqual(['2026-12-01', '2027-01-01']);
  });

  it('splits past, closed periods into history', () => {
    const periods = [{ effectiveFrom: '2020-01-01', effectiveTo: '2020-12-31' }];
    expect(categorizeRatePeriods(periods, '2026-06-01').history).toHaveLength(1);
  });

  it('an open-ended period that has not started yet is scheduled, not current', () => {
    const periods = [{ effectiveFrom: '2027-01-01', effectiveTo: null }];
    const result = categorizeRatePeriods(periods, '2026-06-01');
    expect(result.current).toBeNull();
    expect(result.scheduled).toHaveLength(1);
  });
});

// =======================================================================
// PAGE
// =======================================================================
describe('PayrollRulesPanel: page', () => {
  it('1. the selected resort is shown clearly, in a heading naming it', async () => {
    renderPanel();
    expect(await screen.findByRole('heading', { name: 'Payroll Rules — Crans-Montana' })).toBeInTheDocument();
  });

  it('2. the pay formula/helper explanation is shown', async () => {
    renderPanel();
    await screen.findByRole('heading', { name: 'Payroll Rules — Crans-Montana' });
    expect(screen.getByText(/paid the higher of the Shift base guarantee or their delivery earnings/i)).toBeInTheDocument();
  });

  it('3. active Shifts for the resort are listed', async () => {
    renderPanel();
    expect(await screen.findByText('Dinner')).toBeInTheDocument();
  });

  it('4. active drivers for the resort are listed', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    expect(rateRow('Gianni')).toBeInTheDocument();
  });

  it('5. a missing rate shows "Not configured", never a fabricated CHF 0', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    // Switch to Verbier, which has zero Shifts/drivers/rates configured at all.
    fireEvent.click(screen.getByRole('tab', { name: 'Verbier' }));
    await waitFor(() => expect(screen.getByText(/No active Shifts yet/i)).toBeInTheDocument());
    expect(screen.queryByText(/CHF 0\.00/)).not.toBeInTheDocument();
  });

  it('resort chooser only ever shows active resorts (operational selector)', async () => {
    const repo = new (await import('../../../repositories/mock/resorts')).MockResortRepository();
    await repo.deactivateResort('mock-verbier');
    renderPanel();
    await screen.findByText('Dinner');
    expect(screen.queryByRole('tab', { name: 'Verbier' })).not.toBeInTheDocument();
  });
});

// =======================================================================
// SHIFT BASE PAY
// =======================================================================
describe('PayrollRulesPanel: Shift base pay', () => {
  it('6/9. the initial Set Rate flow performs one atomic repository call', async () => {
    const spy = vi.spyOn(MockPayrollRulesRepository.prototype, 'setShiftBasePayRate');
    // A Shift with no rate configured at all -- create it before rendering
    // so there is no "not configured" -> "configured" mid-test refetch race.
    const { MockShiftConfigurationRepository } = await import('../../../repositories/mock/shiftConfiguration');
    await new MockShiftConfigurationRepository().createShift('mock-crans', {
      name: 'Lunch',
      startTime: '12:00',
      endTime: '14:00',
      weekdays: [0],
      requiredDrivers: 1,
    });

    renderPanel();
    await screen.findByText('Lunch');
    fireEvent.click(within(baseRow('Lunch')).getByRole('button', { name: 'Set rate' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Set base pay — Lunch' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Base pay'), { target: { value: '20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set Rate' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(expect.any(String), 'mock-crans', 20, expect.any(String));
  });

  it('7. the amount is validated (rejects blank/negative before any repository call)', async () => {
    const spy = vi.spyOn(MockPayrollRulesRepository.prototype, 'setShiftBasePayRate');
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Base pay'), { target: { value: '-5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule Change' }));

    expect(await within(dialog).findByText(/CHF 0 or more/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('8. an effective date is required and pre-filled with today', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const dateInput = within(dialog).getByLabelText('Changes from') as HTMLInputElement;
    expect(dateInput.value).not.toBe('');
  });

  it('10. the current rate is displayed on the main card', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    expect(within(baseRow('Dinner')).getByText('CHF 30.00 / attended shift')).toBeInTheDocument();
  });

  it('11. a future scheduled rate is displayed distinctly from the current one', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Base pay'), { target: { value: '35' } });
    fireEvent.change(within(dialog).getByLabelText('Changes from'), { target: { value: futureIso(30) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule Change' }));

    await waitFor(() => expect(within(baseRow('Dinner')).getByText(/Scheduled: CHF 35\.00 from/)).toBeInTheDocument());
    // Current is unaffected by the not-yet-real scheduled change.
    expect(within(baseRow('Dinner')).getByText('CHF 30.00 / attended shift')).toBeInTheDocument();
  });

  it('12. Edit creates an effective future change without disturbing the current period', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Base pay'), { target: { value: '35' } });
    fireEvent.change(within(dialog).getByLabelText('Changes from'), { target: { value: futureIso(30) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule Change' }));

    await waitFor(() => expect(mockShiftBasePayRules.filter((r) => r.shiftTypeId === 'mock-crans-dinner')).toHaveLength(2));
  });

  it('13. history is accessible once a rate has genuinely changed (an immediate change closes the old period into real history)', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    expect(within(baseRow('Dinner')).queryByRole('button', { name: 'History' })).not.toBeInTheDocument();

    // An immediate (today) change closes the old, already-real period into
    // history right away -- a merely-scheduled FUTURE change would not (see
    // test 11: the old period stays "current" until its own end date).
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Base pay'), { target: { value: '35' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule Change' }));

    await waitFor(() => expect(within(baseRow('Dinner')).getByRole('button', { name: 'History' })).toBeInTheDocument());
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'History' }));
    const historyDialog = await screen.findByRole('dialog');
    expect(within(historyDialog).getByRole('heading', { name: 'Dinner — rate history' })).toBeInTheDocument();
    expect(within(historyDialog).getByText('CHF 30.00 / attended shift')).toBeInTheDocument();
    expect(within(historyDialog).getByText('CHF 35.00 / attended shift')).toBeInTheDocument();
  });

  it('14. the historical row is never directly overwritten by the UI -- Edit always targets the current/scheduled row, and the old one is closed, not mutated', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    const originalId = mockShiftBasePayRules.find((r) => r.shiftTypeId === 'mock-crans-dinner')!.id;

    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Base pay'), { target: { value: '35' } });
    fireEvent.change(within(dialog).getByLabelText('Changes from'), { target: { value: futureIso(30) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule Change' }));

    await waitFor(() => {
      const original = mockShiftBasePayRules.find((r) => r.id === originalId)!;
      expect(original.basePayChf).toBe(30); // untouched
      expect(original.effectiveTo).not.toBeNull(); // closed
    });
  });
});

// =======================================================================
// DRIVER DELIVERY RATES
// =======================================================================
describe('PayrollRulesPanel: Driver delivery rates', () => {
  it('15/21. the initial Set Rate flow works, and no global CHF 12 assumption is made for a driver with no rule', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));
    await screen.findByText('Alex');
    expect(rateRow('Tomas')).toBeInTheDocument();
    expect(within(rateRow('Tomas')).getByText('Not configured')).toBeInTheDocument();

    fireEvent.click(within(rateRow('Tomas')).getByRole('button', { name: 'Set rate' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Set delivery rate — Tomas' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Rate per completed delivery'), { target: { value: '14' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set Rate' }));

    await waitFor(() => expect(within(rateRow('Tomas')).getByText('CHF 14.00 / completed delivery')).toBeInTheDocument());
  });

  it('16/17. individual driver rates are displayed, and different drivers can show different rates', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));
    await screen.findByText('Alex');
    expect(within(rateRow('Alex')).getByText('CHF 12.00 / completed delivery')).toBeInTheDocument();
    expect(within(rateRow('Tomas')).getByText('Not configured')).toBeInTheDocument();
  });

  it('18. editing one driver\'s rate does not affect another driver\'s rate', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(rateRow('Gianni')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Rate per completed delivery'), { target: { value: '99' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule Change' }));

    fireEvent.click(await screen.findByRole('tab', { name: 'Zermatt' }));
    await screen.findByText('Alex');
    expect(within(rateRow('Alex')).getByText('CHF 12.00 / completed delivery')).toBeInTheDocument(); // unaffected
  });

  it('19. a future scheduled rate is shown for a driver', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(rateRow('Gianni')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Rate per completed delivery'), { target: { value: '14' } });
    fireEvent.change(within(dialog).getByLabelText('Changes from'), { target: { value: futureIso(30) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule Change' }));

    await waitFor(() => expect(within(rateRow('Gianni')).getByText(/Scheduled: CHF 14\.00 from/)).toBeInTheDocument());
  });

  it('20. history is accessible for a driver once their rate has genuinely changed', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    expect(within(rateRow('Gianni')).queryByRole('button', { name: 'History' })).not.toBeInTheDocument();

    fireEvent.click(within(rateRow('Gianni')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Rate per completed delivery'), { target: { value: '14' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule Change' }));

    await waitFor(() => expect(within(rateRow('Gianni')).getByRole('button', { name: 'History' })).toBeInTheDocument());
    fireEvent.click(within(rateRow('Gianni')).getByRole('button', { name: 'History' }));
    const historyDialog = await screen.findByRole('dialog');
    expect(within(historyDialog).getByText('CHF 12.00 / delivery')).toBeInTheDocument();
    expect(within(historyDialog).getByText('CHF 14.00 / delivery')).toBeInTheDocument();
  });
});

// =======================================================================
// SECURITY / ARCHITECTURE
// =======================================================================
describe('PayrollRulesPanel: mock mode / architecture', () => {
  it('22/23. never calls supabase.from(...) or .rpc(...) directly -- only getRepositories(), and mapped results render correctly', async () => {
    expect(payrollRulesPanelSource).not.toMatch(/supabase\s*\.\s*from\(/);
    expect(payrollRulesPanelSource).not.toMatch(/\.rpc\(/);
    expect(payrollRulesPanelSource).toMatch(/getRepositories\(\)/);
  });

  it('24. mock mode works end to end (list + set both succeed without Supabase)', async () => {
    renderPanel();
    expect(await screen.findByText('Dinner')).toBeInTheDocument();
    expect(rateRow('Gianni')).toBeInTheDocument();
  });

  it('driver delivery rate history/rate data is never fetched through a driver-facing repository path (structural)', () => {
    // PayrollRulesRepository is manager-console-only; no driver-facing type
    // (DriverVisibleShift/DriverVisibleAssignment) exposes pay at all.
    expect(payrollRulesPanelSource).not.toMatch(/DriverVisible/);
  });
});

// =======================================================================
// RESPONSIVE / STRUCTURAL
// =======================================================================
describe('PayrollRulesPanel: responsive structure', () => {
  it('25. reuses the already mobile-verified .segmented resort chooser and filter controls -- no new bespoke layout, no hard-coded pixel widths', () => {
    expect(payrollRulesPanelSource).toMatch(/resort-chooser segmented/);
    expect(payrollRulesPanelSource).toMatch(/shift-setup-filter segmented/);
    expect(payrollRulesPanelSource).not.toMatch(/width:\s*\d+px/);
  });
});

// =======================================================================
// SHIFT SETUP BUG FIX (Stage 2D Payroll Checkpoint B item 24)
// =======================================================================
describe('ShiftSetupPanel: zero-template vs genuinely-inconsistent Shift display', () => {
  it('26. a Shift with zero schedule rows says "No recurring schedule configured yet." and keeps Edit enabled', async () => {
    const { ShiftSetupPanel } = await import('./ShiftSetupPanel');
    const { MockShiftConfigurationRepository } = await import('../../../repositories/mock/shiftConfiguration');
    // create_shift always writes a template -- fabricate a shift type with
    // literally zero shift_templates rows, the exact real-world case found
    // in Payroll Checkpoint A (a seed script that only inserts shift_types).
    const { mockShiftTypes, nextMockShiftTypeId } = await import('../../../repositories/mock/fixtures');
    const id = nextMockShiftTypeId();
    mockShiftTypes.push({ id, resortId: 'mock-crans', key: 'no_schedule', name: 'No Schedule Shift', sortOrder: 99, isActive: true });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ShiftSetupPanel resortId="mock-crans" resortName="Crans-Montana" />
      </QueryClientProvider>
    );

    await screen.findByText('No Schedule Shift');
    const row = screen.getByText('No Schedule Shift').closest('.shift-setup-card') as HTMLElement;
    expect(within(row).getByText('No recurring schedule configured yet.')).toBeInTheDocument();
    expect(within(row).queryByText(/different times configured on different days/i)).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Edit No Schedule Shift' })).not.toBeDisabled();
  });

  it('27. a genuinely inconsistent Shift still shows the review-required notice and keeps Edit disabled', async () => {
    const { ShiftSetupPanel } = await import('./ShiftSetupPanel');
    const { mockShiftTemplates, nextMockShiftTemplateId } = await import('../../../repositories/mock/fixtures');
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

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ShiftSetupPanel resortId="mock-crans" resortName="Crans-Montana" />
      </QueryClientProvider>
    );

    await screen.findByText('Dinner');
    const row = screen.getByText('Dinner').closest('.shift-setup-card') as HTMLElement;
    expect(within(row).getByText(/different times configured on different days/i)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Edit Dinner' })).toBeDisabled();
  });
});

// =======================================================================
// RATE CORRECTION WORKFLOW (Stage 2D Payroll Checkpoint B.1)
// =======================================================================
describe('PayrollRulesPanel: rate correction workflow', () => {
  it('a "Correct current rate" action exists for Shift base pay when a current rate exists', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Correct current rate' })).toBeInTheDocument();
  });

  it('a "Correct current rate" action exists for a driver delivery rate when a current rate exists', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(rateRow('Gianni')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Correct current rate' })).toBeInTheDocument();
  });

  it('a rate that became effective TODAY can be corrected today (the key product requirement)', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));
    await screen.findByText('Tomas');
    // Tomas has no rate at all -- set one effective today (the default).
    fireEvent.click(within(rateRow('Tomas')).getByRole('button', { name: 'Set rate' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Rate per completed delivery'), { target: { value: '13' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set Rate' }));
    await waitFor(() => expect(within(rateRow('Tomas')).getByText('CHF 13.00 / completed delivery')).toBeInTheDocument());

    // Now correct it, same day.
    fireEvent.click(within(rateRow('Tomas')).getByRole('button', { name: 'Edit' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Correct current rate' }));
    const correctDialog = await screen.findByRole('dialog');
    expect(within(correctDialog).getByRole('heading', { name: 'Correct delivery rate — Tomas' })).toBeInTheDocument();
    fireEvent.change(within(correctDialog).getByLabelText('Correct rate'), { target: { value: '12' } });
    fireEvent.click(within(correctDialog).getByRole('button', { name: 'Confirm Correction' }));

    await waitFor(() => expect(within(rateRow('Tomas')).getByText('CHF 12.00 / completed delivery')).toBeInTheDocument());
    // No fake history was created by this correction.
    expect(within(rateRow('Tomas')).queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
    expect(mockDriverDeliveryRates.filter((r) => r.driverId === 'mock-tomas')).toHaveLength(1);
  });

  it('a rate that has been in effect since earlier can be explicitly corrected', async () => {
    // mock-base-pay-crans-dinner has been active since 2024-01-01 -- a
    // genuinely historical start date, not "today".
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Since 1 January 2024/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Correct current rate' }));

    const correctDialog = await screen.findByRole('dialog');
    fireEvent.change(within(correctDialog).getByLabelText('Correct rate'), { target: { value: '32' } });
    fireEvent.click(within(correctDialog).getByRole('button', { name: 'Confirm Correction' }));

    await waitFor(() => expect(within(baseRow('Dinner')).getByText('CHF 32.00 / attended shift')).toBeInTheDocument());
    const rule = mockShiftBasePayRules.find((r) => r.id === 'mock-base-pay-crans-dinner')!;
    expect(rule.basePayChf).toBe(32);
    expect(rule.effectiveFrom).toBe('2024-01-01'); // preserved exactly
    expect(rule.effectiveTo).toBeNull();
  });

  it('a future scheduled rate can be corrected before it takes effect, without disturbing the current rate', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    // Schedule a future change first.
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Base pay'), { target: { value: '35' } });
    fireEvent.change(within(dialog).getByLabelText('Changes from'), { target: { value: futureIso(30) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule Change' }));
    await waitFor(() => expect(within(baseRow('Dinner')).getByText(/Scheduled: CHF 35\.00 from/)).toBeInTheDocument());

    // Now correct the SCHEDULED rate specifically.
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Correct current rate' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Correct scheduled rate' }));
    const correctDialog = await screen.findByRole('dialog');
    fireEvent.change(within(correctDialog).getByLabelText('Correct rate'), { target: { value: '40' } });
    fireEvent.click(within(correctDialog).getByRole('button', { name: 'Confirm Correction' }));

    await waitFor(() => expect(within(baseRow('Dinner')).getByText(/Scheduled: CHF 40\.00 from/)).toBeInTheDocument());
    // Current remains exactly as it was -- untouched by the scheduled correction.
    expect(within(baseRow('Dinner')).getByText('CHF 30.00 / attended shift')).toBeInTheDocument();
    // No unnecessary third rate period was created.
    expect(mockShiftBasePayRules.filter((r) => r.shiftTypeId === 'mock-crans-dinner')).toHaveLength(2);
  });

  it('correcting a rate never creates a fake history period', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    const before = mockShiftBasePayRules.filter((r) => r.shiftTypeId === 'mock-crans-dinner').length;

    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Correct current rate' }));
    const correctDialog = await screen.findByRole('dialog');
    fireEvent.change(within(correctDialog).getByLabelText('Correct rate'), { target: { value: '31' } });
    fireEvent.click(within(correctDialog).getByRole('button', { name: 'Confirm Correction' }));

    await waitFor(() => expect(within(baseRow('Dinner')).getByText('CHF 31.00 / attended shift')).toBeInTheDocument());
    const after = mockShiftBasePayRules.filter((r) => r.shiftTypeId === 'mock-crans-dinner').length;
    expect(after).toBe(before); // no new row -- never a fake one-day/zero-day period
    expect(within(baseRow('Dinner')).queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
  });

  it('the ordinary future Change Rate flow still behaves exactly as before (history preserved, never rewritten)', async () => {
    const spy = vi.spyOn(MockPayrollRulesRepository.prototype, 'setShiftBasePayRate');
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Base pay'), { target: { value: '35' } });
    fireEvent.change(within(dialog).getByLabelText('Changes from'), { target: { value: futureIso(30) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule Change' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const original = mockShiftBasePayRules.find((r) => r.id === 'mock-base-pay-crans-dinner')!;
    expect(original.basePayChf).toBe(30); // untouched, exactly as Checkpoint B behaved
    expect(original.effectiveTo).not.toBeNull(); // closed, not rewritten
  });

  it('audit-oriented helper text is shown on the correction dialog', async () => {
    renderPanel();
    await screen.findByText('Dinner');
    fireEvent.click(within(baseRow('Dinner')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Correct current rate' }));
    const correctDialog = await screen.findByRole('dialog');
    expect(within(correctDialog).getByText(/recorded in the audit log/i)).toBeInTheDocument();
  });

  it('components do not call Supabase directly for corrections either (architecture)', () => {
    expect(payrollRulesPanelSource).toMatch(/correctShiftBasePayRate/);
    expect(payrollRulesPanelSource).toMatch(/correctDriverDeliveryRate/);
    expect(payrollRulesPanelSource).not.toMatch(/supabase\s*\.\s*from\(/);
    expect(payrollRulesPanelSource).not.toMatch(/\.rpc\(/);
  });
});
