// THE FIVE OLD ROUTES, ANSWERED FROM THE ONE READER (one-stream T2).
//
// The design's migration step 2, verbatim: "the old store is kept read-only
// for one release under the same path, and the old routes keep answering from
// it behind a flag, so a regression is a flag flip, not a restore."
//
//   COOKREW_STREAM_ADAPTERS unset/1/on  → /turns /latest /trace /trace/index
//                                         /trace/markers answer from the stream
//   COOKREW_STREAM_ADAPTERS=0/off/false → they answer from the old store,
//                                         through code this module never runs
//
// THE FLAG-OFF PATH IS NOT REIMPLEMENTED HERE. This handler returns false and
// mobile-api.ts's original handlers run, untouched, below it. That is the only
// way "a regression is a flag flip" is true: an adapter that also rewrote the
// fallback would have two ways to be wrong.
//
// BYTE-COMPATIBILITY IS THE GATE, and it is met field by field:
//
//   /turns          index←ordinal, uuid←identity, title/seenAt←marks,
//                   scrollLine←mark.anchor, reply capped at 4000 exactly as
//                   both old parsers cap it, final by the next-user rule with
//                   the settled tail rule at the end. Paged windows go
//                   through pageTurns — the SAME function, so the window
//                   arithmetic cannot drift.
//   /latest         the tail block's prompt/reply, plus a title when a mark
//                   carries one (see the stated difference at the bottom).
//   /trace/index    {index←ordinal, id←identity, title←the 80-cap of the
//                   light index's head — proven identical in stream-turns.ts}
//   /trace          today's TraceBlock exactly, stream extras stripped, the
//                   parser's own `final`/`outcome` passed through untouched,
//                   windowed by pageTraceBlocks — again the SAME function.
//   /trace/markers  ◆ compact with its preTokens/postTokens, ⇥ clear with the
//                   predecessor's session id, ⟲ rewind from the restore stack.
//
// THE ONE COORDINATE CHANGE, stated so nobody discovers it: `index` was the
// block's position in ITS OWN FILE and is now its position in the WHOLE
// chain. For a card that has never compacted the two numbers are identical
// and every response is byte-identical. For a card that HAS compacted they
// differ — and the old number is the one that made 400+ checkpoints
// unaddressable, so this difference is the fix, not a regression.
//
// STATED DIFFERENCE: /latest gains `title`. The old file path could never
// produce one (its parser does not carry titles), so a Sous title was
// invisible there. With marks it is available for the price of a map lookup,
// and the field was already optional in the contract because door cards send
// it. Nothing else changes shape.

import type http from 'node:http'
import { respondJson } from './mobile-http'
import {
  markFieldsOf,
  traceBlockOf,
  traceIndexEntryOfBlock,
  turnRecordsOfStream,
  type StreamMarkFields
} from '../shared/stream-turns'
import { pageTurns, type TurnRecord } from '../shared/turn'
import { pageTraceBlocks, type TraceBoundaryMarker } from '../shared/trace-blocks'
import type { StreamService } from './stream-service'
import type { StreamBlock } from './stream'

/**
 * Is the stream answering the old routes?
 *
 * Default ON in this branch (the design's "for one release"), so the flag is
 * an ESCAPE HATCH rather than an opt-in nobody would ever flip. Only the four
 * explicit off-words turn it off; a typo leaves the adapters on, which is the
 * safer failure for a value that is read from an environment.
 */
export function streamAdaptersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.COOKREW_STREAM_ADAPTERS
  if (raw === undefined) return true
  return !/^(0|off|false|no)$/i.test(raw.trim())
}

export interface StreamAdapterDeps {
  stream?: StreamService
  /** Read once per process in production; injected in tests. */
  env?: NodeJS.ProcessEnv
}

/** Everything the five answers are derived from, read ONCE per request. */
interface StreamView {
  blocks: StreamBlock[]
  marks: (identity: string) => StreamMarkFields | undefined
  total: number
  tailFinal: boolean
}

/**
 * The whole stream's blocks for this card, plus the settled tail finality.
 *
 * Yes, this materialises the window the old routes materialised — they each
 * held the whole current file's blocks too. What it never does is hold the
 * whole CHAIN's bytes: blocks come from trace.ts's per-file cache (appended
 * bytes only after the first read) and the light index is what spans the
 * chain. The adapters are a one-release compatibility layer over a paging
 * API; the paging API is what T3's renderer moves to.
 */
async function viewOf(service: StreamService, terminalId: string): Promise<StreamView> {
  const tail = await service.tailState(terminalId)
  const page = await service.blocks(terminalId, { limit: Math.max(1, tail.total) })
  const marks = service.marks(terminalId)
  return {
    blocks: page.blocks,
    marks: (identity) => markFieldsOf(marks.get(identity)),
    total: page.total,
    tailFinal: tail.final
  }
}

/** Number off the query string, or nothing — never a NaN a pager would act on. */
function num(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key)
  const parsed = raw === null ? NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function turnsOf(view: StreamView): TurnRecord[] {
  return turnRecordsOfStream(view.blocks, view.marks, {
    total: view.total,
    tailFinal: view.tailFinal
  })
}

/** GET /turns — the legacy full array, or a TurnPage when any page param is
 *  present. Both branches match the original handler's own test for "paged". */
function serveTurns(response: http.ServerResponse, url: URL, view: StreamView): void {
  const request = {
    offset: num(url, 'offset'),
    limit: num(url, 'limit'),
    aroundIndex: num(url, 'aroundIndex'),
    beforeIndex: num(url, 'beforeIndex')
  }
  const paged =
    request.offset !== undefined ||
    request.limit !== undefined ||
    request.aroundIndex !== undefined ||
    request.beforeIndex !== undefined
  const history = turnsOf(view)
  respondJson(response, 200, paged ? pageTurns(history, request) : history)
}

/** GET /latest — the last exchange only. Null for a card with no history,
 *  exactly as the tail-read path answers an empty file. */
function serveLatest(response: http.ServerResponse, view: StreamView): void {
  const block = view.blocks[view.blocks.length - 1]
  if (block === undefined) {
    respondJson(response, 200, null)
    return
  }
  const title = view.marks(block.id)?.title
  respondJson(response, 200, {
    prompt: block.prompt,
    reply: block.reply,
    ...(title !== undefined ? { title } : {})
  })
}

/** GET /trace/index — identity + title, whole range, `afterIndex` cursor. */
function serveTraceIndex(response: http.ServerResponse, url: URL, view: StreamView): void {
  const afterIndex = num(url, 'afterIndex')
  const entries = view.blocks.map(traceIndexEntryOfBlock)
  respondJson(
    response,
    200,
    afterIndex === undefined ? entries : entries.filter((entry) => entry.index > afterIndex)
  )
}

/** GET /trace — an identity-keyed window of blocks. */
function serveTracePage(
  response: http.ServerResponse,
  url: URL,
  view: StreamView,
  source: 'claude' | 'codex' | 'pi' | null
): void {
  const page = pageTraceBlocks(view.blocks.map(traceBlockOf), {
    beforeIndex: num(url, 'beforeIndex'),
    afterIndex: num(url, 'afterIndex'),
    aroundIndex: num(url, 'aroundIndex'),
    limit: num(url, 'limit')
  })
  respondJson(response, 200, { ...page, source })
}

/**
 * GET /trace/markers — ◆ compact, ⇥ clear, ⟲ rewind.
 *
 * Every one of them is now DERIVED, in one coordinate space. The old handler
 * had to reconstruct the segment boundary by re-reading the current file,
 * checking whether its first checkpoint was T1, and deciding whether to
 * attach the predecessor to an existing ◆ or stand a ⇥ beside it. The stream
 * already knows: a block is `compacted` because its own file declared a
 * boundary in front of it, or because it opens a file the chain rotated INTO
 * — and only the second kind carries a predecessor.
 */
export function markersOf(view: StreamView, rewinds: readonly number[]): TraceBoundaryMarker[] {
  const markers: TraceBoundaryMarker[] = []
  for (const block of view.blocks) {
    if (!block.compacted) continue
    const facts = block.compaction
    const previous = block.previousSessionId
    markers.push({
      // A declared in-file boundary is a ◆; a bare rotation with nothing in
      // the file is the ⇥ a /clear leaves behind.
      kind: facts !== undefined ? 'compact' : previous !== undefined ? 'clear' : 'compact',
      afterIndex: block.ordinal - 1,
      ...(facts?.preTokens !== undefined ? { preTokens: facts.preTokens } : {}),
      ...(facts?.postTokens !== undefined ? { postTokens: facts.postTokens } : {}),
      ...(previous !== undefined ? { previousSessionId: previous } : {})
    })
  }
  for (const toIndex of rewinds) {
    // A rewind that targeted the live checkpoint of its file is a no-op and
    // has never been drawn; the same guard, in the stream's ordinals.
    if (toIndex > 0 && toIndex < view.total) markers.push({ kind: 'rewind', afterIndex: toIndex, toIndex })
  }
  return markers.sort((a, b) => a.afterIndex - b.afterIndex)
}

/**
 * The five adapters. Returns true when this module answered; false hands the
 * request back to mobile-api.ts's original handlers, which is what the flag
 * being off — or a card with no walkable transcript — means.
 */
export async function handleStreamAdapters(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: StreamAdapterDeps
): Promise<boolean> {
  if ((request.method ?? 'GET') !== 'GET') return false
  const service = deps.stream
  if (service === undefined || !streamAdaptersEnabled(deps.env)) return false
  const match = url.pathname.match(
    /^\/api\/terminal\/([^/]+)\/(turns|latest|trace|trace\/index|trace\/markers)$/
  )
  if (match === null) return false
  const terminalId = decodeURIComponent(match[1])
  // ONLY a card whose record is a transcript this process can walk. A 'door'
  // card's history lives at the author's app and a 'scrape' card's is the
  // PTY; both keep their existing, capability-routed answers untouched.
  if (service.sourceOf(terminalId) !== 'file') return false

  try {
    // AN EMPTY STREAM IS AN ABSENCE, NOT AN ANSWER. A card that is booting —
    // bound to a session id whose transcript does not exist yet — has no
    // chain to read, while the old store may still hold everything the PTY
    // scraped before the file appeared. Answering [] there would blank a
    // working card for the length of a boot, so the request goes back to the
    // handler that can still answer it.
    const chain = await service.chain(terminalId)
    if (chain.files.length === 0) return false
    const view = await viewOf(service, terminalId)
    if (match[2] === 'turns') serveTurns(response, url, view)
    else if (match[2] === 'latest') serveLatest(response, view)
    else if (match[2] === 'trace/index') serveTraceIndex(response, url, view)
    else if (match[2] === 'trace/markers') {
      respondJson(response, 200, markersOf(view, service.rewindPoints(terminalId)))
    } else {
      serveTracePage(response, url, view, chain.files[chain.files.length - 1]?.kind ?? null)
    }
    return true
  } catch (error) {
    // An adapter that throws must not become a 500 where the old route
    // answered: hand the request back and let the original handler serve it.
    // The flag exists for a systematic regression; this is the per-request
    // one, and it degrades to exactly today's behaviour.
    console.error('stream adapter failed, falling back to the old store:', error)
    return false
  }
}
