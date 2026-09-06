// THE LIVE TAIL, OVER SSE (one-stream T2).
//
//   GET /api/terminal/:id/stream/live
//     event: hello      once, on open — what this subscriber is watching
//     event: tail       the OPEN last block, whenever the transcript grows
//     event: mark       one per identity whose marks changed
//     event: heartbeat  every 15 s, so a phone's EventSource stays convinced
//
// ONE TAIL READ PER CHANGE. The design's hard constraint, because one
// measured chain is 119 + 91 + 91 + 71 MB and a live rail ticks forever. The
// change detector is a `stat` of the tail transcript — path, size, mtime —
// and nothing is read while those three are unchanged. When they do change,
// exactly one reader call runs, and that call goes through trace.ts's cache,
// which reads only the APPENDED BYTES (its own contract, unchanged here). So
// a quiet agent costs one stat per tick and a busy one costs its own delta.
//
// The marks ledger is watched the same way and for the same reason: a title
// landing from Sous must reach the rail without re-reading a transcript.
//
// WHY POLLING AND NOT fs.watch. This process already polls session files
// (SessionTurnSync) because fs.watch is unreliable across the editors, git
// operations and network volumes these files live under, and because a watch
// per subscriber per card is a descriptor budget nobody sized. A stat is
// microseconds; the honest cost is stated rather than hidden behind an API
// that looks free and is not.
//
// A 'door' or 'scrape' card has no file to stat, so it is polled through the
// SAME provider the old routes use and the answer is diffed before it is
// sent — no file, no stat, but still no event when nothing changed.

import type http from 'node:http'
import { stat } from 'node:fs/promises'
import { startSse, type SseSend } from './mobile-http'
import { blockOfRecord, markFieldsOf, type StreamMarkFields } from '../shared/stream-turns'
import type { StreamService } from './stream-service'
import type { StreamBlock } from './stream'
import type { TranscriptSource } from './transcript-source'
import type { TurnRecord } from '../shared/turn'

/** The task's contract: a heartbeat every 15 s. Below startSse's own 25 s
 *  comment-ping deliberately — this one is an EVENT a client can act on
 *  ("the stream is alive and nothing changed"), not just bytes on the wire. */
export const STREAM_HEARTBEAT_MS = 15_000

/** How often the change detector runs. A stat per tick per subscriber; the
 *  rail's own refresh cadence, not faster. */
export const STREAM_POLL_MS = 1_000

export interface StreamLiveDeps {
  stream?: StreamService
  turnHistory?: (terminalId: string) => Promise<TurnRecord[]>
  /** Test seams. Production uses the real clock and fs.stat. */
  pollMs?: number
  heartbeatMs?: number
  statOf?: (file: string) => Promise<{ size: number; mtimeMs: number } | null>
  now?: () => number
}

/** What a file looked like last tick — the whole change detector. */
interface Stamp {
  file: string
  size: number
  mtimeMs: number
}

async function stampOf(
  file: string,
  statOf: (file: string) => Promise<{ size: number; mtimeMs: number } | null>
): Promise<Stamp | null> {
  if (file.length === 0) return null
  const info = await statOf(file)
  return info === null ? null : { file, size: info.size, mtimeMs: info.mtimeMs }
}

function sameStamp(a: Stamp | null, b: Stamp | null): boolean {
  if (a === null || b === null) return a === b
  return a.file === b.file && a.size === b.size && a.mtimeMs === b.mtimeMs
}

/** fs.stat, reduced to the two numbers that matter and never throwing: a
 *  transcript that vanished mid-session is "no stamp", which forces exactly
 *  one read to find out what happened. */
async function realStat(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(file)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

/** The tail payload. `final` is the settled rule (stream-finality.ts), which
 *  is the whole reason this route exists rather than a poll of /stream. */
interface TailFrame {
  block: StreamBlock | null
  final: boolean
  ordinal: number | null
  total: number
}

/** Two tails are the same event when nothing a client renders differs.
 *  Compared by field, not by reference: blocks come out of a shared cache
 *  the parsers extend IN PLACE, so reference identity proves nothing. */
function sameTail(a: TailFrame | null, b: TailFrame): boolean {
  if (a === null) return false
  if (a.total !== b.total || a.final !== b.final || a.ordinal !== b.ordinal) return false
  if (a.block === null || b.block === null) return a.block === b.block
  return (
    a.block.id === b.block.id &&
    a.block.reply === b.block.reply &&
    a.block.prompt === b.block.prompt &&
    a.block.endedAt === b.block.endedAt &&
    a.block.activity.length === b.block.activity.length
  )
}

/** Mark fields, compared as the wire would carry them. */
function sameMark(a: StreamMarkFields | undefined, b: StreamMarkFields | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * The tail, from whichever provider this card has.
 *
 * A 'file' card goes through the reader (and its settled finality); a 'door'
 * or 'scrape' card through the SAME provider the old routes use, because
 * neither has a transcript this process can walk.
 */
function tailFrameReader(
  terminalId: string,
  source: TranscriptSource,
  deps: StreamLiveDeps
): () => Promise<TailFrame> {
  const service = deps.stream as StreamService
  return async () => {
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
}

/** Emits one `mark` per identity whose folded marks differ from last pass. */
function markPusher(
  terminalId: string,
  service: StreamService,
  send: SseSend
): () => void {
  let last = new Map<string, StreamMarkFields>()
  return () => {
    const next = new Map<string, StreamMarkFields>()
    for (const [identity, mark] of service.marks(terminalId)) {
      const fields = markFieldsOf(mark)
      if (fields !== undefined) next.set(identity, fields)
    }
    for (const [identity, fields] of next) {
      if (!sameMark(last.get(identity), fields)) send('mark', { identity, mark: fields })
    }
    for (const identity of last.keys()) {
      // A cleared mark is a CHANGE, not an absence: the rail has to drop the
      // title, and a client that never hears about it keeps showing it.
      if (!next.has(identity)) send('mark', { identity, mark: null })
    }
    last = next
  }
}

/**
 * The change detector: one pass, and the state it carries between passes.
 *
 * `force` is the open — the first frame goes out unconditionally so a
 * subscriber is never left with nothing until the agent happens to move.
 */
function changeDetector(
  terminalId: string,
  source: TranscriptSource,
  deps: StreamLiveDeps,
  send: SseSend
): (force: boolean) => Promise<void> {
  const service = deps.stream as StreamService
  const statOf = deps.statOf ?? realStat
  const tailFrameOf = tailFrameReader(terminalId, source, deps)
  const pushMarks = markPusher(terminalId, service, send)
  let lastTranscript: Stamp | null = null
  let lastLedger: Stamp | null = null
  let lastTail: TailFrame | null = null

  return async (force) => {
    const ledger = await stampOf(service.marksFile(terminalId) ?? '', statOf)
    if (force || !sameStamp(lastLedger, ledger)) {
      lastLedger = ledger
      pushMarks()
    }
    if (source === 'file') {
      const chain = await service.chain(terminalId)
      const tailFile = chain.files[chain.files.length - 1]?.file ?? ''
      const transcript = await stampOf(tailFile, statOf)
      // UNCHANGED BYTES, NO READ. This is the bound the design asks for.
      if (!force && sameStamp(lastTranscript, transcript)) return
      lastTranscript = transcript
    }
    const frame = await tailFrameOf()
    if (force || !sameTail(lastTail, frame)) {
      lastTail = frame
      send('tail', frame)
    }
  }
}

/**
 * Open a live subscription. Synchronous by design: the SSE head and the
 * cleanup registration must be in place before the first await, or a client
 * that disconnects during the first read leaks its timers.
 */
export function handleStreamLive(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  terminalId: string,
  source: TranscriptSource,
  deps: StreamLiveDeps
): void {
  const send = startSse(response)
  const now = deps.now ?? Date.now
  const heartbeatMs = deps.heartbeatMs ?? STREAM_HEARTBEAT_MS
  send('hello', { terminalId, source, heartbeatMs })

  const detect = changeDetector(terminalId, source, deps, send)
  let closed = false
  /** One pass at a time: a slow read must never stack up behind the timer. */
  let running = false
  const pass = async (force: boolean): Promise<void> => {
    if (closed || running) return
    running = true
    try {
      await detect(force)
    } catch (error) {
      // A failed pass costs this tick, never the subscription: the next tick
      // re-stats and recovers. Reported, because a rail that silently stops
      // updating is the worst of the three outcomes.
      console.error('stream live pass failed:', error)
    } finally {
      running = false
    }
  }

  void pass(true)
  const poll = setInterval(() => void pass(false), deps.pollMs ?? STREAM_POLL_MS)
  poll.unref?.()
  const beat = setInterval(() => send('heartbeat', { at: now() }), heartbeatMs)
  beat.unref?.()

  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(poll)
    clearInterval(beat)
  }
  request.on('close', close)
  response.on('close', close)
}

/** Re-exported so a caller can name the send type without reaching into
 *  mobile-http for it. */
export type { SseSend }
