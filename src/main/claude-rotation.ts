// Mid-flight Claude session ROTATION — following a conversation that moved
// house without telling anyone.
//
// When a Claude conversation runs out of context it does not keep writing to
// its session file. It rotates: a new process is spawned
// (`--session-id <new> --fork-session --resume <old>.jsonl`) writing a NEW
// JSONL under ~/.claude/projects/<slug>/, seeded with the summary and the
// recent verbatim turns. No respawn, no adopt, no exit — the tmux pane and
// the PTY are untouched, so nothing in the app hears about it. The node's
// stored claudeSessionId keeps pointing at the dead file, SessionTurnSync
// reconciles a file that never grows again, and turns/checkpoints silently
// stop recording while the PTY scrape still looks perfectly alive.
//
// WHAT THE EVIDENCE SAYS (probed on the confirmed Conductor rotation,
// claude 2.1.222, old dfa97c83 → live 32c018ac):
//
//  * The PREDECESSOR says nothing. Its last record is an ordinary
//    `system/turn_duration` — no session-end, no forward pointer, no
//    trailer. A file that rotated and a file whose agent is simply thinking
//    are byte-identical. Staleness alone can therefore never be the proof.
//  * The SUCCESSOR carries the whole provenance, in its head:
//      {type:'system', subtype:'compact_boundary', parentUuid:null,
//       logicalParentUuid:<uuid in the old file>, compactMetadata:{...}}
//      {type:'user', isCompactSummary:true,
//       sessionId:<NEW id>, session_id:<OLD id>, cwd:<the terminal's cwd>}
//    That `session_id`/`sessionId` disagreement IS the predecessor→successor
//    edge, written by claude itself, durable on disk, and readable long after
//    the rotation. It is the only deterministic signal available.
//  * lsof CANNOT be used here (the codex `resolveCodexRolloutByPid` recipe
//    does not port): claude appends open→write→close. Probed live, neither
//    the pane client nor the daemon-spawned session process holds ANY fd
//    under ~/.claude/projects. There is no open file to resolve.
//
// So detection is: notice the bound file went quiet (session-sync, in BYTES),
// then ask the directory whether some other file claims to continue it.
//
// REFUSAL IS THE DEFAULT. A silently wrong file is far worse than an
// honestly stale one, so every doubt returns null: no claimant, two
// claimants for one predecessor, a claimant already owned by another node, a
// cwd that disagrees, a cycle, or a chain longer than we are willing to
// prove. Note in particular that the app's OWN native forks (forkClaudeSession
// copies a session under a fresh id and rewrites `sessionId` but not
// `session_id`) can look like a claimant; they are excluded by being owned by
// the fork's node, by the two-claimants rule when they are not, and by the
// liveness filter below.

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { claudeProjectDir, isSessionUuid, realCwd } from './claude-fork'

/** Head window per candidate file, in bytes and in lines (first hit wins). */
export const ROTATION_HEAD_BYTES = 1024 * 1024
export const ROTATION_HEAD_LINES = 24
/**
 * Newest candidate files a single probe will open. NOT a silent truncation:
 * candidates are ordered by mtime and the live successor is by definition
 * among the most recently written files in the directory, so the cap can only
 * hide an OLD intermediate hop of a multi-rotation chain. That costs
 * completeness, never correctness — the walk then ends one hop early, the
 * rebind lands on a proven segment, and the next probe (which starts from
 * there) follows the rest.
 */
export const ROTATION_CANDIDATE_CAP = 16
/**
 * How much OLDER than the stale file a candidate may be and still count as
 * live. The successor of a rotation keeps being written while the
 * predecessor is frozen, so it is never meaningfully older — but the
 * predecessor's mtime can jump without its size moving (`claude --resume`
 * touches the file it opens), so the comparison needs slack in both
 * directions rather than a strict ordering.
 */
export const ROTATION_MTIME_SLACK_MS = 300_000
/** Rotations followed in one probe (the app can be blind across several). */
export const ROTATION_MAX_HOPS = 8

/**
 * Cheap prefilter. Session-file heads routinely carry 100KB+
 * `file-history-snapshot` lines; only a boundary or a continuation summary
 * can possibly be a rotation marker, and both name compaction explicitly.
 */
const ROTATION_MARKER_RE = /"(?:isCompactSummary|compactMetadata)"|compact_boundary/

/** A predecessor→successor rotation edge, as one session file declares it. */
export interface RotationEdge {
  /** The successor's own session id (its records' `sessionId`). */
  sessionId: string
  /** The session it CONTINUES — the id that just went stale. */
  predecessorId: string
  /** cwd stamped on the continuation record, when it carries one. */
  cwd: string | null
}

interface HeadRecord {
  type?: string
  subtype?: string
  isCompactSummary?: boolean
  sessionId?: string
  session_id?: string
  cwd?: string
}

/**
 * The rotation edge a session file's HEAD declares, or null.
 *
 * Requires BOTH halves of the pair claude writes — a `compact_boundary`
 * system record, then a continuation summary whose `session_id` names a
 * DIFFERENT, UUID-shaped session than the file's own. An in-file compaction
 * (same session compacted in place) writes the same pair with both ids
 * equal, and correctly yields null: nothing rotated, nothing to rebind.
 */
export function rotationEdgeOf(headLines: readonly string[]): RotationEdge | null {
  let sawBoundary = false
  for (const line of headLines) {
    if (!ROTATION_MARKER_RE.test(line)) continue
    let record: HeadRecord
    try {
      record = JSON.parse(line) as HeadRecord
    } catch {
      continue
    }
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      sawBoundary = true
      continue
    }
    if (record.isCompactSummary !== true) continue
    // The summary without its boundary is not a rotation head — it is a
    // fragment (a truncated copy, a hand-edited file). Refuse to read it.
    if (!sawBoundary) return null
    const own = record.sessionId
    const predecessor = record.session_id
    if (typeof own !== 'string' || typeof predecessor !== 'string') return null
    if (!isSessionUuid(own) || !isSessionUuid(predecessor) || own === predecessor) return null
    return {
      sessionId: own,
      predecessorId: predecessor,
      cwd: typeof record.cwd === 'string' ? record.cwd : null
    }
  }
  return null
}

/** One session file as the scan sees it, before its head is read. */
export interface SessionFileEntry {
  file: string
  sessionId: string
  mtimeMs: number
  size: number
}

/** Filesystem access, injected so the scan is testable without a real dir. */
export interface RotationFs {
  listSessions(dir: string): SessionFileEntry[]
  readHead(file: string): string[]
}

export interface RotationScanOptions {
  /** The terminal's working directory (selects the project dir). */
  cwd: string
  /** The session id currently bound to the node — the one that went quiet. */
  sessionId: string
  /**
   * Session ids owned by OTHER nodes, current bindings AND lineage. A session
   * another node holds is never adoptable: stealing it would cross-wire two
   * agents onto one conversation (the 1:1 rule the codex/pi binds keep).
   */
  claimed?: ReadonlySet<string>
  /** Override for tests; defaults to ~/.claude/projects. */
  projectsDir?: string
  fs?: RotationFs
}

/**
 * The chain of successors the bound session rotated through, oldest hop
 * first, or null when nothing can be proven.
 *
 * A chain rather than a single id because the app can be blind across
 * several rotations (a long detach, a workspace parked for a day), and each
 * hop is a real segment of the agent's history that the rail is entitled to
 * keep. The caller folds it through withSessionLineage hop by hop.
 *
 * Null — deliberately, on every doubt:
 *   - no file claims to continue this session (the ordinary case: it is
 *     merely quiet, so stay bound and stay honest)
 *   - TWO files claim the same predecessor (a fork copy alongside the real
 *     successor, a resumed-twice session): unprovable, so refuse
 *   - the claimant is already owned by another node
 *   - the claimant's stamped cwd is not this terminal's
 *   - the chain loops, or runs past ROTATION_MAX_HOPS without ending
 */
export function resolveRotationChain(options: RotationScanOptions): string[] | null {
  const fs = options.fs ?? defaultRotationFs
  if (!isSessionUuid(options.sessionId)) return null
  const dir = claudeProjectDir(options.cwd, options.projectsDir)
  const here = realCwd(options.cwd)

  const entries = fs.listSessions(dir)
  const stale = entries.find((entry) => entry.sessionId === options.sessionId)
  // No stale file at all means there is no rotation to follow — a missing
  // binding is a different repair (resolveClaudeSessionId owns that one).
  if (!stale) return null

  const candidates = entries
    .filter(
      (entry) =>
        entry.sessionId !== options.sessionId &&
        entry.size > 0 &&
        entry.mtimeMs + ROTATION_MTIME_SLACK_MS >= stale.mtimeMs
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, ROTATION_CANDIDATE_CAP)

  // predecessor id → successor ids claiming it.
  const claimants = new Map<string, string[]>()
  for (const candidate of candidates) {
    const edge = rotationEdgeOf(fs.readHead(candidate.file))
    if (edge === null) continue
    // The file's name is its identity; a head that disagrees with it has been
    // copied or rewritten, and is not evidence of anything.
    if (edge.sessionId !== candidate.sessionId) continue
    if (edge.cwd !== null && realCwd(edge.cwd) !== here) continue
    claimants.set(edge.predecessorId, [...(claimants.get(edge.predecessorId) ?? []), edge.sessionId])
  }

  const chain: string[] = []
  const visited = new Set<string>([options.sessionId])
  let current = options.sessionId
  while (chain.length <= ROTATION_MAX_HOPS) {
    const next = claimants.get(current) ?? []
    if (next.length === 0) return chain.length > 0 ? chain : null
    if (next.length > 1) return null // ambiguous — never guess which is live
    const successor = next[0]
    // Unreachable by construction (the bound file is never its own candidate,
    // and a file declares exactly one predecessor) — kept because a walk that
    // could loop on malformed input is worse than a redundant check.
    if (visited.has(successor)) return null
    if (options.claimed?.has(successor)) return null // another node owns it
    visited.add(successor)
    chain.push(successor)
    current = successor
  }
  // Ran past the hop cap without reaching the end of the chain: we cannot say
  // which file is live, so we say nothing.
  return null
}

/**
 * Complete lines from the head of a file, byte- and line-capped. Exported so
 * the real-corpus tests read heads exactly the way the scan does — a head
 * reader that quietly stopped short would otherwise pass its own test.
 */
export function readHeadLines(file: string): string[] {
  try {
    const fd = openSync(file, 'r')
    try {
      const chunks: Buffer[] = []
      let read = 0
      let lineCount = 0
      const buffer = Buffer.alloc(64 * 1024)
      while (read < ROTATION_HEAD_BYTES) {
        const bytes = readSync(fd, buffer, 0, buffer.length, read)
        if (bytes === 0) break
        const chunk = Buffer.from(buffer.subarray(0, bytes))
        chunks.push(chunk)
        read += bytes
        // Counted per chunk, never re-scanned: session heads are hundreds of
        // KB and this runs over every candidate on every probe.
        lineCount += countNewlines(chunk)
        if (lineCount >= ROTATION_HEAD_LINES) break
      }
      // Drop the trailing element: it is a partial line whenever we stopped
      // on a cap rather than at EOF, and an empty string when we stopped at a
      // final newline. Either way it is not a complete record.
      const lines = Buffer.concat(chunks).toString('utf8').split('\n')
      return lines.slice(0, Math.min(lines.length - 1, ROTATION_HEAD_LINES))
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
}

function countNewlines(chunk: Buffer): number {
  let count = 0
  let at = chunk.indexOf(0x0a)
  while (at !== -1) {
    count += 1
    at = chunk.indexOf(0x0a, at + 1)
  }
  return count
}

const defaultRotationFs: RotationFs = {
  listSessions(dir) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    return names.flatMap((name) => {
      if (!name.endsWith('.jsonl')) return []
      const sessionId = name.slice(0, -'.jsonl'.length)
      if (!isSessionUuid(sessionId)) return []
      const file = path.join(dir, name)
      try {
        const stat = statSync(file)
        return stat.isFile() ? [{ file, sessionId, mtimeMs: stat.mtimeMs, size: stat.size }] : []
      } catch {
        return []
      }
    })
  },
  readHead: readHeadLines
}
