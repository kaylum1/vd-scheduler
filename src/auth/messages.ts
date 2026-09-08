import type { AccessDeniedReason } from './types';

/**
 * Shared, neutral copy for every invalid-account-state case (Checkpoint
 * spec section 10). Deliberately collapses B/C/D into one message — see
 * AccessDeniedReason's doc comment for why they can't be distinguished
 * from the frontend without a less safe query than current_app_user().
 */
export function accessDeniedMessage(reason: AccessDeniedReason): string {
  switch (reason) {
    case 'no_app_user':
      return 'Your account is not configured for VD Scheduler. Please contact a manager.';
    case 'inactive_account':
    case 'driver_missing_driver_id':
    case 'invalid_role':
    default:
      return 'Your account is not currently active for VD Scheduler. Please contact a manager.';
  }
}
