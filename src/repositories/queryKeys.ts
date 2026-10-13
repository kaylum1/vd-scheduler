/**
 * TanStack Query keys for the manager Manual Rota data. One resort + one
 * week is exactly one cache entry; an assign/unassign invalidates the whole
 * `all` prefix (any week's coverage could be affected by a stale view) or
 * just the affected week.
 *
 * The repositories themselves don't use TanStack Query -- this only makes
 * the natural cache key explicit so every consumer agrees on it.
 */
export const managerRotaKeys = {
  all: ['manager-rota'] as const,
  week: (resortId: string, weekStart: string) => ['manager-rota', resortId, weekStart] as const,
};
