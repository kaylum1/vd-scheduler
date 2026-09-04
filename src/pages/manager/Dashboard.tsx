import React from 'react';
import { PageHeader } from '../../components/layout/PageHeader';
import { TodayTomorrowPanel } from '../../components/dashboard/TodayTomorrowPanel';
import { NextWeekStatusPanel } from '../../components/dashboard/NextWeekStatusPanel';
import { Card, CardHeader } from '../../components/ui/Card';
import { resortById } from '../../mock-data/resorts';
import { recentActivity } from '../../mock-data/dashboard';
import { useRouter } from '../../router';
import { Button } from '../../components/ui/Button';

export function DashboardPage() {
  const { navigate } = useRouter();
  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        subtitle="What's happening today, tomorrow, and whether next week is ready to go."
      />

      <TodayTomorrowPanel />
      <div style={{ marginBottom: 18 }}>
        <NextWeekStatusPanel />
      </div>

      <div className="dashboard-grid">
        <Card>
          <CardHeader title="Recent activity" />
          <div className="activity-list">
            {recentActivity.slice(0, 3).map((item) => (
              <div key={item.id} className="activity-item">
                <span className="activity-item__dot" />
                <div>
                  <div className="activity-item__message">{item.message}</div>
                  <div className="activity-item__meta">
                    {item.timestamp}
                    {item.resortId && ` · ${resortById(item.resortId)?.name}`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Quick actions" />
          <div className="quick-actions">
            <Button variant="secondary" block onClick={() => navigate('/manager/rota')}>
              Review this week's rota
            </Button>
            <Button variant="secondary" block onClick={() => navigate('/manager/payroll')}>
              Go to payroll
            </Button>
            <Button variant="secondary" block onClick={() => navigate('/manager/configuration')}>
              Manage shift templates
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
