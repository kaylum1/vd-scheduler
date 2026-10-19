import { useAuth } from '../../auth/AuthContext';
import { getDataProvider } from '../../lib/env';
import { resolveMockDriverIdentity } from '../../repositories/mock/identityBridge';

/**
 * Resolves the current driver's identity in the id space the repository
 * layer expects. In Supabase mode `currentUser.driverId`/`resortId` already
 * are real database ids -- used directly. In mock mode they are Stage 1.1's
 * own driver-switcher ids instead (see repositories/mock/identityBridge.ts
 * for why `AuthContext` itself can't just switch this over), so this bridges
 * them before calling into the repository layer. Shared by every live driver
 * page (Availability, My Rota).
 */
export function useDriverRepositoryIdentity(): { driverId: string | null; resortId: string | null } {
  const { currentUser } = useAuth();
  if (!currentUser || currentUser.role !== 'driver') return { driverId: null, resortId: null };
  if (getDataProvider() === 'mock') {
    const identity = resolveMockDriverIdentity(currentUser.driverId);
    return { driverId: identity.driverId, resortId: identity.resortId };
  }
  return { driverId: currentUser.driverId, resortId: currentUser.resortId };
}
