import React from 'react';
import { ConfirmDialog } from '../ui/Modal';
import { describeUncoveredWarning } from './publishRotaUi';

export interface PublishRotaDialogProps {
  /** `confirm`: the first, plain confirmation. `uncovered`: the SERVER reported open positions; the manager may publish anyway. */
  stage: 'confirm' | 'uncovered';
  /** The server-reported count (only meaningful in the `uncovered` stage). */
  uncoveredSlots: number;
  /** The loaded week has no active assignment at all (adds a supplementary line to the uncovered warning). */
  noDriversAssigned: boolean;
  resortName?: string;
  weekLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The Publish Rota confirmation: one dialog that swaps its content when the
 * server asks for acknowledgement of uncovered positions. It shows no coverage
 * of its own before the server responds -- the count it displays is the typed
 * error's, passed in.
 */
export function PublishRotaDialog({ stage, uncoveredSlots, noDriversAssigned, resortName, weekLabel, busy, onConfirm, onCancel }: PublishRotaDialogProps) {
  const uncovered = stage === 'uncovered';
  return (
    <ConfirmDialog
      title="Publish rota?"
      confirmLabel={uncovered ? 'Publish anyway' : 'Publish Rota'}
      busyLabel="Publishing…"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
      message={
        <div className="generate-dialog publish-dialog">
          <p className="generate-dialog__scope">
            {resortName ? <strong>{resortName}</strong> : <strong>This resort</strong>}
            <span>{weekLabel}</span>
          </p>
          {uncovered ? (
            <div role="status" className="publish-dialog__warning">
              <p>
                <strong>{describeUncoveredWarning(uncoveredSlots)}</strong>
              </p>
              {noDriversAssigned && <p>No drivers are assigned yet.</p>}
              <p>You can still publish this rota. Drivers will see their assigned shifts, and availability will be locked.</p>
            </div>
          ) : (
            <>
              <p>Publishing will:</p>
              <ul>
                <li>Make assigned shifts visible to drivers</li>
                <li>Lock driver availability for this week</li>
                <li>Stop Auto-Rota generation</li>
              </ul>
            </>
          )}
        </div>
      }
    />
  );
}
