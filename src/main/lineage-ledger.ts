import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { claudeProjectDir } from './claude-fork'
import {
  ROTATION_RESUME_MIN_UUIDS,
  headMessageUuids,
  isReplayContinuation,
  readHeadLines,
  replayOverlap,
  rotationEdgeOf
} from './claude-rotation'

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

/** Why an overlap-based join was declined. Never a silent skip. */
export interface JoinRefusal {
  reason: 'ambiguous' | 'weak-overlap' | 'no-candidate'
  detail: string
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
 * The predecessor of a file that declares NO boundary — the /clear case.
 *
 * A compact writes a compact_boundary naming its predecessor: that is a FACT,
 * read not inferred. A /clear does not. All that can be done there is look for
 * a file whose messages this one replays, which is a HEURISTIC, and the two
 * must not be confused: a wrong join splices a stranger's checkpoints onto this
 * agent's rail, and unlike a missing history that is invisible from the UI.
 *
 * So this REFUSES on anything short of one clear answer:
 *   - fewer than ROTATION_RESUME_MIN_UUIDS shared messages, or a ratio under
 *     ROTATION_RESUME_MIN_OVERLAP, is not evidence — decline;
 *   - TWO candidates clearing the bar is ambiguity, and picking the better
 *     score would be a guess wearing a number — decline and name both.
 *
 * Declining costs a shorter history, which the UI shows honestly. Guessing
 * costs a history that is wrong in a way nobody can see.
 */
export async function overlapPredecessor(
  file: string,
  candidates: readonly LineageStep[],
  fs: SessionFs
): Promise<{ step: LineageStep } | { refused: JoinRefusal }> {
  const own = headMessageUuids(await fs.headLines(file))
  if (own.length < ROTATION_RESUME_MIN_UUIDS) {
    return {
      refused: {
        reason: 'weak-overlap',
        detail: `only ${own.length} head message uuids; ${ROTATION_RESUME_MIN_UUIDS} needed to judge a replay`
      }
    }
  }

  const clearing: { step: LineageStep; ratio: number }[] = []
  for (const candidate of candidates) {
    const theirs = new Set(headMessageUuids(await fs.headLines(candidate.file)))
    if (theirs.size === 0) continue
    const overlap = replayOverlap(own, theirs)
    if (isReplayContinuation(overlap)) clearing.push({ step: candidate, ratio: overlap.ratio })
  }

  if (clearing.length === 0) {
    return { refused: { reason: 'no-candidate', detail: 'no file this one demonstrably replays' } }
  }
  if (clearing.length > 1) {
    return {
      refused: {
        reason: 'ambiguous',
        detail:
          `${clearing.length} files clear the replay bar (` +
          clearing.map((c) => `${c.step.sessionId.slice(0, 8)} @ ${c.ratio.toFixed(2)}`).join(', ') +
          ') — picking the higher score would be a guess'
      }
    }
  }
  return { step: clearing[0].step }
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
  options: { projectsDir?: string; fs?: SessionFs; inferClearJoins?: boolean } = {}
): Promise<LineageStep[]> {
  const fs = options.fs ?? defaultFs
  const dir = claudeProjectDir(cwd, options.projectsDir)
  const names = new Set(fs.listSessionFiles(dir))

  const chain: LineageStep[] = []
  const refusals: JoinRefusal[] = []
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
    if (edge && edge.predecessorId !== current) {
      current = edge.predecessorId
      continue
    }
    // No declared boundary. This is where a /clear lands, and the join can only
    // be inferred — so it is attempted ONLY when asked for, and it refuses
    // unless exactly one candidate clears both replay bars.
    if (!options.inferClearJoins) break
    const others = [...names]
      .filter((n) => n !== name)
      .map((n) => ({ sessionId: n.replace(/\.jsonl$/, ''), file: path.join(dir, n) }))
      .filter((c) => !seen.has(c.sessionId))
    const found = await overlapPredecessor(file, others, fs)
    if ('refused' in found) {
      refusals.push(found.refused)
      break
    }
    current = found.step.sessionId
  }

  lastRefusals = refusals
  return chain.reverse()
}

/** Why the most recent walk stopped, when it stopped at an inferred join. */
let lastRefusals: JoinRefusal[] = []
export const walkRefusals = (): readonly JoinRefusal[] => lastRefusals

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
