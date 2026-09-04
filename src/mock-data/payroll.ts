import type { PayrollRow } from '../types';

export const payrollRows: PayrollRow[] = [
  {
    id: 'p-gianni',
    driverId: 'gianni',
    resortId: 'crans-montana',
    shiftsWorked: 9,
    hoursWorked: 31.5,
    basePay: 630,
    extras: 45,
    deductions: 0,
    total: 675,
    onfleetMatchStatus: 'matched',
  },
  {
    id: 'p-alex',
    driverId: 'alex',
    resortId: 'zermatt',
    shiftsWorked: 11,
    hoursWorked: 38.5,
    basePay: 770,
    extras: 20,
    deductions: 15,
    total: 775,
    onfleetMatchStatus: 'matched',
  },
  {
    id: 'p-tomas',
    driverId: 'tomas',
    resortId: 'zermatt',
    shiftsWorked: 8,
    hoursWorked: 28,
    basePay: 560,
    extras: 0,
    deductions: 0,
    total: 560,
    onfleetMatchStatus: 'unmatched',
  },
];

export const payrollPeriodLabel = '1 – 31 August 2026';
