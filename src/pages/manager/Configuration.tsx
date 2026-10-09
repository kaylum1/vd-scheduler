import React, { useState } from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { DriversPanel } from './configuration/DriversPanel';
import { ResortShiftSetupPanel } from './configuration/ResortShiftSetupPanel';
import { PayrollRulesPanel } from './configuration/PayrollRulesPanel';

type Tab = 'drivers' | 'resort-shift-setup' | 'payroll-rules';

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
      </div>

      {tab === 'drivers' && <DriversPanel />}
      {tab === 'resort-shift-setup' && <ResortShiftSetupPanel />}
      {tab === 'payroll-rules' && <PayrollRulesPanel />}
    </div>
  );
}
