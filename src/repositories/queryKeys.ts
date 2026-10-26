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

/**
 * TanStack Query keys for the driver's own My Rota. The driver id is part of
 * the key so a (mock-mode) driver switch can never show another driver's
 * cached week; in Supabase mode the session decides and the cache is cleared
 * on sign-in/out anyway.
 */
export const driverRotaKeys = {
  all: ['driver-rota'] as const,
  week: (driverId: string, weekStart: string) => ['driver-rota', driverId, weekStart] as const,
};

/**
 * Manager Availability panel keys (summary per resort + week, expanded
 * per-driver detail per driver + week). Shared so the panel that reads them and
 * anything that must refresh them -- publishing a rota locks the week -- agree
 * on the exact shape.
 */
export const availabilityKeys = {
  managerSummary: (resortId: string | null, weekStart: string) => ['availability', 'managerSummary', resortId, weekStart] as const,
  managerDetail: (driverId: string | null, weekStart: string) => ['availability', 'managerDetail', driverId, weekStart] as const,
  /**
   * Matches every manager per-driver detail cached for ONE week. The driver id
   * sits in the middle of the key, so this is a predicate rather than a prefix.
   */
  isManagerDetailForWeek: (queryKey: readonly unknown[], weekStart: string) =>
    queryKey[0] === 'availability' && queryKey[1] === 'managerDetail' && queryKey[3] === weekStart,
};
