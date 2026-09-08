import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getDataProvider } from '../lib/env';
import { getSupabaseClient } from '../lib/supabase/client';
import { queryClient } from '../lib/queryClient';
import { useAppState } from '../state/AppStateContext';
import { driverById } from '../mock-data/drivers';
import { SupabaseAuthService } from './supabaseAuthService';
import type { AccessDeniedReason, AppRole, AuthErrorInfo, CurrentUser, SignInOutcome } from './types';

export interface AuthContextValue {
  loading: boolean;
  session: Session | null;
  currentUser: CurrentUser | null;
  isAuthenticated: boolean;
  role: AppRole | null;
  accessDeniedReason: AccessDeniedReason | null;
  /** True while the session is a Supabase password-recovery session (the user followed a reset-password email link). */
  isPasswordRecovery: boolean;
  signIn(email: string, password: string): Promise<SignInOutcome>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<{ error: AuthErrorInfo | null }>;
  updatePassword(newPassword: string): Promise<{ error: AuthErrorInfo | null }>;
}

// Only ever populated/consulted in Supabase mode. Mock mode's useAuth()
// value is derived directly from useAppState() instead (see below) — no
// separate provider needed for it, which is what avoids a circular
// dependency between the two contexts (AppStateProvider must be an
// ancestor of this one for mock mode to work at all; a mock-mode-only
// bridge component that itself required an AuthProvider ancestor would
// invert that).
const SupabaseAuthReactContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const provider = getDataProvider();
  // Called unconditionally (rules-of-hooks) — AppStateProvider is always
  // mounted above AuthProvider regardless of data provider, so this never
  // throws even in Supabase mode where its value happens to go unused.
  const appState = useAppState();
  const supabaseValue = useContext(SupabaseAuthReactContext);

  if (provider === 'mock') {
    return buildMockAuthValue(appState);
  }
  if (!supabaseValue) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return supabaseValue;
}

function buildMockAuthValue(appState: ReturnType<typeof useAppState>): AuthContextValue {
  const { role, activeDriverId, isLoggedOut, logout } = appState;
  const isAuthenticated = !isLoggedOut;
  let currentUser: CurrentUser | null = null;
  if (isAuthenticated) {
    currentUser =
      role === 'manager'
        ? { authUserId: 'mock-manager', role: 'manager', driverId: null, resortId: null, email: null }
        : {
            authUserId: `mock-${activeDriverId}`,
            role: 'driver',
            driverId: activeDriverId,
            resortId: driverById(activeDriverId)?.resortId ?? '',
            email: null,
          };
  }

  return {
    loading: false,
    session: null,
    currentUser,
    isAuthenticated,
    role: isAuthenticated ? role : null,
    accessDeniedReason: null,
    isPasswordRecovery: false,
    signIn: async () => {
      throw new Error('signIn() is not available in mock mode — use the Manager/Driver switch instead.');
    },
    signOut: async () => {
      logout();
    },
    requestPasswordReset: async () => {
      throw new Error('requestPasswordReset() is not available in mock mode.');
    },
    updatePassword: async () => {
      throw new Error('updatePassword() is not available in mock mode.');
    },
  };
}

/**
 * Mock mode needs no extra provider (useAuth() reads useAppState()
 * directly, see above) — this mounts the real, stateful Supabase auth
 * provider only when actually needed.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const provider = getDataProvider();
  return provider === 'mock' ? <>{children}</> : <SupabaseAuthProviderInner>{children}</SupabaseAuthProviderInner>;
}

function SupabaseAuthProviderInner({ children }: { children: React.ReactNode }) {
  const serviceRef = useRef<SupabaseAuthService | null>(null);
  if (!serviceRef.current) {
    serviceRef.current = new SupabaseAuthService(getSupabaseClient());
  }
  const service = serviceRef.current;

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [accessDeniedReason, setAccessDeniedReason] = useState<AccessDeniedReason | null>(null);
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false);

  // A sign-in attempt that gets denied internally does its own
  // signInWithPassword -> signOut (see SupabaseAuthService.signIn), which
  // fires SIGNED_IN then SIGNED_OUT on the *global* auth listener below.
  // Without this guard, that transient sequence would flash the global
  // accessDeniedReason (briefly swapping <LoginPage/> for
  // <AccessDeniedScreen/> and back, destroying LoginPage's own local error
  // state before it can render "Incorrect email or password" etc.). A
  // fresh sign-in attempt's outcome belongs to the caller (LoginPage),
  // shown locally — accessDeniedReason/AccessDeniedScreen is only for an
  // *existing* session turning out invalid (page load, token refresh).
  const signInInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    service.initialize().then(({ identity, session }) => {
      if (cancelled) return;
      setSession(session);
      setCurrentUser(identity.user);
      setAccessDeniedReason(identity.deniedReason);
      setLoading(false);
    });

    const unsubscribe = service.onChange((identity, session, event) => {
      if (cancelled || signInInFlightRef.current) return;
      if (event === 'PASSWORD_RECOVERY') {
        setIsPasswordRecovery(true);
      }
      if (event === 'SIGNED_OUT') {
        setIsPasswordRecovery(false);
        // A driver's cached data must never remain visible to whoever
        // signs in next on the same browser.
        queryClient.clear();
      }
      setSession(session);
      setCurrentUser(identity.user);
      setAccessDeniedReason(identity.deniedReason);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // service is stable for the provider's lifetime (see useRef above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      session,
      currentUser,
      isAuthenticated: currentUser !== null,
      role: currentUser?.role ?? null,
      accessDeniedReason,
      isPasswordRecovery,
      signIn: async (email, password) => {
        signInInFlightRef.current = true;
        try {
          const outcome = await service.signIn(email, password);
          if (outcome.user) {
            // Successful, valid sign-in: apply it directly rather than
            // relying on the (suppressed) global listener.
            const {
              data: { session: freshSession },
            } = await getSupabaseClient().auth.getSession();
            setSession(freshSession);
            setCurrentUser(outcome.user);
            setAccessDeniedReason(null);
          }
          // On denial/error, global state deliberately stays as "signed
          // out, no reason" — the caller (LoginPage) renders
          // outcome.error / outcome.accessDenied itself.
          return outcome;
        } finally {
          signInInFlightRef.current = false;
        }
      },
      signOut: async () => {
        await service.signOut();
        queryClient.clear();
      },
      requestPasswordReset: (email) => service.requestPasswordReset(email),
      updatePassword: (newPassword) => service.updatePassword(newPassword),
    }),
    [loading, session, currentUser, accessDeniedReason, isPasswordRecovery, service]
  );

  return <SupabaseAuthReactContext.Provider value={value}>{children}</SupabaseAuthReactContext.Provider>;
}
