import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Avatar } from '../../../components/ui/Avatar';
import { StatusPill } from '../../../components/ui/StatusPill';
import { EmptyState } from '../../../components/ui/EmptyState';
import { InlineNotice } from '../../../components/ui/InlineNotice';
import { Modal, ConfirmDialog } from '../../../components/ui/Modal';
import { IconEdit, IconPlus, IconTruck } from '../../../components/ui/icons';
import { getRepositories } from '../../../repositories';
import type { DriverRecord, ResortRecord } from '../../../repositories/domain';
import { describeConfigurationError } from './errorMessages';

const ALL_RESORTS = 'all';
type StatusFilter = 'active' | 'inactive' | 'all';

function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function DriversPanel() {
  const queryClient = useQueryClient();
  const [resortFilter, setResortFilter] = useState<string>(ALL_RESORTS);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [showCreate, setShowCreate] = useState(false);
  const [editingDriver, setEditingDriver] = useState<DriverRecord | null>(null);
  const [deactivatingDriver, setDeactivatingDriver] = useState<DriverRecord | null>(null);
  const [justCreatedName, setJustCreatedName] = useState<string | null>(null);

  const resortsQuery = useQuery({
    queryKey: ['config', 'resorts'],
    queryFn: () => getRepositories().resorts.listResorts(),
  });

  const driversQuery = useQuery({
    queryKey: ['config', 'drivers', resortFilter],
    queryFn: () => getRepositories().drivers.listDrivers(resortFilter === ALL_RESORTS ? undefined : { resortId: resortFilter }),
  });

  const loginsQuery = useQuery({
    queryKey: ['config', 'driverLogins'],
    queryFn: () => getRepositories().drivers.listDriverIdsWithLogin(),
  });

  const resortById = useMemo(() => {
    const map = new Map<string, ResortRecord>();
    for (const r of resortsQuery.data ?? []) map.set(r.id, r);
    return map;
  }, [resortsQuery.data]);

  const visibleDrivers = useMemo(() => {
    const drivers = driversQuery.data ?? [];
    if (statusFilter === 'active') return drivers.filter((d) => d.isActive);
    if (statusFilter === 'inactive') return drivers.filter((d) => !d.isActive);
    return drivers;
  }, [driversQuery.data, statusFilter]);

  const invalidateDrivers = () => queryClient.invalidateQueries({ queryKey: ['config', 'drivers'] });

  return (
    <Card>
      <CardHeader
        title="Drivers"
        action={
          <Button variant="secondary" size="sm" onClick={() => setShowCreate(true)} disabled={!resortsQuery.data?.length}>
            <IconPlus style={{ width: 14, height: 14 }} />
            Add driver
          </Button>
        }
      />

      {justCreatedName && (
        <div style={{ padding: '12px 18px 0' }}>
          <InlineNotice tone="success" onDismiss={() => setJustCreatedName(null)}>
            Driver profile created for {justCreatedName}. Login access is managed separately.
          </InlineNotice>
        </div>
      )}

      <div className="config-toolbar">
        <select
          aria-label="Filter by resort"
          value={resortFilter}
          onChange={(e) => setResortFilter(e.target.value)}
        >
          <option value={ALL_RESORTS}>All resorts</option>
          {(resortsQuery.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>
      </div>

      {driversQuery.isLoading || resortsQuery.isLoading ? (
        <div className="config-loading">Loading drivers…</div>
      ) : driversQuery.isError ? (
        <div className="config-error">
          <p>Couldn't load drivers. {describeConfigurationError(driversQuery.error, 'driver')}</p>
          <Button variant="secondary" size="sm" onClick={() => driversQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : visibleDrivers.length === 0 ? (
        <EmptyState
          icon={<IconTruck />}
          title={
            resortFilter === ALL_RESORTS
              ? `No ${statusFilter === 'all' ? '' : statusFilter + ' '}drivers yet`
              : `No ${statusFilter === 'all' ? '' : statusFilter + ' '}drivers yet for ${resortById.get(resortFilter)?.name ?? 'this resort'}`
          }
          hint={statusFilter === 'active' ? 'Add a driver to start scheduling shifts.' : undefined}
        />
      ) : (
        visibleDrivers.map((driver) => (
          <div className="config-list-item" key={driver.id}>
            <div className="config-list-item__main">
              <Avatar initials={initialsOf(driver.fullName)} />
              <div>
                <div className="config-list-item__title">{driver.fullName}</div>
                <div className="config-list-item__subtitle">{resortById.get(driver.resortId)?.name ?? 'Unknown resort'}</div>
              </div>
            </div>
            <div className="config-list-item__badges">
              {!driver.isActive && <StatusPill tone="grey">Inactive</StatusPill>}
              {loginsQuery.data?.has(driver.id) ? (
                <StatusPill tone="green">Login linked</StatusPill>
              ) : (
                <StatusPill tone="grey">No login</StatusPill>
              )}
            </div>
            <div className="config-list-item__actions">
              <Button variant="ghost" size="sm" icon aria-label={`Edit ${driver.fullName}`} onClick={() => setEditingDriver(driver)}>
                <IconEdit />
              </Button>
              {driver.isActive && (
                <Button
                  variant="danger-outline"
                  size="sm"
                  onClick={() => setDeactivatingDriver(driver)}
                >
                  Deactivate
                </Button>
              )}
            </div>
          </div>
        ))
      )}

      {showCreate && (
        <CreateDriverModal
          resorts={resortsQuery.data ?? []}
          defaultResortId={resortFilter !== ALL_RESORTS ? resortFilter : undefined}
          onClose={() => setShowCreate(false)}
          onCreated={(name) => {
            setShowCreate(false);
            setJustCreatedName(name);
            invalidateDrivers();
          }}
        />
      )}

      {editingDriver && (
        <EditDriverModal
          driver={editingDriver}
          resortName={resortById.get(editingDriver.resortId)?.name ?? 'Unknown resort'}
          onClose={() => setEditingDriver(null)}
          onSaved={() => {
            setEditingDriver(null);
            invalidateDrivers();
          }}
        />
      )}

      {deactivatingDriver && (
        <DeactivateDriverDialog
          driver={deactivatingDriver}
          onCancel={() => setDeactivatingDriver(null)}
          onDeactivated={() => {
            setDeactivatingDriver(null);
            invalidateDrivers();
          }}
        />
      )}
    </Card>
  );
}

function CreateDriverModal({
  resorts,
  defaultResortId,
  onClose,
  onCreated,
}: {
  resorts: ResortRecord[];
  defaultResortId?: string;
  onClose: () => void;
  onCreated: (fullName: string) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [resortId, setResortId] = useState(defaultResortId ?? '');
  const [touched, setTouched] = useState(false);

  const mutation = useMutation({
    mutationFn: () => getRepositories().drivers.createDriver({ fullName: fullName.trim(), resortId }),
    onSuccess: () => onCreated(fullName.trim()),
  });

  const nameError = touched && !fullName.trim() ? 'Full name is required.' : null;
  const resortError = touched && !resortId ? 'Select a resort.' : null;
  const canSubmit = fullName.trim().length > 0 && resortId.length > 0;

  return (
    <Modal
      title="Add driver"
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
            {mutation.isPending ? 'Creating…' : 'Create driver'}
          </Button>
        </>
      }
    >
      {mutation.isError && <InlineNotice tone="error">{describeConfigurationError(mutation.error, 'driver')}</InlineNotice>}
      <div className="form-field">
        <label htmlFor="driver-full-name">Full name</label>
        <input
          id="driver-full-name"
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="e.g. Gianni"
          autoFocus
        />
        {nameError && <span className="form-field__error">{nameError}</span>}
      </div>
      <div className="form-field">
        <label htmlFor="driver-resort">Resort</label>
        <select id="driver-resort" value={resortId} onChange={(e) => setResortId(e.target.value)}>
          <option value="" disabled>
            Select a resort…
          </option>
          {resorts.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        {resortError && <span className="form-field__error">{resortError}</span>}
        <span className="form-field__hint">A driver belongs to exactly one resort. This cannot be changed later.</span>
      </div>
    </Modal>
  );
}

function EditDriverModal({
  driver,
  resortName,
  onClose,
  onSaved,
}: {
  driver: DriverRecord;
  resortName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(driver.fullName);

  const mutation = useMutation({
    mutationFn: () => getRepositories().drivers.updateDriverName(driver.id, fullName.trim()),
    onSuccess: onSaved,
  });

  return (
    <Modal
      title={`Edit ${driver.fullName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="primary" disabled={mutation.isPending || !fullName.trim()} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      {mutation.isError && <InlineNotice tone="error">{describeConfigurationError(mutation.error, 'driver')}</InlineNotice>}
      <div className="form-field">
        <label htmlFor="edit-driver-full-name">Full name</label>
        <input id="edit-driver-full-name" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus />
      </div>
      <div className="form-field">
        <label htmlFor="edit-driver-resort">Resort</label>
        <select id="edit-driver-resort" value={resortName} disabled>
          <option>{resortName}</option>
        </select>
        <span className="form-field__hint">
          A driver's resort can't be changed here. To move {driver.fullName} to a different resort, deactivate this
          profile and create a new one at the new resort.
        </span>
      </div>
    </Modal>
  );
}

function DeactivateDriverDialog({
  driver,
  onCancel,
  onDeactivated,
}: {
  driver: DriverRecord;
  onCancel: () => void;
  onDeactivated: () => void;
}) {
  const mutation = useMutation({
    mutationFn: () => getRepositories().drivers.deactivateDriver(driver.id),
    onSuccess: onDeactivated,
  });

  return (
    <ConfirmDialog
      title={`Deactivate ${driver.fullName}?`}
      message={
        <>
          <p style={{ marginBottom: mutation.isError ? 10 : 0 }}>
            {driver.fullName} will no longer be schedulable. Historical rota, attendance and payroll data will be
            retained — this can be reviewed later via the Inactive filter.
          </p>
          {mutation.isError && <InlineNotice tone="error">{describeConfigurationError(mutation.error, 'driver')}</InlineNotice>}
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
