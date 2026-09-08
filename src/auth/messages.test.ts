import { describe, expect, it } from 'vitest';
import { accessDeniedMessage } from './messages';

describe('accessDeniedMessage', () => {
  it('gives the distinct "not configured" message for no_app_user', () => {
    expect(accessDeniedMessage('no_app_user')).toMatch(/not configured/i);
  });

  it('gives a generic "not active" message for every other denial reason', () => {
    const reasons = ['inactive_account', 'driver_missing_driver_id', 'invalid_role'] as const;
    for (const reason of reasons) {
      expect(accessDeniedMessage(reason)).toMatch(/not currently active/i);
    }
  });

  it('never mentions internal database detail', () => {
    for (const reason of ['no_app_user', 'inactive_account', 'driver_missing_driver_id', 'invalid_role'] as const) {
      const message = accessDeniedMessage(reason);
      expect(message).not.toMatch(/app_users|driver_id|is_active|sql|postgres/i);
    }
  });
});
