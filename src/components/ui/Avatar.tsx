import React from 'react';
import type { Driver } from '../../types';

export function Avatar({
  initials,
  size = 'md',
}: {
  initials: string;
  size?: 'sm' | 'md';
}) {
  return <span className={`avatar avatar--${size}`}>{initials}</span>;
}

export function AvatarStack({ drivers }: { drivers: Driver[] }) {
  if (drivers.length === 0) return null;
  return (
    <span className="avatar-stack">
      {drivers.map((d) => (
        <Avatar key={d.id} initials={d.initials} size="sm" />
      ))}
    </span>
  );
}
