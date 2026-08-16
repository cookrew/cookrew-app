// Session-file turn derivation, pure parts.
//
// For terminals bound to a Claude session id, the session JSONL under
// ~/.claude/projects is the SOURCE OF TRUTH for TurnRecords: index = real
// position of each user message, prompt/reply = exact session text,
// timestamps from session entries. PTY scraping remains only for the live
// phase and for agents without a session file. Reconciling against the file
// also handles truncation — after /rewind the rewound turns disappear.

import type { TurnRecord } from './turn'

/** Longest reply text carried into a TurnRecord (head kept). */
const MAX_REPLY_CHARS = 4000

/**
 * User records that are UI/command noise, not conversation prompts:
 * slash-command wrappers, local command output, interruptions, caveats.
 */
export function isNoisePrompt(text: string): boolean {
  return (
    /^\s*<(?:command-name|command-message|command-args|local-command-stdout)/.test(text) ||
    text.startsWith('[Request interrupted') ||
    text.startsWith('Caveat: ')
  )
}

/**
 * Minimal shape of a session prompt-bearing entry — shared so the trace-block
 * parser and this turn parser assign checkpoint identity from the SAME rule
 * (see CheckpointAssigner). Any record carrying these fields qualifies.
 */
export interface PromptEntryLike {
  type?: string
  isMeta?: boolean
  uuid?: string
  parentUuid?: string
  message?: { content?: unknown }
}

interface SessionEntry extends PromptEntryLike {
  timestamp?: string
  message?: { content?: unknown; stop_reason?: string | null }
}

interface ContentBlock {
  type?: string
  text?: string
}

/**
 * The conversational prompt text of a user entry, or null when it is not a
 * prompt. Handles BOTH plain-string content and the [text, image] block array
 * an image-bearing prompt carries — so an image prompt still mints a
 * checkpoint. Tool-result arrays (which carry a tool_result block, no text)
 * and noise wrappers return null.
 */
export function promptText(entry: PromptEntryLike): string | null {
  if (entry.type !== 'user' || entry.isMeta === true) return null
  const content = entry.message?.content
  if (typeof content === 'string') {
    return isNoisePrompt(content) ? null : content.trim()
  }
  if (Array.isArray(content)) {
    const blocks = content as ContentBlock[]
    if (blocks.some((b) => b?.type === 'tool_result')) return null
    const joined = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim()
    return joined.length > 0 && !isNoisePrompt(joined) ? joined : null
  }
  return null
}

function parseEntry(line: string): SessionEntry | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? (parsed as SessionEntry) : null
  } catch {
    return null
  }
}

function entryTimeMs(entry: SessionEntry, fallback: number): number {
  const parsed = entry.timestamp === undefined ? NaN : Date.parse(entry.timestamp)
  return Number.isNaN(parsed) ? fallback : parsed
}

/**
 * One assigned checkpoint identity: the reconciled 1-based ordinal (after
 * sibling collapse + noise/image handling) plus the continuation uuid and
 * prompt text. This IS TurnRecord.index by construction.
 */
export interface CheckpointId {
  index: number
  uuid?: string
  prompt: string
}

export interface CheckpointStep {
  id: CheckpointId
  /** True when this prompt collapses into the current checkpoint (same submission). */
  sibling: boolean
}

/** FNV-1a, 32-bit, hex — a short stable digest of a prompt. Not a hash for
 *  security, only for telling two exchanges apart. */
function digest(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The checkpoint's JOIN KEY — TurnRecord.uuid on one side, TraceBlock.id on
 * the other, and they must be the same string or the two records of the same
 * exchange cannot be paired.
 *
 * Normally that is the bound message uuid. Legacy session files predate the
 * uuid field, and a record left without one pairs with no trace block at all:
 * it renders as a phantom rail row that maps nowhere (the failure
 * mergeCheckpointRows clamps around). So the fallback is DERIVED — identical
 * on both sides because it is computed here, once, from data both sides hold.
 *
 * It carries the PROMPT digest, not just the ordinal, because an identity is a
 * claim that this is the same exchange: turn-tracker's matchPrior carries the
 * Sous title and the read marker across an exact uuid match without
 * re-checking the prompt. Ordinal-only ids would make a rewound turn and its
 * replacement look like one exchange and hand the old title to the new turn.
 */
export function checkpointIdentity(id: CheckpointId): string {
  return id.uuid ?? `claude-${id.index}-${digest(id.prompt)}`
}

/**
 * Single-pass checkpoint identity assigner, SHARED by parseSessionTurns and
 * the trace-block parser so the two coordinate systems cannot diverge (the
 * phantom-offset bug: a positional trace counter vs the reconciled turn
 * count). Feed EVERY session entry in order; a prompt entry returns its
 * CheckpointStep (new checkpoint, or a sibling collapse into the current one),
 * a non-prompt returns null without touching state. Identity assignment —
 * image-aware prompt detection, noise/command skipping, and same-parentUuid
 * sibling collapse — lives here ONCE.
 */
export class CheckpointAssigner {
  private count = 0

  /** Checkpoints assigned so far — lets boundary scanners (compact markers)
   * position themselves relative to the checkpoint stream without their own
   * counter. */
  get assigned(): number {
    return this.count
  }
  /** parentUuid of the current checkpoint's FIRST sibling (collapse anchor). */
  private currentParent: string | undefined
  /** uuid the current checkpoint is bound to (its continuation sibling). */
  private boundUuid: string | undefined

  feed(entry: PromptEntryLike): CheckpointStep | null {
    const prompt = promptText(entry)
    if (prompt === null) return null
    // Same submission as the current checkpoint (Claude's string mirror +
    // text/image record, or an edit/resend chain) — collapse, re-bind to
    // this later sibling; the ordinal does NOT advance.
    if (
      this.count > 0 &&
      typeof entry.parentUuid === 'string' &&
      entry.parentUuid === this.currentParent
    ) {
      if (typeof entry.uuid === 'string') this.boundUuid = entry.uuid
      return { id: this.idOf(prompt), sibling: true }
    }
    this.count += 1
    this.currentParent = entry.parentUuid
    this.boundUuid = typeof entry.uuid === 'string' ? entry.uuid : undefined
    return { id: this.idOf(prompt), sibling: false }
  }

  private idOf(prompt: string): CheckpointId {
    return {
      index: this.count,
      ...(this.boundUuid !== undefined ? { uuid: this.boundUuid } : {}),
      prompt
    }
  }
}

/** Joined text blocks of an assistant entry, or null when it has none. */
function assistantText(entry: SessionEntry): string | null {
  if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return null
  const joined = (entry.message.content as Array<{ type?: string; text?: string }>)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
  return joined.length > 0 ? joined : null
}

/**
 * Resumable turn parser: feed session JSONL lines in any number of chunks
 * (split anywhere at LINE granularity — byte-level partial lines are the
 * caller's carry buffer) and read the records so far. Output is identical to
 * feeding every line at once; already-fed lines are never re-read, so
 * observing one appended turn costs the appended lines only.
 */
export interface SessionTurnAccumulator {
  feed(lines: string[]): void
  records(): TurnRecord[]
}

/**
 * A turn parser that can also hand out a SessionTurnAccumulator — the
 * capability SessionTurnSync checks for to reconcile in O(Δbytes). Parsers
 * without it are re-run over retained lines instead (correct, but O(file)).
 */
export interface StreamingTurnParser {
  (lines: string[]): TurnRecord[]
  createAccumulator: () => SessionTurnAccumulator
}

export function createSessionTurnAccumulator(): SessionTurnAccumulator {
  const turns: TurnRecord[] = []
  // Identity (index + sibling collapse + uuid binding) comes from the SHARED
  // assigner so trace-block.index === TurnRecord.index by construction.
  const assigner = new CheckpointAssigner()

  const feedLine = (line: string): void => {
    if (line.trim().length === 0) return
    const entry = parseEntry(line)
    if (entry === null) return
    const step = assigner.feed(entry)
    if (step !== null) {
      const last = turns[turns.length - 1]
      if (step.sibling && last !== undefined) {
        // Same submission — collapse: adopt the continuation prompt/identity,
        // keep the accumulated reply and timestamps. A resend REOPENS the
        // exchange, so any finality the superseded sibling earned is dropped.
        const { final: _reopened, ...kept } = last
        turns[turns.length - 1] = {
          ...kept,
          prompt: step.id.prompt,
          uuid: checkpointIdentity(step.id)
        }
        return
      }
      // A later user prompt is POSITIVE evidence the previous exchange is
      // over — the only finality a record without an end-of-turn marker gets.
      if (last !== undefined && last.final !== true) {
        turns[turns.length - 1] = { ...last, final: true }
      }
      const startedAt = entryTimeMs(entry, last?.endedAt ?? 0)
      turns.push({
        index: step.id.index,
        prompt: step.id.prompt,
        reply: '',
        uuid: checkpointIdentity(step.id),
        startedAt,
        endedAt: startedAt
      })
      return
    }
    const current = turns[turns.length - 1]
    if (current === undefined) return
    const endedAt = Math.max(current.endedAt, entryTimeMs(entry, current.endedAt))
    if (entry.type === 'assistant') {
      // Tail finality tracks the LATEST assistant entry's stop_reason:
      // "end_turn" is the explicit end-of-turn marker Claude writes on the
      // closing entry; "tool_use"/null mean more of this turn is coming — a
      // nonempty reply text is NOT completion evidence (the same record keeps
      // extending with later tool/result entries).
      //
      // FAILURE outcomes (Sol r3 P1): Claude writes NO marker for an errored
      // or interrupted turn — the tail simply never gets its end_turn — so
      // there is no TurnRecord.outcome to set here, deliberately. The turn
      // stays open until the next-user boundary closes it (finality with
      // outcome absent, i.e. done: the file holds no failure evidence, and
      // fabricating one from silence would violate quiet-is-non-terminal).
      // Codex (`turn_aborted`) and pi ('aborted'/'error'/'length') DO write
      // native failure markers; theirs are classified in trace-blocks.ts.
      const reply = assistantText(entry)
      const closed = entry.message?.stop_reason === 'end_turn'
      const { final: _open, ...rest } = current
      turns[turns.length - 1] = {
        ...rest,
        endedAt,
        reply: reply !== null ? reply.slice(0, MAX_REPLY_CHARS) : current.reply,
        ...(closed ? { final: true } : {})
      }
      return
    }
    turns[turns.length - 1] = { ...current, endedAt }
  }

  return {
    feed(lines: string[]): void {
      for (const line of lines) feedLine(line)
    },
    records(): TurnRecord[] {
      return [...turns]
    }
  }
}

/**
 * Derive TurnRecords from session JSONL lines: one record per real user
 * prompt, reply = the LAST assistant text of the turn (the conclusion),
 * endedAt = the latest entry timestamp inside the turn. Malformed lines are
 * skipped; assistant entries before any prompt are ignored. Single-feed use
 * of the accumulator, so whole-file and incremental parsing cannot diverge.
 */
export const parseSessionTurns: StreamingTurnParser = Object.assign(
  function parseSessionTurns(lines: string[]): TurnRecord[] {
    const accumulator = createSessionTurnAccumulator()
    accumulator.feed(lines)
    return accumulator.records()
  },
  { createAccumulator: createSessionTurnAccumulator }
)
