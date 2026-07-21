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
  message?: { content?: unknown }
}

function parseEntry(line: string): SessionEntry | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? (parsed as SessionEntry) : null
  } catch {
    return null
  }
}

/** True for entries that start a real conversation turn. */
function isTurnPrompt(entry: SessionEntry): boolean {
  return (
    entry.type === 'user' &&
    entry.isMeta !== true &&
    typeof entry.message?.content === 'string' &&
    !isNoisePrompt(entry.message.content)
  )
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
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const entry = parseEntry(line)
    if (entry === null) continue
    if (isTurnPrompt(entry)) {
      const startedAt = entryTimeMs(entry, turns[turns.length - 1]?.endedAt ?? 0)
      turns.push({
        index: turns.length + 1,
        prompt: (entry.message?.content as string).trim(),
        reply: '',
        ...(typeof entry.uuid === 'string' ? { uuid: entry.uuid } : {}),
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
