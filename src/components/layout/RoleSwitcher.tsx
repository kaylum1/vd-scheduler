import React from 'react';
import { drivers } from '../../mock-data/drivers';
import { resortById } from '../../mock-data/resorts';
import { useRouter } from '../../router';
import { useAppState } from '../../state/AppStateContext';
import { Avatar } from '../ui/Avatar';

/**
 * Stage 1 stand-in for authentication/session switching. Lets a reviewer
 * flip between the Manager and Driver interface states, and — for the
 * Driver state — pick which driver is "signed in" so My Rota / Availability
 * have something concrete to show. This entire control is removed once
 * real auth exists.
 */
export function RoleSwitcher() {
  const { role, setRole, activeDriverId, setActiveDriverId } = useAppState();
  const { navigate } = useRouter();
  const activeDriver = drivers.find((d) => d.id === activeDriverId);
  const resort = activeDriver ? resortById(activeDriver.resortId) : undefined;

  return (
    <div className="role-switcher">
      <div className="role-switcher__tabs" role="tablist" aria-label="Preview as">
        <button
          role="tab"
          aria-selected={role === 'manager'}
          className={`role-switcher__tab${role === 'manager' ? ' is-active' : ''}`}
          onClick={() => {
            setRole('manager');
            navigate('/manager/dashboard');
          }}
        >
          Manager
        </button>
        <button
          role="tab"
          aria-selected={role === 'driver'}
          className={`role-switcher__tab${role === 'driver' ? ' is-active' : ''}`}
          onClick={() => {
            setRole('driver');
            navigate('/driver/my-rota');
          }}
        >
          Driver
        </button>
      </div>

      {role === 'driver' && (
        <select
          aria-label="Signed in as driver"
          value={activeDriverId}
          onChange={(e) => setActiveDriverId(e.target.value)}
        >
          {drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} — {resortById(d.resortId)?.name}
            </option>
          ))}
        </select>
      )}

      <div className="user-chip">
        <Avatar initials={role === 'manager' ? 'KA' : activeDriver?.initials ?? '?'} size="sm" />
        <span>
          <span className="user-chip__name">{role === 'manager' ? 'Kaylum' : activeDriver?.name}</span>
          <br />
          <span className="user-chip__role">{role === 'manager' ? 'Manager' : resort?.name}</span>
        </span>
      </div>
    </div>
  );
}
