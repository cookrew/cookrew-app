// WHICH BROWSER CARD A NAME MEANS — for a caller in any workspace.
//
// Owner ruling 2026-11-04: every workspace works on its own, and switching
// what the window shows must never stop, refuse or lose anything in another
// one. Browser cards are driven by node-owned headless Chrome held in main
// (headless-browser-manager.ts), so nothing about driving one depends on the
// canvas on screen. The card a name means is therefore a fact about the
// CALLER, in this order:
//   1. the caller's own canvas — where its `cookrew browser create` put it;
//   2. a card it is wired to, wherever that card lives;
//   3. the canvas on screen — only for a caller no workspace holds (a
//      registry-only identity after a reboot), which has no canvas of its own.
// A served caller is held to step 2: its wires, nothing else (fail closed, the
// same rule ask-reach.ts applies). Two DIFFERENT wired cards sharing the name
// is an error, never a pick — store order would decide, and it follows which
// workspaces happen to be resident.
// Pure, so the order is pinned by tests (tests/browser-reach.test.ts).
import type { BrowserNodeData, CanvasNode } from '../shared/model'
import type { WorkspaceNodeHit } from './store'

export interface BrowserHit {
  node: BrowserNodeData
  workspaceId: string
}

export interface BrowserByNameInput {
  name: string
  /** The workspace holding the calling terminal; undefined = held by none. */
  callerWorkspaceId: string | undefined
  focusedId: string
  nodesOf: (workspaceId: string) => readonly CanvasNode[]
  /** The caller's cables, resolved across workspaces — read only when the own canvas misses. */
  wired: () => readonly WorkspaceNodeHit[]
  /** A served session: held to its wires. */
  served?: boolean
}

export function browserByName(input: BrowserByNameInput): BrowserHit | null {
  const wanted = input.name.toLowerCase()
  const isIt = (node: CanvasNode): node is BrowserNodeData =>
    node.kind === 'browser' && node.name.toLowerCase() === wanted
  const onCanvas = (workspaceId: string): BrowserHit | null => {
    const node = input.nodesOf(workspaceId).find(isIt)
    return node ? { node, workspaceId } : null
  }
  if (input.callerWorkspaceId !== undefined && !input.served) {
    const own = onCanvas(input.callerWorkspaceId)
    if (own) return own
  }
  const wired = input.wired().filter((hit) => isIt(hit.node))
  const distinct = new Set(wired.map((hit) => hit.node.id))
  if (distinct.size > 1) {
    throw new Error(
      `You are wired to more than one browser named "${input.name}" (in ${wired.map((hit) => hit.workspaceId).join(', ')}). ` +
        'Rename one so the name is unambiguous.'
    )
  }
  if (wired.length > 0) return { node: wired[0].node as BrowserNodeData, workspaceId: wired[0].workspaceId }
  return input.callerWorkspaceId === undefined && !input.served ? onCanvas(input.focusedId) : null
}

/** What a caller-scoped lookup reads from the store. */
export interface BrowserReachStore {
  readonly focusedId: string
  ownerOf(nodeId: string): string | undefined
  workspaceState(workspaceId: string): { nodes: readonly CanvasNode[] }
  connectedToAcross?(id: string): WorkspaceNodeHit[]
}

/**
 * browserByName for a terminal, read from the store — the ONE lookup both the
 * CLI (cli-browser.ts) and the engine (headless-browser-command.ts) use, so
 * the card the CLI wires and signals is the card the engine drove.
 */
export function browserForCaller(
  store: BrowserReachStore,
  terminalId: string,
  name: string,
  served = false
): BrowserHit | null {
  return browserByName({
    name,
    callerWorkspaceId: store.ownerOf(terminalId),
    focusedId: store.focusedId,
    nodesOf: (workspaceId) => store.workspaceState(workspaceId).nodes,
    wired: () => store.connectedToAcross?.(terminalId) ?? [],
    served
  })
}

/**
 * The browser set a workspace switch hands replaceNodes() — which stops
 * whatever is absent. Resident workspaces' cards, plus any page an agent or a
 * viewer used recently wherever its card lives: the workspace you looked away
 * from keeps working (owner ruling 2026-11-04). A card deleted since is found
 * nowhere and still stops; an idle page outside the resident set may stop,
 * its profile kept, and the next command starts it again.
 */
export function keptBrowsers(input: {
  resident: readonly BrowserNodeData[]
  recentlyUsed: readonly string[]
  nodeOf: (browserId: string) => BrowserNodeData | null
}): BrowserNodeData[] {
  const held = new Set(input.resident.map((node) => node.id))
  const running = input.recentlyUsed
    .filter((id) => !held.has(id))
    .map((id) => input.nodeOf(id))
    .filter((node): node is BrowserNodeData => node !== null)
  return [...input.resident, ...running]
}
