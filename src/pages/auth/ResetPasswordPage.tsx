import React, { useState } from 'react';
import { Card, CardBody } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../auth/AuthContext';

/**
 * Shown whenever the current session is a Supabase password-recovery
 * session (the user followed the link from their reset email) —
 * regardless of the router's own path, see AuthGate.
 */
export function ResetPasswordPage() {
  const { updatePassword, signOut } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    const { error: updateError } = await updatePassword(password);
    setSubmitting(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="auth-screen">
        <Card className="auth-card">
          <CardBody>
            <div className="auth-form">
              <p className="auth-notice">Your password has been updated. Please sign in again.</p>
              <Button variant="primary" block onClick={() => void signOut()}>
                Return to sign in
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    );
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
          <form className="auth-form" onSubmit={handleSubmit}>
            <p className="auth-notice">Choose a new password for your account.</p>
            {error && <div className="auth-error">{error}</div>}
            <div className="auth-field">
              <label htmlFor="new-password">New password</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="auth-field">
              <label htmlFor="confirm-password">Confirm new password</label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <Button type="submit" variant="primary" block disabled={submitting}>
              {submitting ? 'Updating…' : 'Update password'}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
