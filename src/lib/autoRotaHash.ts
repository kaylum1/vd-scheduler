/**
 * The Auto-Rota weekly tie-break hash: FNV-1a, 32-bit, over the UTF-8 bytes of a
 * string, using integer arithmetic only (Math.imul), returned as an UNSIGNED
 * 32-bit number.
 *
 *   hash = 0x811c9dc5
 *   for each byte b:  hash = (hash XOR b) * 0x01000193   (mod 2^32)
 *
 * It is the standard FNV-1a algorithm, so it is stable across engines, runs and
 * machines (no Math.random, no Date, no object-key order, no engine hashing).
 * The planner hashes `${weekStart}:${driverId}` so equal-count ties rotate from
 * week to week instead of always favouring the same driver. Fixed test vectors
 * (lib/autoRotaHash.test.ts) make an accidental change fail loudly -- changing
 * this changes every future plan.
 */

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

const encoder = new TextEncoder();

export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS_32;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME_32);
  }
  return hash >>> 0;
}

/** The per-week, per-driver tie-break key the planner compares ascending. */
export function weeklyTieBreakKey(weekStart: string, driverId: string): number {
  return fnv1a32(`${weekStart}:${driverId}`);
}
