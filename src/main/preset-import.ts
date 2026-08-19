import type { CanvasNode, TerminalNodeData } from '../shared/model'
import { PLACEHOLDER_PREFIX } from './preset-scrub'
import { cutVersionPin, type VersionPinRecord } from '../shared/version-pin'
import type { TeamForkSource, TeamSnapshot } from './teams'

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
 * A team installs through the EXISTING copyTeam engine — `fromSnapshot: true`
 * with an empty node selection, which is that engine's "the whole saved team".
 * No lossy conversion layer, ever: what an author exported is what a buyer
 * pastes, through the same path a locally saved team takes.
 */

/** A single-agent preset: one plain terminal, ready to place. */
export interface SinglePresetPlan {
  kind: 'single'
  node: TerminalNodeData
  pin: VersionPinRecord
}

/** A team preset: the source + spec copyTeam expects. */
export interface TeamPresetPlan {
  kind: 'team'
  source: TeamForkSource
  spec: { nodeIds: string[]; choices: []; dirs: string[] }
  pin: VersionPinRecord
}

export type PresetImportPlan = SinglePresetPlan | TeamPresetPlan

export interface ImportOptions {
  /** The buyer's workspace dirs, primary first. */
  dirs: string[]
  cutAt: number
  /** Versions this buyer already holds for this preset. */
  pins?: readonly VersionPinRecord[]
  /** Checkpoint the install pins at; defaults to 0 (before the first turn). */
  atIndex?: number
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
  const resolve = (text: string): string => {
    // Every placeholder the scrubber could have written, including ones inside
    // commands and note bodies.
    return text.replace(/\{\{dir(\d+)\}\}/g, (_m, n: string) => dirs[Number(n)] ?? dirs[0])
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

/** A preset is "single" when exactly one terminal is what it ships. */
function terminalsOf(snapshot: TeamSnapshot): TerminalNodeData[] {
  return snapshot.nodes.filter((n): n is TerminalNodeData => n.kind === 'terminal')
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

  const terminals = terminalsOf(mapped)
  const soloTerminal = terminals.length === 1 && mapped.nodes.length === 1

  if (soloTerminal) {
    const source = terminals[0]
    return {
      kind: 'single',
      pin,
      node: {
        ...source,
        // Lands IDLE and unbound. A pasted marketplace preset never auto-runs
        // (A4), and it carries no session of the author's to resume.
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
  }

  return {
    kind: 'team',
    pin,
    source: {
      name: mapped.name,
      dir: options.dirs[0],
      dirs: options.dirs,
      nodes: mapped.nodes,
      connections: mapped.connections,
      turnsOf: (terminalId: string) => mapped.turns[terminalId] ?? [],
      // The engine's "this came from a saved file", which with an empty node
      // selection below means the whole team.
      fromSnapshot: true,
      sessionLinesOf: () => null
    },
    spec: { nodeIds: [], choices: [], dirs: options.dirs }
  }
}
