// ONE API (design: docs/site/one-stream-2026-09-07.html, phase T2).
//
//   GET /api/terminal/:id/stream/open    the whole opening move, in one read
//                                        (T2.5 — stream-index-routes.ts)
//   GET /api/terminal/:id/stream/index   the rail — positions + marks, PAGED
//   GET /api/terminal/:id/stream?after=  a WINDOW of blocks, by identity
//   GET /api/terminal/:id/stream/blocks  the same, with no cursor (see the
//                                        path-collision note below)
//   GET /api/terminal/:id/stream/live    the open tail, over SSE (stream-live)
//   PUT /api/terminal/:id/stream/marks   the only thing that is written
//
// "rail · drawer · pager · fork all read this" — the design's own line. The
// renderer's two fetches and its mergeCheckpointRows join go away in T3
// because these three answers already carry what the join was producing.
//
// EVERY CARD ANSWERS. A 'door' card's record lives at someone else's app and a
// 'scrape' card has no record but the PTY, so neither has a transcript this
// process can walk. They are not 404s and they are not empty: they answer from
// the SAME providers the old routes use (deps.turnHistory — capability-routed
// in index.ts to the door's transcript or to the tracker), reshaped to this
// contract. A client can therefore hold ONE code path for every card, which is
// the entire point of naming this "one stream".
//
// 404 IS FOR A CARD THAT DOES NOT EXIST, and only that. The old routes answer
// an unknown terminal with 200 and an empty list, which reads to a client as
// "this agent has no history" — indistinguishable from a card whose transcript
// was deleted, which is the confusion that made 400 checkpoints look
// destroyed. These routes separate the two.

import type http from 'node:http'
import { readJson, respondJson } from './mobile-http'
import { MarkRefused, type Mark, type MarkPatch } from './marks'
import { blockOfRecord, markFieldsOf, type StreamMarkFields } from '../shared/stream-turns'
import { serveStreamIndex, serveStreamOpen } from './stream-index-routes'
import type { StreamService } from './stream-service'
import type { StreamBlock } from './stream'
import type { TurnRecord } from '../shared/turn'
import type { TranscriptSource } from './transcript-source'
import { handleStreamLive, sinceParam } from './stream-live'

/** Cap on ONE window. /stream returns FULL prompt/reply bodies, so an
 *  unbounded page would ship a whole history to draw one screen — the same
 *  reasoning as MAX_TURN_PAGE, restated because it is a different route. */
export const MAX_STREAM_PAGE = 100
export const STREAM_PAGE_LIMIT = 20

/** What the routes need from the surrounding API. Narrow on purpose: these
 *  handlers must be drivable from a test with no store and no disk. */
export interface StreamRouteDeps {
  stream?: StreamService
  /** The door/scrape fallback — the SAME provider the old routes use. */
  turnHistory?: (terminalId: string) => Promise<TurnRecord[]>
}

/** A block as the wire carries it: T1's StreamBlock, unchanged. */
type WireBlock = StreamBlock

/** Marks as the wire carries them for a window: keyed by identity, and only
 *  for the identities IN the window — never the whole ledger. */
function marksOfWindow(
  blocks: readonly WireBlock[],
  marks: Map<string, Mark>
): Record<string, StreamMarkFields> {
  const out: Record<string, StreamMarkFields> = {}
  for (const block of blocks) {
    const fields = markFieldsOf(marks.get(block.id))
    if (fields !== undefined) out[block.id] = fields
  }
  return out
}

/** ?limit=, clamped. A missing or unusable value is the default, never NaN. */
export function windowLimit(raw: string | null): number {
  const parsed = raw === null ? NaN : Number(raw)
  if (!Number.isFinite(parsed)) return STREAM_PAGE_LIMIT
  return Math.max(1, Math.min(Math.floor(parsed), MAX_STREAM_PAGE))
}

/** A cursor off the wire: a non-empty, bounded string or nothing. */
function cursor(raw: string | null): string | undefined {
  return raw !== null && raw.length > 0 && raw.length <= 200 ? raw : undefined
}

/** Does this request ask for a WINDOW OF BLOCKS rather than the PTY mirror?
 *  See the collision note in handleStreamRoutes — this is the discriminator. */
export function hasWindowCursor(url: URL): boolean {
  return ['after', 'before', 'limit'].some((key) => url.searchParams.has(key))
}

/** GET /stream?after=&before=&limit= — a window, never the whole chain. */
async function serveWindow(
  response: http.ServerResponse,
  url: URL,
  terminalId: string,
  source: TranscriptSource,
  deps: StreamRouteDeps
): Promise<void> {
  const service = deps.stream as StreamService
  const after = cursor(url.searchParams.get('after'))
  const before = cursor(url.searchParams.get('before'))
  const limit = windowLimit(url.searchParams.get('limit'))
  const marks = service.marks(terminalId)
  if (source === 'file') {
    const page = await service.blocks(terminalId, {
      ...(after !== undefined ? { after } : {}),
      ...(before !== undefined ? { before } : {}),
      limit
    })
    respondJson(response, 200, {
      blocks: page.blocks,
      marks: marksOfWindow(page.blocks, marks),
      total: page.total,
      missing: page.missing,
      ...(page.unknownAfter === true ? { unknownAfter: true as const } : {}),
      ...(page.unknownBefore === true ? { unknownBefore: true as const } : {}),
      source
    })
    return
  }
  const all = (await deps.turnHistory?.(terminalId) ?? []).map(blockOfRecord)
  const page = windowByIdentity(all, { after, before, limit })
  respondJson(response, 200, {
    blocks: page.blocks,
    marks: marksOfWindow(page.blocks, marks),
    total: all.length,
    missing: [],
    ...(page.unknownAfter === true ? { unknownAfter: true as const } : {}),
    ...(page.unknownBefore === true ? { unknownBefore: true as const } : {}),
    source
  })
}

/**
 * Identity windowing for the door/scrape path, matching stream.ts's rule
 * exactly (forward from `after`, backward from `before`, short at the ends,
 * an unknown cursor said out loud). One rule, two suppliers.
 */
export function windowByIdentity(
  blocks: readonly WireBlock[],
  request: { after?: string; before?: string; limit: number }
): { blocks: WireBlock[]; unknownAfter?: true; unknownBefore?: true } {
  if (request.after !== undefined) {
    const at = blocks.findIndex((block) => block.id === request.after)
    if (at < 0) return { blocks: [], unknownAfter: true }
    return { blocks: blocks.slice(at + 1, at + 1 + request.limit) }
  }
  if (request.before !== undefined) {
    const at = blocks.findIndex((block) => block.id === request.before)
    if (at < 0) return { blocks: [], unknownBefore: true }
    return { blocks: blocks.slice(Math.max(0, at - request.limit), at) }
  }
  return { blocks: blocks.slice(0, request.limit) }
}

/** The five fields a mark may carry, off the wire. `null` clears. */
const MARK_PATCH_FIELDS = ['title', 'seenAt', 'pin', 'anchor', 'fork'] as const

/**
 * Why this body is not a mark patch, or null when it is one.
 *
 * Shape only. The VALUE rules (a title is a line not a document, a pin is a
 * finite number) belong to marks.ts and stay there — this refuses the two
 * things that can be decided without reading the ledger's rules at all.
 */
export function patchRefusal(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'a mark patch must be an object'
  }
  const unknown = unknownMarkKeys(body as Record<string, unknown>)
  if (unknown.length > 0) {
    return (
      `refusing unknown mark field(s): ${unknown.join(', ')} — a mark carries ` +
      'title, seenAt, pin, anchor or fork, and never conversation text'
    )
  }
  const identity = (body as Record<string, unknown>).identity
  return typeof identity === 'string' && identity.length > 0
    ? null
    : 'a mark needs a checkpoint identity (the block uuid, or the derived digest)'
}

/**
 * PUT /stream/marks — the ONLY write in this design.
 *
 * The body is passed to writeMark almost verbatim, because marks.ts owns the
 * refusal: a patch carrying prompt/reply (or any key outside the mark's own
 * five) throws MarkRefused, and that becomes a 400 here. The check is NOT
 * duplicated as a route-level allow-list — one rule, enforced where the write
 * happens, is what makes "a ledger that cannot hold the conversation cannot
 * drift from it" a property rather than a promise.
 */
async function serveMarkWrite(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  terminalId: string,
  deps: StreamRouteDeps
): Promise<void> {
  const service = deps.stream as StreamService
  let body: Record<string, unknown>
  try {
    body = await readJson<Record<string, unknown>>(request, 64 * 1024)
  } catch (error) {
    respondJson(response, 400, { ok: false, error: `unreadable body: ${messageOf(error)}` })
    return
  }
  const refusal = patchRefusal(body)
  if (refusal !== null) {
    respondJson(response, 400, { ok: false, error: refusal })
    return
  }
  const patch = { ...body, identity: body.identity as string } as MarkPatch
  try {
    const result = service.writeMark(terminalId, patch)
    if (!result.ok) {
      respondJson(response, 400, { ok: false, error: result.error ?? 'mark write failed' })
      return
    }
    const mark = service.marks(terminalId).get(patch.identity)
    respondJson(response, 200, { ok: true, identity: patch.identity, mark: mark ?? null })
  } catch (error) {
    // MarkRefused is a bug in the CALLER (conversation text, an unknown
    // field), so it is a 400 with the ledger's own sentence — never a 500
    // that hides which key was refused.
    if (error instanceof MarkRefused) {
      respondJson(response, 400, { ok: false, error: error.message })
      return
    }
    respondJson(response, 500, { ok: false, error: messageOf(error) })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Keys the wire may set, so a typo is refused HERE with a readable message
 *  rather than reaching the ledger as an unknown field. Both layers refuse;
 *  this one only exists to say which key. */
export function unknownMarkKeys(body: Record<string, unknown>): string[] {
  const allowed = new Set<string>(['identity', 'at', ...MARK_PATCH_FIELDS])
  return Object.keys(body).filter((key) => !allowed.has(key))
}

/**
 * The four stream routes. Returns true when the request was answered.
 *
 * Auth is the caller's: handleMobileApi's C1 choke point has already demanded
 * the pairing token for the PUT and the read gate for the GETs, exactly as
 * for the routes these stand beside. Nothing is re-checked here — a second,
 * differently-worded gate is how one of them ends up weaker than the other.
 */
export async function handleStreamRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: StreamRouteDeps
): Promise<boolean> {
  const match = url.pathname.match(
    /^\/api\/terminal\/([^/]+)\/stream(\/blocks|\/index|\/live|\/marks|\/open)?$/
  )
  if (match === null) return false
  const [, rawId, leaf] = match
  const method = request.method ?? 'GET'
  if (leaf === '/marks' ? method !== 'PUT' : method !== 'GET') return false
  // THE ONE PATH COLLISION IN THIS DESIGN, and it is not hypothetical:
  // `GET /api/terminal/:id/stream` has meant "open the PTY mirror over SSE"
  // since long before this reader existed, and the phone's terminal viewer is
  // the thing on the other end of it. The design doc writes the block window
  // as `GET /stream?after=<id>`, which is that exact path.
  //
  // So the bare path is claimed ONLY when the request carries a stream cursor
  // (after / before / limit) — which every block-window caller sends and no
  // mirror subscriber ever has — and `/stream/blocks` is the unambiguous name
  // for the same answer with no cursor at all. A mirror open is never
  // shadowed, and no caller has to know which of the two it got.
  if (leaf === undefined && !hasWindowCursor(url)) return false

  const terminalId = decodeURIComponent(rawId)
  const service = deps.stream
  if (service === undefined) {
    respondJson(response, 503, { error: 'the stream reader is not wired' })
    return true
  }
  const source = service.sourceOf(terminalId)
  if (source === null) {
    respondJson(response, 404, { error: 'no such terminal' })
    return true
  }

  try {
    if (leaf === '/marks') {
      await serveMarkWrite(request, response, terminalId, deps)
      return true
    }
    if (leaf === '/index') {
      await serveStreamIndex(response, url, terminalId, source, deps)
      return true
    }
    if (leaf === '/open') {
      await serveStreamOpen(response, url, terminalId, source, deps)
      return true
    }
    if (leaf === '/live') {
      // A NEW deps object, never a mutation: `deps` is the API's own, shared
      // by every request, and `since` belongs to this subscription alone.
      const since = sinceParam(url)
      handleStreamLive(request, response, terminalId, source, {
        ...deps,
        ...(since !== null ? { since } : {})
      })
      return true
    }
    await serveWindow(response, url, terminalId, source, deps)
    return true
  } catch (error) {
    // A rail that throws is a rail that renders nothing. Every read below is
    // already non-throwing by contract; this is the backstop that keeps a
    // surprise off the phone's screen as a blank card.
    console.error('stream route failed:', error)
    respondJson(response, 500, { error: messageOf(error) })
    return true
  }
}
