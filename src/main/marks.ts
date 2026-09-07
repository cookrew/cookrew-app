// MARKS — the only thing about a checkpoint that is STORED.
//
// (Design: docs/site/one-stream-2026-09-07.html, phase T1.)
//
// A checkpoint is a position in the stream plus what a person or Sous
// attached to it. The position is derived (stream.ts); only the attachment
// lives here: a title, a seen-at, a pin, a scroll anchor, a fork reference.
// Of the nine fields in today's stored checkpoint exactly TWO are not in the
// transcript — title and seenAt — and the other seven are a second copy of
// the conversation. That second copy is the source of every checkpoint
// incident this codebase has had:
//
//   · the 400+ checkpoints that went unaddressable at a compaction, because
//     the stored ledger numbered its own T1..Tn per file and needed a
//     renumbering pass to span the boundary;
//   · the cap that deleted history on 2026-09-06, because the list that could
//     reach a transcript was a mutable blob with a slice() in it;
//   · the phantom rail rows the renderer clamps around when a stored record
//     pairs with no block.
//
// So: NO CONVERSATION TEXT IS EVER WRITTEN HERE, and that is enforced rather
// than documented — writeMark REFUSES a patch carrying prompt/reply (or any
// key outside the mark's own five). A ledger that cannot hold the
// conversation cannot drift from it.
//
// SHAPE. One line per CHANGE, append-only, last-wins per identity:
//
//   ~/.cookrew/marks/<terminalId>.jsonl
//   {"identity":"<uuid|claude-N-digest>","at":1757222400000,"title":"…"}
//
// APPEND, NOT REWRITE. atomic-file.ts's writeFileAtomic is a whole-file
// tmp+rename; using it here would rewrite the ledger on every seen-at, which
// is the O(n²) shape turn-store.ts had to grow tail-overlay lines to escape.
// A mark is one line written with a single O_APPEND write, so concurrent
// writers cannot interleave offsets.
//
// THE TORN-TAIL SANITY. A crash mid-write can leave a partial last line, and
// two rules make that harmless without a length prefix (which would break
// every JSONL tool on a file this design names `.jsonl`): a record is written
// with its terminating newline, so a file that does not end in one has a torn
// tail that is dropped; and JSON.stringify escapes newlines, so a truncated
// object can never contain one — a torn line is always an unbalanced object
// and can never parse. Truncation is therefore detectable in both directions,
// which is exactly what a length prefix would have bought.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './atomic-file'

export const MARKS_DIR_NAME = 'marks'

/** A Sous title is a line, not a document. Refused past this — a mark that
 *  can hold a paragraph is a mark that can hold a reply. */
export const MARK_TITLE_MAX = 512
export const MARK_IDENTITY_MAX = 200
/** A fork reference is a terminal id. */
export const MARK_FORK_MAX = 200

/** What a mark can carry. Everything else is refused, by name. */
export const MARK_FIELDS = ['title', 'seenAt', 'pin', 'anchor', 'fork'] as const
export type MarkField = (typeof MARK_FIELDS)[number]

/**
 * Keys that would make this a second copy of the conversation. Named
 * explicitly so the refusal says WHY rather than "unknown key": this is the
 * invariant the whole design rests on.
 */
const CONVERSATION_KEYS = ['prompt', 'reply', 'promptHead', 'text', 'content', 'activity']

/** The folded state of one checkpoint's marks. */
export interface Mark {
  identity: string
  /** When the newest change landed (epoch ms). */
  at: number
  /** Sous's title for the exchange. */
  title?: string
  /** When the owner viewed this result (acknowledge-on-view). */
  seenAt?: number
  /** The version pin cut at this checkpoint (VersionPinRecord.version). */
  pin?: number
  /** Scroll anchor for the rail, in the pane's own line coordinates. */
  anchor?: number
  /** Terminal id of an agent forked from this checkpoint. */
  fork?: string
}

/**
 * One change. A field left out is unchanged; a field set to null is CLEARED.
 * Both are needed: "nothing to say about the title" and "there is no title
 * any more" are different facts, and a ledger that can only add would make an
 * un-pinned checkpoint impossible to express.
 */
export interface MarkPatch {
  identity: string
  at?: number
  title?: string | null
  seenAt?: number | null
  pin?: number | null
  anchor?: number | null
  fork?: string | null
}

export interface MarkOptions {
  dir?: string
  now?: () => number
}

/** An I/O outcome. A mark is a nicety; losing one must never fail a turn. */
export interface MarkResult {
  ok: boolean
  error?: string
}

/** A patch that must not be written. LOUD on purpose: a caller trying to
 *  store conversation text is a bug in the caller, not a disk problem. */
export class MarkRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarkRefused'
  }
}

export function defaultMarksDir(): string {
  return path.join(homedir(), '.cookrew', MARKS_DIR_NAME)
}

/**
 * The ledger file for a terminal, or null when the id cannot safely name one.
 *
 * Same refusal as lineage-spill's spillFileName: an id is a uuid, and
 * anything that is not becomes a path segment nobody vetted.
 */
export function markFileFor(terminalId: string, options: MarkOptions = {}): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(terminalId)) return null
  return path.join(options.dir ?? defaultMarksDir(), `${terminalId}.jsonl`)
}

function refuseUnless(condition: boolean, message: string): void {
  if (!condition) throw new MarkRefused(message)
}

function checkNumber(value: unknown, field: string): void {
  refuseUnless(
    typeof value === 'number' && Number.isFinite(value),
    `mark field ${field} must be a finite number`
  )
}

/**
 * The written form of a patch, or a refusal.
 *
 * Pure and exported so the invariant can be tested without touching a disk,
 * and so a migration can validate a whole extraction before writing a byte.
 */
export function markLineOf(patch: MarkPatch, at: number): Record<string, unknown> {
  refuseUnless(
    typeof patch === 'object' && patch !== null,
    'a mark patch must be an object'
  )
  for (const key of Object.keys(patch)) {
    refuseUnless(
      !CONVERSATION_KEYS.includes(key),
      `refusing a mark carrying conversation text (${key}): the transcript is the ` +
        'record, and a second copy of it is what this ledger exists to remove'
    )
    refuseUnless(
      key === 'identity' || key === 'at' || (MARK_FIELDS as readonly string[]).includes(key),
      `unknown mark field: ${key}`
    )
  }
  refuseUnless(
    typeof patch.identity === 'string' &&
      patch.identity.length > 0 &&
      patch.identity.length <= MARK_IDENTITY_MAX &&
      !/[\n\r]/.test(patch.identity),
    'a mark needs a checkpoint identity (the block uuid, or the derived digest)'
  )
  const line: Record<string, unknown> = { identity: patch.identity, at }
  let carried = 0
  for (const field of MARK_FIELDS) {
    const value = patch[field]
    if (value === undefined) continue
    carried += 1
    if (value === null) {
      line[field] = null
      continue
    }
    if (field === 'title') {
      refuseUnless(typeof value === 'string', 'mark field title must be a string')
      refuseUnless(
        (value as string).length <= MARK_TITLE_MAX,
        `a mark title is a line, not a document (max ${MARK_TITLE_MAX} chars)`
      )
    } else if (field === 'fork') {
      refuseUnless(typeof value === 'string', 'mark field fork must be a string')
      refuseUnless((value as string).length <= MARK_FORK_MAX, 'mark field fork is too long')
    } else {
      checkNumber(value, field)
    }
    line[field] = value
  }
  refuseUnless(carried > 0, 'a mark with no fields records nothing')
  return line
}

/** Fold one parsed line onto the state so far — last-wins, field by field. */
function applyLine(marks: Map<string, Mark>, line: Record<string, unknown>): void {
  const identity = line.identity
  if (typeof identity !== 'string' || identity.length === 0) return
  const at = typeof line.at === 'number' && Number.isFinite(line.at) ? line.at : 0
  const previous = marks.get(identity) ?? { identity, at }
  const next: Mark = { ...previous, identity, at }
  for (const field of MARK_FIELDS) {
    if (!(field in line)) continue
    const value = line[field]
    if (value === null) {
      delete next[field]
      continue
    }
    if (field === 'title' || field === 'fork') {
      if (typeof value === 'string') next[field] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      next[field] = value
    }
  }
  marks.set(identity, next)
}

export interface MarkLedger {
  marks: Map<string, Mark>
  /** Lines that did not parse or carried no identity — reported, not hidden:
   *  a ledger quietly dropping lines is how a title disappears. */
  skipped: number
  /** True when the file ended mid-line and its tail was dropped. */
  tornTail: boolean
}

/** Read the ledger with its diagnostics. Never throws: an unreadable ledger
 *  costs the marks, never the history they describe. */
export function readMarkLedger(terminalId: string, options: MarkOptions = {}): MarkLedger {
  const marks = new Map<string, Mark>()
  const file = markFileFor(terminalId, options)
  if (file === null) return { marks, skipped: 0, tornTail: false }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { marks, skipped: 0, tornTail: false } // absent is the common case
  }
  const lines = text.split('\n')
  const tornTail = text.length > 0 && !text.endsWith('\n')
  if (tornTail) lines.pop()
  let skipped = 0
  for (const line of lines) {
    if (line.trim().length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        skipped += 1
        continue
      }
      applyLine(marks, parsed as Record<string, unknown>)
    } catch {
      skipped += 1
    }
  }
  return { marks, skipped, tornTail }
}

/** Every checkpoint's marks for a terminal, keyed by identity. */
export function readMarks(terminalId: string, options: MarkOptions = {}): Map<string, Mark> {
  return readMarkLedger(terminalId, options).marks
}

/**
 * Carry a card's marks onto a NEW terminal id (T4).
 *
 * A cut-and-paste re-ids a terminal, and marks are keyed by terminal id. The
 * conversation does not need moving — a file-backed card's history is derived
 * from a transcript the paste leaves exactly where it was — but a title and a
 * seen-at are the two things about a checkpoint that are NOT derivable, so
 * they have to travel with the card or they are simply gone.
 *
 * Written as PATCHES through the same writer, never as a file copy: the target
 * may already have marks of its own, and last-wins per identity is the only
 * merge rule this ledger has.
 */
export function copyMarks(
  fromId: string,
  toId: string,
  options: MarkOptions = {}
): { copied: number; failed: number } {
  let copied = 0
  let failed = 0
  for (const mark of readMarks(fromId, options).values()) {
    const { identity, at: _at, ...fields } = mark
    if (Object.keys(fields).length === 0) continue
    const result = writeMark(toId, { identity, ...fields }, options)
    if (result.ok) copied += 1
    else failed += 1
  }
  return { copied, failed }
}

/**
 * Record one change. Throws MarkRefused for a patch that must never be
 * written; returns a result for anything the disk did, because a failed title
 * must not take a turn down with it (the mistake PR #65 already made once).
 */
export function writeMark(
  terminalId: string,
  patch: MarkPatch,
  options: MarkOptions = {}
): MarkResult {
  const file = markFileFor(terminalId, options)
  if (file === null) {
    return { ok: false, error: `refusing unusable terminal id: ${terminalId}` }
  }
  const at = patch.at ?? (options.now?.() ?? Date.now())
  const line = markLineOf(patch, at)
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE })
    // ONE write, newline included: see the torn-tail note at the top.
    appendFileSync(file, `${JSON.stringify(line)}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
      flag: 'a'
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `mark write for ${terminalId} failed: ${(error as Error).message}` }
  }
}
