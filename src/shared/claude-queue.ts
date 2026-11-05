/**
 * WHAT YOU SAY WHILE A CLAUDE AGENT WORKS (owner, 2026-11-05: prompts added
 * while an agent worked never reached the chat).
 *
 * Words sent into a running turn are never a `user` record, so the checkpoint
 * rule cannot see them, and it must not: they do not open a turn, the agent
 * reads them inside the one it is on. Claude Code writes two other things:
 *
 *   queue-operation  its queue moving. `enqueue` lands the moment you send, and
 *                    the words then wait for the next tool boundary: 17 s at
 *                    the median, 114 s at p90, 870 s at worst (232 real waits).
 *                    `remove` takes them out to deliver, `popAll` takes them
 *                    back into the input box (one record per prompt, despite
 *                    the name), `dequeue` (no content) starts the next turn
 *                    with them. A prompt with pictures enqueues with no content.
 *   attachment       `queued_command`: the delivery, inside the turn, with its
 *                    origin. No user record repeats it.
 *
 * The queue also carries what is not yours to see as a bubble: background task
 * notices and other sessions' messages. Their records stay in line here, so a
 * `dequeue` (which names nothing) takes the right place; they are only never
 * shown.
 */
import { isHarnessNotice, isPeerMessage } from './harness-notice'
import { isNoisePrompt } from './session-turns'

/** The queue-operation fields of a session record. */
export interface QueueRecord {
  operation?: string
  content?: unknown
}

/** The attachment field of a session record. */
export interface ClaudeAttachment {
  type?: string
  prompt?: unknown
  commandMode?: string
  origin?: { kind?: string }
}

/** Your words in a queued line, or null when it holds none of yours to show. */
function ownWords(text: string): string | null {
  const words = text.trim()
  const foreign = words.length === 0 || isHarnessNotice(words) || isPeerMessage(words) || isNoisePrompt(words)
  return foreign ? null : words
}

/** The queue after one record: a new list, one entry per prompt in line, '' when it has no words. */
export function queueAfter(queue: readonly string[], record: QueueRecord): readonly string[] {
  const words = typeof record.content === 'string' ? record.content : ''
  if (record.operation === 'enqueue') return [...queue, words]
  if (record.operation === 'dequeue') return queue.slice(1)
  if (record.operation !== 'remove' && record.operation !== 'popAll') return queue
  const at = queue.indexOf(words)
  return at < 0 ? queue : [...queue.slice(0, at), ...queue.slice(at + 1)]
}

/** The queue as the chat shows it: your words, oldest first. */
export function queuedWords(queue: readonly string[]): string[] {
  return queue.map(ownWords).filter((words): words is string => words !== null)
}

/** A prompt's text: a string, or the text blocks beside its pictures (never their bytes). */
function promptWords(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return (prompt as Array<{ type?: string; text?: unknown }>)
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/**
 * The words of a delivery, or null when this attachment is not you speaking.
 * A transcript older than the origin field has none: its prompt mode is enough,
 * and the text itself still rules out a peer's envelope.
 */
export function deliveredWords(attachment: ClaudeAttachment | undefined): string | null {
  if (attachment?.type !== 'queued_command' || attachment.commandMode !== 'prompt') return null
  const origin = attachment.origin?.kind
  return origin === undefined || origin === 'human' ? ownWords(promptWords(attachment.prompt)) : null
}
