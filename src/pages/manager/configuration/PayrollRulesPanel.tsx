import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { StatusPill } from '../../../components/ui/StatusPill';
import { EmptyState } from '../../../components/ui/EmptyState';
import { InlineNotice } from '../../../components/ui/InlineNotice';
import { Modal } from '../../../components/ui/Modal';
import { IconPayroll, IconTruck } from '../../../components/ui/icons';
import { getRepositories } from '../../../repositories';
import type { DriverRecord, ShiftRecord } from '../../../repositories/domain';
import { getOperationalToday } from '../../../lib/operationalTime';
import { describeConfigurationError } from './errorMessages';
import { formatIsoDateLong, toIsoDateString } from './isoDate';

type RatePeriod = { effectiveFrom: string; effectiveTo: string | null };
type DriverFilter = 'active' | 'inactive' | 'all';

interface CategorisedPeriods<T extends RatePeriod> {
  current: T | null;
  /** Ascending by effectiveFrom. V1 UI only ever surfaces the nearest one inline (§7 of the spec permits this); the rest are still visible via History. */
  scheduled: T[];
  /** Ascending by effectiveFrom. */
  history: T[];
}

/**
 * Splits a flat list of effective-dated periods for ONE key (a Shift or a
 * driver) into Current/Scheduled/History -- the one place this resolution
 * logic lives, reused for both rate types (Stage 2D Payroll Checkpoint B).
 * Pure and provider-agnostic, mirroring assembleShift.ts's own role for
 * shift schedules.
 */
export function categorizeRatePeriods<T extends RatePeriod>(periods: T[], today: string): CategorisedPeriods<T> {
  const current = periods.find((p) => p.effectiveFrom <= today && (p.effectiveTo === null || p.effectiveTo >= today)) ?? null;
  const scheduled = periods.filter((p) => p.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const history = periods
    .filter((p) => p.effectiveTo !== null && p.effectiveTo < today)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return { current, scheduled, history };
}

function chf(amount: number): string {
  return `CHF ${amount.toFixed(2)}`;
}

/**
 * Stage 2D Payroll Checkpoint B: Configuration -> Payroll Rules. Rate
 * configuration ONLY -- Shift base pay and driver delivery rates, both
 * effective-dated. No attendance, Onfleet, double-pay, or payroll
 * calculation/finalisation belongs here (see docs/business-rules.md
 * section G and Configuration -> Dashboard for those, once built).
 *
 * Resort selection reuses the exact "Choose resort" pattern established in
 * Resort & Shift Setup (Stage 2D Checkpoint 4.1's UX amendment) rather than
 * inventing a second, inconsistent selector -- active resorts only.
 */
export function PayrollRulesPanel() {
  const [selectedResortId, setSelectedResortId] = useState<string | null>(null);

  const resortsQuery = useQuery({
    queryKey: ['config', 'resorts'],
    queryFn: () => getRepositories().resorts.listResorts(),
  });
  const activeResorts = useMemo(() => (resortsQuery.data ?? []).filter((r) => r.isActive), [resortsQuery.data]);

  useEffect(() => {
    if (!resortsQuery.data) return;
    const stillValidSelection = selectedResortId !== null && activeResorts.some((r) => r.id === selectedResortId);
    if (!stillValidSelection) {
      setSelectedResortId(activeResorts[0]?.id ?? null);
    }
  }, [resortsQuery.data, activeResorts, selectedResortId]);

  const selectedResort = useMemo(() => activeResorts.find((r) => r.id === selectedResortId) ?? null, [activeResorts, selectedResortId]);

  return (
    <>
      {activeResorts.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <CardHeader title="Choose resort" />
          <div className="resort-chooser segmented" role="tablist" aria-label="Choose resort">
            {activeResorts.map((resort) => (
              <button
                key={resort.id}
                role="tab"
                aria-selected={resort.id === selectedResortId}
                className={`segmented__item${resort.id === selectedResortId ? ' is-active' : ''}`}
                onClick={() => setSelectedResortId(resort.id)}
              >
                {resort.name}
              </button>
            ))}
          </div>
        </Card>
      )}

      {selectedResort ? (
        <PayrollRulesForResort resortId={selectedResort.id} resortName={selectedResort.name} />
      ) : (
        !resortsQuery.isLoading &&
        activeResorts.length === 0 && (
          <Card>
            <EmptyState icon={<IconPayroll />} title="Add and activate a resort to configure Payroll Rules" />
          </Card>
        )
      )}
    </>
  );
}

function PayrollRulesForResort({ resortId, resortName }: { resortId: string; resortName: string }) {
  const queryClient = useQueryClient();
  const today = toIsoDateString(getOperationalToday());

  const [ratingShift, setRatingShift] = useState<ShiftRecord | null>(null);
  const [historyShift, setHistoryShift] = useState<ShiftRecord | null>(null);
  const [ratingDriver, setRatingDriver] = useState<DriverRecord | null>(null);
  const [historyDriver, setHistoryDriver] = useState<DriverRecord | null>(null);
  const [driverFilter, setDriverFilter] = useState<DriverFilter>('active');

  const shiftsQuery = useQuery({
    queryKey: ['config', 'shifts', resortId],
    queryFn: () => getRepositories().shiftConfiguration.listShifts(resortId),
  });
  const driversQuery = useQuery({
    queryKey: ['config', 'drivers', resortId],
    queryFn: () => getRepositories().drivers.listDrivers({ resortId }),
  });
  const baseRulesQuery = useQuery({
    queryKey: ['config', 'payrollRules', 'shiftBasePay', resortId],
    queryFn: () => getRepositories().payrollRules.listShiftBasePayRules(resortId),
  });
  const rateRulesQuery = useQuery({
    queryKey: ['config', 'payrollRules', 'driverDeliveryRates', resortId],
    queryFn: () => getRepositories().payrollRules.listDriverDeliveryRates(resortId),
  });

  const activeShifts = useMemo(
    () => (shiftsQuery.data ?? []).filter((s) => s.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
    [shiftsQuery.data]
  );
  const visibleDrivers = useMemo(() => {
    const drivers = driversQuery.data ?? [];
    const filtered = driverFilter === 'all' ? drivers : drivers.filter((d) => (driverFilter === 'active' ? d.isActive : !d.isActive));
    return [...filtered].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [driversQuery.data, driverFilter]);

  const invalidateBaseRules = () => queryClient.invalidateQueries({ queryKey: ['config', 'payrollRules', 'shiftBasePay', resortId] });
  const invalidateRates = () => queryClient.invalidateQueries({ queryKey: ['config', 'payrollRules', 'driverDeliveryRates', resortId] });

  const isLoading = shiftsQuery.isLoading || driversQuery.isLoading || baseRulesQuery.isLoading || rateRulesQuery.isLoading;
  const isError = shiftsQuery.isError || driversQuery.isError || baseRulesQuery.isError || rateRulesQuery.isError;

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <CardHeader title={`Payroll Rules — ${resortName}`} />
        <p className="shift-setup-hint">Configure Shift base pay and driver delivery rates.</p>
        <div style={{ padding: '10px 18px 18px' }}>
          <InlineNotice tone="info">
            Drivers are paid the higher of the Shift base guarantee or their delivery earnings for that Shift.
            <div style={{ marginTop: 6, opacity: 0.85 }}>
              e.g. Base CHF 30.00, 2 × CHF 12.00 deliveries = CHF 24.00 → pay CHF 30.00. 3 × CHF 12.00 = CHF 36.00 → pay CHF 36.00.
            </div>
          </InlineNotice>
        </div>
      </Card>

      {isLoading ? (
        <Card>
          <div className="config-loading">Loading Payroll Rules…</div>
        </Card>
      ) : isError ? (
        <Card>
          <div className="config-error">
            <p>Couldn't load Payroll Rules. {describeConfigurationError(shiftsQuery.error ?? driversQuery.error ?? baseRulesQuery.error ?? rateRulesQuery.error, 'payrollRule')}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                shiftsQuery.refetch();
                driversQuery.refetch();
                baseRulesQuery.refetch();
                rateRulesQuery.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <Card style={{ marginBottom: 16 }}>
            <CardHeader title="Shift base pay" />
            {activeShifts.length === 0 ? (
              <EmptyState icon={<IconPayroll />} title="No active Shifts yet for this resort" hint="Add a Shift in Resort & Shift Setup first." />
            ) : (
              <div className="shift-setup-list">
                {activeShifts.map((shift) => {
                  const periods = (baseRulesQuery.data ?? []).filter((r) => r.shiftTypeId === shift.shiftTypeId);
                  const categorised = categorizeRatePeriods(periods, today);
                  return (
                    <ShiftBaseRateRow
                      key={shift.shiftTypeId}
                      shift={shift}
                      categorised={categorised}
                      onSetOrEdit={() => setRatingShift(shift)}
                      onHistory={() => setHistoryShift(shift)}
                    />
                  );
                })}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Driver delivery rates" />
            <div className="shift-setup-filter segmented" role="tablist" aria-label="Filter drivers">
              {(['active', 'inactive', 'all'] as const).map((f) => (
                <button
                  key={f}
                  role="tab"
                  aria-selected={driverFilter === f}
                  className={`segmented__item${driverFilter === f ? ' is-active' : ''}`}
                  onClick={() => setDriverFilter(f)}
                >
                  {f === 'active' ? 'Active' : f === 'inactive' ? 'Inactive' : 'All'}
                </button>
              ))}
            </div>
            {visibleDrivers.length === 0 ? (
              <EmptyState
                icon={<IconTruck />}
                title={driverFilter === 'inactive' ? 'No inactive drivers' : 'No active drivers yet for this resort'}
              />
            ) : (
              <div className="shift-setup-list">
                {visibleDrivers.map((driver) => {
                  const periods = (rateRulesQuery.data ?? []).filter((r) => r.driverId === driver.id);
                  const categorised = categorizeRatePeriods(periods, today);
                  return (
                    <DriverRateRow
                      key={driver.id}
                      driver={driver}
                      categorised={categorised}
                      onSetOrEdit={() => setRatingDriver(driver)}
                      onHistory={() => setHistoryDriver(driver)}
                    />
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}

      {ratingShift &&
        (() => {
          const periods = (baseRulesQuery.data ?? []).filter((r) => r.shiftTypeId === ratingShift.shiftTypeId);
          const { current } = categorizeRatePeriods(periods, today);
          return (
            <RateAmountModal
              title={current ? `Edit base pay — ${ratingShift.name}` : `Set base pay — ${ratingShift.name}`}
              amountLabel="Base pay"
              helperText="This is the minimum pay guaranteed to each driver who attends this Shift."
              currentSummary={current ? `${chf(current.basePayChf)} / attended shift` : undefined}
              initialAmount={current?.basePayChf ?? 0}
              onSubmit={(amount, effectiveFrom) =>
                getRepositories().payrollRules.setShiftBasePayRate(ratingShift.shiftTypeId, resortId, amount, effectiveFrom)
              }
              onClose={() => setRatingShift(null)}
              onSaved={() => {
                setRatingShift(null);
                invalidateBaseRules();
              }}
            />
          );
        })()}

      {historyShift &&
        (() => {
          const periods = (baseRulesQuery.data ?? []).filter((r) => r.shiftTypeId === historyShift.shiftTypeId);
          return (
            <RateHistoryModal
              title={historyShift.name}
              unitSuffix="/ attended shift"
              rows={periods.map((p) => ({ amountChf: p.basePayChf, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo }))}
              onClose={() => setHistoryShift(null)}
            />
          );
        })()}

      {ratingDriver &&
        (() => {
          const periods = (rateRulesQuery.data ?? []).filter((r) => r.driverId === ratingDriver.id);
          const { current } = categorizeRatePeriods(periods, today);
          return (
            <RateAmountModal
              title={current ? `Edit delivery rate — ${ratingDriver.fullName}` : `Set delivery rate — ${ratingDriver.fullName}`}
              amountLabel="Rate per completed delivery"
              helperText="Paid for each completed delivery this driver makes during a worked Shift."
              currentSummary={current ? `${chf(current.rateChf)} / completed delivery` : undefined}
              initialAmount={current?.rateChf ?? 0}
              onSubmit={(amount, effectiveFrom) => getRepositories().payrollRules.setDriverDeliveryRate(ratingDriver.id, amount, effectiveFrom)}
              onClose={() => setRatingDriver(null)}
              onSaved={() => {
                setRatingDriver(null);
                invalidateRates();
              }}
            />
          );
        })()}

      {historyDriver &&
        (() => {
          const periods = (rateRulesQuery.data ?? []).filter((r) => r.driverId === historyDriver.id);
          return (
            <RateHistoryModal
              title={historyDriver.fullName}
              unitSuffix="/ delivery"
              rows={periods.map((p) => ({ amountChf: p.rateChf, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo }))}
              onClose={() => setHistoryDriver(null)}
            />
          );
        })()}
    </>
  );
}

function ShiftBaseRateRow({
  shift,
  categorised,
  onSetOrEdit,
  onHistory,
}: {
  shift: ShiftRecord;
  categorised: CategorisedPeriods<{ basePayChf: number; effectiveFrom: string; effectiveTo: string | null }>;
  onSetOrEdit: () => void;
  onHistory: () => void;
}) {
  const { current, scheduled, history } = categorised;
  const hasAnyRule = current !== null || scheduled.length > 0;
  const nextScheduled = scheduled[0];

  return (
    <div className="config-list-item shift-setup-card">
      <div className="config-list-item__main">
        <div>
          <div className="config-list-item__title">{shift.name}</div>
          <div className="config-list-item__subtitle">{current ? `${chf(current.basePayChf)} / attended shift` : 'Not configured'}</div>
          {nextScheduled && (
            <div className="config-list-item__subtitle">
              Scheduled: {chf(nextScheduled.basePayChf)} from {formatIsoDateLong(nextScheduled.effectiveFrom)}
            </div>
          )}
        </div>
      </div>
      <div className="config-list-item__badges">{!current && <StatusPill tone="amber">Needs setup</StatusPill>}</div>
      <div className="config-list-item__actions">
        {history.length > 0 && (
          <Button variant="ghost" size="sm" onClick={onHistory}>
            History
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onSetOrEdit}>
          {hasAnyRule ? 'Edit' : 'Set rate'}
        </Button>
      </div>
    </div>
  );
}

function DriverRateRow({
  driver,
  categorised,
  onSetOrEdit,
  onHistory,
}: {
  driver: DriverRecord;
  categorised: CategorisedPeriods<{ rateChf: number; effectiveFrom: string; effectiveTo: string | null }>;
  onSetOrEdit: () => void;
  onHistory: () => void;
}) {
  const { current, scheduled, history } = categorised;
  const hasAnyRule = current !== null || scheduled.length > 0;
  const nextScheduled = scheduled[0];

  return (
    <div className="config-list-item shift-setup-card">
      <div className="config-list-item__main">
        <div>
          <div className="config-list-item__title">{driver.fullName}</div>
          <div className="config-list-item__subtitle">{current ? `${chf(current.rateChf)} / completed delivery` : 'Not configured'}</div>
          {nextScheduled && (
            <div className="config-list-item__subtitle">
              Scheduled: {chf(nextScheduled.rateChf)} from {formatIsoDateLong(nextScheduled.effectiveFrom)}
            </div>
          )}
        </div>
      </div>
      <div className="config-list-item__badges">
        {!driver.isActive && <StatusPill tone="grey">Inactive</StatusPill>}
        {!current && <StatusPill tone="amber">Needs setup</StatusPill>}
      </div>
      <div className="config-list-item__actions">
        {history.length > 0 && (
          <Button variant="ghost" size="sm" onClick={onHistory}>
            History
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onSetOrEdit}>
          {hasAnyRule ? 'Edit' : 'Set rate'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Shared Set/Edit form for both rate types -- amount + effective date only.
 * A manager never sees "effective dating"/table/ID terminology: just
 * "Applies from" (first-time) / "Changes from" (editing an existing rate).
 */
function RateAmountModal({
  title,
  amountLabel,
  helperText,
  currentSummary,
  initialAmount,
  onSubmit,
  onClose,
  onSaved,
}: {
  title: string;
  amountLabel: string;
  helperText: string;
  currentSummary?: string;
  initialAmount: number;
  onSubmit: (amountChf: number, effectiveFrom: string) => Promise<unknown>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = toIsoDateString(getOperationalToday());
  const [amount, setAmount] = useState(initialAmount > 0 ? String(initialAmount) : '');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [touched, setTouched] = useState(false);
  const isEdit = !!currentSummary;

  const mutation = useMutation({
    mutationFn: () => onSubmit(Number(amount), effectiveFrom),
    onSuccess: onSaved,
  });

  const parsedAmount = Number(amount);
  const amountInvalid = amount.trim() === '' || Number.isNaN(parsedAmount) || parsedAmount < 0;
  const amountError = touched && amountInvalid ? 'Enter an amount of CHF 0 or more.' : null;
  const dateError = touched && !effectiveFrom ? 'Choose a date.' : null;
  const canSubmit = !amountInvalid && !!effectiveFrom;

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
            {mutation.isPending ? 'Saving…' : isEdit ? 'Save Change' : 'Set Rate'}
          </Button>
        </>
      }
    >
      {mutation.isError && <InlineNotice tone="error">{describeConfigurationError(mutation.error, 'payrollRule')}</InlineNotice>}
      {currentSummary && (
        <p className="form-field__hint" style={{ marginTop: 0, marginBottom: 12 }}>
          Current: {currentSummary}
        </p>
      )}
      <div className="form-field">
        <label htmlFor="rate-amount-input">{amountLabel}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true">CHF</span>
          <input
            id="rate-amount-input"
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
        </div>
        {amountError && <span className="form-field__error">{amountError}</span>}
      </div>
      <div className="form-field">
        <label htmlFor="rate-effective-from-input">{isEdit ? 'Changes from' : 'Applies from'}</label>
        <input
          id="rate-effective-from-input"
          type="date"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
        />
        {dateError && <span className="form-field__error">{dateError}</span>}
      </div>
      <p className="form-field__hint">{helperText}</p>
    </Modal>
  );
}

function RateHistoryModal({
  title,
  unitSuffix,
  rows,
  onClose,
}: {
  title: string;
  unitSuffix: string;
  rows: { amountChf: number; effectiveFrom: string; effectiveTo: string | null }[];
  onClose: () => void;
}) {
  const sorted = [...rows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return (
    <Modal title={`${title} — rate history`} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {sorted.map((row, i) => (
          <div key={i}>
            <div style={{ fontWeight: 600 }}>
              {chf(row.amountChf)} {unitSuffix}
            </div>
            <div className="config-list-item__subtitle">
              {row.effectiveTo ? `${formatIsoDateLong(row.effectiveFrom)} → ${formatIsoDateLong(row.effectiveTo)}` : `From ${formatIsoDateLong(row.effectiveFrom)}`}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
