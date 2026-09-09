// THE DURABLE LINEAGE RECORD — its shape, and every pure decision about it.
//
// WHY IT EXISTS (2026-09-06, fourth "I lost my checkpoints")
// ---------------------------------------------------------
// The lineage lived only on the canvas node, as `sessionLineage: string[]` in
// workspace.json, and was capped at 20 by `slice(len - CAP)`. Conductor sat at
// exactly 20: the next rebind would have dropped its oldest session id, and a
// dropped id is a whole transcript — every checkpoint in it — that nothing in
// the product can reach again. No error, no event, no way to notice.
//
// The node array is append-only now, but that alone would still trust ONE
// mutable blob: preset-scrub.ts clears sessionLineage, teams.ts drops it on a
// copy, and any future writer can truncate it again. So the chain also lives
// in a per-node file of its own — one small append-only record per card, with
// when each id was bound. The rail reads node lineage ∪ spill, so losing
// either side loses nothing.
//
// Pure module: shape, parsing, merging. The fs half (atomic write, lock,
// migration) is src/main/lineage-spill.ts; the gate reads these same
// functions so the app and the gate cannot disagree about the format.

export const SPILL_VERSION = 1

/** ~/.cookrew/<SPILL_DIR_NAME>/<terminalId>.json */
export const SPILL_DIR_NAME = 'lineage'

/**
 * Node ids that may become a file name. A terminal id is a uuid today, but it
 * arrives from workspace.json — which the unauthenticated mobile node-update
 * endpoint can influence — and it is interpolated into a path. Anything with a
 * dot or a separator is refused rather than sanitised.
 */
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function isSpillableId(terminalId) {
  return typeof terminalId === 'string' && NODE_ID_RE.test(terminalId)
}

export function spillFileName(terminalId) {
  return isSpillableId(terminalId) ? `${terminalId}.json` : null
}

export function emptySpill(terminalId) {
  return { version: SPILL_VERSION, terminalId, ids: [], boundAt: {} }
}

/**
 * Order-preserving union. First occurrence wins, so the OLDEST recorded order
 * survives every merge — the rail renders segments oldest-first and a chain
 * that reorders itself between reads is a chain nobody can trust.
 */
export function unionLineage(...lists) {
  const out = []
  const seen = new Set()
  for (const list of lists) {
    for (const id of list ?? []) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * A record read back from disk, or the empty one when it is unusable.
 *
 * NEVER throws. A half-written or hand-edited file must not be the reason a
 * rebind fails or an id is dropped — the caller merges what it has on top and
 * the next atomic write repairs the file.
 */
export function parseSpill(text, terminalId) {
  try {
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.ids)) return emptySpill(terminalId)
    const ids = unionLineage(raw.ids.filter((id) => typeof id === 'string'))
    const boundAt = {}
    for (const id of ids) {
      const at = raw.boundAt?.[id]
      if (typeof at === 'string') boundAt[id] = at
    }
    return { version: SPILL_VERSION, terminalId, ids, boundAt }
  } catch {
    return emptySpill(terminalId)
  }
}

/**
 * `record` with `ids` appended — a NEW record, never a mutation, and a no-op
 * when it would add nothing. Idempotence is what makes the write safe to
 * repeat after a crash, a retry or a duplicate rebind.
 */
export function mergeSpill(record, ids, at) {
  const merged = unionLineage(record.ids, ids)
  const appended = merged.filter((id) => !record.ids.includes(id))
  if (appended.length === 0) return { record, appended }
  const boundAt = { ...record.boundAt }
  for (const id of appended) boundAt[id] = at
  return {
    record: { version: SPILL_VERSION, terminalId: record.terminalId, ids: merged, boundAt },
    appended
  }
}

export function serializeSpill(record) {
  return `${JSON.stringify(record, null, 2)}\n`
}
