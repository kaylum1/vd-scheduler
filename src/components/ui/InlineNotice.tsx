import React from 'react';
import { IconX } from './icons';

export type NoticeTone = 'info' | 'success' | 'error';

/** Compact dismissible banner — form-level errors, post-action confirmations. */
export function InlineNotice({
  tone = 'info',
  children,
  onDismiss,
}: {
  tone?: NoticeTone;
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`inline-notice inline-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span>{children}</span>
      {onDismiss && (
        <button type="button" className="inline-notice__dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <IconX style={{ width: 13, height: 13 }} />
        </button>
      )}
    </div>
  );
}
