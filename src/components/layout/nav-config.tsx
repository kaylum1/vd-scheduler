import React from 'react';
import {
  IconCalendar,
  IconConfig,
  IconDashboard,
  IconPayroll,
  IconTruck,
} from '../ui/icons';

export interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

export const managerNavItems: NavItem[] = [
  { label: 'Dashboard', path: '/manager/dashboard', icon: <IconDashboard /> },
  { label: 'Rota & Availability', path: '/manager/rota', icon: <IconCalendar /> },
  { label: 'Payroll', path: '/manager/payroll', icon: <IconPayroll /> },
  { label: 'Configuration', path: '/manager/configuration', icon: <IconConfig /> },
];

export const driverNavItems: NavItem[] = [
  { label: 'My Rota', path: '/driver/my-rota', icon: <IconCalendar /> },
  { label: 'Availability', path: '/driver/availability', icon: <IconTruck /> },
];
