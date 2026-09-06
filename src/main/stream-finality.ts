// THE FINALITY QUESTION T1 LEFT OPEN (one-stream T2).
//
// T1's StreamTailResult says it plainly: `open` is the harness's own
// evidence, and only Codex and Pi write it into the block shape
// (TraceBlock.final — `task_complete`/`turn_aborted`, pi's terminal
// stopReasons). Claude's end-of-turn marker — `stop_reason: "end_turn"` on
// the closing assistant entry — is read by session-turns.ts and is NOT
// projected onto trace blocks, so a Claude tail always read as open. T1 chose
// that conservative direction on purpose and named T2 as the place to decide.
//
// THE RULE, SETTLED:
//
//   1. TraceBlock.final === true            → final. The harness wrote a
//      terminal marker into its own file; nothing beats that.
//   2. A later block exists past this one    → final. A next user prompt in
//      an append-only file is positive evidence the earlier exchange ended —
//      the same next-user rule BOTH old parsers already apply. (Applied by
//      the callers, which know the ordinal; not repeated here.)
//   3. Otherwise, for a CLAUDE transcript, read a bounded TAIL of the file
//      and ask session-turns.ts — the module that owns the stop_reason rule —
//      whether the last record it can see is closed, and whether that record
//      is the block we are asking about.
//   4. Anything else → OPEN.
//
// WHY NOT PROJECT `final` ONTO CLAUDE TRACE BLOCKS INSTEAD. It would be one
// line in parseClaudeTraceDocument and it would change the JSON of /trace for
// every card's newest block — the exact byte-compatibility T2 is gated on.
// The finality question is a question about the TAIL, so it is answered at
// the tail, once, by the parser that already knows the answer.
//
// WHY A BOUNDED READ IS SOUND. The window is taken from the END of the file,
// so the last record in it is always complete; only the FIRST can be torn,
// and a torn first record is dropped exactly the way TraceReader
// .latestCheckpoint drops it. If the window holds no record matching the
// block's identity we answer OPEN — the conservative direction T1 named:
// reporting a finished exchange as still live costs one redundant refresh,
// while the reverse freezes a running turn on the card.

import { open, stat } from 'node:fs/promises'
import { parseSessionTurns } from '../shared/session-turns'
import type { TraceBlock } from '../shared/trace-blocks'
import type { TraceKind } from './trace'

/** How much of the tail is read to look for an end-of-turn marker. One turn's
 *  worth of records; the same 256 KB latestCheckpoint starts from. */
export const FINALITY_TAIL_BYTES = 256 * 1024

export interface FinalityDeps {
  /** Injected for tests; production reads the file's last bytes. */
  readTail?: (file: string, bytes: number) => Promise<{ text: string; fromStart: boolean } | null>
  tailBytes?: number
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
  deps: FinalityDeps = {}
): Promise<boolean> {
  if (block.final === true) return true
  if (kind !== 'claude' || file.length === 0) return false
  const read = deps.readTail ?? readFileTail
  const window = await read(file, deps.tailBytes ?? FINALITY_TAIL_BYTES)
  if (window === null) return false
  return lastRecordClosed(window, block.id)
}

/**
 * Pure half: does the tail window's LAST record carry Claude's end-of-turn
 * marker, and is it the record we asked about? Exported so the rule can be
 * tested without a disk.
 */
export function lastRecordClosed(
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
  const last = records[records.length - 1]
  // The identity check is load-bearing: a window that happened to end on an
  // OLDER closed turn would otherwise close a turn that is still running.
  return last !== undefined && last.uuid === identity && last.final === true
}
