import { QueryClient } from '@tanstack/react-query';

/**
 * Single shared QueryClient for the app. Sensible, conservative
 * development defaults — no aggressive polling, no refetch-on-focus, so
 * we don't create noisy DB traffic without reason. Page-specific
 * freshness (e.g. shorter staleTime on a live rota view) is deliberately
 * left for later, per-query, rather than tuned globally here.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
