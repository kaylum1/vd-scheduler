import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { InlineNotice } from '../../../components/ui/InlineNotice';
import { Modal, ConfirmDialog } from '../../../components/ui/Modal';
import { IconCalendar, IconClock, IconEdit, IconPlus } from '../../../components/ui/icons';
import { getRepositories } from '../../../repositories';
import { getOperationalToday } from '../../../lib/operationalTime';
import type {
  ShiftTemplateRecord,
  ShiftTypeRecord,
  TemplateCancellationPreviewRow,
  TemplateRefreshFieldChange,
  TemplateRefreshPreviewRow,
} from '../../../repositories/domain';
import { describeConfigurationError } from './errorMessages';
import { addIsoDays, formatIsoDateLong, maxIsoDate, toIsoDateString } from './isoDate';

/**
 * Weekday convention throughout: Monday = 0 .. Sunday = 6, matching the
 * database (app_weekday) — this array is the ONLY place the UI translates
 * that integer to something a manager reads. Deliberately not imported
 * from mock-data/date-utils — Configuration never depends on the Stage 1.1
 * mock-data module (see Configuration.test.tsx's architecture check).
 */
const WEEKDAYS = [
  { index: 0, label: 'Mon', full: 'Monday' },
  { index: 1, label: 'Tue', full: 'Tuesday' },
  { index: 2, label: 'Wed', full: 'Wednesday' },
  { index: 3, label: 'Thu', full: 'Thursday' },
  { index: 4, label: 'Fri', full: 'Friday' },
  { index: 5, label: 'Sat', full: 'Saturday' },
  { index: 6, label: 'Sun', full: 'Sunday' },
] as const;

const FIELD_LABELS: Record<string, string> = {
  start_time: 'Start time',
  end_time: 'End time',
  required_drivers: 'Required drivers',
  base_pay_chf: 'Base pay',
  delivery_rate_chf: 'Delivery rate',
  is_premium: 'High-value shift',
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
  if (key === 'base_pay_chf' || key === 'delivery_rate_chf') return `CHF ${Number(value).toFixed(2)}`;
  if (key === 'is_premium') return value ? 'Yes' : 'No';
  if (key === 'start_time' || key === 'end_time') return toHHMM(String(value));
  return String(value);
}

/** Not currently used to fetch anything — resortId is threaded through purely to scope mutations/query-invalidation to the selected resort. */
export function RecurringScheduleCard({ resortId, resortName }: { resortId: string; resortName: string }) {
  const queryClient = useQueryClient();
  const [materialiseNotice, setMaterialiseNotice] = useState<string | null>(null);
  const [showRefreshDialog, setShowRefreshDialog] = useState(false);

  const shiftTypesQuery = useQuery({
    queryKey: ['config', 'shiftTypes', resortId],
    queryFn: () => getRepositories().shiftConfiguration.listShiftTypes(resortId),
  });

  const activeShiftTypes = useMemo(
    () => (shiftTypesQuery.data ?? []).filter((t) => t.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
    [shiftTypesQuery.data]
  );

  const materialiseMutation = useMutation({
    mutationFn: () => getRepositories().shiftConfiguration.materialiseShifts(resortId),
    onSuccess: (result) => {
      setMaterialiseNotice(
        `${result.createdCount} shift${result.createdCount === 1 ? '' : 's'} created. ${result.skippedExistingCount} already existed.`
      );
      queryClient.invalidateQueries({ queryKey: ['config', 'shiftInstances', resortId] });
    },
  });

  return (
    <Card style={{ marginTop: 16 }}>
      <CardHeader
        title={`Recurring shift schedule — ${resortName}`}
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button variant="secondary" size="sm" onClick={() => setShowRefreshDialog(true)}>
              Review schedule updates
            </Button>
            <Button variant="primary" size="sm" onClick={() => materialiseMutation.mutate()} disabled={materialiseMutation.isPending}>
              {materialiseMutation.isPending ? 'Generating…' : 'Generate upcoming shifts'}
            </Button>
          </div>
        }
      />

      {materialiseNotice && (
        <div style={{ padding: '12px 18px 0' }}>
          <InlineNotice tone="success" onDismiss={() => setMaterialiseNotice(null)}>
            {materialiseNotice}
          </InlineNotice>
        </div>
      )}
      {materialiseMutation.isError && (
        <div style={{ padding: '12px 18px 0' }}>
          <InlineNotice tone="error">{describeConfigurationError(materialiseMutation.error, 'shiftTemplate')}</InlineNotice>
        </div>
      )}

      {shiftTypesQuery.isLoading ? (
        <div className="config-loading">Loading shift types…</div>
      ) : shiftTypesQuery.isError ? (
        <div className="config-error">
          <p>Couldn't load shift types. {describeConfigurationError(shiftTypesQuery.error, 'shiftType')}</p>
          <Button variant="secondary" size="sm" onClick={() => shiftTypesQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : activeShiftTypes.length === 0 ? (
        <EmptyState
          icon={<IconCalendar />}
          title="No shift types configured yet"
          hint="Add a shift type above first — its recurring schedule can be set up here once it exists."
        />
      ) : (
        activeShiftTypes.map((type) => <ShiftTypeSchedule key={type.id} resortId={resortId} shiftType={type} />)
      )}

      {showRefreshDialog && <RefreshPreviewDialog resortId={resortId} onClose={() => setShowRefreshDialog(false)} />}
    </Card>
  );
}

function ShiftTypeSchedule({ resortId, shiftType }: { resortId: string; shiftType: ShiftTypeRecord }) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ShiftTemplateRecord | null>(null);
  const [endingTemplate, setEndingTemplate] = useState<ShiftTemplateRecord | null>(null);

  const templatesQuery = useQuery({
    queryKey: ['config', 'shiftTemplates', shiftType.id],
    queryFn: () => getRepositories().shiftConfiguration.listShiftTemplates(shiftType.id),
  });

  // Only the currently-active version per weekday is shown — historical
  // (superseded/ended) versions are not a "confusing admin table" the
  // manager needs to see here (Checkpoint 2 section 3).
  const activeTemplates = useMemo(
    () => (templatesQuery.data ?? []).filter((t) => t.isActive).sort((a, b) => a.weekday - b.weekday),
    [templatesQuery.data]
  );
  const usedWeekdays = useMemo(() => new Set(activeTemplates.map((t) => t.weekday)), [activeTemplates]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['config', 'shiftTemplates', shiftType.id] });

  return (
    <div className="schedule-section">
      <div className="schedule-section__header">
        <strong>{shiftType.name}</strong>
        <Button variant="ghost" size="sm" onClick={() => setShowAdd(true)} disabled={usedWeekdays.size === 7}>
          <IconPlus style={{ width: 13, height: 13 }} />
          Add day
        </Button>
      </div>

      {templatesQuery.isLoading ? (
        <div className="config-loading">Loading…</div>
      ) : templatesQuery.isError ? (
        <div className="config-error">
          <p>Couldn't load the schedule. {describeConfigurationError(templatesQuery.error, 'shiftTemplate')}</p>
          <Button variant="secondary" size="sm" onClick={() => templatesQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : activeTemplates.length === 0 ? (
        // No active template = no service on any day for this shift type —
        // a normal, neutral state, never "uncovered" (docs/business-rules.md §A).
        <div className="schedule-empty">No recurring shifts configured.</div>
      ) : (
        <div className="schedule-days">
          {activeTemplates.map((t) => (
            <div className="schedule-day" key={t.id}>
              <div className="schedule-day__weekday">{WEEKDAYS[t.weekday]?.label ?? '?'}</div>
              <div className="schedule-day__body">
                <div className="schedule-day__row">
                  <span className="schedule-day__time">
                    <IconClock style={{ width: 11, height: 11, marginRight: 3, verticalAlign: -1 }} />
                    {toHHMM(t.startTime)}–{toHHMM(t.endTime)}
                  </span>
                  <span>
                    {t.requiredDrivers} driver{t.requiredDrivers === 1 ? '' : 's'}
                  </span>
                  {t.isPremium && <Badge tone="amber">High-value</Badge>}
                </div>
                <div className="schedule-day__row schedule-day__row--muted">
                  <span>
                    CHF {t.basePayChf.toFixed(2)} base / CHF {t.deliveryRateChf.toFixed(2)} delivery
                  </span>
                  <span>
                    From {formatIsoDateLong(t.effectiveFrom)}
                    {t.effectiveTo ? ` until ${formatIsoDateLong(t.effectiveTo)}` : ' — continues until changed'}
                  </span>
                </div>
              </div>
              <div className="schedule-day__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  icon
                  aria-label={`Edit ${shiftType.name} ${WEEKDAYS[t.weekday]?.full}`}
                  onClick={() => setEditingTemplate(t)}
                >
                  <IconEdit />
                </Button>
                <Button variant="danger-outline" size="sm" onClick={() => setEndingTemplate(t)}>
                  End
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <TemplateFormModal
          mode="create"
          resortId={resortId}
          shiftType={shiftType}
          excludedWeekdays={usedWeekdays}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            invalidate();
          }}
        />
      )}
      {editingTemplate && (
        <TemplateFormModal
          mode="revise"
          resortId={resortId}
          shiftType={shiftType}
          currentTemplate={editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onSaved={() => {
            setEditingTemplate(null);
            invalidate();
          }}
        />
      )}
      {endingTemplate && (
        <EndTemplateDialog
          resortId={resortId}
          shiftType={shiftType}
          template={endingTemplate}
          onClose={() => setEndingTemplate(null)}
          onEnded={() => {
            setEndingTemplate(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function TemplateFormModal({
  mode,
  resortId,
  shiftType,
  currentTemplate,
  excludedWeekdays,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'revise';
  resortId: string;
  shiftType: ShiftTypeRecord;
  currentTemplate?: ShiftTemplateRecord;
  excludedWeekdays?: Set<number>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = toIsoDateString(getOperationalToday());
  const tomorrow = addIsoDays(today, 1);
  // The new version must start strictly after the version it replaces
  // started (so deactivating the old one with effectiveTo = the day
  // before never produces effective_to < effective_from — a real
  // constraint violation caught in Checkpoint 2's manual pass, e.g. when
  // the current version itself starts "tomorrow" and a manager revises it
  // again before that date arrives) — and never earlier than tomorrow,
  // so past configuration is never rewritten.
  const minEffectiveFrom = mode === 'revise' && currentTemplate ? maxIsoDate(tomorrow, addIsoDays(currentTemplate.effectiveFrom, 1)) : tomorrow;

  const [weekday, setWeekday] = useState<number>(currentTemplate?.weekday ?? -1);
  const [startTime, setStartTime] = useState(currentTemplate ? toHHMM(currentTemplate.startTime) : '18:00');
  const [endTime, setEndTime] = useState(currentTemplate ? toHHMM(currentTemplate.endTime) : '21:30');
  const [requiredDrivers, setRequiredDrivers] = useState(currentTemplate?.requiredDrivers ?? 1);
  const [basePayChf, setBasePayChf] = useState(currentTemplate?.basePayChf ?? 0);
  const [deliveryRateChf, setDeliveryRateChf] = useState(currentTemplate?.deliveryRateChf ?? 0);
  const [isPremium, setIsPremium] = useState(currentTemplate?.isPremium ?? false);
  const [effectiveFrom, setEffectiveFrom] = useState(mode === 'create' ? today : minEffectiveFrom);
  const [effectiveTo, setEffectiveTo] = useState('');
  const [touched, setTouched] = useState(false);

  const effectiveWeekday = mode === 'revise' ? currentTemplate!.weekday : weekday;

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === 'revise' && currentTemplate) {
        const dayBeforeNewVersion = addIsoDays(effectiveFrom, -1);
        await getRepositories().shiftConfiguration.deactivateShiftTemplate(currentTemplate.id, dayBeforeNewVersion);
      }
      return getRepositories().shiftConfiguration.createShiftTemplateVersion({
        shiftTypeId: shiftType.id,
        resortId,
        weekday: effectiveWeekday,
        startTime,
        endTime,
        requiredDrivers,
        basePayChf,
        deliveryRateChf,
        isPremium,
        effectiveFrom,
        effectiveTo: effectiveTo || undefined,
      });
    },
    onSuccess: onSaved,
  });

  const weekdayError = touched && mode === 'create' && weekday === -1 ? 'Select a day.' : null;
  const canSubmit = effectiveWeekday !== -1 && startTime && endTime && requiredDrivers > 0 && effectiveFrom;

  const deliveryExample = deliveryRateChf > 0 ? Math.ceil((basePayChf + 0.01) / deliveryRateChf) : null;

  return (
    <Modal
      title={mode === 'create' ? `Add day — ${shiftType.name}` : `Edit ${shiftType.name} — ${WEEKDAYS[currentTemplate!.weekday]?.full}`}
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
            {mutation.isPending ? 'Saving…' : mode === 'create' ? 'Add day' : 'Save new version'}
          </Button>
        </>
      }
    >
      {mutation.isError && (
        <InlineNotice tone="error">
          {describeConfigurationError(mutation.error, 'shiftTemplate', {
            shiftTypeName: shiftType.name,
            weekdayLabel: WEEKDAYS[effectiveWeekday]?.full,
          })}
        </InlineNotice>
      )}

      {mode === 'create' ? (
        <div className="form-field">
          <label htmlFor="tpl-weekday">Day of week</label>
          <select id="tpl-weekday" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
            <option value={-1} disabled>
              Select a day…
            </option>
            {WEEKDAYS.filter((w) => !excludedWeekdays?.has(w.index)).map((w) => (
              <option key={w.index} value={w.index}>
                {w.full}
              </option>
            ))}
          </select>
          {weekdayError && <span className="form-field__error">{weekdayError}</span>}
        </div>
      ) : (
        <div className="form-field">
          <label htmlFor="tpl-weekday-fixed">Day of week</label>
          <input id="tpl-weekday-fixed" type="text" value={WEEKDAYS[currentTemplate!.weekday]?.full} disabled />
          <span className="form-field__hint">To change the day itself, end this service and add a new one.</span>
        </div>
      )}

      <div className="form-row">
        <div className="form-field">
          <label htmlFor="tpl-start">Start time</label>
          <input id="tpl-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </div>
        <div className="form-field">
          <label htmlFor="tpl-end">End time</label>
          <input id="tpl-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="tpl-required">Required drivers</label>
        <input
          id="tpl-required"
          type="number"
          min={1}
          value={requiredDrivers}
          onChange={(e) => setRequiredDrivers(Number(e.target.value))}
        />
      </div>

      <div className="form-row">
        <div className="form-field">
          <label htmlFor="tpl-base-pay">Base pay (CHF)</label>
          <input
            id="tpl-base-pay"
            type="number"
            min={0}
            step="0.5"
            value={basePayChf}
            onChange={(e) => setBasePayChf(Number(e.target.value))}
          />
        </div>
        <div className="form-field">
          <label htmlFor="tpl-delivery-rate">Delivery rate (CHF)</label>
          <input
            id="tpl-delivery-rate"
            type="number"
            min={0}
            step="0.5"
            value={deliveryRateChf}
            onChange={(e) => setDeliveryRateChf(Number(e.target.value))}
          />
        </div>
      </div>
      <span className="form-field__hint">
        Shift pay is whichever is higher: the base pay, or completed deliveries × delivery rate.
        {deliveryExample && basePayChf > 0
          ? ` With these numbers, a driver needs ${deliveryExample} deliveries before delivery pay overtakes the CHF ${basePayChf.toFixed(2)} base.`
          : ''}
      </span>

      <div className="form-field form-field--checkbox">
        <label>
          <input type="checkbox" checked={isPremium} onChange={(e) => setIsPremium(e.target.checked)} /> High-value shift
        </label>
        <span className="form-field__hint">Internal only, used later for rota fairness. Drivers never see this.</span>
      </div>

      <div className="form-row">
        <div className="form-field">
          <label htmlFor="tpl-effective-from">Effective from</label>
          <input
            id="tpl-effective-from"
            type="date"
            value={effectiveFrom}
            min={mode === 'revise' ? minEffectiveFrom : undefined}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
          {mode === 'revise' && (
            <span className="form-field__hint">Must be after {formatIsoDateLong(currentTemplate!.effectiveFrom)}, when the current version started.</span>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="tpl-effective-to">Effective until (optional)</label>
          <input id="tpl-effective-to" type="date" value={effectiveTo} min={effectiveFrom} onChange={(e) => setEffectiveTo(e.target.value)} />
          <span className="form-field__hint">Leave blank to continue until changed.</span>
        </div>
      </div>
    </Modal>
  );
}

function EndTemplateDialog({
  resortId,
  shiftType,
  template,
  onClose,
  onEnded,
}: {
  resortId: string;
  shiftType: ShiftTypeRecord;
  template: ShiftTemplateRecord;
  onClose: () => void;
  onEnded: () => void;
}) {
  const [stage, setStage] = useState<'confirm' | 'preview' | 'done'>('confirm');
  const [previewRows, setPreviewRows] = useState<TemplateCancellationPreviewRow[]>([]);
  const [applyNotice, setApplyNotice] = useState<string | null>(null);

  const endMutation = useMutation({
    mutationFn: async () => {
      const today = toIsoDateString(getOperationalToday());
      await getRepositories().shiftConfiguration.deactivateShiftTemplate(template.id, today);
      // Ending the template above always succeeds the same way in both
      // providers; only the *review* step is Supabase-only (materialisation/
      // refresh/cancellation are never faked in mock mode — see
      // MockShiftConfigurationRepository). A failure here doesn't mean
      // ending failed, so it's reported as an informational outcome, not an
      // error state.
      try {
        const rows = await getRepositories().shiftConfiguration.previewTemplateCancellation(resortId, shiftType.id);
        return { supported: true as const, rows };
      } catch {
        return { supported: false as const, rows: [] as TemplateCancellationPreviewRow[] };
      }
    },
    onSuccess: ({ supported, rows }) => {
      if (!supported) {
        setApplyNotice('Ended. Reviewing already-scheduled shifts needs Supabase mode.');
        setStage('done');
        return;
      }
      setPreviewRows(rows);
      setStage('preview');
    },
  });

  const applyMutation = useMutation({
    mutationFn: () => getRepositories().shiftConfiguration.applyTemplateCancellation(resortId, shiftType.id, 'template_ended_by_manager'),
    onSuccess: (result) => {
      setApplyNotice(`${result.cancelledCount} affected shift${result.cancelledCount === 1 ? '' : 's'} cancelled.`);
      setStage('done');
    },
  });

  if (stage === 'confirm') {
    return (
      <ConfirmDialog
        title={`End ${shiftType.name} on ${WEEKDAYS[template.weekday]?.full}?`}
        message={
          <>
            <p style={{ marginBottom: endMutation.isError ? 10 : 0 }}>
              This stops future {shiftType.name} shifts being generated for {WEEKDAYS[template.weekday]?.full}. Already
              generated shifts are not automatically cancelled — you'll see exactly what's affected next.
            </p>
            {endMutation.isError && <InlineNotice tone="error">{describeConfigurationError(endMutation.error, 'shiftTemplate')}</InlineNotice>}
          </>
        }
        confirmLabel="End & review"
        danger
        busy={endMutation.isPending}
        onConfirm={() => endMutation.mutate()}
        onCancel={onClose}
      />
    );
  }

  if (stage === 'preview') {
    const safeRows = previewRows.filter((r) => r.isSafeToCancel);
    const protectedRows = previewRows.filter((r) => !r.isSafeToCancel);
    const dates = safeRows.map((r) => r.date).sort();

    return (
      <Modal
        title={`Review affected ${shiftType.name} shifts`}
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={applyMutation.isPending}>
              Not now
            </Button>
            <Button variant="danger-outline" disabled={applyMutation.isPending || safeRows.length === 0} onClick={() => applyMutation.mutate()}>
              {applyMutation.isPending ? 'Cancelling…' : `Cancel ${safeRows.length} shift${safeRows.length === 1 ? '' : 's'}`}
            </Button>
          </>
        }
      >
        {applyMutation.isError && <InlineNotice tone="error">{describeConfigurationError(applyMutation.error, 'shiftTemplate')}</InlineNotice>}
        {previewRows.length === 0 ? (
          <p>No already-generated shifts are affected — nothing further to do.</p>
        ) : (
          <>
            {safeRows.length > 0 && (
              <p>
                <strong>{safeRows.length}</strong> shift{safeRows.length === 1 ? '' : 's'} will be cancelled, from{' '}
                {formatIsoDateLong(dates[0])} to {formatIsoDateLong(dates[dates.length - 1])}.
              </p>
            )}
            {protectedRows.length > 0 && (
              <InlineNotice tone="info">
                {protectedRows.length} shift{protectedRows.length === 1 ? ' was' : 's were'} not changed — already published or
                with recorded attendance.
              </InlineNotice>
            )}
          </>
        )}
      </Modal>
    );
  }

  return (
    <Modal title="Done" onClose={onEnded} footer={<Button variant="primary" onClick={onEnded}>Close</Button>}>
      <p>{applyNotice}</p>
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
      overassignedCount: number;
      timeWouldChange: boolean;
    }
  >();
  for (const row of rows) {
    const key = `${row.shiftTypeId}:${JSON.stringify(row.changedFields)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.dates.push(row.date);
      existing.assignmentCount += row.assignmentCount;
      if (row.wouldBeOverassigned) existing.overassignedCount += 1;
    } else {
      groups.set(key, {
        name: row.name,
        changedFields: row.changedFields,
        dates: [row.date],
        assignmentCount: row.assignmentCount,
        overassignedCount: row.wouldBeOverassigned ? 1 : 0,
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
      if (result.overassignedCount > 0) parts.push(`${result.overassignedCount} now need${result.overassignedCount === 1 ? 's' : ''} attention (over-assigned).`);
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
  const anyOverassigned = changedRows.some((r) => r.wouldBeOverassigned);

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
      {applyMutation.isError && <InlineNotice tone="error">{describeConfigurationError(applyMutation.error, 'shiftTemplate')}</InlineNotice>}
      {previewQuery.isLoading ? (
        <p>Checking for changes…</p>
      ) : previewQuery.isError ? (
        <InlineNotice tone="error">{describeConfigurationError(previewQuery.error, 'shiftTemplate')}</InlineNotice>
      ) : changedRows.length === 0 ? (
        <p>No changes to review right now — already-generated shifts already match their recurring schedule.</p>
      ) : (
        <>
          {anyTimeChange && (
            <InlineNotice tone="info">
              Changing the shift time will reopen confirmed driver availability for the affected week(s).
            </InlineNotice>
          )}
          {anyOverassigned && (
            <InlineNotice tone="error">
              Some shifts would have more drivers assigned than the new headcount allows — assignments are kept, but flagged for
              your attention.
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
                  {g.overassignedCount > 0 ? ` · ${g.overassignedCount} over-assigned` : ''}
                </div>
              </div>
            );
          })}
        </>
      )}
    </Modal>
  );
}
