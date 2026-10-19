import { useQuery } from '@tanstack/react-query';
import { getRepositories } from '../../repositories';
import { driverRotaKeys } from '../../repositories/queryKeys';

/**
 * The signed-in driver's own rota for one operational week.
 *
 * A manager may edit a PUBLISHED rota after the fact, and the manager's and
 * the driver's sessions are separate, so the manager's cache invalidation can
 * never reach a driver's device. Rather than polling or subscribing (not worth
 * it for V1) this query is always considered stale: it refetches when the page
 * mounts, when the week changes, and when the driver returns to the app.
 */
export function useDriverWeekRota(driverId: string | null, weekStart: string) {
  return useQuery({
    queryKey: driverRotaKeys.week(driverId ?? '', weekStart),
    queryFn: () => getRepositories().rota.getDriverWeekRota({ weekStart, driverId: driverId as string }),
    enabled: !!driverId,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
