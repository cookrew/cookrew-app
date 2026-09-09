// THE FINALITY QUESTION T1 LEFT OPEN (one-stream T2), RE-CUT AT THE BLOCK
// (D4, T5 QA 2026-09-07).
//
// T1's StreamTailResult says it plainly: `open` is the harness's own
// evidence, and only Codex and Pi write it into the block shape
// (TraceBlock.final — `task_complete`/`turn_aborted`, pi's terminal
// stopReasons). Claude's end-of-turn marker — `stop_reason: "end_turn"` on
// the closing assistant entry — is read by session-turns.ts and is NOT
// projected onto trace blocks, so a Claude tail always read as open. T1 chose
// that conservative direction on purpose and named T2 as the place to decide.
//
// WHAT T2 GOT WRONG, AND HOW IT WAS MEASURED. T2 answered the question from a
// fixed 256 KB window at the END of the file and demanded that the window's
// LAST parsed turn be the block itself. On a tool-heavy turn that never
// holds: the QA card's window carried 19 records, the assistant record with
// `stop_reason: end_turn` was inside it, and neither the block's identity nor
// its own user prompt was — so the turn was reported OPEN, and stayed open
// forever. Trailing `attachment`/`system` records compound it by pushing the
// prompt further out of reach.
//
// WIDENING THE WINDOW IS NOT THE FIX. The window is not too small; it is
// pointed at the wrong thing. The reader knows where the exchange BEGINS
// (parseClaudeTraceDocument publishes each block's line, trace.ts turns the
// last of those into a byte span), so the window is now the BLOCK'S OWN
// SPAN — its opening record to EOF — and normally a few kilobytes.
//
// THE RULE, AS IMPLEMENTED:
//
//   1. TraceBlock.final === true            → final. The harness wrote a
//      terminal marker into its own file; nothing beats that.
//   2. A later block exists past this one    → final. A next user prompt in
//      an append-only file is positive evidence the earlier exchange ended —
//      the same next-user rule BOTH old parsers already apply. Applied here
//      too, over the window (a record of ANOTHER exchange after this one),
//      and by the callers, which know the ordinal.
//   3. Otherwise, for a CLAUDE transcript, read from the block's own start to
//      EOF and ask session-turns.ts — the module that owns the stop_reason
//      rule — whether THIS block's record is closed. `attachment`, `system`
//      and progress records are ignored for free: parseSessionTurns advances
//      only `endedAt` for them and never clears a finality already earned.
//   4. Anything the window cannot show → OPEN.
//
// THE BYTE CAP, AND WHAT "UNKNOWN" MEANS. A span longer than
// FINALITY_MAX_WINDOW_BYTES (8 MiB) is not read at all and the answer is
// OPEN — not because the turn is running, but because we do not know and the
// conservative direction is the one that costs a redundant refresh rather
// than a card frozen mid-turn. The same answer covers a missing span (a
// non-Claude parser, a replayed tail), which falls back to the fixed
// FINALITY_TAIL_BYTES window T2 shipped.
//
// WHY A BOUNDED READ IS SOUND. The window is taken from the END of the file,
// so the last record in it is always complete; only the FIRST can be torn,
// and a torn first record is dropped exactly the way TraceReader
// .latestCheckpoint drops it.

import { open, stat } from 'node:fs/promises'
import { parseSessionTurns } from '../shared/session-turns'
import type { TraceBlock } from '../shared/trace-blocks'
import type { TraceKind } from './trace'

/** The window when the reader could not name the block's own span. One
 *  turn's worth of records; the same 256 KB latestCheckpoint starts from. */
export const FINALITY_TAIL_BYTES = 256 * 1024

/**
 * Slack added to a named span before it is read.
 *
 * The span is summed over the block's own lines, and blank lines are dropped
 * before the parser sees them (trace.ts readLines pushes only non-empty
 * lines), so a transcript with blanks inside its last exchange yields a span
 * a little SHORT of the truth — which would open the window just past the
 * record we need. 64 KiB of backoff covers any realistic count of them, and a
 * window that still opens mid-record drops its torn first line.
 */
export const FINALITY_SPAN_BACKOFF_BYTES = 64 * 1024

/** Past this the finality read is not attempted at all: unknown → open. */
export const FINALITY_MAX_WINDOW_BYTES = 8 * 1024 * 1024

export interface FinalityDeps {
  /** Injected for tests; production reads the file's last bytes. */
  readTail?: (file: string, bytes: number) => Promise<{ text: string; fromStart: boolean } | null>
  tailBytes?: number
  maxWindowBytes?: number
}

/** The last `bytes` of a file as text, plus whether the window reached the
 *  file's start (which decides if the first line can be trusted). */
export async function readFileTail(
  file: string,
  bytes: number
): Promise<{ text: string; fromStart: boolean } | null> {
  try {
    const { size } = await stat(file)
    const start = Math.max(0, size - bytes)
    const length = size - start
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      return { text: buffer.toString('utf8'), fromStart: start === 0 }
    } finally {
      await handle.close()
    }
  } catch (error) {
    // A transcript that cannot be read tells us nothing about finality, and
    // "nothing" must never read as "finished".
    console.error('stream finality: tail read failed:', error)
    return null
  }
}

/**
 * How many bytes to read for a block whose span the reader named, or null
 * when the answer is "do not read" — the documented unknown → open fallback.
 *
 * Exported so the cap is testable as arithmetic rather than as a file.
 */
export function finalityWindowBytes(
  span: number | undefined,
  deps: FinalityDeps = {}
): number | null {
  const max = deps.maxWindowBytes ?? FINALITY_MAX_WINDOW_BYTES
  const fixed = deps.tailBytes ?? FINALITY_TAIL_BYTES
  if (span === undefined || !Number.isFinite(span) || span < 0) return fixed
  const wanted = span + FINALITY_SPAN_BACKOFF_BYTES
  if (wanted > max) return null
  // Never SMALLER than the fixed window: a two-line exchange costs the same
  // one read either way, and the wider window can only help rule 2.
  return Math.max(wanted, fixed)
}

/**
 * Does the harness say this tail block's turn is over?
 *
 * `block` is the stream's LAST block. Callers apply rule 2 themselves — a
 * block with anything after it is closed without any I/O at all, which is
 * why this is only ever called once per request, for one block.
 */
export async function tailIsFinal(
  block: Pick<TraceBlock, 'id' | 'final'>,
  file: string,
  kind: TraceKind,
  deps: FinalityDeps = {},
  span?: number
): Promise<boolean> {
  if (block.final === true) return true
  if (kind !== 'claude' || file.length === 0) return false
  const bytes = finalityWindowBytes(span, deps)
  if (bytes === null) return false
  const read = deps.readTail ?? readFileTail
  const window = await read(file, bytes)
  if (window === null) return false
  return blockIsClosed(window, block.id)
}

/**
 * Pure half: within this window, is the exchange named by `identity` over?
 *
 * THE IDENTITY IS FOUND, NOT ASSUMED TO BE LAST. T2 required the window's
 * final record to BE the block, which is the bug this replaces: a window
 * opened at the block's own start normally ends on it, but an exchange that
 * kept writing after a rotation, or a window widened by the backoff, does
 * not, and "the record I asked about is not last" is not evidence of
 * anything. A record of a LATER exchange after it is the next-user boundary
 * and closes this one; nothing found at all is OPEN.
 */
export function blockIsClosed(
  window: { text: string; fromStart: boolean },
  identity: string
): boolean {
  const lines = window.text.split('\n')
  // Mid-file windows open on a partial JSONL record the parser cannot use.
  const usable = !window.fromStart && lines.length > 1 ? lines.slice(1) : lines
  let records: ReturnType<typeof parseSessionTurns>
  try {
    records = parseSessionTurns(usable)
  } catch (error) {
    console.error('stream finality: tail parse failed:', error)
    return false
  }
  const at = records.findIndex((record) => record.uuid === identity)
  // A window that does not hold the exchange says nothing about it. That
  // covers the legacy path too: an identity DERIVED from an in-file ordinal
  // renumbers inside a window, so it will not be found and the answer is the
  // conservative one.
  if (at < 0) return false
  // Rule 2: another exchange follows, so this one ended.
  if (at < records.length - 1) return true
  return records[at].final === true
}
