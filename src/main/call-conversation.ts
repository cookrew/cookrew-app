import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './turn-annotations'

/**
 * ONE FORK PER CALLER-CONVERSATION (§10 · ④ · S3).
 *
 * THE RULING, AND WHY THE SPEC'S PLAIN READING IS WRONG. §10 says "every import
 * and every remote call forks a copy of the transcript". Taken per HTTP
 * request, that is three separate mistakes:
 *
 *  1. Latency. A fork returns as soon as the card exists, but the context lands
 *     asynchronously after the fresh TUI boots and goes quiet — so a fork per
 *     call means a full harness boot before the first token of EVERY turn.
 *  2. It destroys the rail's own grammar. §10's distinction is that diamonds
 *     are session mechanics (ephemeral) and pins are published identity —
 *     permanent, named, addressable. A pin per HTTP request makes pins the more
 *     numerous and less meaningful of the two.
 *  3. It breaks §10's update channel. "Buyers see v3 available on the chip"
 *     presumes versions are cut deliberately, not accreted by traffic.
 *
 * So a conversation is the unit. The first call mints the fork and cuts ONE
 * pin; every later call on the same conversation lands on that fork.
 *
 * THE DEFAULT IS THE SAFE ONE. A caller that sends no conversation id gets its
 * OWN default conversation rather than a fresh fork, so "one fork per caller"
 * is what happens when a client does nothing — not something a client has to
 * remember to opt into. An explicit id is for running several conversations at
 * once, and it is scoped by subject: caller A's "c1" and caller B's "c1" are
 * different conversations, so a stranger cannot join one by guessing its name.
 *
 * A CONVERSATION OUTLIVES ITS CREDENTIAL. Credentials last an hour; a
 * conversation may not be finished in one. Nothing here is keyed on a token —
 * re-asserting mid-conversation resumes the same fork instead of cutting a
 * second version.
 */

export interface CallConversation {
  workspaceId: string
  /** The ORIGINAL agent addressed, not the fork. */
  nodeId: string
  /** The caller. Conversations are scoped by it, never merely named. */
  sub: string
  /** Caller-chosen, or DEFAULT_CONVERSATION when it chose nothing. */
  conversation: string
  /** The fork this conversation runs against. */
  forkId: string
  /** The version pin cut when this conversation began. */
  version: number
  startedAt: number
}

/** What a caller that names no conversation gets. One per caller, per agent. */
export const DEFAULT_CONVERSATION = 'default'

/**
 * A caller-supplied conversation id is a KEY, never a path or a display string.
 * Bounded and allow-listed rather than sanitised, for the same reason slugs
 * are: a value that becomes part of an identity should have one spelling.
 */
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isConversationId(value: string): boolean {
  return typeof value === 'string' && CONVERSATION_ID.test(value)
}

function isConversation(value: unknown): value is CallConversation {
  const c = value as CallConversation
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.workspaceId === 'string' &&
    typeof c.nodeId === 'string' &&
    typeof c.sub === 'string' &&
    typeof c.conversation === 'string' &&
    typeof c.forkId === 'string' &&
    Number.isInteger(c.version) &&
    c.forkId.length > 0
  )
}

export class CallConversationStore {
  private readonly file: string

  constructor(base: string = path.join(homedir(), '.cookrew')) {
    this.file = path.join(base, 'call-conversations.json')
  }

  private read(): CallConversation[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return Array.isArray(parsed) ? parsed.filter(isConversation) : []
    } catch {
      // Unreadable reads as none. The cost is a re-fork and a new version,
      // which is honest; the alternative is running a caller's turn against a
      // fork we cannot prove belongs to them.
      return []
    }
  }

  private write(next: readonly CallConversation[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileAtomic(this.file, JSON.stringify(next, null, 2))
  }

  /**
   * The conversation for this exact (workspace, agent, caller, name), or null.
   *
   * All four parts are matched. Dropping the subject would let one caller
   * continue another's conversation by naming it, which is the whole reason the
   * subject is in the key rather than in the value.
   */
  find(
    workspaceId: string,
    nodeId: string,
    sub: string,
    conversation: string
  ): CallConversation | null {
    return (
      this.read().find(
        (c) =>
          c.workspaceId === workspaceId &&
          c.nodeId === nodeId &&
          c.sub === sub &&
          c.conversation === conversation
      ) ?? null
    )
  }

  /** Record a conversation, replacing any prior one for the same key. */
  record(entry: CallConversation): void {
    const rest = this.read().filter(
      (c) =>
        !(
          c.workspaceId === entry.workspaceId &&
          c.nodeId === entry.nodeId &&
          c.sub === entry.sub &&
          c.conversation === entry.conversation
        )
    )
    this.write([...rest, entry])
  }

  /** Forget a conversation whose fork no longer exists. */
  forget(workspaceId: string, nodeId: string, sub: string, conversation: string): void {
    this.write(
      this.read().filter(
        (c) =>
          !(
            c.workspaceId === workspaceId &&
            c.nodeId === nodeId &&
            c.sub === sub &&
            c.conversation === conversation
          )
      )
    )
  }
}
