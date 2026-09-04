import type { Driver } from '../types';

// Verbier intentionally has zero drivers — used throughout the rota mock
// data to demonstrate the "no coverage" state end-to-end.
export const drivers: Driver[] = [
  { id: 'gianni', name: 'Gianni', resortId: 'crans-montana', initials: 'GI', onfleetNameMatched: true },
  { id: 'alex', name: 'Alex', resortId: 'zermatt', initials: 'AL', onfleetNameMatched: true },
  { id: 'tomas', name: 'Tomas', resortId: 'zermatt', initials: 'TO', onfleetNameMatched: false },
];

export const driverById = (id: string) => drivers.find((d) => d.id === id);
export const driversByResort = (resortId: string) => drivers.filter((d) => d.resortId === resortId);
