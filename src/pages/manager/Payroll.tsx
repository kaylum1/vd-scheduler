import React, { useState } from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { StatusPill } from '../../components/ui/StatusPill';
import { Avatar } from '../../components/ui/Avatar';
import { IconUpload } from '../../components/ui/icons';
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  formatShortDate,
  parseISODate,
  startOfMonth,
  startOfWeek,
  toISODate,
} from '../../mock-data/date-utils';
import { driverById } from '../../mock-data/drivers';
import { resortById } from '../../mock-data/resorts';
import { payrollRows } from '../../mock-data/payroll';

const currency = (n: number) => `CHF ${n.toFixed(2)}`;

type Shortcut = 'this-week' | 'last-week' | 'this-month' | 'last-month';

function rangeForShortcut(shortcut: Shortcut, today: Date): [Date, Date] {
  switch (shortcut) {
    case 'this-week': {
      const start = startOfWeek(today);
      return [start, addDays(start, 6)];
    }
    case 'last-week': {
      const start = addWeeks(startOfWeek(today), -1);
      return [start, addDays(start, 6)];
    }
    case 'last-month': {
      const monthDate = addMonths(today, -1);
      return [startOfMonth(monthDate), endOfMonth(monthDate)];
    }
    case 'this-month':
    default:
      return [startOfMonth(today), endOfMonth(today)];
  }
}

export function PayrollPage() {
  const today = new Date();
  const [range, setRange] = useState<[Date, Date]>(() => rangeForShortcut('this-month', today));
  const [startDate, endDate] = range;
  const [activeShortcut, setActiveShortcut] = useState<Shortcut | null>('this-month');

  const applyShortcut = (shortcut: Shortcut) => {
    setRange(rangeForShortcut(shortcut, today));
    setActiveShortcut(shortcut);
  };

  const setStartDate = (iso: string) => {
    setRange(([, end]) => [parseISODate(iso), end]);
    setActiveShortcut(null);
  };
  const setEndDate = (iso: string) => {
    setRange(([start]) => [start, parseISODate(iso)]);
    setActiveShortcut(null);
  };

  const totals = payrollRows.reduce(
    (acc, row) => ({
      shifts: acc.shifts + row.shiftsWorked,
      total: acc.total + row.total,
    }),
    { shifts: 0, total: 0 }
  );

  const shortcuts: { key: Shortcut; label: string }[] = [
    { key: 'this-week', label: 'This Week' },
    { key: 'last-week', label: 'Last Week' },
    { key: 'this-month', label: 'This Month' },
    { key: 'last-month', label: 'Last Month' },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Payroll"
        subtitle="Combines attendance (or published rota as fallback) with Onfleet delivery data — this stage shows the shell only."
      />

      <div className="payroll-toolbar">
        <div className="payroll-range">
          <div className="payroll-range__field">
            <label htmlFor="payroll-start">Start date</label>
            <input
              id="payroll-start"
              type="date"
              value={toISODate(startDate)}
              max={toISODate(endDate)}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <span className="payroll-range__sep">–</span>
          <div className="payroll-range__field">
            <label htmlFor="payroll-end">End date</label>
            <input
              id="payroll-end"
              type="date"
              value={toISODate(endDate)}
              min={toISODate(startDate)}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <div className="payroll-shortcuts">
          {shortcuts.map((s) => (
            <button
              key={s.key}
              className={`payroll-shortcut-btn${activeShortcut === s.key ? ' is-active' : ''}`}
              onClick={() => applyShortcut(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="payroll-toolbar__actions">
          <Button variant="secondary">Export CSV</Button>
          <Button variant="primary">Run payroll</Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
        <Card className="stat-card">
          <div className="stat-card__label">Total shifts this period</div>
          <div className="stat-card__value">{totals.shifts}</div>
        </Card>
        <Card className="stat-card">
          <div className="stat-card__label">Total payout</div>
          <div className="stat-card__value">{currency(totals.total)}</div>
        </Card>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <CardHeader title="Onfleet CSV import" />
        <CardBody>
          <div className="upload-dropzone">
            <IconUpload style={{ width: 22, height: 22, marginBottom: 6 }} />
            <strong>Drop Onfleet delivery CSV here</strong>
            Driver names will be matched against verified Onfleet mappings — unmatched drivers are flagged, never guessed.
            <div style={{ marginTop: 12 }}>
              <Button variant="secondary" disabled>
                Choose file (Stage 3)
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Payroll — ${formatShortDate(startDate)} – ${formatShortDate(endDate)}`} />
        <div style={{ padding: '2px 18px 0', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          Sample data shown below — totals won't reflect the selected range until payroll calculations are implemented in a later stage.
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Driver</th>
                <th>Resort</th>
                <th className="numeric">Shifts</th>
                <th className="numeric">Hours</th>
                <th className="numeric">Base pay</th>
                <th className="numeric">Extras</th>
                <th className="numeric">Deductions</th>
                <th className="numeric">Total</th>
                <th>Onfleet match</th>
              </tr>
            </thead>
            <tbody>
              {payrollRows.map((row) => {
                const driver = driverById(row.driverId);
                return (
                  <tr key={row.id}>
                    <td>
                      <div className="driver-cell">
                        <Avatar initials={driver?.initials ?? '?'} size="sm" />
                        {driver?.name ?? 'Unknown driver'}
                      </div>
                    </td>
                    <td>{resortById(row.resortId)?.name}</td>
                    <td className="numeric">{row.shiftsWorked}</td>
                    <td className="numeric">{row.hoursWorked}</td>
                    <td className="numeric">{currency(row.basePay)}</td>
                    <td className="numeric">{currency(row.extras)}</td>
                    <td className="numeric">{currency(row.deductions)}</td>
                    <td className="numeric" style={{ fontWeight: 700 }}>
                      {currency(row.total)}
                    </td>
                    <td>
                      {row.onfleetMatchStatus === 'matched' ? (
                        <StatusPill tone="green">Matched</StatusPill>
                      ) : row.onfleetMatchStatus === 'unmatched' ? (
                        <StatusPill tone="red">Unmatched</StatusPill>
                      ) : (
                        <StatusPill tone="grey">Pending</StatusPill>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
