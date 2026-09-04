import React, { createContext, useContext, useMemo, useState } from 'react';
import type { UserRole } from '../types';
import { drivers } from '../mock-data/drivers';

/**
 * Stage 1 stand-in for authentication: lets the reviewer flip between the
 * Manager and Driver interface states, and pick which driver is "signed
 * in". A real auth/session layer replaces this entirely later — no other
 * component should assume this context's shape survives that change.
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
      logout: () => setIsLoggedOut(true),
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
