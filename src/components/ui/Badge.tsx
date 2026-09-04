import React from 'react';

type BadgeTone = 'default' | 'amber' | 'blue' | 'green' | 'grey';

export function Badge({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
}) {
  return <span className={`badge${tone !== 'default' ? ` badge--${tone}` : ''}`}>{children}</span>;
}
