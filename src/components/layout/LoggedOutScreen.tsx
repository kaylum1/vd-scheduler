import React from 'react';
import { useAppState } from '../../state/AppStateContext';
import { Button } from '../ui/Button';
import { IconLogout } from '../ui/icons';

export function LoggedOutScreen() {
  const { logBackIn } = useAppState();
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div className="card" style={{ maxWidth: 360, width: '100%', textAlign: 'center' }}>
        <div className="card__body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div className="empty-state__icon" style={{ color: 'var(--text-secondary)' }}>
            <IconLogout />
          </div>
          <h3 style={{ fontSize: 15 }}>You've been logged out</h3>
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            This is a Stage 1 UI placeholder — authentication isn't implemented yet.
          </p>
          <Button variant="primary" block onClick={logBackIn}>
            Return to demo
          </Button>
        </div>
      </div>
    </div>
  );
}
