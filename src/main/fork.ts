// Fork an agent from one of its recorded turns: a NEW terminal card seeded
// with the source's transcript up to that turn. The original agent is never
// touched — this is the non-destructive sibling of an in-place rewind.

import { randomUUID } from 'node:crypto'
import { DEFAULT_TERMINAL_SIZE, TerminalNodeData, uniqueName } from '../shared/model'
import { buildForkPreamble } from '../shared/fork'
import type { WorkspaceStore } from './store'
import type { PtyManager, PtySession } from './pty'
import type { TurnTracker } from './turn-tracker'

export interface ForkDeps {
  store: WorkspaceStore
  ptys: PtyManager
  turns: TurnTracker
  /** Same spawn path as IPC/CLI terminal creation (PTY + turn tracking). */
  spawnTerminal: (t: { id: string; command: string; cwd: string }) => void
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
  const source = deps.store.node(sourceId)
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

  const name = uniqueName(
    `${source.name} ⑂T${index}`,
    deps.store.state.nodes.map((n) => n.name)
  )
  const fork: TerminalNodeData = {
    kind: 'terminal',
    id: randomUUID(),
    name,
    preset: source.preset,
    command: source.command,
    cwd: source.cwd,
    orch: false,
    role: source.role,
    forkOf: { sourceId: source.id, sourceName: source.name, turnIndex: index },
    position: {
      x: source.position.x + source.size.width + 80,
      y: source.position.y + 80
    },
    size: DEFAULT_TERMINAL_SIZE
  }

  const added = deps.store.addNode(fork) as TerminalNodeData
  deps.store.connect(source.id, added.id)
  deps.spawnTerminal(added)

  const preamble = buildForkPreamble({
    forkName: added.name,
    sourceName: source.name,
    turns: history,
    turnIndex: index
  })
  const session = deps.ptys.get(added.id)
  if (session) {
    injectWhenReady(session, preamble).catch((error) => {
      console.error('Fork context injection failed:', error)
    })
  }
  return added
}

/**
 * Wait for the agent TUI to boot (first output, then quiescence), then paste
 * the preamble via bracketed paste — multi-line text must arrive as ONE
 * message, not one submit per newline — and press Enter.
 */
async function injectWhenReady(session: PtySession, preamble: string): Promise<void> {
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
