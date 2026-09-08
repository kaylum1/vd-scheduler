// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { RecurringScheduleCard } from './RecurringScheduleCard';
import { ResortShiftSetupPanel } from './ResortShiftSetupPanel';
import { resetRepositoriesForTesting } from '../../../repositories';
import { resetMockFixturesForTesting } from '../../../repositories/mock/fixtures';
import { MockShiftConfigurationRepository } from '../../../repositories/mock/shiftConfiguration';
import { RepositoryError } from '../../../repositories/errors';
import recurringScheduleCardSource from './RecurringScheduleCard.tsx?raw';

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
  vi.useRealTimers();
});

/**
 * RTL's default getByText matcher only looks at an element's own direct
 * text-node children, not full nested textContent — so a sentence split
 * across a <strong> (e.g. "<strong>1</strong> shift will be cancelled...")
 * never matches a pattern spanning both. This matches on the full
 * textContent of the given tag instead.
 */
function elementTextMatching(tag: string, pattern: RegExp) {
  return (_content: string, element: Element | null) =>
    Boolean(element && element.tagName.toLowerCase() === tag && pattern.test(element.textContent ?? ''));
}

/** Adds a "Dinner"/"Lunch"-style shift type at Verbier (which starts with none), for tests that need a clean slate to add days to. */
async function addVerbierShiftType(key: string, name: string) {
  const repo = new MockShiftConfigurationRepository();
  return repo.createShiftType({ resortId: 'mock-verbier', key, name, sortOrder: 1 });
}

describe('RecurringScheduleCard: schedule list + resort scoping', () => {
  it('1. the schedule is scoped by resort — Crans-Montana shows only its own fixture (Monday Dinner)', async () => {
    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    expect(await screen.findByText('Dinner')).toBeInTheDocument();
    expect(await screen.findByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('18:00–21:30', { exact: false })).toBeInTheDocument();
  });

  it('2. Verbier (no shift types at all) shows a neutral empty state', async () => {
    renderWithQueryClient(<RecurringScheduleCard resortId="mock-verbier" resortName="Verbier" />);
    expect(await screen.findByText('No shift types configured yet')).toBeInTheDocument();
  });

  it('12. switching resort in ResortShiftSetupPanel updates the recurring schedule shown', async () => {
    renderWithQueryClient(<ResortShiftSetupPanel />);
    await screen.findByRole('tab', { name: /Crans-Montana/ });

    await waitFor(() => expect(screen.getByText(/Recurring shift schedule — Crans-Montana/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /Verbier/ }));
    await waitFor(() => expect(screen.getByText(/Recurring shift schedule — Verbier/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('No shift types configured yet')).toBeInTheDocument());
  });

  it('13: no active templates for a shift type reads as neutral "No recurring shifts configured", never an uncovered/coverage warning', async () => {
    await addVerbierShiftType('dinner', 'Dinner');
    renderWithQueryClient(<RecurringScheduleCard resortId="mock-verbier" resortName="Verbier" />);
    expect(await screen.findByText('No recurring shifts configured.')).toBeInTheDocument();
    expect(screen.queryByText(/uncovered/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no coverage/i)).not.toBeInTheDocument();
  });
});

describe('RecurringScheduleCard: add a recurring day', () => {
  it('3/5/6/7/8: creating a day persists weekday, headcount, pay, delivery rate and high-value together', async () => {
    await addVerbierShiftType('dinner', 'Dinner');
    renderWithQueryClient(<RecurringScheduleCard resortId="mock-verbier" resortName="Verbier" />);
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: /Add day/i }));
    fireEvent.change(await screen.findByLabelText('Day of week'), { target: { value: '0' } }); // Monday
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '18:00' } });
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '21:30' } });
    fireEvent.change(screen.getByLabelText('Required drivers'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Base pay (CHF)'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Delivery rate (CHF)'), { target: { value: '12' } });
    fireEvent.click(screen.getByLabelText(/High-value shift/));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add day' }));

    await waitFor(() => expect(screen.getByText('Mon')).toBeInTheDocument());
    expect(screen.getByText('18:00–21:30', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('1 driver')).toBeInTheDocument();
    expect(screen.getByText(/CHF 30\.00 base \/ CHF 12\.00 delivery/)).toBeInTheDocument();
    expect(screen.getByText('High-value')).toBeInTheDocument();
  });

  it('4: a second shift type (Lunch) can have its own day (Saturday) independent of Dinner', async () => {
    await addVerbierShiftType('dinner', 'Dinner');
    await addVerbierShiftType('lunch', 'Lunch');
    renderWithQueryClient(<RecurringScheduleCard resortId="mock-verbier" resortName="Verbier" />);
    await screen.findByText('Lunch');

    const lunchSection = screen.getByText('Lunch').closest('.schedule-section') as HTMLElement;
    fireEvent.click(within(lunchSection).getByRole('button', { name: /Add day/i }));
    fireEvent.change(await screen.findByLabelText('Day of week'), { target: { value: '5' } }); // Saturday
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '12:00' } });
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '14:30' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add day' }));

    await waitFor(() => expect(within(lunchSection).getByText('Sat')).toBeInTheDocument());
    const dinnerSection = screen.getByText('Dinner').closest('.schedule-section') as HTMLElement;
    expect(within(dinnerSection).queryByText('Sat')).not.toBeInTheDocument();
  });

  it('9: weekday is always shown as a name (Mon/Monday), never a bare integer', async () => {
    await addVerbierShiftType('dinner', 'Dinner');
    renderWithQueryClient(<RecurringScheduleCard resortId="mock-verbier" resortName="Verbier" />);
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: /Add day/i }));
    const weekdaySelect = (await screen.findByLabelText('Day of week')) as HTMLSelectElement;
    // Every visible option text is a weekday name, never a bare digit.
    for (const option of Array.from(weekdaySelect.options)) {
      if (option.disabled) continue;
      expect(option.textContent).toMatch(/^[A-Za-z]+$/);
    }
    fireEvent.change(weekdaySelect, { target: { value: '0' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add day' }));

    await waitFor(() => expect(screen.getByText('Mon')).toBeInTheDocument());
    expect(screen.queryByText('0', { selector: '.schedule-day__weekday' })).not.toBeInTheDocument();
  });

  it('10: effective dates are shown in a readable long form, never a raw ISO string', async () => {
    // Deliberately not using fake timers here -- @testing-library's
    // findBy/waitFor polling relies on real timers, and vi.useFakeTimers()
    // makes them hang instead of resolving against the frozen clock. The
    // requirement under test (long, readable form) doesn't need a pinned
    // date -- just proving the effective-from text is NOT the raw
    // "YYYY-MM-DD" the repository returns, and DOES read like a real date.
    await addVerbierShiftType('dinner', 'Dinner');
    renderWithQueryClient(<RecurringScheduleCard resortId="mock-verbier" resortName="Verbier" />);
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: /Add day/i }));
    fireEvent.change(await screen.findByLabelText('Day of week'), { target: { value: '0' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add day' }));

    const effectiveText = await screen.findByText(/^From \d{1,2} [A-Za-z]+ \d{4}/);
    expect(effectiveText).toBeInTheDocument();
    expect(effectiveText.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/); // never the raw ISO form
  });

  it('11: an overlap error surfaces the friendly, specific message inside the form, not a raw constraint name', async () => {
    vi.spyOn(MockShiftConfigurationRepository.prototype, 'createShiftTemplateVersion').mockRejectedValueOnce(
      new RepositoryError('conflicting key value violates exclusion constraint', { operation: 'x', code: '23P01' })
    );
    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: /Add day/i }));
    fireEvent.change(await screen.findByLabelText('Day of week'), { target: { value: '1' } }); // Tuesday -- free
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add day' }));

    expect(await screen.findByText(/There is already a Dinner schedule covering Tuesday for these dates\./)).toBeInTheDocument();
    expect(screen.queryByText(/exclusion constraint/i)).not.toBeInTheDocument();
  });

  it('revising a version that itself starts in the future defaults to a date after *that* start, not just tomorrow (regression: found in Checkpoint 2 manual testing — the naive "tomorrow" default produced effective_to < effective_from on the version being closed)', async () => {
    const repo = new MockShiftConfigurationRepository();
    // mock-crans-dinner's baseline fixture already starts 2024-01-01 (safely
    // in the past); revise it once to a version starting well in the future,
    // simulating "the current version itself hasn't taken effect yet".
    await repo.deactivateShiftTemplate('mock-crans-dinner-tpl', '2099-01-01');
    await repo.createShiftTemplateVersion({
      shiftTypeId: 'mock-crans-dinner',
      resortId: 'mock-crans',
      weekday: 0,
      startTime: '18:00',
      endTime: '21:30',
      requiredDrivers: 1,
      basePayChf: 30,
      deliveryRateChf: 12,
      effectiveFrom: '2099-01-02', // "the future" relative to any real test-run date
      isPremium: false,
    });

    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');
    await screen.findByText(/From 2 January 2099/);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Dinner Monday' }));
    const effectiveFromInput = (await screen.findByLabelText('Effective from')) as HTMLInputElement;
    expect(effectiveFromInput.min).toBe('2099-01-03'); // strictly after the version being replaced, not "tomorrow"
    expect(effectiveFromInput.value).toBe('2099-01-03'); // and defaults there too

    // Submitting the unmodified default must not hit the effective-date-
    // ordering constraint the naive "tomorrow" default used to violate.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save new version' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(/must be after the current version started/i)).not.toBeInTheDocument();
  });
});

describe('RecurringScheduleCard: materialisation', () => {
  it('14/15: "Generate upcoming shifts" calls the repository and shows the result', async () => {
    const spy = vi
      .spyOn(MockShiftConfigurationRepository.prototype, 'materialiseShifts')
      .mockResolvedValue({ createdCount: 42, skippedExistingCount: 14, fromDate: '2026-01-01', toDate: '2026-02-28' });

    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: 'Generate upcoming shifts' }));

    expect(await screen.findByText('42 shifts created. 14 already existed.')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith('mock-crans');
  });

  it('16: generating twice replaces the notice rather than stacking duplicate banners', async () => {
    const spy = vi
      .spyOn(MockShiftConfigurationRepository.prototype, 'materialiseShifts')
      .mockResolvedValueOnce({ createdCount: 10, skippedExistingCount: 0, fromDate: '2026-01-01', toDate: '2026-02-28' })
      .mockResolvedValueOnce({ createdCount: 0, skippedExistingCount: 10, fromDate: '2026-01-01', toDate: '2026-02-28' });

    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');

    fireEvent.click(screen.getByRole('button', { name: 'Generate upcoming shifts' }));
    await screen.findByText('10 shifts created. 0 already existed.');

    fireEvent.click(screen.getByRole('button', { name: 'Generate upcoming shifts' }));
    await screen.findByText('0 shifts created. 10 already existed.');

    expect(screen.queryByText('10 shifts created. 0 already existed.')).not.toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('RecurringScheduleCard: review schedule updates (refresh preview/apply)', () => {
  it('17/19: a pay-only change is listed, with no availability-reopen warning', async () => {
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
        changedFields: { base_pay_chf: { old: 30, new: 35 } },
        assignmentCount: 1,
        currentRequiredDrivers: 1,
        newRequiredDrivers: 1,
        wouldBeOverassigned: false,
        timeWouldChange: false,
      },
    ]);

    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Review schedule updates' }));

    expect(await screen.findByText(/Base pay: CHF 30\.00 → CHF 35\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/reopen confirmed driver availability/i)).not.toBeInTheDocument();
  });

  it('18: a start/end time change shows the availability-reopen warning', async () => {
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
        currentRequiredDrivers: 1,
        newRequiredDrivers: 1,
        wouldBeOverassigned: false,
        timeWouldChange: true,
      },
    ]);

    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Review schedule updates' }));

    expect(await screen.findByText(/reopen confirmed driver availability/i)).toBeInTheDocument();
  });

  it('20: an over-assigned consequence is flagged', async () => {
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
        changedFields: { required_drivers: { old: 2, new: 1 } },
        assignmentCount: 2,
        currentRequiredDrivers: 2,
        newRequiredDrivers: 1,
        wouldBeOverassigned: true,
        timeWouldChange: false,
      },
    ]);

    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Review schedule updates' }));

    expect(await screen.findByText(/over-assigned/i)).toBeInTheDocument();
  });

  it('21: applying the refresh requires an explicit click — it never fires just from opening the preview', async () => {
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
        changedFields: { base_pay_chf: { old: 30, new: 35 } },
        assignmentCount: 0,
        currentRequiredDrivers: 1,
        newRequiredDrivers: 1,
        wouldBeOverassigned: false,
        timeWouldChange: false,
      },
    ]);
    const applySpy = vi
      .spyOn(MockShiftConfigurationRepository.prototype, 'applyTemplateRefresh')
      .mockResolvedValue({ updatedCount: 1, overassignedCount: 0, overassignedShiftInstanceIds: [], reopenedSubmissionCount: 0 });

    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');
    fireEvent.click(screen.getByRole('button', { name: 'Review schedule updates' }));
    await screen.findByText(/Base pay/);

    expect(applySpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Apply to 1 shift/ }));
    await waitFor(() => expect(applySpy).toHaveBeenCalledWith('mock-crans'));
    expect(await screen.findByText(/1 shift updated/)).toBeInTheDocument();
  });
});

describe('RecurringScheduleCard: ending a recurring service', () => {
  it('22/23: ending a template previews cancellation, and applying requires an explicit second confirmation', async () => {
    const previewSpy = vi.spyOn(MockShiftConfigurationRepository.prototype, 'previewTemplateCancellation').mockResolvedValue([
      {
        shiftInstanceId: 'si1',
        date: '2026-02-09',
        shiftTypeId: 'mock-crans-dinner',
        shiftKey: 'dinner',
        name: 'Dinner',
        isPublished: false,
        assignmentCount: 0,
        hasAvailabilityAnswers: false,
        hasAttendance: false,
        isSafeToCancel: true,
      },
    ]);
    const applySpy = vi
      .spyOn(MockShiftConfigurationRepository.prototype, 'applyTemplateCancellation')
      .mockResolvedValue({ cancelledCount: 1, cancelledShiftInstanceIds: ['si1'] });

    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');
    await screen.findByText('Mon');

    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await screen.findByRole('heading', { name: /End Dinner on Monday\?/ });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'End & review' }));

    await waitFor(() => expect(previewSpy).toHaveBeenCalledWith('mock-crans', 'mock-crans-dinner'));
    expect(await screen.findByText(elementTextMatching('p', /1.*will be cancelled/))).toBeInTheDocument();

    expect(applySpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Cancel 1 shift/ }));
    await waitFor(() => expect(applySpy).toHaveBeenCalled());
    expect(await screen.findByText(/1 affected shift cancelled/)).toBeInTheDocument();
  });

  it('24: protected (published/attended) rows are reported as excluded, not silently dropped', async () => {
    vi.spyOn(MockShiftConfigurationRepository.prototype, 'previewTemplateCancellation').mockResolvedValue([
      {
        shiftInstanceId: 'si1',
        date: '2026-02-09',
        shiftTypeId: 'mock-crans-dinner',
        shiftKey: 'dinner',
        name: 'Dinner',
        isPublished: false,
        assignmentCount: 0,
        hasAvailabilityAnswers: false,
        hasAttendance: false,
        isSafeToCancel: true,
      },
      {
        shiftInstanceId: 'si2',
        date: '2026-02-16',
        shiftTypeId: 'mock-crans-dinner',
        shiftKey: 'dinner',
        name: 'Dinner',
        isPublished: true,
        assignmentCount: 1,
        hasAvailabilityAnswers: true,
        hasAttendance: false,
        isSafeToCancel: false,
      },
    ]);

    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');
    await screen.findByText('Mon');
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await screen.findByRole('heading', { name: /End Dinner on Monday\?/ });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'End & review' }));

    expect(await screen.findByText(/1 shift was not changed/)).toBeInTheDocument();
    expect(screen.getByText(elementTextMatching('p', /1.*will be cancelled/))).toBeInTheDocument();
  });

  it('ending a template when the review step is unsupported (e.g. mock mode) still confirms the end, without an error', async () => {
    vi.spyOn(MockShiftConfigurationRepository.prototype, 'previewTemplateCancellation').mockRejectedValue(
      new RepositoryError('not supported in mock mode', { operation: 'x', code: 'mock_unsupported' })
    );

    renderWithQueryClient(<RecurringScheduleCard resortId="mock-crans" resortName="Crans-Montana" />);
    await screen.findByText('Dinner');
    await screen.findByText('Mon');
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    await screen.findByRole('heading', { name: /End Dinner on Monday\?/ });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'End & review' }));

    expect(await screen.findByText(/Ended\. Reviewing already-scheduled shifts needs Supabase mode\./)).toBeInTheDocument();
  });
});

describe('RecurringScheduleCard: architecture + mobile structure', () => {
  it('25: no direct supabase.from(...)/.rpc(...) calls — everything goes through getRepositories()', () => {
    expect(recurringScheduleCardSource).not.toMatch(/supabase\s*\.\s*from\(/);
    expect(recurringScheduleCardSource).not.toMatch(/\.rpc\(/);
    expect(recurringScheduleCardSource).toMatch(/getRepositories\(\)/);
  });

  it('26: uses the existing responsive form-field/Modal/form-row building blocks, no hard-coded pixel widths', () => {
    expect(recurringScheduleCardSource).toMatch(/className="form-row"/);
    expect(recurringScheduleCardSource).toMatch(/className="form-field/);
    expect(recurringScheduleCardSource).not.toMatch(/width:\s*\d+px/);
  });
});
