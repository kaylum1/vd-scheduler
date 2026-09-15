import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { StatusPill } from '../../../components/ui/StatusPill';
import { EmptyState } from '../../../components/ui/EmptyState';
import { InlineNotice } from '../../../components/ui/InlineNotice';
import { Modal, ConfirmDialog } from '../../../components/ui/Modal';
import { IconCalendar, IconClock, IconEdit, IconPlus } from '../../../components/ui/icons';
import { getRepositories } from '../../../repositories';
import { getOperationalToday } from '../../../lib/operationalTime';
import type { ShiftRecord, TemplateCancellationPreviewRow, TemplateRefreshFieldChange, TemplateRefreshPreviewRow } from '../../../repositories/domain';
import type { ShiftScheduleInput } from '../../../repositories/types';
import { describeConfigurationError } from './errorMessages';
import { toIsoDateString, formatIsoDateLong } from './isoDate';
import { WEEKDAYS, WeekdayChipsDisplay, WeekdayToggleGroup, weekdaysLabel } from './WeekdayChips';

type ShiftFilter = 'active' | 'inactive' | 'all';

const FIELD_LABELS: Record<string, string> = {
  start_time: 'Start time',
  end_time: 'End time',
  name: 'Name',
  sort_order: 'Sort order',
};

/**
 * Postgres `time` columns round-trip through PostgREST as "HH:MM:SS"
 * (mock mode's plain strings never had seconds) — trimmed here for display
 * and for pre-filling the <input type="time"> form field. This is a plain
 * string slice, never a Date conversion (Stage 2C.1: shift wall-clock times
 * are never routed through JS Date).
 */
function toHHMM(time: string): string {
  return time.slice(0, 5);
}

function formatFieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (key === 'start_time' || key === 'end_time') return toHHMM(String(value));
  return String(value);
}

/**
 * Stage 2D Checkpoint 4: the manager-facing "Shift Setup" — the single
 * replacement for the old two-layer Shift Types + Recurring Shift Schedule
 * UX. Managers work with one object, "Shift" (name/time/weekdays/effective
 * period) — shift_type/template/weekday-integer/stable-key are internal
 * only from here on. See docs/business-rules.md for the terminology
 * mapping and the legacy inconsistent-schedule safety rule.
 */
export function ShiftSetupPanel({ resortId, resortName }: { resortId: string; resortName: string }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ShiftFilter>('active');
  const [showAdd, setShowAdd] = useState(false);
  const [editingShift, setEditingShift] = useState<ShiftRecord | null>(null);
  const [reactivatingShift, setReactivatingShift] = useState<ShiftRecord | null>(null);
  const [deactivatingShift, setDeactivatingShift] = useState<ShiftRecord | null>(null);
  const [materialiseNotice, setMaterialiseNotice] = useState<{ text: string; hasWarning: boolean } | null>(null);
  const [showRefreshDialog, setShowRefreshDialog] = useState(false);

  const shiftsQuery = useQuery({
    queryKey: ['config', 'shifts', resortId],
    queryFn: () => getRepositories().shiftConfiguration.listShifts(resortId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['config', 'shifts', resortId] });

  const filtered = useMemo(() => {
    const shifts = shiftsQuery.data ?? [];
    const byFilter = filter === 'all' ? shifts : shifts.filter((s) => (filter === 'active' ? s.isActive : !s.isActive));
    return [...byFilter].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [shiftsQuery.data, filter]);

  const materialiseMutation = useMutation({
    mutationFn: () => getRepositories().shiftConfiguration.materialiseShifts(resortId),
    onSuccess: (result) => {
      const parts = [
        `${result.createdCount} shift${result.createdCount === 1 ? '' : 's'} created.`,
        `${result.skippedExistingCount} already existed.`,
      ];
      const hasWarning = result.missingRotaRuleCount > 0;
      if (result.missingRotaRuleCount > 0) {
        parts.push(`${result.missingRotaRuleCount} shift${result.missingRotaRuleCount === 1 ? ' has' : 's have'} no Rota Rule configured.`);
      }
      setMaterialiseNotice({ text: parts.join(' '), hasWarning });
      queryClient.invalidateQueries({ queryKey: ['config', 'shiftInstances', resortId] });
    },
  });

  return (
    <Card style={{ marginTop: 16 }}>
      <CardHeader
        title={`Shift Setup — ${resortName}`}
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button variant="secondary" size="sm" onClick={() => setShowRefreshDialog(true)}>
              Review schedule updates
            </Button>
            <Button variant="secondary" size="sm" onClick={() => materialiseMutation.mutate()} disabled={materialiseMutation.isPending}>
              {materialiseMutation.isPending ? 'Generating…' : 'Generate upcoming shifts'}
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
              <IconPlus style={{ width: 14, height: 14 }} />
              Add Shift
            </Button>
          </div>
        }
      />
      <p className="shift-setup-hint">Choose a resort above to edit its shifts.</p>

      {materialiseNotice && (
        <div style={{ padding: '12px 18px 0' }}>
          {/* Missing Rota Rule count is an informational "Needs Attention"
              signal, never a materialisation failure -- amber, not red, and
              dismissible like any other success notice. Shift generation has
              no payroll-rate awareness at all (Stage 2D Payroll Checkpoint
              A) -- missing-rate configuration is surfaced by Payroll itself. */}
          <InlineNotice tone={materialiseNotice.hasWarning ? 'warning' : 'success'} onDismiss={() => setMaterialiseNotice(null)}>
            {materialiseNotice.text}
          </InlineNotice>
        </div>
      )}
      {materialiseMutation.isError && (
        <div style={{ padding: '12px 18px 0' }}>
          <InlineNotice tone="error">{describeConfigurationError(materialiseMutation.error, 'shift')}</InlineNotice>
        </div>
      )}

      <div className="shift-setup-filter segmented" role="tablist" aria-label="Filter shifts">
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

      {shiftsQuery.isLoading ? (
        <div className="config-loading">Loading shifts…</div>
      ) : shiftsQuery.isError ? (
        <div className="config-error">
          <p>Couldn't load shifts. {describeConfigurationError(shiftsQuery.error, 'shift')}</p>
          <Button variant="secondary" size="sm" onClick={() => shiftsQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<IconCalendar />}
          title={filter === 'inactive' ? 'No inactive shifts' : `No shifts configured yet for ${resortName}`}
          hint={filter === 'inactive' ? undefined : 'Add the services this resort runs, e.g. Lunch, Dinner.'}
        />
      ) : (
        <div className="shift-setup-list">
          {filtered.map((shift) => (
            <ShiftCard
              key={shift.shiftTypeId}
              shift={shift}
              onEdit={() => setEditingShift(shift)}
              onDeactivate={() => setDeactivatingShift(shift)}
              onReactivate={() => setReactivatingShift(shift)}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <ShiftFormModal
          mode="create"
          resortId={resortId}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            invalidate();
          }}
        />
      )}
      {editingShift && (
        <ShiftFormModal
          mode="revise"
          resortId={resortId}
          shift={editingShift}
          onClose={() => setEditingShift(null)}
          onSaved={() => {
            setEditingShift(null);
            invalidate();
          }}
        />
      )}
      {reactivatingShift && (
        <ShiftFormModal
          mode="reactivate"
          resortId={resortId}
          shift={reactivatingShift}
          onClose={() => setReactivatingShift(null)}
          onSaved={() => {
            setReactivatingShift(null);
            invalidate();
          }}
        />
      )}
      {deactivatingShift && (
        <DeactivateShiftFlow
          resortId={resortId}
          shift={deactivatingShift}
          onClose={() => setDeactivatingShift(null)}
          onDeactivated={() => {
            setDeactivatingShift(null);
            invalidate();
          }}
        />
      )}
      {showRefreshDialog && <RefreshPreviewDialog resortId={resortId} onClose={() => setShowRefreshDialog(false)} />}
    </Card>
  );
}

function ShiftCard({
  shift,
  onEdit,
  onDeactivate,
  onReactivate,
}: {
  shift: ShiftRecord;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  const { schedule } = shift;

  return (
    <div className="config-list-item shift-setup-card">
      <div className="config-list-item__main">
        <div style={{ width: '100%' }}>
          <div className="config-list-item__title">{shift.name}</div>
          {schedule ? (
            <>
              <div className="shift-setup-card__row">
                <span className="schedule-day__time">
                  <IconClock style={{ width: 11, height: 11, marginRight: 3, verticalAlign: -1 }} />
                  {toHHMM(schedule.startTime)}–{toHHMM(schedule.endTime)}
                </span>
                <WeekdayChipsDisplay weekdays={schedule.weekdays} prefix={shift.isActive ? '' : 'Previously '} />
              </div>
              <div className="config-list-item__subtitle">
                {shift.isActive
                  ? `From ${formatIsoDateLong(schedule.effectiveFrom)}${schedule.effectiveTo ? ` until ${formatIsoDateLong(schedule.effectiveTo)}` : ''}`
                  : `Previously ${weekdaysLabel(schedule.weekdays)} · Ended ${schedule.effectiveTo ? formatIsoDateLong(schedule.effectiveTo) : formatIsoDateLong(schedule.effectiveFrom)}`}
              </div>
            </>
          ) : (
            <InlineNotice tone="error">
              This shift has different times configured on different days. Review required before it can use the simplified
              editor.
              {shift.inconsistentWeekdays && (
                <> Affected days: {shift.inconsistentWeekdays.map((w) => WEEKDAYS[w]?.label ?? '?').join(', ')}.</>
              )}
            </InlineNotice>
          )}
        </div>
      </div>
      <div className="config-list-item__badges">
        <StatusPill tone={shift.isActive ? 'green' : 'grey'}>{shift.isActive ? 'Active' : 'Inactive'}</StatusPill>
      </div>
      <div className="config-list-item__actions">
        {shift.isActive ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              icon
              aria-label={`Edit ${shift.name}`}
              onClick={onEdit}
              disabled={!schedule}
              title={schedule ? undefined : 'Review required before this shift can be edited here'}
            >
              <IconEdit />
            </Button>
            <Button variant="danger-outline" size="sm" onClick={onDeactivate}>
              Deactivate
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" onClick={onReactivate}>
            Reactivate
          </Button>
        )}
      </div>
    </div>
  );
}

function ShiftFormModal({
  mode,
  resortId,
  shift,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'revise' | 'reactivate';
  resortId: string;
  shift?: ShiftRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = toIsoDateString(getOperationalToday());
  const existing = shift?.schedule ?? null;
  const previousWeekdays = useMemo(() => new Set(existing?.weekdays ?? []), [existing]);

  const [name, setName] = useState(shift?.name ?? '');
  const [startTime, setStartTime] = useState(existing ? toHHMM(existing.startTime) : '18:00');
  const [endTime, setEndTime] = useState(existing ? toHHMM(existing.endTime) : '21:30');
  const [selectedWeekdays, setSelectedWeekdays] = useState<Set<number>>(new Set(existing?.weekdays ?? []));
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  // Reactivate's "existing" schedule is the shift's last-known (now closed)
  // period -- its effectiveTo is when that period ENDED (the deactivation
  // date), not a sensible default for the NEW period about to start, so
  // reactivate (like create) always defaults to open-ended. Only revise
  // inherits the currently-active schedule's own planned end date, if any.
  const inheritEndDate = mode === 'revise';
  const [continuesUntilChanged, setContinuesUntilChanged] = useState(!(inheritEndDate && existing?.effectiveTo));
  const [effectiveTo, setEffectiveTo] = useState(inheritEndDate ? existing?.effectiveTo ?? '' : '');
  const [touched, setTouched] = useState(false);

  const mutation = useMutation({
    mutationFn: () => {
      const input: ShiftScheduleInput = {
        name: name.trim(),
        startTime,
        endTime,
        weekdays: [...selectedWeekdays],
        effectiveFrom,
        effectiveTo: continuesUntilChanged ? undefined : effectiveTo || undefined,
      };
      if (mode === 'create') return getRepositories().shiftConfiguration.createShift(resortId, input);
      if (mode === 'revise') return getRepositories().shiftConfiguration.reviseShift(shift!.shiftTypeId, resortId, input);
      return getRepositories().shiftConfiguration.reactivateShift(shift!.shiftTypeId, resortId, input);
    },
    onSuccess: onSaved,
  });

  const nameError = touched && !name.trim() ? 'Name is required.' : null;
  const weekdayError = touched && selectedWeekdays.size === 0 ? 'Select at least one day.' : null;
  const timeError = touched && endTime <= startTime ? 'End time must be after start time.' : null;
  const endsError = touched && !continuesUntilChanged && !effectiveTo ? 'Choose an end date, or select "Continues until changed".' : null;
  const canSubmit =
    name.trim().length > 0 && selectedWeekdays.size > 0 && endTime > startTime && effectiveFrom && (continuesUntilChanged || !!effectiveTo);

  const addedWeekdays = mode !== 'create' ? [...selectedWeekdays].filter((w) => !previousWeekdays.has(w)).sort((a, b) => a - b) : [];
  const removedWeekdays = mode !== 'create' ? [...previousWeekdays].filter((w) => !selectedWeekdays.has(w)).sort((a, b) => a - b) : [];

  const title = mode === 'create' ? 'Add Shift' : mode === 'revise' ? `Edit ${shift?.name}` : `Reactivate ${shift?.name}`;
  const dateLabel = mode === 'create' ? 'Starts' : mode === 'revise' ? 'Changes apply from' : 'Reactivates from';
  const submitLabel = mode === 'create' ? 'Create Shift' : mode === 'revise' ? 'Save Changes' : 'Reactivate';

  return (
    <Modal
      title={title}
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
            {mutation.isPending ? 'Saving…' : submitLabel}
          </Button>
        </>
      }
    >
      {mutation.isError && (
        <InlineNotice tone="error">{describeConfigurationError(mutation.error, 'shift', { shiftTypeName: shift?.name })}</InlineNotice>
      )}

      <div className="form-field">
        <label htmlFor="shift-form-name">Name</label>
        <input id="shift-form-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dinner" autoFocus />
        {nameError && <span className="form-field__error">{nameError}</span>}
      </div>

      <div className="form-field">
        <label id="shift-form-time-label">Time</label>
        <div className="shift-form-time-row" aria-labelledby="shift-form-time-label">
          <input aria-label="Start time" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          <span aria-hidden="true">→</span>
          <input aria-label="End time" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>
        {timeError && <span className="form-field__error">{timeError}</span>}
        <span className="form-field__hint">One standard time across every day this shift runs. A day that genuinely needs a different time is a separate Shift.</span>
      </div>

      <div className="form-field">
        <label id="shift-form-repeats-label">Repeats</label>
        <WeekdayToggleGroup selected={selectedWeekdays} onChange={setSelectedWeekdays} idPrefix="shift-form" />
        {weekdayError && <span className="form-field__error">{weekdayError}</span>}
        {(addedWeekdays.length > 0 || removedWeekdays.length > 0) && (
          <span className="form-field__hint">
            {addedWeekdays.map((w) => (
              <React.Fragment key={`add-${w}`}>
                {WEEKDAYS[w].full} service will begin from {formatIsoDateLong(effectiveFrom)}.{' '}
              </React.Fragment>
            ))}
            {removedWeekdays.map((w) => (
              <React.Fragment key={`remove-${w}`}>
                {WEEKDAYS[w].full} service will end from {formatIsoDateLong(effectiveFrom)}.{' '}
              </React.Fragment>
            ))}
          </span>
        )}
      </div>

      <div className="form-field">
        <label htmlFor="shift-form-effective-from">{dateLabel}</label>
        <input
          id="shift-form-effective-from"
          type="date"
          value={effectiveFrom}
          min={mode === 'create' ? undefined : today}
          onChange={(e) => setEffectiveFrom(e.target.value)}
        />
      </div>

      <div className="form-field form-field--radio-group">
        <label id="shift-form-ends-label">Ends</label>
        <label className="radio-option">
          <input
            type="radio"
            name="shift-form-ends"
            checked={continuesUntilChanged}
            onChange={() => setContinuesUntilChanged(true)}
          />
          Continues until changed
        </label>
        <label className="radio-option">
          <input
            type="radio"
            name="shift-form-ends"
            checked={!continuesUntilChanged}
            onChange={() => setContinuesUntilChanged(false)}
          />
          On{' '}
          <input
            type="date"
            aria-label="End date"
            value={effectiveTo}
            min={effectiveFrom}
            disabled={continuesUntilChanged}
            onChange={(e) => setEffectiveTo(e.target.value)}
          />
        </label>
        {endsError && <span className="form-field__error">{endsError}</span>}
      </div>
    </Modal>
  );
}

function DeactivateShiftFlow({
  resortId,
  shift,
  onClose,
  onDeactivated,
}: {
  resortId: string;
  shift: ShiftRecord;
  onClose: () => void;
  onDeactivated: () => void;
}) {
  const [stage, setStage] = useState<'confirm' | 'preview' | 'done'>('confirm');
  const [previewRows, setPreviewRows] = useState<TemplateCancellationPreviewRow[]>([]);
  const [doneNotice, setDoneNotice] = useState<string | null>(null);

  const deactivateMutation = useMutation({
    mutationFn: async () => {
      await getRepositories().shiftConfiguration.deactivateShift(shift.shiftTypeId, resortId);
      // The cancellation *review* step is Supabase-only (materialisation/
      // refresh/cancellation are never faked in mock mode — see
      // MockShiftConfigurationRepository). A failure here doesn't mean the
      // deactivation itself failed, so it's reported as an informational
      // outcome, not an error state.
      try {
        const rows = await getRepositories().shiftConfiguration.previewTemplateCancellation(resortId, shift.shiftTypeId);
        return { supported: true as const, rows };
      } catch {
        return { supported: false as const, rows: [] as TemplateCancellationPreviewRow[] };
      }
    },
    onSuccess: ({ supported, rows }) => {
      if (!supported) {
        setDoneNotice('Deactivated. Reviewing already-generated shifts needs Supabase mode.');
        setStage('done');
        return;
      }
      if (rows.length === 0) {
        setDoneNotice('Deactivated. No already-generated shifts were affected.');
        setStage('done');
        return;
      }
      setPreviewRows(rows);
      setStage('preview');
    },
  });

  const applyMutation = useMutation({
    mutationFn: () => getRepositories().shiftConfiguration.applyTemplateCancellation(resortId, shift.shiftTypeId, 'shift_deactivated'),
    onSuccess: (result) => {
      setDoneNotice(`Deactivated. ${result.cancelledCount} affected shift${result.cancelledCount === 1 ? '' : 's'} cancelled.`);
      setStage('done');
    },
  });

  if (stage === 'confirm') {
    return (
      <ConfirmDialog
        title={`Deactivate ${shift.name}?`}
        message={
          <>
            <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
              <li>The recurring service will end.</li>
              <li>Historical records remain — nothing is deleted.</li>
              <li>Already-generated future shifts are handled separately and safely — you'll review them next.</li>
            </ul>
            {deactivateMutation.isError && <InlineNotice tone="error">{describeConfigurationError(deactivateMutation.error, 'shift')}</InlineNotice>}
          </>
        }
        confirmLabel="Deactivate"
        danger
        busy={deactivateMutation.isPending}
        onConfirm={() => deactivateMutation.mutate()}
        onCancel={onClose}
      />
    );
  }

  if (stage === 'preview') {
    const safeRows = previewRows.filter((r) => r.isSafeToCancel);
    const protectedRows = previewRows.filter((r) => !r.isSafeToCancel);

    return (
      <Modal
        title={`Review affected ${shift.name} shifts`}
        onClose={onDeactivated}
        footer={
          <>
            <Button variant="secondary" onClick={onDeactivated} disabled={applyMutation.isPending}>
              Not now
            </Button>
            <Button variant="danger-outline" disabled={applyMutation.isPending || safeRows.length === 0} onClick={() => applyMutation.mutate()}>
              {applyMutation.isPending ? 'Cancelling…' : `Cancel ${safeRows.length} shift${safeRows.length === 1 ? '' : 's'}`}
            </Button>
          </>
        }
      >
        {applyMutation.isError && <InlineNotice tone="error">{describeConfigurationError(applyMutation.error, 'shift')}</InlineNotice>}
        <p>
          <strong>{previewRows.length}</strong> upcoming generated shift{previewRows.length === 1 ? '' : 's'} affected.
        </p>
        {protectedRows.length > 0 && (
          <InlineNotice tone="info">
            {protectedRows.length} shift{protectedRows.length === 1 ? ' was' : 's were'} not changed — already published or with
            recorded attendance.
          </InlineNotice>
        )}
      </Modal>
    );
  }

  return (
    <Modal title="Done" onClose={onDeactivated} footer={<Button variant="primary" onClick={onDeactivated}>Close</Button>}>
      <p>{doneNotice}</p>
    </Modal>
  );
}

function groupRefreshRows(rows: TemplateRefreshPreviewRow[]) {
  const groups = new Map<
    string,
    {
      name: string;
      changedFields: Record<string, TemplateRefreshFieldChange>;
      dates: string[];
      assignmentCount: number;
      timeWouldChange: boolean;
    }
  >();
  for (const row of rows) {
    const key = `${row.shiftTypeId}:${JSON.stringify(row.changedFields)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.dates.push(row.date);
      existing.assignmentCount += row.assignmentCount;
    } else {
      groups.set(key, {
        name: row.name,
        changedFields: row.changedFields,
        dates: [row.date],
        assignmentCount: row.assignmentCount,
        timeWouldChange: row.timeWouldChange,
      });
    }
  }
  return Array.from(groups.values());
}

function RefreshPreviewDialog({ resortId, onClose }: { resortId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [applyNotice, setApplyNotice] = useState<string | null>(null);

  const previewQuery = useQuery({
    queryKey: ['config', 'templateRefreshPreview', resortId],
    queryFn: () => getRepositories().shiftConfiguration.previewTemplateRefresh(resortId),
  });

  const applyMutation = useMutation({
    mutationFn: () => getRepositories().shiftConfiguration.applyTemplateRefresh(resortId),
    onSuccess: (result) => {
      const parts = [`${result.updatedCount} shift${result.updatedCount === 1 ? '' : 's'} updated.`];
      if (result.reopenedSubmissionCount > 0) {
        parts.push(
          `${result.reopenedSubmissionCount} driver submission${result.reopenedSubmissionCount === 1 ? '' : 's'} reopened due to the time change.`
        );
      }
      setApplyNotice(parts.join(' '));
      queryClient.invalidateQueries({ queryKey: ['config', 'shiftInstances', resortId] });
      queryClient.invalidateQueries({ queryKey: ['config', 'templateRefreshPreview', resortId] });
    },
  });

  const changedRows = (previewQuery.data ?? []).filter((r) => r.willChange);
  const groups = useMemo(() => groupRefreshRows(changedRows), [changedRows]);
  const anyTimeChange = changedRows.some((r) => r.timeWouldChange);

  if (applyNotice) {
    return (
      <Modal title="Schedule updates applied" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
        <p>{applyNotice}</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Review schedule updates"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={applyMutation.isPending}>
            Not now
          </Button>
          <Button variant="primary" disabled={applyMutation.isPending || changedRows.length === 0} onClick={() => applyMutation.mutate()}>
            {applyMutation.isPending ? 'Applying…' : `Apply to ${changedRows.length} shift${changedRows.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      {applyMutation.isError && <InlineNotice tone="error">{describeConfigurationError(applyMutation.error, 'shift')}</InlineNotice>}
      {previewQuery.isLoading ? (
        <p>Checking for changes…</p>
      ) : previewQuery.isError ? (
        <InlineNotice tone="error">{describeConfigurationError(previewQuery.error, 'shift')}</InlineNotice>
      ) : changedRows.length === 0 ? (
        <p>No changes to review right now — already-generated shifts already match their recurring schedule.</p>
      ) : (
        <>
          {anyTimeChange && (
            <InlineNotice tone="info">
              Changing the shift time will reopen confirmed driver availability for the affected week(s).
            </InlineNotice>
          )}
          {groups.map((g, i) => {
            const sortedDates = [...g.dates].sort();
            return (
              <div className="schedule-refresh-group" key={i}>
                <div className="schedule-refresh-group__header">
                  <strong>{g.name}</strong>
                  <span>
                    {g.dates.length} shift{g.dates.length === 1 ? '' : 's'} · {formatIsoDateLong(sortedDates[0])}
                    {sortedDates.length > 1 ? ` – ${formatIsoDateLong(sortedDates[sortedDates.length - 1])}` : ''}
                  </span>
                </div>
                <ul className="schedule-refresh-group__changes">
                  {Object.entries(g.changedFields).map(([field, change]) => (
                    <li key={field}>
                      {FIELD_LABELS[field] ?? field}: {formatFieldValue(field, change.old)} → {formatFieldValue(field, change.new)}
                    </li>
                  ))}
                </ul>
                <div className="schedule-refresh-group__meta">
                  {g.assignmentCount} draft assignment{g.assignmentCount === 1 ? '' : 's'} kept
                </div>
              </div>
            );
          })}
        </>
      )}
    </Modal>
  );
}
