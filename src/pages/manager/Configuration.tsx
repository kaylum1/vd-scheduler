import React, { useState } from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Avatar } from '../../components/ui/Avatar';
import { EmptyState } from '../../components/ui/EmptyState';
import { IconEdit, IconPlus, IconTrash, IconTruck } from '../../components/ui/icons';
import { driversByResort } from '../../mock-data/drivers';
import { resorts } from '../../mock-data/resorts';
import { shiftDefinitions } from '../../mock-data/shifts';
import { WEEKDAY_LABELS } from '../../mock-data/date-utils';

type Tab = 'resorts' | 'shifts' | 'drivers';

export function ConfigurationPage() {
  const [tab, setTab] = useState<Tab>('shifts');

  return (
    <div className="page">
      <PageHeader
        title="Configuration"
        subtitle="Resorts, shift templates and driver rosters. Changes here define what the rota generator has to work with."
      />

      <div className="config-section-tabs">
        <button
          className={`config-section-tabs__tab${tab === 'resorts' ? ' is-active' : ''}`}
          onClick={() => setTab('resorts')}
        >
          Resorts
        </button>
        <button
          className={`config-section-tabs__tab${tab === 'shifts' ? ' is-active' : ''}`}
          onClick={() => setTab('shifts')}
        >
          Shift templates
        </button>
        <button
          className={`config-section-tabs__tab${tab === 'drivers' ? ' is-active' : ''}`}
          onClick={() => setTab('drivers')}
        >
          Drivers
        </button>
      </div>

      {tab === 'resorts' && (
        <Card>
          <CardHeader
            title="Resorts"
            action={
              <Button variant="secondary" size="sm">
                <IconPlus style={{ width: 14, height: 14 }} />
                Add resort
              </Button>
            }
          />
          {resorts.map((resort) => {
            const count = driversByResort(resort.id).length;
            return (
              <div className="config-list-item" key={resort.id}>
                <div className="config-list-item__main">
                  <span className={`resort-dot resort-dot--${resort.id}`} />
                  <div>
                    <div className="config-list-item__title">{resort.name}</div>
                    <div className="config-list-item__subtitle">
                      {count === 0 ? 'No drivers assigned yet' : `${count} driver${count === 1 ? '' : 's'}`}
                      {' · operates independently'}
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="sm" icon aria-label="Edit resort">
                  <IconEdit />
                </Button>
              </div>
            );
          })}
        </Card>
      )}

      {tab === 'shifts' && (
        <Card>
          <CardHeader
            title="Shift templates"
            action={
              <Button variant="secondary" size="sm">
                <IconPlus style={{ width: 14, height: 14 }} />
                Add shift template
              </Button>
            }
          />
          {resorts.map((resort) => {
            const templates = shiftDefinitions.filter((s) => s.resortId === resort.id);
            return (
              <div key={resort.id}>
                <div
                  style={{
                    padding: '10px 18px',
                    background: 'var(--bg-panel-muted)',
                    borderBottom: '1px solid var(--border-default)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span className={`resort-dot resort-dot--${resort.id}`} />
                  <strong style={{ fontSize: 12.5 }}>{resort.name}</strong>
                </div>
                {templates.map((template) => (
                  <div className="shift-template-row" key={template.id}>
                    <div style={{ minWidth: 90, fontWeight: 700, fontSize: 13 }}>{template.name}</div>
                    <div style={{ minWidth: 110, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      {template.startTime}–{template.endTime}
                    </div>
                    <div style={{ minWidth: 130, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      Requires {template.requiredDrivers} driver{template.requiredDrivers === 1 ? '' : 's'}
                    </div>
                    {template.isPremium && <Badge tone="amber">Premium</Badge>}
                    <div className="shift-template-row__days">
                      {WEEKDAY_LABELS.map((label, i) => (
                        <span
                          key={label}
                          className={`shift-template-row__day${template.weekdays.includes(i as 0 | 1 | 2 | 3 | 4 | 5 | 6) ? ' is-active' : ''}`}
                        >
                          {label[0]}
                        </span>
                      ))}
                    </div>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                      <Button variant="ghost" size="sm" icon aria-label="Edit shift template">
                        <IconEdit />
                      </Button>
                      <Button variant="ghost" size="sm" icon aria-label="Delete shift template">
                        <IconTrash />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </Card>
      )}

      {tab === 'drivers' && (
        <div className="config-grid">
          {resorts.map((resort) => {
            const resortDrivers = driversByResort(resort.id);
            return (
              <Card key={resort.id}>
                <CardHeader
                  title={
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`resort-dot resort-dot--${resort.id}`} />
                      {resort.name}
                    </span>
                  }
                  action={
                    <Button variant="ghost" size="sm" icon aria-label={`Add driver to ${resort.name}`}>
                      <IconPlus />
                    </Button>
                  }
                />
                {resortDrivers.length === 0 ? (
                  <EmptyState
                    icon={<IconTruck />}
                    title="No drivers yet"
                    hint="Add drivers to start scheduling shifts at this resort."
                  />
                ) : (
                  resortDrivers.map((driver) => (
                    <div className="config-list-item" key={driver.id}>
                      <div className="config-list-item__main">
                        <Avatar initials={driver.initials} />
                        <div>
                          <div className="config-list-item__title">{driver.name}</div>
                          <div className="config-list-item__subtitle">
                            {driver.onfleetNameMatched ? 'Onfleet name verified' : 'Onfleet name not yet matched'}
                          </div>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" icon aria-label="Edit driver">
                        <IconEdit />
                      </Button>
                    </div>
                  ))
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
