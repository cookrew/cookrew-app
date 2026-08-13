/**
 * Filesystem-safe file stem for a user-given name. Lives in shared/ because
 * BOTH sides depend on its exact behavior: main derives role/team file names
 * from it, and the renderer must predict those collisions (e.g. the dock's
 * SAVE overwrite guard) — two implementations would eventually disagree
 * about what collides.
 */
export function fileSlug(name: string, fallback = 'role'): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || fallback
}
