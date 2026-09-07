// THE RAIL'S TWO READS (one-stream T2.5 — "index 也分页，open 内嵌首页").
//
//   GET /api/terminal/:id/stream/index?before=<identity>&limit=<n>
//   GET /api/terminal/:id/stream/index?after=<identity>&limit=<n>
//   GET /api/terminal/:id/stream/open
//
// WHY OPEN EXISTS. Codex's thread/resume embeds initial_turns_page so that
// opening a conversation is ONE round trip and the client can start paging
// backwards immediately; the alternative is the shape we have today, where a
// card draws nothing until two fetches have both landed and then joins them.
// /stream/open is that answer for a card: the newest page of the rail, the
// tail with its settled finality, the cursor to page backwards from, and the
// two facts a rail cannot derive — what the projection skipped, and which
// checkpoints a /rewind took beyond the file.
//
// WHY THE FULL LIST IS DEPRECATED AND NOT DELETED. Codex marks thread/read
// deprecated with the reason in the protocol itself ("prefer a metadata-only
// read and page with thread/turns/list and thread/items/list") and keeps it
// answering. T2's clients — and the equivalence harness — ask /stream/index
// with no parameters and expect the whole list; breaking that in the same
// release that introduces the cursors would make a paging bug and a wiring
// bug indistinguishable. So the parameterless answer stands for one release,
// carries `deprecated: true` so nobody adopts it by accident, and goes in T4.

import type http from 'node:http'
import { respondJson } from './mobile-http'
import {
  blockOfRecord,
  entryOfRecordBlock,
  streamIndexRowOf,
  type StreamIndexRow
} from '../shared/stream-turns'
import { indexPageLimit, pageByIdentity, type IndexPage } from '../shared/stream-paging'
import type { StreamService } from './stream-service'
import type { CheckpointsResult } from './stream-marks'
import type { TranscriptSource } from './transcript-source'
import type { TurnRecord } from '../shared/turn'

export interface StreamIndexRouteDeps {
  stream?: StreamService
  /** The door/scrape fallback — the SAME provider the old routes use. */
  turnHistory?: (terminalId: string) => Promise<TurnRecord[]>
}

/** A cursor off the wire: a non-empty, bounded string or nothing. */
function cursor(raw: string | null): string | undefined {
  return raw !== null && raw.length > 0 && raw.length <= 200 ? raw : undefined
}

/** Does this request ask for a PAGE of the index rather than the whole list? */
export function hasIndexCursor(url: URL): boolean {
  return ['after', 'before', 'limit'].some((key) => url.searchParams.has(key))
}

/**
 * The rail's rows for a card, from whichever provider it has.
 *
 * A 'door' or 'scrape' card has no transcript this process can walk, so it
 * answers from the same provider the old routes use — reshaped to this exact
 * contract, so a client holds one code path for every card.
 */
async function rowsOf(
  terminalId: string,
  source: TranscriptSource,
  deps: StreamIndexRouteDeps
): Promise<{ rows: StreamIndexRow[]; result: Omit<CheckpointsResult, 'checkpoints'> }> {
  const service = deps.stream as StreamService
  const marks = service.marks(terminalId)
  if (source === 'file') {
    const { checkpoints, ...rest } = await service.checkpoints(terminalId)
    return {
      rows: checkpoints.map((entry) => streamIndexRowOf(entry, marks.get(entry.identity))),
      result: rest
    }
  }
  const blocks = (await deps.turnHistory?.(terminalId) ?? []).map(blockOfRecord)
  const placed = new Set(blocks.map((block) => block.id))
  return {
    rows: blocks.map((block) => streamIndexRowOf(entryOfRecordBlock(block), marks.get(block.id))),
    result: {
      missing: [],
      orphanMarks: [...marks.keys()].filter((identity) => !placed.has(identity))
    }
  }
}

/** The evidence that rides along with every rail answer. Never swallowed:
 *  a chain member with no transcript, a mark the stream cannot place, a line
 *  the projection skipped and a rewind are all things that MOVED. */
function evidence(
  result: Omit<CheckpointsResult, 'checkpoints'>,
  source: TranscriptSource
): Record<string, unknown> {
  return {
    missing: result.missing,
    orphanMarks: result.orphanMarks,
    anomalies: result.anomalies ?? {},
    rolledBack: result.rolledBack ?? [],
    source
  }
}

function pageFields(page: IndexPage<StreamIndexRow>): Record<string, unknown> {
  return {
    checkpoints: page.rows,
    nextCursor: page.nextCursor,
    backwardsCursor: page.backwardsCursor,
    total: page.total,
    ...(page.unknownAfter === true ? { unknownAfter: true as const } : {}),
    ...(page.unknownBefore === true ? { unknownBefore: true as const } : {})
  }
}

/** GET /stream/index — one page of the rail, or (deprecated) the whole list. */
export async function serveStreamIndex(
  response: http.ServerResponse,
  url: URL,
  terminalId: string,
  source: TranscriptSource,
  deps: StreamIndexRouteDeps
): Promise<void> {
  const { rows, result } = await rowsOf(terminalId, source, deps)
  if (!hasIndexCursor(url)) {
    respondJson(response, 200, {
      checkpoints: rows,
      nextCursor: null,
      backwardsCursor: null,
      total: rows.length,
      // ONE RELEASE ONLY — see the header. Page with ?before= / ?after=.
      deprecated: true,
      ...evidence(result, source)
    })
    return
  }
  const page = pageByIdentity(rows, {
    ...(cursor(url.searchParams.get('after')) !== undefined
      ? { after: cursor(url.searchParams.get('after')) as string }
      : {}),
    ...(cursor(url.searchParams.get('before')) !== undefined
      ? { before: cursor(url.searchParams.get('before')) as string }
      : {}),
    limit: indexPageLimit(url.searchParams.get('limit'))
  })
  respondJson(response, 200, { ...pageFields(page), ...evidence(result, source) })
}

/**
 * GET /stream/open — the whole opening move, in one round trip.
 *
 * `index` is the NEWEST page (a rail opens at the bottom), `backwardsCursor`
 * is what to pass as `?before=` to walk up from it, and `tail` is the same
 * frame /stream/live sends — so a client draws the rail, shows the current
 * exchange, and subscribes, without a second fetch or a join.
 */
export async function serveStreamOpen(
  response: http.ServerResponse,
  url: URL,
  terminalId: string,
  source: TranscriptSource,
  deps: StreamIndexRouteDeps
): Promise<void> {
  const service = deps.stream as StreamService
  const { rows, result } = await rowsOf(terminalId, source, deps)
  const page = pageByIdentity(rows, { limit: indexPageLimit(url.searchParams.get('limit')) })
  const tail = await tailFrame(terminalId, source, deps, service)
  respondJson(response, 200, {
    index: page.rows,
    nextCursor: page.nextCursor,
    backwardsCursor: page.backwardsCursor,
    total: page.total,
    tail,
    ...evidence(result, source)
  })
}

/** The tail, in the SAME shape /stream/live sends — live and replay must not
 *  need two renderers for the same exchange. */
async function tailFrame(
  terminalId: string,
  source: TranscriptSource,
  deps: StreamIndexRouteDeps,
  service: StreamService
): Promise<{ block: unknown; final: boolean; ordinal: number | null; total: number }> {
  if (source === 'file') {
    const state = await service.tailState(terminalId)
    return {
      block: state.block,
      final: state.final,
      ordinal: state.block?.ordinal ?? null,
      total: state.total
    }
  }
  const history = (await deps.turnHistory?.(terminalId)) ?? []
  const last = history[history.length - 1]
  if (last === undefined) return { block: null, final: false, ordinal: null, total: 0 }
  const block = blockOfRecord(last)
  return { block, final: last.final === true, ordinal: block.ordinal, total: history.length }
}
