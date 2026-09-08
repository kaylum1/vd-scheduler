// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
import App from './App';

/**
 * Exercises the real route guard in App.tsx (RouteOutlet) end to end,
 * through the actual App component tree — not a re-implementation of the
 * guard logic elsewhere. Runs in mock mode (VITE_DATA_PROVIDER defaults to
 * 'mock' when unset, which is the case for this test file), using the
 * existing RoleSwitcher to change role, exactly as a developer would.
 */
describe('App: role-based route guarding', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  afterEach(() => {
    window.location.hash = '';
  });

  it('a driver session cannot reach a manager URL — it is redirected to its own home', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    );

    // Default role is 'manager' — switch to Driver via the existing dev
    // RoleSwitcher control, same as a reviewer would.
    const driverTab = await screen.findByRole('tab', { name: 'Driver' });
    driverTab.click();

    await waitFor(() => expect(window.location.hash).toBe('#/driver/my-rota'));

    // Now try to reach a manager-only URL directly (as if typed in the
    // address bar).
    window.location.hash = '/manager/dashboard';

    await waitFor(() => expect(window.location.hash).toBe('#/driver/my-rota'));
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'My Rota' })).toBeInTheDocument();
  });

  it('a manager session can reach manager routes', async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    );

    await waitFor(() => expect(window.location.hash).toBe('#/manager/dashboard'));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });
});
