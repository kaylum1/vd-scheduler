import { useQuery } from '@tanstack/react-query';
import { getRepositories } from '../../repositories';
import { managerRotaKeys } from '../../repositories/queryKeys';

/**
 * The manager's weekly rota for one resort + one operational Monday, via the
 * repository (never Supabase directly). Everything that needs this week's
 * rota -- the Manual Rota panel and the page's Draft/Published indicator --
 * calls this same hook with the same key, so TanStack Query serves them from
 * ONE cache entry and ONE network round of reads.
 *
 * Disabled until a resort is chosen.
 */
export function useManagerWeekRota(resortId: string | null, weekStart: string) {
  return useQuery({
    queryKey: managerRotaKeys.week(resortId ?? '', weekStart),
    queryFn: () => getRepositories().rota.getManagerWeekRota({ resortId: resortId as string, weekStart }),
    enabled: !!resortId,
    // The app default (lib/queryClient.ts) keeps data "fresh" for 30s. A manager picks people by
    // availability that drivers keep changing, so returning to a week must re-read it: staleTime 0
    // shows the cached week instantly and refreshes it in the background. (The server's override
    // check keeps even a stale screen SAFE; this just keeps it current.)
    staleTime: 0,
  });
}
