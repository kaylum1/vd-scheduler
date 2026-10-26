import { useEffect } from 'react';
import { useAppState } from '../state/AppStateContext';
import { resolveMockDriverIdentity } from '../repositories/mock/identityBridge';
import { setMockActingDriver } from '../repositories/mock/session';

/**
 * Mock mode only. The mock repository has no session, yet check_in_to_shift takes no driver id (the
 * real database derives the driver from the session), so this keeps the mock "session" in step with
 * the Stage 1.1 Manager/Driver switcher: signed-in driver -> that driver's repository id; manager or
 * logged out -> null (denied). Never mounted in Supabase mode, where the session is the real one.
 */
export function MockActingDriverBridge() {
  const { role, activeDriverId, isLoggedOut } = useAppState();
  const actingId = !isLoggedOut && role === 'driver' ? resolveMockDriverIdentity(activeDriverId).driverId : null;

  useEffect(() => {
    setMockActingDriver(actingId);
    return () => setMockActingDriver(null);
  }, [actingId]);

  return null;
}
