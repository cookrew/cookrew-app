import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { CanvasNode, CanvasPosition, Connection, TerminalNodeData } from '../shared/model'
import { HOME_PLACEHOLDER, PLACEHOLDER_PREFIX } from './preset-scrub'
import { cutVersionPin, type VersionPinRecord } from '../shared/version-pin'
import type { TeamSnapshot } from './teams'

/**
 * PRESET INSTALL (marketplace §8, §10) — the planning half. Decides what a
 * bought preset becomes on the buyer's canvas and what version it lands as.
 * Pure: no fs, no engine calls, nothing placed. The caller hands the plan to
 * the machinery that already ships.
 *
 * Two rules from the spec shape everything here:
 *
 * A single agent installs as a NORMAL harness terminal — not a new node kind.
 * Once placed it degrades to a plain agent, so uninstalling the marketplace can
 * never break something already on a canvas (A2). A marketplace-shaped node
 * type would have made every placed preset depend on the marketplace forever.
 *
 * A team installs as its own nodes and cables, added through the ordinary
 * node-add path. No lossy conversion layer, ever: what an author exported is
 * what a buyer places.
 */

/**
 * What to place. Concrete nodes for BOTH kinds, with fresh ids, connections
 * remapped onto them, and layout anchored at the click.
 *
 * It used to hand a team to `copyTeam`. That was wrong twice over: copyTeam is
 * workspace-to-workspace (it wants nodeIds + intoWorkspaceId and resolves its
 * own source from a store, ignoring a caller's snapshot), so the call threw on
 * its first guard EVERY time — and an `as never` on the argument is what let
 * that compile. forkTeam is no better a fit: it makes a NEW WORKSPACE, and a
 * preset click has to land on the canvas under the pointer.
 *
 * So both kinds go through the ordinary node-add path instead, which is also
 * the only way `command` and `cwd` survive: forwarding {name, preset, position,
 * orch} to createTerminal dropped exactly the fields the scrubber worked to
 * carry, and silently fell back to a built-in preset when the name was unknown.
 */
export interface PresetImportPlan {
  /** Chip semantics: one agent, or a team. */
  kind: 'single' | 'team'
  /** Ready to add, in order. Terminals carry their command and mapped cwd. */
  nodes: CanvasNode[]
  /** Cables among the placed nodes, on the new ids. */
  connections: Connection[]
  pin: VersionPinRecord
}

export interface ImportOptions {
  /** The buyer's workspace dirs, primary first. */
  dirs: string[]
  cutAt: number
  /** Versions this buyer already holds for this preset. */
  pins?: readonly VersionPinRecord[]
  /** Checkpoint the install pins at; defaults to 0 (before the first turn). */
  atIndex?: number
  /** Canvas point the placement anchors at — the click (R2). */
  position?: CanvasPosition
  /** Injectable id source so tests can assert remapping deterministically. */
  newId?: () => string
  /** The manifest this install came from, when it came from one. */
  manifestId?: string
}

const placeholderAt = (index: number): string => `${PLACEHOLDER_PREFIX}${index}}}`

/**
 * The installer's half of the target-workdir rule: map `{{dirN}}` back to the
 * buyer's directories. An index the buyer did not supply falls back to the
 * primary dir — a preset built around three workdirs must still install for
 * someone who keeps one, and collapsing onto the primary is the choice the
 * paste engine already makes.
 *
 * Throws with no dirs at all: landing a terminal whose cwd is a literal
 * `{{dir0}}` would spawn a shell in a directory that does not exist, which is
 * worse than refusing.
 */
export function applyWorkdirs(snapshot: TeamSnapshot, dirs: string[]): TeamSnapshot {
  if (dirs.length === 0) throw new Error('cannot install a preset without a target workdir')
  const home = homedir()
  const resolve = (text: string): string => {
    // Every placeholder the scrubber could have written, including ones inside
    // commands and note bodies.
    const withDirs = text.replace(/\{\{dir(\d+)\}\}/g, (_m, n: string) => dirs[Number(n)] ?? dirs[0])
    // The other half of the scrubber's home mask. Without this a buyer receives
    // a literal `{{home}}/deploy.sh` in a command the paste engine runs.
    return withDirs.split(HOME_PLACEHOLDER).join(home)
  }
  const nodes: CanvasNode[] = snapshot.nodes.map((node) => {
    if (node.kind === 'note') return { ...node, content: resolve(node.content) }
    if (node.kind === 'browser') return { ...node, url: resolve(node.url) }
    return { ...node, cwd: resolve(node.cwd), command: resolve(node.command) }
  })
  return {
    ...snapshot,
    dir: resolve(snapshot.dir),
    ...(snapshot.dirs ? { dirs: snapshot.dirs.map(resolve) } : {}),
    nodes
  }
}

/** A preset is "single" when exactly one node is what it ships. */
function terminalsOf(snapshot: TeamSnapshot): TerminalNodeData[] {
  return snapshot.nodes.filter((n): n is TerminalNodeData => n.kind === 'terminal')
}

/**
 * DEFERRED — M2 + N3, one ticket because they are one missing piece.
 *
 * A preset published with includeSessions carries `turns` and a `sessions`
 * sidecar reference, and neither survives an install: `blobs` only ever
 * addresses team.json, so the sidecar reference dangles, and nothing here
 * restores turn history onto the placed nodes. So a session-carrying preset
 * currently installs as if it carried nothing.
 *
 * Not patched piecemeal on purpose. Adding the blob without the restore leaves
 * dangling hashes inside a SIGNED manifest; adding the restore without the blob
 * restores nothing. Both need real blob plumbing — publish writes the sidecar as
 * an addressed blob, verify checks it, the store keeps it, and the planner
 * rehydrates it through the same sidecar path copyTeam already uses.
 *
 * Until then the honest behaviour is what ships: the scrub report says
 * `sessions: true` because the author opted in, and the buyer gets the cards
 * without the conversation. That is visible on the review sheet rather than
 * silent.
 */

/** Strip everything that bound a node to the AUTHOR's machine or session. */
function unbind(node: CanvasNode, id: string): CanvasNode {
  if (node.kind !== 'terminal') return { ...node, id }
  return {
    ...node,
    id,
    // Lands IDLE and unbound. A pasted marketplace preset never auto-runs (A4),
    // and it carries no session of the author's to resume.
    claudeSessionId: null,
    piSessionId: null,
    codexSessionRef: null,
    opencodeSessionId: null,
    sessionLineage: undefined,
    restoreStack: undefined,
    pendingInject: null,
    forkOf: null
  }
}

/**
 * Plan an install. Never mutates the published snapshot — §10's invariant is
 * that the original is immutable, and the copy the buyer gets is a VERSION of
 * it, so every step here builds new objects.
 */
export function planPresetImport(snapshot: TeamSnapshot, options: ImportOptions): PresetImportPlan {
  const mapped = applyWorkdirs(snapshot, options.dirs)
  const pin = cutVersionPin(options.pins ?? [], {
    // An install is pinned at the checkpoint the buyer's copy BEGINS at, which
    // is before their first turn — so it names no drawn row yet, and the rail
    // correctly shows nothing until one exists (R17: omitted, never guessed).
    atIndex: options.atIndex ?? 0,
    scrollLine: 0,
    cutAt: options.cutAt,
    ...(options.manifestId !== undefined ? { manifestId: options.manifestId } : {})
  })

  // Fresh ids: the same preset placed twice must not collide with itself.
  const newId = options.newId ?? (() => randomUUID())
  const idMap = new Map<string, string>()
  for (const node of mapped.nodes) idMap.set(node.id, newId())

  // Anchor the layout at the click. The author's coordinates are relative
  // geometry, not a place on the buyer's canvas, so the top-left of the
  // selection is what lands under the pointer and the rest keeps its shape.
  const originX = Math.min(...mapped.nodes.map((n) => n.position.x))
  const originY = Math.min(...mapped.nodes.map((n) => n.position.y))
  const at = options.position ?? { x: originX, y: originY }

  const nodes = mapped.nodes.map((node) =>
    ({
      ...unbind(node, idMap.get(node.id) as string),
      position: {
        x: at.x + (node.position.x - originX),
        y: at.y + (node.position.y - originY)
      }
    }) as CanvasNode
  )

  // Cables travel, remapped onto the new ids. A connection naming a node the
  // preset does not ship is dropped rather than left dangling.
  const connections: Connection[] = mapped.connections
    .filter((c) => idMap.has(c.a) && idMap.has(c.b))
    .map((c) => ({
      id: newId(),
      a: idMap.get(c.a) as string,
      b: idMap.get(c.b) as string
    }))

  return {
    kind: mapped.nodes.length === 1 && terminalsOf(mapped).length === 1 ? 'single' : 'team',
    pin,
    nodes,
    connections
  }
}
