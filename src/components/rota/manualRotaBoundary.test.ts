import { describe, expect, it } from 'vitest';
import panelSource from './ManualRotaPanel.tsx?raw';
import cardSource from './ManualRotaShiftCard.tsx?raw';
import dialogSource from './AssignDriverDialog.tsx?raw';
import badgeSource from './AvailabilityBadge.tsx?raw';
import hookSource from './useManagerWeekRota.ts?raw';
import errorMessagesSource from './rotaErrorMessages.ts?raw';
import pageSource from '../../pages/manager/RotaAvailability.tsx?raw';

/**
 * Import-boundary guard for Manual Rota (MR-C). The React layer talks to the
 * database ONLY through RotaRepository (via getRepositories()). The database
 * owns every assignment rule, so a component that could reach Supabase
 * directly could bypass them.
 */
const manualRotaFiles: Record<string, string> = {
  'ManualRotaPanel.tsx': panelSource,
  'ManualRotaShiftCard.tsx': cardSource,
  'AssignDriverDialog.tsx': dialogSource,
  'AvailabilityBadge.tsx': badgeSource,
  'useManagerWeekRota.ts': hookSource,
  'rotaErrorMessages.ts': errorMessagesSource,
  'pages/manager/RotaAvailability.tsx': pageSource,
};

// Driver-facing pages (not their tests, which legitimately name what must be absent), read as raw text: none may reach for the manager surface.
const driverPages = import.meta.glob(['../../pages/driver/*.tsx', '!../../pages/driver/*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('Manual Rota import boundary', () => {
  it.each(Object.entries(manualRotaFiles))('%s never imports the Supabase client, generated DB types, or supabase-js', (_name, source) => {
    expect(source).not.toMatch(/from\s+['"][^'"]*lib\/supabase[^'"]*['"]/);
    expect(source).not.toMatch(/from\s+['"]@supabase\//);
    expect(source).not.toMatch(/from\s+['"][^'"]*database\.generated[^'"]*['"]/);
  });

  it.each(Object.entries(manualRotaFiles))('%s never queries a table or calls an RPC directly', (_name, source) => {
    expect(source).not.toMatch(/\.from\(\s*['"`]/);
    expect(source).not.toMatch(/\.rpc\(/);
    expect(source).not.toMatch(/rota_assignments|assign_driver|unassign_driver|audit_log/);
  });

  it('reads and writes through the repository only', () => {
    expect(hookSource).toMatch(/getRepositories\(\)\.rota\.getManagerWeekRota/);
    expect(panelSource).toMatch(/getRepositories\(\)\.rota\.assignDriver/);
    expect(panelSource).toMatch(/getRepositories\(\)\.rota\.unassignDriver/);
  });

  it('never leaks a SQLSTATE or the VD001 code into the UI layer', () => {
    for (const source of Object.values(manualRotaFiles)) {
      expect(source).not.toMatch(/VD001|55006|23514|23505|P0002|\.details\b/);
    }
  });

  it('no driver-facing page uses the manager rota surface', () => {
    const entries = Object.entries(driverPages);
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, source] of entries) {
      expect(source, path).not.toMatch(/ManualRotaPanel|ManagerWeekRota|managerRotaKeys|useManagerWeekRota|getManagerWeekRota|assignDriver|unassignDriver/);
    }
  });
});
