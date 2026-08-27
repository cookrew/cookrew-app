import { promptAnswersDispatch } from './dispatch'
import type { TurnRecord } from '../shared/turn'

const DEFAULT_FINALITY_TIMEOUT_MS = 10_000
const DEFAULT_POLL_MS = 100

export interface ServedTurnReplyDeps {
  /** Existing file-derived turn history for the served orch. */
  history: () => readonly TurnRecord[]
  /** Lease-aware terminal delivery. Its PTY-shaped return value is ignored. */
  deliver: () => Promise<string>
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

export interface ServedTurnReplyOptions {
  finalityTimeoutMs?: number
  pollMs?: number
}

const identity = (record: TurnRecord): string =>
  record.uuid ?? `${record.index}:${record.startedAt}:${record.prompt}`

/**
 * Deliver a served prompt, then return only its parser-final assistant text.
 *
 * `askTerminal` remains the submission and liveness mechanism, but its return
 * value is a terminal-buffer diff: on a cold boot that can be a welcome banner,
 * paste markers, or nothing. Served callers paid for an agent turn, so this
 * adapter waits for the harness session parser's positive finality marker and
 * returns that record's reply instead.
 */
export async function servedTurnReply(
  deps: ServedTurnReplyDeps,
  prompt: string,
  options: ServedTurnReplyOptions = {}
): Promise<string> {
  const before = new Set(deps.history().map(identity))
  const wait = deps.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const timeoutMs = options.finalityTimeoutMs ?? DEFAULT_FINALITY_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS

  // Deliberately discarded. The session file below is the reply authority.
  await deps.deliver()

  const deadline = now() + timeoutMs
  for (;;) {
    const answer = deps.history().find(
      (record) =>
        !before.has(identity(record)) &&
        record.final === true &&
        promptAnswersDispatch(record.prompt, prompt)
    )
    if (answer !== undefined) return answer.reply
    if (now() >= deadline) {
      throw new Error('the served crew completed no file-backed agent turn')
    }
    await wait(pollMs)
  }
}
