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

interface SessionEntry {
  type?: string
  isMeta?: boolean
  timestamp?: string
  uuid?: string
  parentUuid?: string
  message?: { content?: unknown }
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
function promptText(entry: SessionEntry): string | null {
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
  // parentUuid of the current turn's prompt entry. Sibling user records of ONE
  // submission (e.g. Claude's plain-string mirror + the text+image record)
  // share a parentUuid; they must collapse to ONE checkpoint, bound to the
  // sibling the thread continues from — in file order the LAST one — so fork
  // cutoffs stay exact.
  let currentParent: string | undefined
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const entry = parseEntry(line)
    if (entry === null) continue
    const prompt = promptText(entry)
    if (prompt !== null) {
      const last = turns[turns.length - 1]
      if (
        last !== undefined &&
        typeof entry.parentUuid === 'string' &&
        entry.parentUuid === currentParent
      ) {
        // Same submission as the current turn — collapse. Re-bind to this
        // later sibling's uuid (the continuation); text is identical.
        turns[turns.length - 1] = {
          ...last,
          prompt,
          ...(typeof entry.uuid === 'string' ? { uuid: entry.uuid } : {})
        }
        continue
      }
      const startedAt = entryTimeMs(entry, last?.endedAt ?? 0)
      turns.push({
        index: turns.length + 1,
        prompt,
        reply: '',
        ...(typeof entry.uuid === 'string' ? { uuid: entry.uuid } : {}),
        startedAt,
        endedAt: startedAt
      })
      currentParent = entry.parentUuid
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
