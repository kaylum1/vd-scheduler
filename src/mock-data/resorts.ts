import type { Resort } from '../types';

export const resorts: Resort[] = [
  { id: 'crans-montana', name: 'Crans-Montana', shortName: 'CM' },
  { id: 'zermatt', name: 'Zermatt', shortName: 'ZE' },
  { id: 'verbier', name: 'Verbier', shortName: 'VB' },
];

export const resortById = (id: string) => resorts.find((r) => r.id === id);
