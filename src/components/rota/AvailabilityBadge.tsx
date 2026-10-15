import React from 'react';
import type { RotaAvailabilityState } from '../../repositories/domain';
import { IconAlert, IconCheck, IconClock } from '../ui/icons';

const CONFIG: Record<RotaAvailabilityState, { label: string; Icon: typeof IconCheck }> = {
  available: { label: 'Available', Icon: IconCheck },
  not_submitted: { label: 'Not Submitted', Icon: IconClock },
  unavailable: { label: 'Unavailable', Icon: IconAlert },
};

/**
 * A driver's availability for one shift. Never conveyed by colour alone: every
 * state has its own icon AND its own text label (and a distinct border style,
 * see rota.css). Deliberately styled unlike a status pill, so availability
 * cannot be mistaken for assignment or coverage status.
 */
export function AvailabilityBadge({ state }: { state: RotaAvailabilityState }) {
  const { label, Icon } = CONFIG[state];
  return (
    <span className={`availability-badge availability-badge--${state}`} data-availability={state}>
      <Icon aria-hidden="true" style={{ width: 12, height: 12 }} />
      {label}
    </span>
  );
}
