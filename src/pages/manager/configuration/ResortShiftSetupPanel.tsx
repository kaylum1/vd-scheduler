import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { StatusPill } from '../../../components/ui/StatusPill';
import { EmptyState } from '../../../components/ui/EmptyState';
import { InlineNotice } from '../../../components/ui/InlineNotice';
import { Modal, ConfirmDialog } from '../../../components/ui/Modal';
import { IconMapPin, IconPlus } from '../../../components/ui/icons';
import { getRepositories } from '../../../repositories';
import type { ResortRecord } from '../../../repositories/domain';
import { describeConfigurationError } from './errorMessages';
import { ShiftSetupPanel } from './ShiftSetupPanel';

type ResortFilter = 'active' | 'inactive' | 'all';

/**
 * Stage 2D Checkpoint 4.1: resort lifecycle management (Add/Deactivate/
 * Reactivate), plus the resort picker that decides which ACTIVE resort's
 * Shift Setup is shown below -- matching §5's "normal operational
 * selectors show active resorts only" (this picker is exactly that kind
 * of selector: it decides where a manager can create/edit shifts).
 */
export function ResortShiftSetupPanel() {
  const queryClient = useQueryClient();
  const [selectedResortId, setSelectedResortId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ResortFilter>('active');
  const [showAdd, setShowAdd] = useState(false);
  const [deactivatingResort, setDeactivatingResort] = useState<ResortRecord | null>(null);

  const resortsQuery = useQuery({
    queryKey: ['config', 'resorts'],
    queryFn: () => getRepositories().resorts.listResorts(),
  });

  const activeResorts = useMemo(() => (resortsQuery.data ?? []).filter((r) => r.isActive), [resortsQuery.data]);

  // Default to the first active resort once resorts load, without fighting
  // a manager's own later selection -- but a resort that just got
  // deactivated (by this manager, in this same session) must not stay
  // "selected" with nothing valid to configure underneath it.
  useEffect(() => {
    if (!resortsQuery.data) return;
    const stillValidSelection = selectedResortId !== null && activeResorts.some((r) => r.id === selectedResortId);
    if (!stillValidSelection) {
      setSelectedResortId(activeResorts[0]?.id ?? null);
    }
  }, [resortsQuery.data, activeResorts, selectedResortId]);

  const selectedResort = useMemo(() => activeResorts.find((r) => r.id === selectedResortId) ?? null, [activeResorts, selectedResortId]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['config', 'resorts'] });

  const filteredResorts = useMemo(() => {
    const resorts = resortsQuery.data ?? [];
    const byFilter = filter === 'all' ? resorts : resorts.filter((r) => (filter === 'active' ? r.isActive : !r.isActive));
    return [...byFilter].sort((a, b) => a.name.localeCompare(b.name));
  }, [resortsQuery.data, filter]);

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <CardHeader
          title="Resorts"
          action={
            <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
              <IconPlus style={{ width: 14, height: 14 }} />
              Add Resort
            </Button>
          }
        />

        <div className="shift-setup-filter segmented" role="tablist" aria-label="Filter resorts">
          {(['active', 'inactive', 'all'] as const).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              className={`segmented__item${filter === f ? ' is-active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'active' ? 'Active' : f === 'inactive' ? 'Inactive' : 'All'}
            </button>
          ))}
        </div>

        {resortsQuery.isLoading ? (
          <div className="config-loading">Loading resorts…</div>
        ) : resortsQuery.isError ? (
          <div className="config-error">
            <p>Couldn't load resorts. {describeConfigurationError(resortsQuery.error, 'resort')}</p>
            <Button variant="secondary" size="sm" onClick={() => resortsQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : filteredResorts.length === 0 ? (
          <EmptyState
            icon={<IconMapPin />}
            title={filter === 'inactive' ? 'No inactive resorts' : 'No resorts configured yet'}
            hint={filter === 'active' ? 'Add a resort to begin scheduling shifts.' : undefined}
          />
        ) : (
          <div className="shift-setup-list">
            {filteredResorts.map((resort) => (
              <ResortRow
                key={resort.id}
                resort={resort}
                isSelected={resort.id === selectedResortId}
                onSelect={() => setSelectedResortId(resort.id)}
                onDeactivate={() => setDeactivatingResort(resort)}
                onReactivated={invalidate}
              />
            ))}
          </div>
        )}
      </Card>

      {showAdd && (
        <AddResortModal
          onClose={() => setShowAdd(false)}
          onCreated={(resortId) => {
            setShowAdd(false);
            invalidate();
            setSelectedResortId(resortId);
          }}
        />
      )}

      {deactivatingResort && (
        <DeactivateResortDialog
          resort={deactivatingResort}
          onClose={() => setDeactivatingResort(null)}
          onDeactivated={() => {
            setDeactivatingResort(null);
            invalidate();
          }}
        />
      )}

      {selectedResort ? (
        <ShiftSetupPanel resortId={selectedResort.id} resortName={selectedResort.name} />
      ) : (
        !resortsQuery.isLoading &&
        activeResorts.length === 0 && (
          <Card>
            <EmptyState icon={<IconMapPin />} title="Add and activate a resort to start configuring its shifts" />
          </Card>
        )
      )}
    </>
  );
}

function ResortRow({
  resort,
  isSelected,
  onSelect,
  onDeactivate,
  onReactivated,
}: {
  resort: ResortRecord;
  isSelected: boolean;
  onSelect: () => void;
  onDeactivate: () => void;
  onReactivated: () => void;
}) {
  const reactivateMutation = useMutation({
    mutationFn: () => getRepositories().resorts.reactivateResort(resort.id),
    onSuccess: onReactivated,
  });

  return (
    <div className="config-list-item shift-setup-card">
      <div
        className="config-list-item__main"
        style={resort.isActive ? { cursor: 'pointer' } : undefined}
        onClick={resort.isActive ? onSelect : undefined}
        onKeyDown={resort.isActive ? (e) => (e.key === 'Enter' || e.key === ' ') && onSelect() : undefined}
        role={resort.isActive ? 'button' : undefined}
        tabIndex={resort.isActive ? 0 : undefined}
        aria-pressed={resort.isActive ? isSelected : undefined}
      >
        <span className={`resort-dot resort-dot--${resort.slug}`} aria-hidden="true" />
        <div>
          <div className="config-list-item__title">{resort.name}</div>
          {isSelected && resort.isActive && <div className="config-list-item__subtitle">Now configuring</div>}
        </div>
      </div>
      <div className="config-list-item__badges">
        <StatusPill tone={resort.isActive ? 'green' : 'grey'}>{resort.isActive ? 'Active' : 'Inactive'}</StatusPill>
      </div>
      <div className="config-list-item__actions">
        {resort.isActive ? (
          <Button variant="danger-outline" size="sm" onClick={onDeactivate}>
            Deactivate
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled={reactivateMutation.isPending} onClick={() => reactivateMutation.mutate()}>
            {reactivateMutation.isPending ? 'Reactivating…' : 'Reactivate'}
          </Button>
        )}
      </div>
      {reactivateMutation.isError && (
        <div style={{ width: '100%', padding: '0 18px 10px' }}>
          <InlineNotice tone="error">{describeConfigurationError(reactivateMutation.error, 'resort')}</InlineNotice>
        </div>
      )}
    </div>
  );
}

function AddResortModal({ onClose, onCreated }: { onClose: () => void; onCreated: (resortId: string) => void }) {
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);

  const mutation = useMutation({
    mutationFn: () => getRepositories().resorts.createResort(name.trim()),
    onSuccess: (result) => onCreated(result.resortId),
  });

  const nameError = touched && !name.trim() ? 'Name is required.' : null;
  const canSubmit = name.trim().length > 0;

  return (
    <Modal
      title="Add Resort"
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
            {mutation.isPending ? 'Adding…' : 'Add Resort'}
          </Button>
        </>
      }
    >
      {mutation.isError && <InlineNotice tone="error">{describeConfigurationError(mutation.error, 'resort')}</InlineNotice>}
      <div className="form-field">
        <label htmlFor="resort-form-name">Name</label>
        <input id="resort-form-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Verbier" autoFocus />
        {nameError && <span className="form-field__error">{nameError}</span>}
      </div>
    </Modal>
  );
}

function DeactivateResortDialog({
  resort,
  onClose,
  onDeactivated,
}: {
  resort: ResortRecord;
  onClose: () => void;
  onDeactivated: () => void;
}) {
  const mutation = useMutation({
    mutationFn: () => getRepositories().resorts.deactivateResort(resort.id),
    onSuccess: onDeactivated,
  });

  return (
    <ConfirmDialog
      title={`Deactivate ${resort.name}?`}
      message={
        <>
          <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
            <li>{resort.name} will disappear from normal active resort selectors (Shift Setup, Drivers, and later Rota/Payroll/Rota Rules).</li>
            <li>Historical data is retained — drivers, shifts, assignments, payroll records, and audit history are unaffected.</li>
            <li>Nothing is deleted.</li>
          </ul>
          {mutation.isError && <InlineNotice tone="error">{describeConfigurationError(mutation.error, 'resort')}</InlineNotice>}
        </>
      }
      confirmLabel="Deactivate"
      danger
      busy={mutation.isPending}
      onConfirm={() => mutation.mutate()}
      onCancel={onClose}
    />
  );
}
