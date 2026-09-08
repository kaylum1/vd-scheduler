import React, { createContext, useContext, useMemo, useState } from 'react';
import type { UserRole } from '../types';
import { drivers } from '../mock-data/drivers';
import { getDataProvider } from '../lib/env';
import { getSupabaseClient } from '../lib/supabase/client';
import { queryClient } from '../lib/queryClient';

/**
 * Stage 1 stand-in for authentication: lets the reviewer flip between the
 * Manager and Driver interface states, and pick which driver is "signed
 * in". A real auth/session layer replaces this entirely later — no other
 * component should assume this context's shape survives that change.
 *
 * Stage 2B note: `logout()` is the one place this shim now talks to real
 * auth. In Supabase mode it performs a real sign-out (and clears the
 * query cache, so one driver's cached data never stays visible to
 * whoever signs in next) instead of the mock isLoggedOut toggle — Sidebar
 * and every other existing caller of `logout()` need no changes for
 * this. Role/driver-scoped UI now reads `useAuth()` instead of this
 * context where it matters for real access control (see Sidebar) —
 * `role`/`activeDriverId` here remain the mock-only switchable state.
 */

interface AppStateValue {
  role: UserRole;
  setRole: (role: UserRole) => void;
  activeDriverId: string;
  setActiveDriverId: (id: string) => void;
  isLoggedOut: boolean;
  logout: () => void;
  logBackIn: () => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [role, setRole] = useState<UserRole>('manager');
  const [activeDriverId, setActiveDriverId] = useState<string>(drivers[0].id);
  const [isLoggedOut, setIsLoggedOut] = useState(false);

  const value = useMemo(
    () => ({
      role,
      setRole,
      activeDriverId,
      setActiveDriverId,
      isLoggedOut,
      logout: () => {
        if (getDataProvider() === 'supabase') {
          void getSupabaseClient()
            .auth.signOut()
            .then(() => queryClient.clear());
          return;
        }
        setIsLoggedOut(true);
      },
      logBackIn: () => setIsLoggedOut(false),
    }),
    [role, activeDriverId, isLoggedOut]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}
