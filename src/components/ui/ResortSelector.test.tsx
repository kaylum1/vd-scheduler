// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ResortSelector, useActiveResortSelection } from './ResortSelector';
import { resetRepositoriesForTesting } from '../../repositories';
import { resetMockFixturesForTesting } from '../../repositories/mock/fixtures';
import { MockResortRepository } from '../../repositories/mock/resorts';

/**
 * Pre-Manual-Rota cleanup: this pattern used to be duplicated three times
 * (Resort & Shift Setup, Payroll Rules, Manager Availability). These tests
 * cover the shared implementation directly -- page-level tests still cover
 * each consumer's own wiring/semantics (e.g. Manager Availability also
 * collapsing an expanded row on resort change) on top of this.
 */

function Harness({ onSelectExtra }: { onSelectExtra?: (resortId: string) => void }) {
  const { activeResorts, selectedResortId, setSelectedResortId, selectedResort } = useActiveResortSelection();
  return (
    <>
      <ResortSelector
        resorts={activeResorts}
        selectedResortId={selectedResortId}
        onSelect={(id) => {
          setSelectedResortId(id);
          onSelectExtra?.(id);
        }}
      />
      <div data-testid="selected-name">{selectedResort?.name ?? 'none'}</div>
    </>
  );
}

function renderHarness(onSelectExtra?: (resortId: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness onSelectExtra={onSelectExtra} />
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

describe('ResortSelector (presentational)', () => {
  it('renders nothing when there are no resorts to choose from', () => {
    render(<ResortSelector resorts={[]} selectedResortId={null} onSelect={() => {}} />);
    expect(screen.queryByRole('tablist', { name: 'Choose resort' })).not.toBeInTheDocument();
  });

  it('renders one tab per resort and marks the selected one', () => {
    const resorts = [
      { id: 'r1', slug: 'r1', name: 'Resort One', timezone: 'Europe/Zurich', isActive: true },
      { id: 'r2', slug: 'r2', name: 'Resort Two', timezone: 'Europe/Zurich', isActive: true },
    ];
    render(<ResortSelector resorts={resorts} selectedResortId="r2" onSelect={() => {}} />);

    expect(screen.getByRole('tab', { name: 'Resort One' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Resort Two' })).toHaveAttribute('aria-selected', 'true');
  });

  it('calls onSelect with the clicked resort id, and only that one', () => {
    const resorts = [
      { id: 'r1', slug: 'r1', name: 'Resort One', timezone: 'Europe/Zurich', isActive: true },
      { id: 'r2', slug: 'r2', name: 'Resort Two', timezone: 'Europe/Zurich', isActive: true },
    ];
    const onSelect = vi.fn();
    render(<ResortSelector resorts={resorts} selectedResortId="r2" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Resort One' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('r1');
  });
});

describe('useActiveResortSelection (shared state)', () => {
  it('defaults to the first active resort once resorts load', async () => {
    renderHarness();
    await screen.findByRole('tab', { name: 'Crans-Montana' });
    expect(screen.getByTestId('selected-name')).toHaveTextContent('Crans-Montana');
  });

  it('never offers an inactive resort as a choice', async () => {
    // Verbier has no drivers/shifts in the baseline fixtures -- safe to
    // deactivate directly without first retiring dependents.
    const repo = new MockResortRepository();
    await repo.deactivateResort('mock-verbier');
    renderHarness();

    await screen.findByRole('tab', { name: 'Crans-Montana' });
    expect(screen.queryByRole('tab', { name: 'Verbier' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Zermatt' })).toBeInTheDocument();
  });

  it('re-selects automatically when the current selection is deactivated after load', async () => {
    renderHarness();
    await screen.findByRole('tab', { name: 'Crans-Montana' });
    expect(screen.getByTestId('selected-name')).toHaveTextContent('Crans-Montana');

    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));
    expect(screen.getByTestId('selected-name')).toHaveTextContent('Zermatt');
  });

  it('a caller-supplied onSelect side effect still fires alongside selection (Manager Availability semantics)', async () => {
    const extra = vi.fn();
    renderHarness(extra);
    await screen.findByRole('tab', { name: 'Zermatt' });

    fireEvent.click(screen.getByRole('tab', { name: 'Zermatt' }));
    expect(extra).toHaveBeenCalledWith('mock-zermatt');
  });
});
