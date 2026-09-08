import React from 'react';
import { getDataProvider } from '../lib/env';
import { useAuth } from './AuthContext';
import { accessDeniedMessage } from './messages';
import { LoginPage } from '../pages/auth/LoginPage';
import { ResetPasswordPage } from '../pages/auth/ResetPasswordPage';
import { Card, CardBody } from '../components/ui/Card';
import { Button } from '../components/ui/Button';

/**
 * The single real-auth gate: decides Loading / password-recovery / Login /
 * access-denied / the actual app, so the app never briefly renders
 * authenticated content before role resolution finishes. In mock mode this
 * is a complete no-op passthrough — no login is ever required to view the
 * mock prototype (Checkpoint spec section 14).
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const provider = getDataProvider();
  const { loading, isAuthenticated, accessDeniedReason, isPasswordRecovery, signOut } = useAuth();

  if (provider === 'mock') {
    return <>{children}</>;
  }

  if (isPasswordRecovery) {
    return <ResetPasswordPage />;
  }

  if (loading) {
    return (
      <div className="auth-screen">
        <p className="auth-notice">Loading…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    if (accessDeniedReason) {
      return <AccessDeniedScreen reason={accessDeniedReason} onSignOut={signOut} />;
    }
    return <LoginPage />;
  }

  return <>{children}</>;
}

function AccessDeniedScreen({
  reason,
  onSignOut,
}: {
  reason: NonNullable<ReturnType<typeof useAuth>['accessDeniedReason']>;
  onSignOut: () => Promise<void>;
}) {
  return (
    <div className="auth-screen">
      <Card className="auth-card">
        <CardBody>
          <div className="auth-form">
            <p className="auth-notice">{accessDeniedMessage(reason)}</p>
            <Button variant="secondary" block onClick={() => void onSignOut()}>
              Sign out
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
