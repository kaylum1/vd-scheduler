// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../state/AppStateContext';
import { AuthProvider } from './AuthContext';
import { getMockActingDriverId, setMockActingDriver } from '../repositories/mock/session';
import { drivers } from '../mock-data/drivers';
import { resetMockFixturesForTesting } from '../repositories/mock/fixtures';
import authSource from './AuthContext.tsx?raw';

let app: ReturnType<typeof useAppState>;
function Capture() {
  app = useAppState();
  return null;
}
const mount = () =>
  render(
    <AppStateProvider>
      <AuthProvider>
        <Capture />
      </AuthProvider>
    </AppStateProvider>,
  );

beforeEach(() => {
  resetMockFixturesForTesting();
});
afterEach(() => {
  cleanup();
  setMockActingDriver(null);
});

describe('MockActingDriverBridge (mock mode)', () => {
  it('a manager is not an acting driver', () => {
    mount();
    expect(getMockActingDriverId()).toBeNull();
  });

  it('follows the Driver switch to the REPOSITORY id, and follows a driver change', () => {
    mount();
    act(() => app.setRole('driver'));
    act(() => app.setActiveDriverId('gianni'));
    expect(getMockActingDriverId()).toBe('mock-gianni');
    const other = drivers.find((d) => d.id !== 'gianni')!;
    act(() => app.setActiveDriverId(other.id));
    expect(getMockActingDriverId()).not.toBe('mock-gianni');
    expect(getMockActingDriverId()).toMatch(/^mock-/);
  });

  it('clears when switching back to manager and on logout', () => {
    mount();
    act(() => app.setRole('driver'));
    act(() => app.setActiveDriverId('gianni'));
    expect(getMockActingDriverId()).toBe('mock-gianni');
    act(() => app.setRole('manager'));
    expect(getMockActingDriverId()).toBeNull();
    act(() => app.setRole('driver'));
    expect(getMockActingDriverId()).toBe('mock-gianni');
    act(() => app.logout());
    expect(getMockActingDriverId()).toBeNull();
  });

  it('clears on unmount', () => {
    const { unmount } = mount();
    act(() => app.setRole('driver'));
    act(() => app.setActiveDriverId('gianni'));
    unmount();
    expect(getMockActingDriverId()).toBeNull();
  });

  it('is mounted only in the mock branch of AuthProvider -- Supabase mode never touches the mock session', () => {
    const provider = authSource.slice(authSource.indexOf('export function AuthProvider'));
    const mockBranch = provider.slice(0, provider.indexOf("return <SupabaseAuthProviderInner"));
    expect(mockBranch).toContain('<MockActingDriverBridge />');
    expect(provider.slice(provider.indexOf("return <SupabaseAuthProviderInner"), provider.indexOf('function SupabaseAuthProviderInner'))).not.toContain('MockActingDriverBridge');
  });
});
