// CODEX CONTINUATION ROLLOUTS (Theme System, 2026-11-13).
//
// A Codex BACKTRACK (Esc-Esc to edit an earlier message) does not rewrite the
// rollout. Codex keeps the thread id and opens a NEW file,
//
//   rollout-<ts>-<thread>_<rollout>.jsonl
//
// whose session_meta says where its history starts:
//
//   history_base: { thread_id, end_ordinal_exclusive, end_byte_offset }
//
// "the first end_byte_offset bytes of an earlier rollout of this thread, then
// me". The process writes only the new file from then on. A card bound to the
// old file therefore froze on the exchange the backtrack dropped (CHAT stopped
// at "Now the styles:" while three more turns landed next door).
//
// This module answers the two questions that follow:
//
//   · WHICH FILE CONTINUES WHICH — codexBaseChain walks history_base back to
//     the original rollout, verifying every hop against the bytes (the record
//     at end_byte_offset must carry end_ordinal_exclusive), so a stray or
//     hand-edited header can never splice a stranger's history in.
//   · WHAT A CONTINUATION READS AS — the base prefixes fed into the parser
//     first, then the file itself: one conversation, numbered straight
//     through, exactly as Codex's own history is.
//
// Nothing about the CHAIN is memoised: the sweep asks while a backtrack's
// file may be mid-write, so a remembered answer could pin a transient one.
// Thread ids and per-file turn parsers (stable identities for the ledger) are
// memoised; both are one per file and never change once written.

import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import path from 'node:path'
import { dayDirs, defaultCodexSessionsDir, readFirstLine, rolloutIdFromRolloutPath } from './codex-bind'
import {
  createCodexTraceAccumulator,
  parseCodexHistoryBase,
  parseCodexSessionMeta,
  parseCodexTurns,
  turnAccumulatorOver,
  type CodexHistoryBase,
  type TraceBlockAccumulator
} from '../shared/trace-blocks'
import type { StreamingTurnParser } from '../shared/session-turns'

export interface CodexLineageOptions {
  /** Override for tests; defaults to ~/.codex/sessions. */
  sessionsDir?: string
}

/** A base a continuation carries on from: the first `endByteOffset` bytes of `file`. */
export interface CodexBaseSegment {
  file: string
  endByteOffset: number
}

/** Hops walked before giving up — a backtrack per hop, far beyond real use. */
const MAX_BASE_DEPTH = 32
/** Positioned-read chunk while feeding a base prefix. */
const FEED_CHUNK_BYTES = 1024 * 1024
/** Cap on the record read at a cut point (a cut lands on a small task_started). */
const CUT_RECORD_CAP_BYTES = 16 * 1024 * 1024
/** Memo bound, per map. */
const MEMO_CAP = 256

const NEWLINE = 0x0a
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const parserMemo = new Map<string, StreamingTurnParser>()
const threadMemo = new Map<string, string>()

function remember<T>(memo: Map<string, T>, key: string, value: T): T {
  memo.delete(key)
  memo.set(key, value)
  while (memo.size > MEMO_CAP) {
    const oldest = memo.keys().next()
    if (oldest.done === true) break
    memo.delete(oldest.value)
  }
  return value
}

function sessionsDirOf(options: CodexLineageOptions): string {
  return path.resolve(options.sessionsDir ?? defaultCodexSessionsDir())
}

/** The thread a rollout belongs to, from its own session_meta (memoised:
 *  the sweep asks this of every bound rollout twice a minute). */
function threadOf(file: string): string | null {
  const key = path.resolve(file)
  const memo = threadMemo.get(key)
  if (memo !== undefined) return memo
  const first = readFirstLine(file)
  const thread = first === null ? null : (parseCodexSessionMeta(first)?.sessionId ?? null)
  // A header not written yet is not remembered.
  return thread === null ? null : remember(threadMemo, key, thread)
}

/** Every rollout file of `threadId` under `dirs` (by name, then by header). */
function rolloutsOfThread(threadId: string, dirs: readonly string[]): string[] {
  if (!UUID_RE.test(threadId)) return []
  const found: string[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      if (!name.includes(`-${threadId}`)) continue
      const file = path.join(dir, name)
      if (threadOf(file) === threadId) found.push(file)
    }
  }
  return found
}

/** Every YYYY/MM/DD dir in the sessions tree. A base can be any age. */
function allDayDirs(root: string): string[] {
  const dirs: string[] = []
  const children = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((name) => /^\d+$/.test(name))
    } catch {
      return []
    }
  }
  for (const year of children(root)) {
    for (const month of children(path.join(root, year))) {
      for (const day of children(path.join(root, year, month))) {
        dirs.push(path.join(root, year, month, day))
      }
    }
  }
  return dirs
}

/** Bytes [start, start+length) of a file; shorter at EOF. */
function readAt(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, start + read)
    if (n === 0) break
    read += n
  }
  return read === length ? buffer : buffer.subarray(0, read)
}

/**
 * Does `offset` in `file` sit on a record boundary whose record carries
 * Codex ordinal `ordinal`? An offset AT end of file is a boundary with no
 * record after it — a base consumed whole — and holds when the byte before is
 * a newline.
 */
function cutHolds(file: string, offset: number, ordinal: number): boolean {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return false
  }
  try {
    const size = fstatSync(fd).size
    if (offset > size) return false
    if (offset > 0 && readAt(fd, offset - 1, 1)[0] !== NEWLINE) return false
    if (offset === size) {
      // A whole-file base has no next record to carry the cut ordinal. Verify
      // Codex's exclusive boundary against the final record instead of
      // accepting any positive ordinal merely because the file ends in \n.
      const windowStart = Math.max(0, size - FEED_CHUNK_BYTES)
      const tail = readAt(fd, windowStart, size - windowStart).toString('utf8')
      const records = tail.split('\n').filter((line) => line.length > 0)
      if (records.length === 0) return false
      const last = JSON.parse(records[records.length - 1]) as { ordinal?: unknown }
      return typeof last.ordinal === 'number' && last.ordinal + 1 === ordinal
    }
    const chunks: Buffer[] = []
    let total = 0
    while (total < CUT_RECORD_CAP_BYTES) {
      const chunk = readAt(fd, offset + total, FEED_CHUNK_BYTES)
      if (chunk.length === 0) break
      const newline = chunk.indexOf(NEWLINE)
      if (newline !== -1) {
        chunks.push(chunk.subarray(0, newline))
        total += newline
        break
      }
      chunks.push(chunk)
      total += chunk.length
    }
    if (total === 0) return offset > 0
    const record = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ordinal?: unknown }
    return record.ordinal === ordinal
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/** The one verified base `file`'s history_base names, or null on any doubt. */
function resolveBase(
  file: string,
  base: CodexHistoryBase,
  root: string
): CodexBaseSegment | null {
  const self = path.resolve(file)
  // Search every day. A near-day shortcut would accept one matching base and
  // skip a second valid holder in an older day, defeating the ambiguity guard.
  // The filename filter keeps this bounded to this thread's rollouts; the
  // sweep is 30 s and this path is only reached when a continuation header is
  // actually present.
  const verified = rolloutsOfThread(base.threadId, allDayDirs(root)).filter(
    (candidate) =>
      path.resolve(candidate) !== self &&
      cutHolds(candidate, base.endByteOffset, base.endOrdinalExclusive)
  )
  // Two files that both hold the cut is a doubt, and doubt reads as "no base".
  return verified.length === 1
    ? { file: path.resolve(verified[0]), endByteOffset: base.endByteOffset }
    : null
}

/**
 * The bases a rollout carries on from, OLDEST FIRST, every hop verified.
 * Empty for an ordinary rollout. A cycle refuses the whole chain.
 *
 * NOTHING IS MEMOISED. The sweep asks this while a backtrack's file may be
 * mid-write (a header with no history_base is then indistinguishable from the
 * real terminus), so any remembered answer could pin a transient one forever.
 * The sweep is 30 s and each hop is one first-line read plus a byte check —
 * the price of never being wrong.
 */
export function codexBaseChain(
  file: string,
  options: CodexLineageOptions = {}
): readonly CodexBaseSegment[] {
  const root = sessionsDirOf(options)
  if (readFirstLine(file) === null) return []
  const chain: CodexBaseSegment[] = []
  const seen = new Set([path.resolve(file)])
  let at = file
  for (let depth = 0; depth < MAX_BASE_DEPTH; depth++) {
    const first = readFirstLine(at)
    if (first === null) return []
    const meta = parseCodexSessionMeta(first)
    const base = parseCodexHistoryBase(first)
    if (base === null) return chain
    // A continuation may only point into its own thread. Without this check,
    // a malformed history_base could splice a valid rollout from another
    // thread into this conversation merely because the UUID was discoverable.
    if (meta === null || meta.sessionId !== base.threadId) return []
    const segment = resolveBase(at, base, root)
    // A declared base that is missing or ambiguous invalidates the WHOLE
    // inherited view. Returning a partial prefix would make CHAT look
    // plausible while silently dropping the older conversation.
    if (segment === null) return []
    if (seen.has(segment.file)) return []
    seen.add(segment.file)
    chain.unshift(segment)
    at = segment.file
  }
  // The depth cap is a safety boundary, not a valid terminus.
  return []
}

/** Is `held` a continuation (at any depth) of `bound`? */
export function codexRolloutContinues(
  held: string,
  bound: string,
  options: CodexLineageOptions = {}
): boolean {
  const target = path.resolve(bound)
  if (path.resolve(held) === target) return false
  return codexBaseChain(held, options).some((segment) => segment.file === target)
}

export interface CodexSuccessorScope extends CodexLineageOptions {
  /** The moment a continuation would have been written; defaults to now. */
  aroundMs?: number
  /**
   * Search the whole sessions tree instead of the days around `aroundMs`.
   * For a card that was not watching when the backtrack happened (an app
   * restart days later): once per spawn, never per sweep.
   */
  everywhere?: boolean
}

/**
 * Continuations of `bound` — the cheap, disk-only question asked before the
 * authoritative one (which file the codex process holds open). A backtrack
 * writes its file NOW, so the days around now are where a live card finds one.
 */
export function codexSuccessorsOf(bound: string, options: CodexSuccessorScope = {}): string[] {
  const threadId = threadOf(bound)
  if (threadId === null) return []
  const root = sessionsDirOf(options)
  const dirs = options.everywhere
    ? allDayDirs(root)
    : [...new Set(dayDirs(root, options.aroundMs ?? Date.now()))]
  return rolloutsOfThread(threadId, dirs).filter((candidate) =>
    codexRolloutContinues(candidate, bound, options)
  )
}

export interface CodexFollowInput {
  /** The rollout the card is bound to (already validated), or null. */
  bound: string | null
  /** The rollout the card's codex process holds open (lsof) — asked lazily. */
  held: () => string | null
  /** Is this rollout already bound to ANOTHER card? */
  ownedElsewhere: (file: string) => boolean
}

/**
 * The rollout a Codex card should move to, or null to stay put.
 *
 * Disk first, process second: lsof is a synchronous child process, so it is
 * only asked once a continuation of the bound rollout exists on disk. The
 * process's open file is the authority (the EXACT-CONTEXT rule the spawn bind
 * follows), and it is followed only when it PROVABLY continues this card's own
 * conversation — never onto another thread, never onto a file another card
 * owns.
 */
export function codexRolloutToFollow(
  input: CodexFollowInput,
  options: CodexSuccessorScope = {}
): string | null {
  const { bound } = input
  if (bound === null) return null
  if (codexSuccessorsOf(bound, options).length === 0) return null
  const held = input.held()
  if (held === null || path.resolve(held) === path.resolve(bound)) return null
  if (!codexRolloutContinues(held, bound, options)) return null
  return input.ownedElsewhere(held) ? null : held
}

/** Feed `file`'s lines in [0, end) to `onLines`, chunk by chunk (sync). */
function feedPrefix(file: string, end: number, onLines: (lines: string[]) => void): void {
  const fd = openSync(file, 'r')
  try {
    let carry: Buffer = Buffer.alloc(0)
    let at = 0
    while (at < end) {
      const chunk = readAt(fd, at, Math.min(FEED_CHUNK_BYTES, end - at))
      if (chunk.length === 0) break
      at += chunk.length
      const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
      const boundary = data.lastIndexOf(NEWLINE)
      if (boundary === -1) {
        carry = data
        continue
      }
      onLines(data.toString('utf8', 0, boundary).split('\n'))
      carry = Buffer.from(data.subarray(boundary + 1))
    }
    if (carry.length > 0) onLines([carry.toString('utf8')])
  } finally {
    closeSync(fd)
  }
}

/** Feed every base prefix of `file`, oldest first. No-op for an ordinary rollout. */
export function feedCodexBase(
  file: string,
  onLines: (lines: string[]) => void,
  options: CodexLineageOptions = {},
  onFileStart?: (branch: string | null) => void
): void {
  for (const segment of codexBaseChain(file, options)) {
    try {
      onFileStart?.(rolloutIdFromRolloutPath(segment.file))
      feedPrefix(segment.file, segment.endByteOffset, onLines)
    } catch (error) {
      console.error('codex lineage: base prefix unreadable:', error)
      return
    }
  }
}

/** A trace parser for `file` that already holds the history it continues. */
export function codexTraceAccumulatorFor(
  file: string,
  options: CodexLineageOptions = {}
): TraceBlockAccumulator {
  // The continuation's own rollout id namespaces ITS blocks, so a resend can
  // never wear the identity the base still holds for the exchange it dropped.
  const accumulator = createCodexTraceAccumulator()
  feedCodexBase(
    file,
    (lines) => accumulator.feed(lines),
    options,
    (branch) => accumulator.startFile(branch === null ? null : `b${branch}`)
  )
  accumulator.startFile(
    rolloutIdFromRolloutPath(file) === null ? null : `b${rolloutIdFromRolloutPath(file) as string}`
  )
  return accumulator
}

/**
 * The turn parser SessionTurnSync should use for `file`.
 *
 * An ordinary rollout gets the shared parser itself. A continuation gets one
 * whose ACCUMULATOR starts from the base prefixes, so the ledger sees the
 * whole conversation; it is memoised per file because SessionTurnSync
 * re-watches by parser identity. The plain-function form stays unseeded on
 * purpose: TraceReader.latest calls it over a bounded TAIL, and seeding there
 * would re-read every base on each poll.
 */
export function codexTurnParserFor(
  file: string,
  options: CodexLineageOptions = {}
): StreamingTurnParser {
  if (codexBaseChain(file, options).length === 0) return parseCodexTurns
  const key = `${sessionsDirOf(options)}\0${path.resolve(file)}`
  const memo = parserMemo.get(key)
  if (memo !== undefined) return memo
  const parser: StreamingTurnParser = Object.assign((lines: string[]) => parseCodexTurns(lines), {
    createAccumulator: () => turnAccumulatorOver(codexTraceAccumulatorFor(file, options))
  })
  return remember(parserMemo, key, parser)
}
