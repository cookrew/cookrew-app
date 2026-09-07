// THE LIVE TAIL, OVER SSE (one-stream T2).
//
//   GET /api/terminal/:id/stream/live[?since=<epoch ms>]
//     event: hello      once, on open — what this subscriber is watching
//     event: tail       the OPEN last block, whenever the transcript grows
//     event: rollback   {fromOrdinal} — a /rewind took checkpoints beyond the
//                       file (T2.5). The rows stay in the index with their
//                       marks; this tells a live rail to grey them rather
//                       than re-fetching a list to discover they moved.
//     event: mark       one per identity whose marks changed
//     event: heartbeat  every 15 s, so a phone's EventSource stays convinced
//
// NO MARK BACKLOG ON CONNECT (T5 QA, 2026-09-07). The open pass used to emit
// one `mark` frame for EVERY identity the ledger held — measured on the
// owner's busiest card: 498 frames in the first two seconds, once per focused
// card per client, for facts the client already had. /stream/open's own rows
// carry those marks, so the open pass now takes a BASELINE without emitting,
// exactly as the rollback pusher already did and for the same reason: a
// subscriber that has just opened is not behind.
//
// WHAT `?since=` IS FOR. A client that reconnects WITHOUT re-opening would
// otherwise never hear about a title written during the outage. `hello`
// carries `marksAt` — the newest mark timestamp the ledger holds at connect —
// and every `mark` frame carries its own `at`; a client echoes the newest it
// has seen back as `?since=` and receives the marks written at or after it.
// A mark CLEARED during an outage is not replayed (a cleared mark leaves no
// fields to send), which is why a reconnect that also re-opens is still the
// complete answer; `since` is the cheap path, never the authoritative one.
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
import type { Mark } from './marks'
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
  /**
   * Replay marks written AT OR AFTER this epoch-ms reading on connect, and
   * nothing else. Inclusive on purpose: two marks can share a millisecond, and
   * one duplicate frame is cheaper than a title that never arrives. Absent
   * (the fresh-subscriber case) replays nothing at all — see the header. Off
   * the wire as `?since=`.
   */
  since?: number
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

/**
 * Emits one `rollback` per NEW rewind.
 *
 * A rewind is the one change a live subscriber cannot infer from the tail: the
 * transcript gets SHORTER, so the frames that follow simply stop mentioning
 * the exchanges that were taken beyond it. The materialised state records each
 * one as an appended fact (stream-materialise.ts), and this diffs that list.
 *
 * The open pass takes a BASELINE without emitting: a subscriber that has just
 * fetched /stream/open already has every rollback in that answer, and
 * replaying them would make a fresh card look like it had just been rewound.
 */
function rollbackPusher(
  terminalId: string,
  service: StreamService,
  send: SseSend
): (force: boolean) => Promise<void> {
  let sent = 0
  return async (force) => {
    if (service.rollbacks === undefined) return
    const marks = await service.rollbacks(terminalId)
    if (force) {
      sent = marks.length
      return
    }
    for (const mark of marks.slice(sent)) send('rollback', { fromOrdinal: mark.fromOrdinal })
    sent = marks.length
  }
}

/** One identity's folded marks, with the ledger's own clock beside them —
 *  the clock is the resume token, never a field a client renders. */
interface FoldedMark {
  fields: StreamMarkFields
  at: number
}

/** The ledger, reduced to what the wire carries. An identity whose marks are
 *  all cleared holds no fields and is therefore ABSENT, which is what makes a
 *  clear detectable as a disappearance. */
function foldMarks(marks: ReadonlyMap<string, Mark>): Map<string, FoldedMark> {
  const folded = new Map<string, FoldedMark>()
  for (const [identity, mark] of marks) {
    const fields = markFieldsOf(mark)
    if (fields === undefined) continue
    folded.set(identity, { fields, at: Number.isFinite(mark.at) ? mark.at : 0 })
  }
  return folded
}

/** The newest mark this card holds, or 0 — the `marksAt` a client echoes back
 *  as `?since=` when it reconnects without re-opening. */
export function newestMarkAt(marks: ReadonlyMap<string, Mark>): number {
  let newest = 0
  for (const mark of marks.values()) {
    if (Number.isFinite(mark.at) && mark.at > newest) newest = mark.at
  }
  return newest
}

/**
 * Emits one `mark` per identity whose folded marks differ from last pass.
 *
 * THE OPEN PASS EMITS NOTHING unless `since` names a reading to catch up from
 * — see the header for the 498-frame measurement that made that the rule. It
 * still takes the baseline, so the very next change is a single frame.
 */
function markPusher(
  terminalId: string,
  service: StreamService,
  send: SseSend,
  since: number | null
): (force: boolean) => void {
  let last = new Map<string, FoldedMark>()
  return (force) => {
    const next = foldMarks(service.marks(terminalId))
    for (const [identity, folded] of next) {
      const wanted = force
        // INCLUSIVE. Two marks written in the same millisecond and a client
        // holding one of them: a strict `>` would never replay the sibling.
        // One duplicate frame is the cheaper mistake (review, T5 QA).
        ? since !== null && folded.at >= since
        : !sameMark(last.get(identity)?.fields, folded.fields)
      if (wanted) send('mark', { identity, mark: folded.fields, at: folded.at })
    }
    if (!force) {
      for (const identity of last.keys()) {
        // A cleared mark is a CHANGE, not an absence: the rail has to drop the
        // title, and a client that never hears about it keeps showing it.
        if (!next.has(identity)) send('mark', { identity, mark: null })
      }
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
  const pushMarks = markPusher(
    terminalId,
    service,
    send,
    typeof deps.since === 'number' && Number.isFinite(deps.since) ? deps.since : null
  )
  const pushRollbacks = rollbackPusher(terminalId, service, send)
  let lastTranscript: Stamp | null = null
  let lastLedger: Stamp | null = null
  let lastTail: TailFrame | null = null

  return async (force) => {
    const ledger = await stampOf(service.marksFile(terminalId) ?? '', statOf)
    if (force || !sameStamp(lastLedger, ledger)) {
      lastLedger = ledger
      pushMarks(force)
    }
    if (source === 'file') {
      const chain = await service.chain(terminalId)
      const tailFile = chain.files[chain.files.length - 1]?.file ?? ''
      const transcript = await stampOf(tailFile, statOf)
      // UNCHANGED BYTES, NO READ. This is the bound the design asks for.
      if (!force && sameStamp(lastTranscript, transcript)) return
      lastTranscript = transcript
      // A SHRINK is a change like any other, so this runs on exactly the
      // passes that could have seen one — never on a quiet tick.
      await pushRollbacks(force)
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
  // `marksAt` is the resume token: echoed back as `?since=` it replays exactly
  // the marks written after this connect and no backlog at all.
  send('hello', {
    terminalId,
    source,
    heartbeatMs,
    marksAt: marksAtOf(terminalId, deps)
  })

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

/** The ledger's newest reading, never throwing: a card whose marks cannot be
 *  read resumes from 0, which costs one extra replay and never a subscription. */
function marksAtOf(terminalId: string, deps: StreamLiveDeps): number {
  try {
    return newestMarkAt(deps.stream?.marks(terminalId) ?? new Map())
  } catch (error) {
    console.error('stream live: mark ledger unreadable:', error)
    return 0
  }
}

/**
 * `?since=` off the wire: a finite, non-negative epoch-ms reading or null.
 *
 * A nonsense value reads as ABSENT rather than 0 — `since=0` would replay the
 * whole ledger, which is the 498-frame connect this parameter exists to end.
 */
export function sinceParam(url: URL): number | null {
  const raw = url.searchParams.get('since')
  if (raw === null || raw.length === 0) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Re-exported so a caller can name the send type without reaching into
 *  mobile-http for it. */
export type { SseSend }
