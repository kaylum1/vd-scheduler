import React, { useState } from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { Card, CardHeader } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconPayroll, IconCalendar } from '../../components/ui/icons';
import { DriversPanel } from './configuration/DriversPanel';
import { ResortShiftSetupPanel } from './configuration/ResortShiftSetupPanel';

type Tab = 'drivers' | 'resort-shift-setup' | 'payroll-rules' | 'rota-rules';

export function ConfigurationPage() {
  const [tab, setTab] = useState<Tab>('drivers');

  return (
    <div className="page">
      <PageHeader
        title="Configuration"
        subtitle="Resorts, shift setup and driver rosters. Changes here define what the rota generator has to work with."
      />

      <div className="config-section-tabs">
        <button className={`config-section-tabs__tab${tab === 'drivers' ? ' is-active' : ''}`} onClick={() => setTab('drivers')}>
          Drivers
        </button>
        <button
          className={`config-section-tabs__tab${tab === 'resort-shift-setup' ? ' is-active' : ''}`}
          onClick={() => setTab('resort-shift-setup')}
        >
          Resort &amp; Shift Setup
        </button>
        <button
          className={`config-section-tabs__tab${tab === 'payroll-rules' ? ' is-active' : ''}`}
          onClick={() => setTab('payroll-rules')}
        >
          Payroll Rules
        </button>
        <button className={`config-section-tabs__tab${tab === 'rota-rules' ? ' is-active' : ''}`} onClick={() => setTab('rota-rules')}>
          Rota Rules
        </button>
      </div>

      {tab === 'drivers' && <DriversPanel />}
      {tab === 'resort-shift-setup' && <ResortShiftSetupPanel />}

      {tab === 'payroll-rules' && (
        <Card>
          <CardHeader title="Payroll rules" />
          <EmptyState
            icon={<IconPayroll />}
            title="Coming in a later stage"
            hint="Configure base and per-delivery pay for each shift. Not available yet — until then, generated shifts show a Needs Attention notice for any missing pay."
          />
        </Card>
      )}

      {tab === 'rota-rules' && (
        <Card>
          <CardHeader title="Rota rules" />
          <EmptyState
            icon={<IconCalendar />}
            title="Coming in a later stage"
            hint="Configure normal staffing requirements and high-value shifts. Not available yet — until then, generated shifts show a Needs Attention notice for any missing staffing."
          />
        </Card>
      )}
    </div>
  );
}
