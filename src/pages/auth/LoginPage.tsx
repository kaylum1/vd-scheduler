import React, { useState } from 'react';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../auth/AuthContext';
import { accessDeniedMessage } from '../../auth/messages';

type Mode = 'login' | 'forgot' | 'forgot-sent';

/**
 * Private staff application: email + password only. No sign-up link
 * exists here or anywhere else in the app — accounts are provisioned
 * separately (see supabase/config.toml, [auth].enable_signup = false).
 */
export function LoginPage() {
  const { signIn, requestPasswordReset } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const outcome = await signIn(email.trim(), password);
    setSubmitting(false);
    if (outcome.error) {
      setError(outcome.error.message);
      return;
    }
    if (outcome.accessDenied) {
      setError(accessDeniedMessage(outcome.accessDenied));
      return;
    }
    // Success: AuthContext state updates and AuthGate shows the app.
  }

  async function handleForgotSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    await requestPasswordReset(email.trim());
    setSubmitting(false);
    setMode('forgot-sent');
  }

  return (
    <div className="auth-screen">
      <Card className="auth-card">
        <CardBody>
          <div className="auth-brand">
            <span className="topbar__brand-mark">VD</span>
            <span className="topbar__brand-text">
              <strong>VD Scheduler</strong>
              <span>Payroll</span>
            </span>
          </div>

          {mode === 'login' && (
            <form className="auth-form" onSubmit={handleLogin}>
              {error && <div className="auth-error">{error}</div>}
              <div className="auth-field">
                <label htmlFor="login-email">Email</label>
                <input
                  id="login-email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="auth-field">
                <label htmlFor="login-password">Password</label>
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" variant="primary" block disabled={submitting}>
                {submitting ? 'Signing in…' : 'Sign In'}
              </Button>
              <div className="auth-links">
                <button type="button" onClick={() => { setMode('forgot'); setError(null); }}>
                  Forgot password?
                </button>
              </div>
            </form>
          )}

          {mode === 'forgot' && (
            <form className="auth-form" onSubmit={handleForgotSubmit}>
              <p className="auth-notice">Enter your email and we'll send a password reset link if an account exists.</p>
              <div className="auth-field">
                <label htmlFor="forgot-email">Email</label>
                <input
                  id="forgot-email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button type="submit" variant="primary" block disabled={submitting}>
                {submitting ? 'Sending…' : 'Send reset link'}
              </Button>
              <div className="auth-links">
                <button type="button" onClick={() => setMode('login')}>
                  Back to sign in
                </button>
              </div>
            </form>
          )}

          {mode === 'forgot-sent' && (
            <div className="auth-form">
              <p className="auth-notice">
                If an account exists for that email, a password reset link is on its way. Check your inbox.
              </p>
              <Button variant="secondary" block onClick={() => setMode('login')}>
                Back to sign in
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
