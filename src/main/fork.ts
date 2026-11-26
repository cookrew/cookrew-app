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
import { ownerSubmit } from './ask'
import { dialogOnScreen, waitChoiceOfScreen } from '../shared/wait-choice'
import { inputFor } from './harness-input'
import { DEFAULT_TERMINAL_SIZE, TerminalNodeData, uniqueName } from '../shared/model'
import { buildForkPreamble, buildResumeForkNotice } from '../shared/fork'
import { withoutSessionFlags } from './harness'
import { harnessHas } from './harness-features'
import { forkClaudeSession } from './claude-fork'
import type { WorkspaceStore } from './store'
import type { PtyManager, PtySession } from './pty'
import type { TurnTracker } from './turn-tracker'

export { claudeComposerDrawn, codexComposerDrawn, piComposerDrawn } from './harness-input'

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
    piSessionId?: string | null
  }) => void
}

/** Poll cadence while waiting for the forked agent's TUI to finish booting. */
const BOOT_POLL_MS = 300
/** Output silence that counts as "the agent finished booting". */
const BOOT_QUIET_MS = 1500
/** Inject anyway after this long, so a chatty TUI can't stall the fork. */
const BOOT_TIMEOUT_MS = 25000
/**
 * How long a person's first task waits for its agent. A new Claude opens on a
 * theme picker, notes and a sign-in, which take as long as they take: past this
 * the words go back to the box, and nothing is typed anywhere.
 */
export const FIRST_TASK_WAIT_MS = 6 * 60 * 60_000


/**
 * HAS THE AGENT TUI BOOTED FAR ENOUGH TO TAKE TYPED INPUT? Output seen, then
 * BOOT_QUIET_MS of quiet, and for Claude its composer drawn. The one
 * readiness predicate for a fresh pane: the fork preamble below and the
 * recruit brief (recruit-delivery.ts) both wait on it. `command` defaults to
 * the session's own; a caller holding the card can pass the card's.
 */
export function harnessReadyForInput(
  session: Pick<PtySession, 'idleFor' | 'viewportText'> & { command?: string },
  command: string = session.command ?? ''
): boolean {
  const idle = session.idleFor()
  if (!Number.isFinite(idle) || idle < BOOT_QUIET_MS) return false
  const input = inputFor(command)
  return !input?.gatesEveryInput || input.drawn(session.viewportText())
}
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
  // null means no native fork for this harness (harness-features.ts) or the
  // session file not found, so replay a preamble. The source's stored
  // session id resolves its file deterministically.
  const native = harnessHas('nativeFork', source.command)
    ? forkClaudeSession({
        command: source.command,
        cwd: source.cwd,
        sessionId: source.claudeSessionId,
        turns: history,
        turnIndex: index
      })
    : null

  const fork: TerminalNodeData = {
    kind: 'terminal',
    id: randomUUID(),
    // addNodeToWorkspace unique-names within the source's workspace.
    name: `${source.name} ⑂T${index}`,
    preset: source.preset,
    // Session bindings live on node fields, not in the command. The spawn
    // path reconstructs the correct harness flags for the new node.
    command: withoutSessionFlags(source.command),
    cwd: source.cwd,
    orch: false,
    role: source.role,
    forkOf: { sourceId: source.id, sourceName: source.name, turnIndex: index },
    claudeSessionId: native ? native.sessionId : null,
    piSessionId: null,
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
    trackInjection(
      added.id,
      injectWhenReady(session, firstMessage).catch((error) => {
        console.error('Fork context injection failed:', error)
      })
    )
  }
  return added
}

/**
 * Injections still in flight, by fork node id.
 *
 * WHY THIS IS OBSERVABLE NOW (④ · S4). This function has always returned as
 * soon as the CARD exists, with the context landing asynchronously afterwards —
 * fine for the owner, who sees a card fill in. It is not fine for a remote
 * call, because the preamble a non-native fork receives CONTAINS A PLAIN-TEXT
 * REPLAY OF THE SOURCE'S TURNS. A caller whose ask started before that landed
 * would get the replay back in its own reply diff: the owner's transcript,
 * handed to the internet, by a path nobody wrote down.
 *
 * So the promise stops being discarded. Nothing else about the fork changes,
 * and no existing caller has to wait — this only makes an already-existing
 * asynchronous fact askable by the one caller that must not race it.
 */
const injections = new Map<string, Promise<void>>()

function trackInjection(nodeId: string, promise: Promise<void>): void {
  injections.set(nodeId, promise)
  // Settled entries are dropped, so this cannot grow with fork count.
  void promise.finally(() => {
    if (injections.get(nodeId) === promise) injections.delete(nodeId)
  })
}

/**
 * Resolves once this fork's context has landed — immediately if it already has.
 *
 * An unknown id resolves rather than rejecting: a fork made before this process
 * started, or one whose injection already settled, is READY, and the caller
 * asking cannot tell those apart from a fork that never needed one. Callers
 * that need a bound must impose their own — this promise is as patient as
 * injectWhenReady's own 25-second boot ceiling.
 */
export function forkContextReady(nodeId: string): Promise<void> {
  return injections.get(nodeId) ?? Promise.resolve()
}

/**
 * Wait for the agent TUI to boot (first output, then quiescence), then submit
 * the preamble through the owner-submit primitive (Sol r7 P0-2), which
 * delivers it as ONE bracketed paste plus a delayed Enter — multi-line text
 * must arrive as one message, not one submit per newline — under a producer
 * lease held across the whole sequence. A refusal (a dispatch mid-delivery
 * at the fresh terminal, a contaminated input box) throws, and the caller's
 * catch reports the failed injection instead of a silent half-delivery.
 * Shared with the team-fork engine (teams.ts), which injects per-terminal
 * context the same way after a workspace switch boots the forked agents.
 */

/**
 * Ready, and asking nothing. A dialog can pass for a composer: the folder-trust
 * one has a rule and a ❯ row, the bypass consent says "bypass permissions", and
 * Enter on either takes the default row, which quits. Waits on any menu at all,
 * so the person's answer (the prompt box draws these rows) comes first.
 */
function freeForFirstTask(session: PtySession): boolean {
  if (!harnessReadyForInput(session)) return false
  const screen = session.viewportText()
  if (!(inputFor(session.command ?? '')?.drawn(screen) ?? true)) return false
  return waitChoiceOfScreen(screen) === null && !dialogOnScreen(screen)
}

export interface InjectOptions {
  timeoutMs?: number
  /**
   * Past the wait, give up rather than type. The default goes in anyway so a
   * chatty TUI cannot stall a fork; a first task must not, because on a screen
   * that is not the composer its Enter answers whatever is being asked.
   */
  onlyWhenReady?: boolean
  /** The agent's process ended: stop waiting, and say so. */
  gone?: () => boolean
  /** Up and quiet, and not taking input: what is on its screen. */
  onWait?: (screen: string) => void
}

export async function injectWhenReady(session: PtySession, preamble: string, options: InjectOptions = {}): Promise<void> {
  const { timeoutMs = BOOT_TIMEOUT_MS, onlyWhenReady = false, gone, onWait } = options
  const startedAt = Date.now()
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setInterval(() => {
      if (gone?.()) {
        clearInterval(timer)
        return resolve(false)
      }
      const now = onlyWhenReady ? freeForFirstTask(session) : harnessReadyForInput(session)
      if (!now && onWait && session.idleFor() >= BOOT_QUIET_MS) onWait(session.viewportText())
      if (now || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer)
        resolve(now)
      }
    }, BOOT_POLL_MS)
  })
  if (!ready && onlyWhenReady) throw new Error('the agent never took input; the prompt was not typed')
  const verdict = await ownerSubmit(session, `${preamble}\r`)
  if (!verdict.ok) throw new Error(verdict.reason)
}
