import { DEFAULT_CONVERSATION, type CallConversation } from './call-conversation'
import type { CallVersion } from './call-fork'

/**
 * RESOLVE THE FORK A CALL RUNS AGAINST (§9 · §10 · ④ · S3).
 *
 * Two outcomes and no third: this conversation already has a fork, or it gets
 * one now and a version pin is cut for it. There is no path here that returns
 * the ORIGINAL terminal — the call layer must never be handed the session the
 * owner is typing into, and the way to guarantee that is for this function to
 * be incapable of naming it.
 */

export interface CallSessionDeps {
  conversations: {
    find: (
      workspaceId: string,
      nodeId: string,
      sub: string,
      conversation: string
    ) => CallConversation | null
    record: (entry: CallConversation) => void
    forget: (workspaceId: string, nodeId: string, sub: string, conversation: string) => void
  }
  /** Fork + pin, together and non-splittable. See call-fork.ts. */
  cutVersion: (sourceId: string) => CallVersion
  /**
   * Is this fork still a node the app holds?
   *
   * A conversation whose fork the owner deleted is over. Resuming onto a
   * missing terminal id would silently do nothing; re-forking gives the caller
   * a working conversation again, and it is a NEW version because it is
   * genuinely a new copy of the transcript.
   */
  forkAlive: (forkId: string) => boolean
  now: () => number
}

export interface CallSession {
  forkId: string
  version: number
  conversation: string
  /** Whether this call cut a new version or joined one already running. */
  cut: boolean
}

export function makeCallSession(deps: CallSessionDeps): (input: {
  workspaceId: string
  nodeId: string
  sub: string
  conversation?: string
}) => CallSession {
  return ({ workspaceId, nodeId, sub, conversation = DEFAULT_CONVERSATION }) => {
    const existing = deps.conversations.find(workspaceId, nodeId, sub, conversation)
    if (existing !== null) {
      if (deps.forkAlive(existing.forkId)) {
        // The ordinary case, and the one the ruling exists for: the second and
        // every later turn of a conversation costs no fork and no pin.
        return {
          forkId: existing.forkId,
          version: existing.version,
          conversation,
          cut: false
        }
      }
      deps.conversations.forget(workspaceId, nodeId, sub, conversation)
    }

    const version = deps.cutVersion(nodeId)
    const entry: CallConversation = {
      workspaceId,
      nodeId,
      sub,
      conversation,
      forkId: version.forkId,
      version: version.pin.version,
      startedAt: deps.now()
    }
    // Recorded only after the fork and its pin both landed. A conversation
    // pointing at a fork that was never made would resume onto nothing.
    deps.conversations.record(entry)
    return { forkId: entry.forkId, version: entry.version, conversation, cut: true }
  }
}
