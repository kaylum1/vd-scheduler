import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { StatusPill } from '../../../components/ui/StatusPill';
import { EmptyState } from '../../../components/ui/EmptyState';
import { InlineNotice } from '../../../components/ui/InlineNotice';
import { Modal, ConfirmDialog } from '../../../components/ui/Modal';
import { IconCalendar, IconEdit, IconPlus } from '../../../components/ui/icons';
import { getRepositories } from '../../../repositories';
import type { ShiftTypeRecord } from '../../../repositories/domain';
import { describeConfigurationError } from './errorMessages';
import { slugifyKey } from './slugifyKey';

export function ResortShiftSetupPanel() {
  const [selectedResortId, setSelectedResortId] = useState<string | null>(null);

  const resortsQuery = useQuery({
    queryKey: ['config', 'resorts'],
    queryFn: () => getRepositories().resorts.listResorts(),
  });

  // Default to the first resort once resorts load, without fighting a
  // manager's own later selection.
  useEffect(() => {
    if (!selectedResortId && resortsQuery.data && resortsQuery.data.length > 0) {
      setSelectedResortId(resortsQuery.data[0].id);
    }
  }, [resortsQuery.data, selectedResortId]);

  const selectedResort = useMemo(
    () => resortsQuery.data?.find((r) => r.id === selectedResortId) ?? null,
    [resortsQuery.data, selectedResortId]
  );

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <CardHeader title="Resorts" />
        {resortsQuery.isLoading ? (
          <div className="config-loading">Loading resorts…</div>
        ) : resortsQuery.isError ? (
          <div className="config-error">
            <p>Couldn't load resorts. {describeConfigurationError(resortsQuery.error, 'driver')}</p>
            <Button variant="secondary" size="sm" onClick={() => resortsQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : !resortsQuery.data?.length ? (
          <EmptyState title="No resorts configured yet" />
        ) : (
          <div style={{ padding: 18 }}>
            <div className="segmented" role="tablist" aria-label="Select resort to configure">
              {resortsQuery.data.map((r) => (
                <button
                  key={r.id}
                  role="tab"
                  aria-selected={r.id === selectedResortId}
                  className={`segmented__item${r.id === selectedResortId ? ' is-active' : ''}`}
                  onClick={() => setSelectedResortId(r.id)}
                >
                  <span className={`resort-dot resort-dot--${r.slug}`} />
                  {r.name}
                </button>
              ))}
            </div>
            {selectedResort && (
              <div className="config-resort-info">
                <span>
                  Now configuring <strong>{selectedResort.name}</strong>
                </span>
                <Badge tone="blue">{selectedResort.timezone}</Badge>
                <StatusPill tone={selectedResort.isActive ? 'green' : 'grey'}>
                  {selectedResort.isActive ? 'Active' : 'Inactive'}
                </StatusPill>
              </div>
            )}
          </div>
        )}
      </Card>

      {selectedResort && <ShiftTypesCard resortId={selectedResort.id} resortName={selectedResort.name} />}

      <Card style={{ marginTop: 16 }}>
        <CardHeader title="Recurring shift templates" />
        <EmptyState
          icon={<IconCalendar />}
          title="Coming in a later stage"
          hint="Recurring shift templates (days of week, pay, headcount) will be editable here once Stage 2D wires up template management. The shift types above already provide the stable identity they'll attach to."
        />
      </Card>
    </>
  );
}

function ShiftTypesCard({ resortId, resortName }: { resortId: string; resortName: string }) {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editingType, setEditingType] = useState<ShiftTypeRecord | null>(null);
  const [deactivatingType, setDeactivatingType] = useState<ShiftTypeRecord | null>(null);

  const shiftTypesQuery = useQuery({
    queryKey: ['config', 'shiftTypes', resortId],
    queryFn: () => getRepositories().shiftConfiguration.listShiftTypes(resortId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['config', 'shiftTypes', resortId] });

  const sorted = useMemo(() => [...(shiftTypesQuery.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder), [shiftTypesQuery.data]);

  return (
    <Card>
      <CardHeader
        title={`Shift types — ${resortName}`}
        action={
          <Button variant="secondary" size="sm" onClick={() => setShowCreate(true)}>
            <IconPlus style={{ width: 14, height: 14 }} />
            Add shift type
          </Button>
        }
      />
      {shiftTypesQuery.isLoading ? (
        <div className="config-loading">Loading shift types…</div>
      ) : shiftTypesQuery.isError ? (
        <div className="config-error">
          <p>Couldn't load shift types. {describeConfigurationError(shiftTypesQuery.error, 'shiftType')}</p>
          <Button variant="secondary" size="sm" onClick={() => shiftTypesQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState title={`No shift types yet for ${resortName}`} hint="Add the distinct shift rows/services this resort runs, e.g. Lunch, Dinner." />
      ) : (
        sorted.map((type) => (
          <div className="config-list-item" key={type.id}>
            <div className="config-list-item__main">
              <div>
                <div className="config-list-item__title">
                  {type.name} <span className="config-list-item__key">{type.key}</span>
                </div>
                <div className="config-list-item__subtitle">Sort order {type.sortOrder}</div>
              </div>
            </div>
            <div className="config-list-item__badges">
              {!type.isActive && <StatusPill tone="grey">Inactive</StatusPill>}
            </div>
            <div className="config-list-item__actions">
              <Button variant="ghost" size="sm" icon aria-label={`Edit ${type.name}`} onClick={() => setEditingType(type)}>
                <IconEdit />
              </Button>
              {type.isActive && (
                <Button variant="danger-outline" size="sm" onClick={() => setDeactivatingType(type)}>
                  Deactivate
                </Button>
              )}
            </div>
          </div>
        ))
      )}

      {showCreate && (
        <CreateShiftTypeModal
          resortId={resortId}
          existingKeys={new Set((shiftTypesQuery.data ?? []).map((t) => t.key))}
          nextSortOrder={(shiftTypesQuery.data ?? []).length + 1}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            invalidate();
          }}
        />
      )}

      {editingType && (
        <EditShiftTypeModal
          shiftType={editingType}
          onClose={() => setEditingType(null)}
          onSaved={() => {
            setEditingType(null);
            invalidate();
          }}
        />
      )}

      {deactivatingType && (
        <DeactivateShiftTypeDialog
          shiftType={deactivatingType}
          onCancel={() => setDeactivatingType(null)}
          onDeactivated={() => {
            setDeactivatingType(null);
            invalidate();
          }}
        />
      )}
    </Card>
  );
}

function CreateShiftTypeModal({
  resortId,
  existingKeys,
  nextSortOrder,
  onClose,
  onCreated,
}: {
  resortId: string;
  existingKeys: Set<string>;
  nextSortOrder: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouchedManually, setKeyTouchedManually] = useState(false);
  const [sortOrder, setSortOrder] = useState(nextSortOrder);
  const [touched, setTouched] = useState(false);

  const mutation = useMutation({
    mutationFn: () => getRepositories().shiftConfiguration.createShiftType({ resortId, key: key.trim(), name: name.trim(), sortOrder }),
    onSuccess: onCreated,
  });

  const duplicateKey = existingKeys.has(key.trim());
  const nameError = touched && !name.trim() ? 'Name is required.' : null;
  const keyError = touched && !key.trim() ? 'Key is required.' : duplicateKey ? 'That key is already used at this resort.' : null;
  const canSubmit = name.trim().length > 0 && key.trim().length > 0 && !duplicateKey;

  return (
    <Modal
      title="Add shift type"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={mutation.isPending}
            onClick={() => {
              setTouched(true);
              if (canSubmit) mutation.mutate();
            }}
          >
            {mutation.isPending ? 'Creating…' : 'Create shift type'}
          </Button>
        </>
      }
    >
      {mutation.isError && <InlineNotice tone="error">{describeConfigurationError(mutation.error, 'shiftType')}</InlineNotice>}
      <div className="form-field">
        <label htmlFor="shift-type-name">Display name</label>
        <input
          id="shift-type-name"
          type="text"
          value={name}
          onChange={(e) => {
            const value = e.target.value;
            setName(value);
            if (!keyTouchedManually) setKey(slugifyKey(value));
          }}
          placeholder="e.g. Dinner"
          autoFocus
        />
        {nameError && <span className="form-field__error">{nameError}</span>}
      </div>
      <div className="form-field">
        <label htmlFor="shift-type-key">Stable key</label>
        <input
          id="shift-type-key"
          type="text"
          value={key}
          onChange={(e) => {
            setKeyTouchedManually(true);
            setKey(e.target.value);
          }}
          placeholder="e.g. dinner"
        />
        {keyError && <span className="form-field__error">{keyError}</span>}
        <span className="form-field__hint">
          Used as this shift's permanent grid identity. Cannot be changed once created — renaming the display name
          later won't affect it.
        </span>
      </div>
      <div className="form-field">
        <label htmlFor="shift-type-sort-order">Sort order</label>
        <input
          id="shift-type-sort-order"
          type="number"
          min={1}
          value={sortOrder}
          onChange={(e) => setSortOrder(Number(e.target.value))}
        />
      </div>
    </Modal>
  );
}

function EditShiftTypeModal({
  shiftType,
  onClose,
  onSaved,
}: {
  shiftType: ShiftTypeRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(shiftType.name);
  const [sortOrder, setSortOrder] = useState(shiftType.sortOrder);

  const renameMutation = useMutation({
    mutationFn: async () => {
      if (name.trim() !== shiftType.name) {
        await getRepositories().shiftConfiguration.renameShiftType(shiftType.id, name.trim());
      }
      if (sortOrder !== shiftType.sortOrder) {
        await getRepositories().shiftConfiguration.reorderShiftType(shiftType.id, sortOrder);
      }
    },
    onSuccess: onSaved,
  });

  return (
    <Modal
      title={`Edit ${shiftType.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={renameMutation.isPending}>
            Cancel
          </Button>
          <Button variant="primary" disabled={renameMutation.isPending || !name.trim()} onClick={() => renameMutation.mutate()}>
            {renameMutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      {renameMutation.isError && <InlineNotice tone="error">{describeConfigurationError(renameMutation.error, 'shiftType')}</InlineNotice>}
      <div className="form-field">
        <label htmlFor="edit-shift-type-name">Display name</label>
        <input id="edit-shift-type-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="form-field">
        <label htmlFor="edit-shift-type-key">Stable key</label>
        <input id="edit-shift-type-key" type="text" value={shiftType.key} disabled />
        <span className="form-field__hint">The key is permanent and can't be edited after creation.</span>
      </div>
      <div className="form-field">
        <label htmlFor="edit-shift-type-sort-order">Sort order</label>
        <input
          id="edit-shift-type-sort-order"
          type="number"
          min={1}
          value={sortOrder}
          onChange={(e) => setSortOrder(Number(e.target.value))}
        />
      </div>
    </Modal>
  );
}

function DeactivateShiftTypeDialog({
  shiftType,
  onCancel,
  onDeactivated,
}: {
  shiftType: ShiftTypeRecord;
  onCancel: () => void;
  onDeactivated: () => void;
}) {
  const mutation = useMutation({
    mutationFn: () => getRepositories().shiftConfiguration.deactivateShiftType(shiftType.id),
    onSuccess: onDeactivated,
  });

  return (
    <ConfirmDialog
      title={`Deactivate ${shiftType.name}?`}
      message={
        <>
          <p style={{ marginBottom: mutation.isError ? 10 : 0 }}>
            Historical shift instances already using {shiftType.name} are unaffected. It will no longer be offered
            for new shifts.
          </p>
          {mutation.isError && <InlineNotice tone="error">{describeConfigurationError(mutation.error, 'shiftType')}</InlineNotice>}
        </>
      }
      confirmLabel="Deactivate"
      danger
      busy={mutation.isPending}
      onConfirm={() => mutation.mutate()}
      onCancel={onCancel}
    />
  );
}
