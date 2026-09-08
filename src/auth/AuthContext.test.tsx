// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../lib/env');
  vi.doUnmock('../lib/supabase/client');
});

function makeProbe(useAuth: typeof import('./AuthContext').useAuth) {
  return function Probe() {
    const { role, currentUser, isAuthenticated, loading } = useAuth();
    return (
      <div data-testid="probe">
        {JSON.stringify({
          loading,
          isAuthenticated,
          role,
          driverId: currentUser?.role === 'driver' ? currentUser.driverId : null,
        })}
      </div>
    );
  };
}

describe('AuthContext: mock-vs-Supabase selection', () => {
  it('mock mode: useAuth() derives its value from AppStateContext, no AuthProvider needed', async () => {
    vi.doMock('../lib/env', () => ({ getDataProvider: () => 'mock' }));
    const { AppStateProvider } = await import('../state/AppStateContext');
    const { useAuth } = await import('./AuthContext');
    const Probe = makeProbe(useAuth);

    render(
      <AppStateProvider>
        <Probe />
      </AppStateProvider>
    );

    const parsed = JSON.parse(screen.getByTestId('probe').textContent!);
    // Stage 1.1's AppStateContext defaults to role='manager'.
    expect(parsed).toMatchObject({ loading: false, isAuthenticated: true, role: 'manager' });
  });

  it('mock mode: useAuth() throws nothing even without a real AuthProvider (AppStateProvider alone is enough)', async () => {
    vi.doMock('../lib/env', () => ({ getDataProvider: () => 'mock' }));
    const { AppStateProvider } = await import('../state/AppStateContext');
    const { useAuth } = await import('./AuthContext');
    const Probe = makeProbe(useAuth);
    expect(() =>
      render(
        <AppStateProvider>
          <Probe />
        </AppStateProvider>
      )
    ).not.toThrow();
  });

  it('Supabase mode: useAuth() outside AuthProvider throws a clear error rather than silently returning a mock-shaped value', async () => {
    vi.doMock('../lib/env', () => ({ getDataProvider: () => 'supabase' }));
    const { AppStateProvider } = await import('../state/AppStateContext');
    const { useAuth } = await import('./AuthContext');
    const Probe = makeProbe(useAuth);
    const orig = console.error;
    console.error = () => {}; // React logs the thrown render error; keep test output clean
    expect(() =>
      render(
        <AppStateProvider>
          <Probe />
        </AppStateProvider>
      )
    ).toThrow(/useAuth must be used within AuthProvider/);
    console.error = orig;
  });
});

describe('AuthContext: Supabase session resolution + role', () => {
  async function mockedClient(rpcResponse: unknown, sessionUser: { id: string; email: string } | null) {
    let changeListener: ((event: string, session: unknown) => void) | null = null;
    const session = sessionUser ? { user: sessionUser } : null;
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session } }),
        onAuthStateChange: vi.fn().mockImplementation((cb) => {
          changeListener = cb;
          return { data: { subscription: { unsubscribe: vi.fn() } } };
        }),
        signOut: vi.fn().mockResolvedValue({ error: null }),
      },
      rpc: vi.fn().mockResolvedValue({ data: rpcResponse, error: null }),
    };
    return { client, fireChange: (event: string) => changeListener?.(event, session) };
  }

  it('starts loading, then resolves to the manager identity from current_app_user()', async () => {
    vi.doMock('../lib/env', () => ({ getDataProvider: () => 'supabase' }));
    const { client } = await mockedClient(
      { role: 'manager', driver_id: null, resort_id: null, is_active: true },
      { id: 'auth-1', email: 'manager@vd-scheduler.local' }
    );
    vi.doMock('../lib/supabase/client', () => ({ getSupabaseClient: () => client }));

    const { AppStateProvider } = await import('../state/AppStateContext');
    const { AuthProvider, useAuth } = await import('./AuthContext');
    const Probe = makeProbe(useAuth);

    render(
      <AppStateProvider>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </AppStateProvider>
    );

    await waitFor(() => {
      const parsed = JSON.parse(screen.getByTestId('probe').textContent!);
      expect(parsed).toMatchObject({ loading: false, isAuthenticated: true, role: 'manager' });
    });
  });

  it('resolves the driver identity (driverId/resortId), never trusting client-side state for it', async () => {
    vi.doMock('../lib/env', () => ({ getDataProvider: () => 'supabase' }));
    const { client } = await mockedClient(
      { role: 'driver', driver_id: 'driver-xyz', resort_id: 'resort-xyz', is_active: true },
      { id: 'auth-2', email: 'gianni@vd-scheduler.local' }
    );
    vi.doMock('../lib/supabase/client', () => ({ getSupabaseClient: () => client }));

    const { AppStateProvider } = await import('../state/AppStateContext');
    const { AuthProvider, useAuth } = await import('./AuthContext');
    const Probe = makeProbe(useAuth);

    render(
      <AppStateProvider>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </AppStateProvider>
    );

    await waitFor(() => {
      const parsed = JSON.parse(screen.getByTestId('probe').textContent!);
      expect(parsed).toMatchObject({ role: 'driver', driverId: 'driver-xyz' });
    });
  });

  it('an unauthenticated session (no user) resolves to isAuthenticated=false with no role', async () => {
    vi.doMock('../lib/env', () => ({ getDataProvider: () => 'supabase' }));
    const { client } = await mockedClient(null, null);
    vi.doMock('../lib/supabase/client', () => ({ getSupabaseClient: () => client }));

    const { AppStateProvider } = await import('../state/AppStateContext');
    const { AuthProvider, useAuth } = await import('./AuthContext');
    const Probe = makeProbe(useAuth);

    render(
      <AppStateProvider>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </AppStateProvider>
    );

    await waitFor(() => {
      const parsed = JSON.parse(screen.getByTestId('probe').textContent!);
      expect(parsed).toMatchObject({ loading: false, isAuthenticated: false, role: null });
    });
  });
});

describe('AuthContext: logout clears the query cache', () => {
  it('signOut() clears TanStack Query cache in Supabase mode', async () => {
    vi.doMock('../lib/env', () => ({ getDataProvider: () => 'supabase' }));
    const signOutMock = vi.fn().mockResolvedValue({ error: null });
    const client = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
        onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
        signOut: signOutMock,
      },
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    vi.doMock('../lib/supabase/client', () => ({ getSupabaseClient: () => client }));

    const { queryClient } = await import('../lib/queryClient');
    const clearSpy = vi.spyOn(queryClient, 'clear');

    const { AppStateProvider } = await import('../state/AppStateContext');
    const { AuthProvider, useAuth } = await import('./AuthContext');

    let signOutFn: (() => Promise<void>) | null = null;
    function Capture() {
      const { signOut, loading } = useAuth();
      signOutFn = signOut;
      return <div data-testid="ready">{String(!loading)}</div>;
    }

    render(
      <AppStateProvider>
        <AuthProvider>
          <Capture />
        </AuthProvider>
      </AppStateProvider>
    );

    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    await signOutFn!();

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalled();
  });

  it('mock mode: signOut() delegates to AppStateContext.logout()', async () => {
    vi.doMock('../lib/env', () => ({ getDataProvider: () => 'mock' }));
    const { AppStateProvider } = await import('../state/AppStateContext');
    const { useAuth } = await import('./AuthContext');

    let signOutFn: (() => Promise<void>) | null = null;
    function Capture() {
      const { signOut, isAuthenticated } = useAuth();
      signOutFn = signOut;
      return <div data-testid="state">{String(isAuthenticated)}</div>;
    }

    render(
      <AppStateProvider>
        <Capture />
      </AppStateProvider>
    );

    expect(screen.getByTestId('state').textContent).toBe('true');
    await signOutFn!();
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('false'));
  });
});
