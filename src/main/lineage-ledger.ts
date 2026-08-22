import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { claudeProjectDir } from './claude-fork'
import { readHeadLines, rotationEdgeOf } from './claude-rotation'

/**
 * A checkpoint history that spans compacts.
 *
 * THE BUG THIS EXISTS FOR. A compact ends one session file and starts another.
 * The ledger is built from the CURRENT file alone, so at every compact the
 * numbering restarts at 1 and everything before it stops being addressable —
 * the owner lost 400+ checkpoints that way and reported them as destroyed.
 *
 * They were never destroyed. ledger-rebuild.ts says it plainly: the transcripts
 * ARE the conversation and the ledger is an index over them. The transcripts
 * are intact, they are large (one chain measured 119 MB + 91 + 91 + 71), and
 * every compact writes a machine-readable join — a `compact_boundary` record
 * whose `logicalParentUuid` points into the predecessor, followed by a summary
 * carrying the predecessor's id. claude-rotation.ts has understood that shape
 * all along. Nothing joined it to the ledger: a grep for resolveRotationChain,
 * predecessor or lineage across turn-store, turn-tracker and ledger-rebuild
 * returned zero. The data was not lost, only unindexed.
 *
 * WHY THE TRANSCRIPTS AND NOT `node.sessionLineage`. That array exists and is
 * populated, and consuming it would have been less code. It is not demonstrably
 * COMPLETE: across the live workspaces only TWO nodes had both a boundary in
 * their current file and a non-empty array, which is a hint, not a proof, and
 * the recorded depths vary against chains that are deeper. A lineage that
 * records only some rotations yields a history that is quietly partial, which
 * fails the same way as one that is quietly wrong. The transcripts are the
 * source of truth by the architecture's own claim, so the chain is derived from
 * them. If the array is ever proven complete, it slots in behind this seam.
 */

/** How far back a single walk will go before it refuses to keep going. */
export const MAX_LINEAGE_DEPTH = 64

/**
 * How many head lines to read when looking for the rotation edge.
 *
 * NOT claude-rotation's ROTATION_HEAD_LINES, which is 24. That window is right
 * for its own job — deciding quickly whether a file is a rotation of a session
 * we are already holding — but it is too small for WALKING a lineage, and the
 * difference is not theoretical: Commander's own chain hides its edge at lines
 * 26-27, two past that window. Walking with 24 read the boundary as absent,
 * stopped at 6c6cbb65, and silently dropped adc47533 (119 MB) and everything
 * behind it. A history that is quietly partial fails the same way as one that
 * is quietly wrong — nothing errors and the answer is just short.
 *
 * 256 covers the chrome claude writes before the boundary (ai-title, mode and
 * agent-name records) with room to spare, and it is still a bounded head read,
 * not a scan of a 119 MB file.
 */
export const LINEAGE_HEAD_LINES = 256

export interface LineageStep {
  sessionId: string
  file: string
}

export interface SessionFs {
  listSessionFiles: (dir: string) => string[]
  headLines: (file: string) => Promise<string[]>
}

const defaultFs: SessionFs = {
  listSessionFiles(dir) {
    try {
      return readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      return []
    }
  },
  headLines: (file) => readHeadLines(file, LINEAGE_HEAD_LINES)
}

/**
 * The session chain ending at `sessionId`, OLDEST FIRST.
 *
 * Walks backwards one compact at a time: a file's head declares the predecessor
 * it continues, so the edge is read rather than inferred. The walk stops — it
 * does not guess — when a predecessor has no file on disk, which is the honest
 * outcome for a transcript that was deleted or never synced: a shorter true
 * history beats a fabricated long one.
 *
 * Cycle-guarded and depth-capped. A file that names itself, or a loop created
 * by a copied transcript, would otherwise walk forever inside the main process.
 */
export async function sessionChain(
  cwd: string,
  sessionId: string,
  options: { projectsDir?: string; fs?: SessionFs } = {}
): Promise<LineageStep[]> {
  const fs = options.fs ?? defaultFs
  const dir = claudeProjectDir(cwd, options.projectsDir)
  const names = new Set(fs.listSessionFiles(dir))

  const chain: LineageStep[] = []
  const seen = new Set<string>()
  let current: string | null = sessionId

  while (current !== null && chain.length < MAX_LINEAGE_DEPTH) {
    if (seen.has(current)) break // a cycle: stop at the repeat, keep what is real
    seen.add(current)
    const name = `${current}.jsonl`
    if (!names.has(name)) break // predecessor named but not present
    const file = path.join(dir, name)
    chain.push({ sessionId: current, file })
    const edge = rotationEdgeOf(await fs.headLines(file))
    current = edge && edge.predecessorId !== current ? edge.predecessorId : null
  }

  return chain.reverse()
}

/**
 * Why a node may not be renumbered right now.
 *
 * VERSION PINS ARE STILL INDEX-KEYED (src/shared/version-pin.ts, `atIndex`,
 * resolved through rows.findIndex(r => r.index === atIndex) and persisted by
 * pin-store.ts). Renumbering a node that carries one would move every pin onto
 * a different checkpoint, silently — the same wrong-not-orphaned failure the
 * annotation re-key exists to stop, in data owned by the marketplace lane.
 *
 * So this REFUSES, explicitly and with a reason a person can act on. No node
 * carries a pin today, which is exactly why the check has to be written now:
 * the first one that does will arrive long after this commit, and nobody will
 * be watching for it then.
 */
export interface RenumberRefusal {
  terminalId: string
  reason: 'version-pins-are-index-keyed'
  detail: string
}

export function refuseRenumber(
  terminalId: string,
  pinCount: number
): RenumberRefusal | null {
  if (pinCount <= 0) return null
  return {
    terminalId,
    reason: 'version-pins-are-index-keyed',
    detail:
      `${terminalId} carries ${pinCount} version pin(s), which are keyed by checkpoint ` +
      'index (version-pin.ts atIndex). Renumbering would move them onto different ' +
      'checkpoints without any error. Re-key pins by checkpoint uuid first, then re-run.'
  }
}

/** True when this directory holds a transcript for `sessionId`. */
export function hasTranscript(
  cwd: string,
  sessionId: string,
  projectsDir?: string
): boolean {
  return existsSync(path.join(claudeProjectDir(cwd, projectsDir), `${sessionId}.jsonl`))
}
