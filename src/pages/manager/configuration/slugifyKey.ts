/**
 * Proposes a friendly, stable `key` default from a shift type's display
 * name (e.g. "Late Dinner" -> "late-dinner"). Only ever used to pre-fill
 * the key field at creation time — the key is immutable afterwards
 * (Stage 2D Checkpoint 1 guard), so renaming the display name later never
 * touches it. The manager can still edit the proposed key before creating.
 */
export function slugifyKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
