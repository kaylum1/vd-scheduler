import React, { useCallback, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { InlineNotice } from '../ui/InlineNotice';
import type { AvailabilityOverrideState } from '../../repositories/errors';

export const MAX_REASON_LENGTH = 500;

/**
 * Everything the single confirmation dialog needs. One dialog covers every
 * reason a manager might need to confirm an assignment, so there are never
 * two sequential, confusing dialogs:
 *
 *   availability  'unavailable' | 'not_submitted' -> an availability override
 *                 is needed (optional reason shown); null -> none needed.
 *   coverage      non-null -> the shift ALREADY has its required coverage and
 *                 this would be an additional driver.
 *
 * `availability` may be set by the SERVER (the typed override-required error)
 * even when the screen showed "Available" -- the race-safe path.
 */
export interface AssignDialogState {
  /** Changes only when a brand-new dialog opens, so the typed reason survives a server-supplied state change. */
  key: number;
  shiftInstanceId: string;
  driverId: string;
  driverName: string;
  shiftName: string;
  availability: AvailabilityOverrideState | null;
  coverage: { active: number; required: number } | null;
}

export function AssignDriverDialog({
  dialog,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  dialog: AssignDialogState;
  busy: boolean;
  error: string | null;
  /** `reason` is null unless an availability override is being confirmed and the manager typed one. */
  onConfirm: (reason: string | null) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const needsOverride = dialog.availability !== null;

  const close = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);

  const confirm = () => {
    const trimmed = reason.trim();
    onConfirm(needsOverride && trimmed !== '' ? trimmed : null);
  };

  return (
    <Modal
      title={`Assign ${dialog.driverName}?`}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant={dialog.availability === 'unavailable' ? 'danger-outline' : 'primary'} onClick={confirm} disabled={busy}>
            {busy ? 'Assigning…' : 'Assign anyway'}
          </Button>
        </>
      }
    >
      {dialog.coverage && (
        <p className="assign-dialog__line">
          <strong>{dialog.shiftName}</strong> already has the required coverage ({dialog.coverage.active} / {dialog.coverage.required} drivers assigned).{' '}
          {dialog.driverName} would be an additional driver.
        </p>
      )}

      {dialog.availability === 'unavailable' && (
        <InlineNotice tone="error">
          <strong>Unavailable.</strong> This driver marked themselves unavailable for this shift.
        </InlineNotice>
      )}
      {dialog.availability === 'not_submitted' && (
        <InlineNotice tone="warning">
          <strong>Not Submitted.</strong> This driver has not submitted availability for this shift.
        </InlineNotice>
      )}

      {needsOverride && (
        <div className="form-field assign-dialog__reason">
          <label htmlFor="assign-reason">Reason (optional)</label>
          <textarea
            id="assign-reason"
            rows={3}
            maxLength={MAX_REASON_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Driver confirmed they can work by phone"
            disabled={busy}
          />
          <span className="form-field__hint" aria-live="polite">
            {reason.length} / {MAX_REASON_LENGTH}
          </span>
        </div>
      )}

      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </Modal>
  );
}
