/**
 * ONE ANSWER FOR MANY THUMBS — the batch behind GET /api/browser/thumbs.
 *
 * A phone polling browser-card pictures used to ask one URL per card, eight a
 * tick, every five seconds, with `?v=` so no cache could ever help, for as
 * long as the canvas was open. Through the relay every one of those is an
 * exchange (~0.2 s), so 93 browser cards cost ~96 exchanges a minute for
 * pictures that mostly had not changed (perf lane L7, measured 2026-09-08).
 *
 * The batch takes the ids the phone can SEE and the version it already holds
 * for each (`known=id:at,…`, the frame's own `at`), and answers per id:
 *
 *   { id, at: null }               no frame yet — the phone backs off that id
 *   { id, at }                     unchanged — nothing crosses but the number
 *   { id, at, type, data }         changed — the bytes, base64
 *
 * Pure: the route supplies the lookup. No caching header games — the version
 * lives in the payload, which is the only place a relay cannot strip it.
 */

import { THUMB_BATCH_MAX } from '../shared/thumb-batch'
export { THUMB_BATCH_MAX }

export interface ThumbLookup {
  readonly data: Buffer
  readonly type: string
  readonly at: number
}

export interface ThumbBatchFrame {
  readonly id: string
  readonly at: number | null
  readonly type?: string
  readonly data?: string
}

/** `a:1700000000,b:1700000001` → { a: 1700000000, b: 1700000001 }. Junk is skipped. */
export function parseKnownVersions(raw: string | null): Readonly<Record<string, number>> {
  if (!raw) return {}
  return Object.fromEntries(
    raw
      .split(',')
      .map((part) => part.split(':'))
      .filter((pair): pair is [string, string] => pair.length === 2 && pair[0].length > 0)
      .map(([id, at]) => [id, Number(at)] as const)
      .filter(([, at]) => Number.isFinite(at))
  )
}

/** The ids of `?ids=`, deduplicated and capped. */
export function parseBatchIds(raw: string | null): string[] {
  if (!raw) return []
  return [...new Set(raw.split(',').filter((id) => id.length > 0))].slice(0, THUMB_BATCH_MAX)
}

export function batchFrames(
  ids: readonly string[],
  known: Readonly<Record<string, number>>,
  lookup: (id: string) => ThumbLookup | undefined
): ThumbBatchFrame[] {
  return ids.map((id) => {
    const thumb = lookup(id)
    if (!thumb) return { id, at: null }
    if (known[id] === thumb.at) return { id, at: thumb.at }
    return { id, at: thumb.at, type: thumb.type, data: thumb.data.toString('base64') }
  })
}

/**
 * A lookup that answers only for the browser cards of the canvas the client
 * is scoped to. The ids ride the query, so the slug layer's node-membership
 * check never sees them; this is that check, for this route. An id outside
 * the canvas is answered as "no frame" — never dropped, or the phone would
 * see no answer at all for it and ask again every tick forever.
 */
export function scopedThumbLookup(
  nodes: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
  lookup: (id: string) => ThumbLookup | undefined
): (id: string) => ThumbLookup | undefined {
  const browsers = new Set(nodes.filter((node) => node.kind === 'browser').map((node) => node.id))
  return (id) => (browsers.has(id) ? lookup(id) : undefined)
}
