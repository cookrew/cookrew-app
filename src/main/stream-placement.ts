// WHERE A FILE NOBODY DECLARED BELONGS (one-stream T2.5 follow-up).

/** What placement needs off a loaded chain member, and nothing more. */
export interface PlaceableFile {
  /** The rotation walk named this file (stream-chain.ts). */
  declared: boolean
  /** Its first block's clock, or null when it holds none. */
  startedAt: number | null
}

/**
 * Put the chain members the rotation walk could not place BACK IN TIME.
 *
 * stream-chain.ts resolves binding ∪ node lineage ∪ spill and puts the ids no
 * transcript declares any more IN FRONT of the declared walk, saying plainly
 * why: "They cannot be placed by evidence — that is what 'undeclared' means."
 * That was true while the only evidence considered was the rotation pointer
 * in a file's head. It is not true of the blocks themselves, which carry
 * their own clock.
 *
 * MEASURED, 2026-09-07, the owner's busiest card. Two undeclared ids sat at
 * the head of a nine-file chain: one written 2026-09-03 (belonging seventh)
 * and one written 2026-09-06→07 — the CURRENT session, belonging last. The
 * rail therefore drew this week's exchanges at ordinals 20-90, ahead of
 * exchanges from 2026-07-19, and the old store's own record order could not
 * be reproduced from the stream at all. With the undeclared files placed by
 * their first block's timestamp, all 34 cards with a resolvable stream
 * reproduce the old store's order exactly; leaving them at the front, 33 do.
 *
 * The DECLARED walk keeps its own order untouched: a file's head naming its
 * predecessor is stronger evidence than a clock, and this only decides where
 * to insert the files that have no such statement at all. A file with no
 * blocks has no clock either, and stays where it was.
 */
export function placeUndeclared<T extends PlaceableFile>(files: readonly T[]): T[] {
  const undeclared = files.filter((entry) => !entry.declared && entry.startedAt !== null)
  if (undeclared.length === 0) return [...files]
  const declared = files.filter((entry) => entry.declared || entry.startedAt === null)
  const placed = [...declared]
  for (const entry of undeclared) {
    const at = placed.findIndex(
      (other) => other.startedAt !== null && other.startedAt > (entry.startedAt as number)
    )
    placed.splice(at < 0 ? placed.length : at, 0, entry)
  }
  return placed
}
