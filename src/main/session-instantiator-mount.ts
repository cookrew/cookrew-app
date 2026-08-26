import { rmSync } from 'node:fs'
import type { EntryTerminalLookup, SandboxRemover } from './session-instantiator-adapters'

/**
 * MOUNT HELPERS — the parts of the index.ts wiring that are pure enough to build
 * and test on their own, separated from the parts that need net-new core seams
 * (boot-in-place, scrubbed-env-at-spawn) and a running app to verify.
 *
 * The rest of the mount — constructing the four adapters, the instantiator and
 * the ServedTemplates registry, and inserting `resolveCallScope → admit` at the
 * mobile-server call seam — is documented as a recipe rather than written here,
 * because it depends on those seams and cannot be exercised headlessly. What
 * lives here is exactly what CAN be proven without the app.
 */

/** A live node, in the minimal shape this lookup reads. */
export interface WorkspaceNode {
  id: string
  kind: string
  /** Set on the one orchestrator terminal (`seedConductorIfEmpty`). */
  orch?: boolean
}

/** The store slice the lookup needs: a WORKSPACE's own nodes, by id. */
export interface WorkspaceNodesLookup {
  nodesOf(workspaceId: string): readonly WorkspaceNode[]
}

/**
 * The scoped conductor lookup (design S5). `entryAgentOf` does not exist and the
 * only orch finder in the tree — `activeOrch()` — reads the FOCUSED canvas,
 * which is exactly wrong for a served session: it would answer for whatever
 * workspace the owner is looking at, the same class of bug that took `/cwd` off
 * the table. This reads the addressed workspace's OWN nodes and finds its orch
 * terminal there, so a served session's door is its own.
 *
 * In index.ts, `nodesOf` is `(id) => store.workspaceState(id).nodes`.
 */
export function makeEntryTerminalLookup(store: WorkspaceNodesLookup): EntryTerminalLookup {
  return {
    entryTerminalOf(workspaceId) {
      // The orch is the door. A team SAVED without one still serves: the first
      // terminal answers, which is EXACTLY the door the share sheet promised —
      // SelectionBar derives its "Callers talk to {orch} only" line as
      // orch-among-picked, else first terminal. Requiring a literal orch flag
      // here made the UI promise a door the backend then refused (503 on a
      // crew the owner had just been told was taking calls).
      const terminals = store.nodesOf(workspaceId).filter((n) => n.kind === 'terminal')
      const door = terminals.find((n) => n.orch === true) ?? terminals[0]
      return door?.id ?? null
    }
  }
}

/**
 * The sandbox remover the Minter's rollback and the Ender's cleanup share. `rm
 * -rf` semantics: recursive, and absence is not an error — a cleanup that raced
 * a never-created dir must not throw. `force` also lets it follow symlinked
 * ancestors, which the Ender relies on because its path is lexical while the
 * minter's was realpathed (see the makeEnder note).
 */
export const rmSandbox: SandboxRemover = {
  remove(dir: string): void {
    rmSync(dir, { recursive: true, force: true })
  }
}
