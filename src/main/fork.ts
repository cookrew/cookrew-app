// Fork an agent from one of its recorded turns: a NEW terminal card that
// continues from that turn. The original agent is never touched — this is
// the non-destructive sibling of an in-place rewind.
//
// Two mechanisms, best first:
//  1. Native session fork (Claude Code): resume a truncated COPY of the
//     source's real session file — full-fidelity context, origin read-only.
//  2. Prompt preamble (any agent, or when the session can't be found): a
//     fresh agent seeded with a plain-text transcript replay.

import { randomUUID } from 'node:crypto'
import { DEFAULT_TERMINAL_SIZE, TerminalNodeData, uniqueName } from '../shared/model'
import { buildForkPreamble, buildResumeForkNotice } from '../shared/fork'
import { stripSessionFlags } from '../shared/claude-fork'
import { forkClaudeSession } from './claude-fork'
import type { WorkspaceStore } from './store'
import type { PtyManager, PtySession } from './pty'
import type { TurnTracker } from './turn-tracker'

export interface ForkDeps {
  store: WorkspaceStore
  ptys: PtyManager
  turns: TurnTracker
  /** Same spawn path as IPC/CLI terminal creation (PTY + turn tracking). */
  spawnTerminal: (t: {
    id: string
    command: string
    cwd: string
    claudeSessionId?: string | null
  }) => void
}

/** Poll cadence while waiting for the forked agent's TUI to finish booting. */
const BOOT_POLL_MS = 300
/** Output silence that counts as "the agent finished booting". */
const BOOT_QUIET_MS = 1500
/** Inject anyway after this long, so a chatty TUI can't stall the fork. */
const BOOT_TIMEOUT_MS = 25000
/** Pause between pasting the preamble and pressing Enter. */
const SUBMIT_DELAY_MS = 150

/**
 * Create the fork node (placed beside its source, wired to it with an edge)
 * and kick off context injection. Returns as soon as the card exists — the
 * preamble lands asynchronously once the fresh agent's TUI goes quiet.
 */
export function forkTerminal(
  deps: ForkDeps,
  sourceId: string,
  turnIndex?: number
): TerminalNodeData {
  // Cross-workspace: the source may live outside the active canvas (orch
  // forking a teammate after a switch). The fork lands in the SOURCE's
  // workspace, beside it.
  const sourceHit = deps.store.nodeAcrossWorkspaces(sourceId)
  const source = sourceHit?.node
  if (!source || source.kind !== 'terminal') {
    throw new Error('Fork source is not a terminal node')
  }
  if (source.command.trim().length === 0) {
    throw new Error('Only agent terminals can be forked (this is a plain shell)')
  }
  const history = deps.turns.history(sourceId)
  if (history.length === 0) {
    throw new Error(`Agent '${source.name}' has no completed turns to fork from yet`)
  }
  const index = turnIndex ?? history[history.length - 1].index
  if (!history.some((t) => t.index === index)) {
    throw new Error(`Agent '${source.name}' has no recorded turn ${index}`)
  }

  // Prefer a native session fork (truncated session copy under a fresh id);
  // null means not Claude / session file not found, so replay a preamble.
  // The source's stored session id resolves its file deterministically.
  const native = forkClaudeSession({
    command: source.command,
    cwd: source.cwd,
    sessionId: source.claudeSessionId,
    turns: history,
    turnIndex: index
  })

  const fork: TerminalNodeData = {
    kind: 'terminal',
    id: randomUUID(),
    // addNodeToWorkspace unique-names within the source's workspace.
    name: `${source.name} ⑂T${index}`,
    preset: source.preset,
    // Session binding lives on claudeSessionId, not in the command — the
    // spawn path appends --resume/--session-id for the bound id itself.
    command: stripSessionFlags(source.command),
    cwd: source.cwd,
    orch: false,
    role: source.role,
    forkOf: { sourceId: source.id, sourceName: source.name, turnIndex: index },
    claudeSessionId: native ? native.sessionId : null,
    position: {
      x: source.position.x + source.size.width + 80,
      y: source.position.y + 80
    },
    size: DEFAULT_TERMINAL_SIZE
  }

  const added = deps.store.addNodeToWorkspace(sourceHit.workspaceId, fork) as TerminalNodeData
  deps.store.connectAcross(source.id, added.id)
  deps.spawnTerminal(added)

  const firstMessage = native
    ? buildResumeForkNotice({ forkName: added.name, sourceName: source.name, turnIndex: index })
    : buildForkPreamble({
        forkName: added.name,
        sourceName: source.name,
        turns: history,
        turnIndex: index
      })
  const session = deps.ptys.get(added.id)
  if (session) {
    injectWhenReady(session, firstMessage).catch((error) => {
      console.error('Fork context injection failed:', error)
    })
  }
  return added
}

/**
 * Wait for the agent TUI to boot (first output, then quiescence), then paste
 * the preamble via bracketed paste — multi-line text must arrive as ONE
 * message, not one submit per newline — and press Enter. Shared with the
 * team-fork engine (teams.ts), which injects per-terminal context the same
 * way after a workspace switch boots the forked agents.
 */
export async function injectWhenReady(session: PtySession, preamble: string): Promise<void> {
  const startedAt = Date.now()
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const idle = session.idleFor()
      const booted = Number.isFinite(idle) && idle >= BOOT_QUIET_MS
      if (booted || Date.now() - startedAt >= BOOT_TIMEOUT_MS) {
        clearInterval(timer)
        resolve()
      }
    }, BOOT_POLL_MS)
  })
  session.write(`\x1b[200~${preamble}\x1b[201~`)
  await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS))
  session.write('\r')
}
