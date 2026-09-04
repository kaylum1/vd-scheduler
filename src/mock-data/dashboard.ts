import type { ActivityItem, DashboardStat } from '../types';

export const dashboardStats: DashboardStat[] = [
  { id: 'shifts-this-week', label: 'Shifts this week', value: '24', tone: 'neutral' },
  { id: 'coverage', label: 'Coverage', value: '68%', trend: '-2 uncovered shifts', tone: 'warning' },
  { id: 'active-drivers', label: 'Active drivers', value: '3', trend: 'Verbier has none yet', tone: 'warning' },
  { id: 'pending-availability', label: 'Pending availability', value: '11', trend: 'due before next publish', tone: 'neutral' },
];

export const recentActivity: ActivityItem[] = [
  { id: 'a1', message: 'Rota published for Zermatt — week of 31 Aug', timestamp: '2 hours ago', resortId: 'zermatt' },
  { id: 'a2', message: 'Gianni marked unavailable for Thu 10 Sep dinner', timestamp: 'Yesterday', resortId: 'crans-montana' },
  { id: 'a3', message: 'Onfleet CSV imported — 142 deliveries matched', timestamp: '2 days ago' },
  { id: 'a4', message: 'New shift template added: Crans-Montana Saturday lunch', timestamp: '3 days ago', resortId: 'crans-montana' },
  { id: 'a5', message: 'Manager override: added Tomas to Fri 5 Sep dinner', timestamp: '4 days ago', resortId: 'zermatt' },
];
