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
 * Derive TurnRecords from session JSONL lines: one record per real user
 * prompt, reply = the LAST assistant text of the turn (the conclusion),
 * endedAt = the latest entry timestamp inside the turn. Malformed lines are
 * skipped; assistant entries before any prompt are ignored.
 */
export function parseSessionTurns(lines: string[]): TurnRecord[] {
  const turns: TurnRecord[] = []
  // Identity (index + sibling collapse + uuid binding) comes from the SHARED
  // assigner so trace-block.index === TurnRecord.index by construction.
  const assigner = new CheckpointAssigner()
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const entry = parseEntry(line)
    if (entry === null) continue
    const step = assigner.feed(entry)
    if (step !== null) {
      const last = turns[turns.length - 1]
      if (step.sibling && last !== undefined) {
        // Same submission — collapse: adopt the continuation prompt/uuid,
        // keep the accumulated reply and timestamps.
        turns[turns.length - 1] = {
          ...last,
          prompt: step.id.prompt,
          ...(step.id.uuid !== undefined ? { uuid: step.id.uuid } : {})
        }
        continue
      }
      const startedAt = entryTimeMs(entry, last?.endedAt ?? 0)
      turns.push({
        index: step.id.index,
        prompt: step.id.prompt,
        reply: '',
        ...(step.id.uuid !== undefined ? { uuid: step.id.uuid } : {}),
        startedAt,
        endedAt: startedAt
      })
      continue
    }
    const current = turns[turns.length - 1]
    if (current === undefined) continue
    const reply = assistantText(entry)
    turns[turns.length - 1] = {
      ...current,
      endedAt: Math.max(current.endedAt, entryTimeMs(entry, current.endedAt)),
      reply: reply !== null ? reply.slice(0, MAX_REPLY_CHARS) : current.reply
    }
  }
  return turns
}
