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
// THE PROBE IS ASYNCHRONOUS, THE COMMIT IS NOT. Reading up to
// ROTATION_CANDIDATE_CAP heads of ROTATION_HEAD_BYTES each is up to ~64MB of
// file I/O in the worst case (the line cap usually ends a read far earlier;
// see ROTATION_HEAD_BYTES), and this runs on the Electron MAIN thread — the one that also
// serves every IPC call, every PTY write and the window's own compositing. So
// every byte here goes through node:fs/promises (libuv's threadpool, with a
// real yield point at each await), while the decision it feeds is committed
// synchronously in one JS turn. See `rotationCommitVerdict` below for what
// that split costs and how the cost is paid.
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

import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { claudeProjectDir, continuedInOf, isSessionUuid, realCwd } from './claude-fork'

/**
 * Head window per candidate file, in bytes and in lines (first hit wins).
 *
 * 4 MB, not 1: a long-lived session's head is mostly `file-history-snapshot`
 * records, and on a rotated conversation they run past a megabyte before the
 * first message. Measured 2026-09-05 across the sixteen newest files of this
 * project: the eighth message record (ROTATION_RESUME_MIN_UUIDS) sat at
 * 1.5–1.9 MB in every file that had ever rotated, and at 50–850 KB in the
 * rest. A 1 MB window saw ZERO uuids in the live successor and the scan
 * refused with nothing to refuse on. The line cap still ends the read early
 * on ordinary heads, so the extra budget is only spent where it is needed.
 */
export const ROTATION_HEAD_BYTES = 4 * 1024 * 1024
export const ROTATION_HEAD_LINES = 24
/**
 * Head window for the REPLAY shape, which needs conversation records rather
 * than a marker in the first few lines. A resume replays the transcript from
 * the beginning, so the evidence is a prefix — but it sits behind whatever
 * metadata records the new process writes first, and one exchange can be many
 * records. 200 lines is far more than the threshold needs and still one
 * bounded read per file.
 */
export const ROTATION_RESUME_HEAD_LINES = 200
/**
 * How many replayed message uuids must be seen before the shape is allowed to
 * decide anything. A handful of shared uuids is a coincidence budget nobody
 * should spend a rebind on; this is the floor under the ratio below.
 */
export const ROTATION_RESUME_MIN_UUIDS = 8
/**
 * Share of the candidate's head message uuids that must already exist in the
 * bound file. Not 1.0: the successor's head can hold its own first new records
 * once the replay ends, and a strict equality would refuse a real rotation for
 * being one exchange further along. Measured live, the replay is verbatim
 * (375/375), so the slack is headroom, not a fudge.
 */
export const ROTATION_RESUME_MIN_OVERLAP = 0.9
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
 * Candidate heads read at once. libuv's default threadpool is 4 threads and it
 * is SHARED with every other async fs user in main; firing all sixteen reads
 * together would hand the pool to a background probe and make the work that
 * users can feel queue behind it. Four keeps the probe one job deep per thread
 * and still finishes the scan in a quarter of the sequential wall time.
 */
export const ROTATION_READ_CONCURRENCY = 4

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

/**
 * The moment a head's compaction pair was written — the summary's timestamp.
 *
 * A resume REPLAYS the predecessor verbatim, and the replay includes the
 * predecessor's own compaction pair with only `sessionId` rewritten to the
 * new file (measured on f16cf111, 2026-09-05: lines 19–20 are 5a4cdb91's
 * boundary and summary, same timestamps to the millisecond, naming
 * 5a4cdb91's predecessor). Read as a declaration, that pair says the new
 * file continues the GRANDPARENT, and the real edge is missed. The stamp is
 * how an inherited pair is told from an own one: claude never writes two
 * compactions at the same millisecond, so equal stamps mean the same event.
 */
export function compactStampOf(headLines: readonly string[]): string | null {
  for (const line of headLines) {
    if (!ROTATION_MARKER_RE.test(line)) continue
    try {
      const record = JSON.parse(line) as HeadRecord & { timestamp?: unknown }
      if (record.isCompactSummary === true) {
        return typeof record.timestamp === 'string' ? record.timestamp : null
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Does `candidateHead` carry the SAME compaction pair `predecessorHead` does —
 * inherited by replay rather than declared by its own compaction? True only
 * when both declare an edge to the same session at the same stamp.
 */
export function inheritsCompactionOf(
  candidateHead: readonly string[],
  predecessorHead: readonly string[]
): boolean {
  const own = rotationEdgeOf(candidateHead)
  const inherited = rotationEdgeOf(predecessorHead)
  if (!own || !inherited) return false
  if (own.predecessorId !== inherited.predecessorId) return false
  const stamp = compactStampOf(candidateHead)
  return stamp !== null && stamp === compactStampOf(predecessorHead)
}

/**
 * THE SECOND PROVENANCE SHAPE: a RESUME rotation.
 *
 * A compaction announces itself. A crash recovery does not. `claude --resume`
 * mints a NEW session id and writes NO compact_boundary and NO
 * isCompactSummary — verified live on Conductor tonight (bound 32c018ac went
 * stale at T39, live f8cf0774, whose head is ai-title / agent-name / mode
 * records and nothing else). Every crash-recovery rotation was therefore
 * invisible to the shape above, which is most of them.
 *
 * What a resume DOES leave is a replay: the successor rewrites the
 * predecessor's message records verbatim, keeping their ORIGINAL uuids
 * (measured: all 375 of the successor's head uuids exist in the predecessor,
 * 375/375). That is the edge — not declared, but inherited, and just as
 * durable on disk.
 *
 * Why this cannot be read like the compact shape: the replayed records also
 * carry the PREDECESSOR's `sessionId`, because they are its records. The
 * successor's identity is its FILE NAME and nothing else, so the
 * head-agrees-with-name check that guards the compact shape is inverted here
 * and must not be applied.
 *
 * Why a fresh session cannot collide: uuids are v4 and the records are the
 * predecessor's own, so an unrelated conversation shares exactly zero. A false
 * positive needs a genuine uuid collision, not a coincidence of shape.
 */
export function headMessageUuids(headLines: readonly string[]): string[] {
  const uuids: string[] = []
  for (const line of headLines) {
    let record: ReplayRecord
    try {
      record = JSON.parse(line) as ReplayRecord
    } catch {
      continue
    }
    // Conversation records only. Metadata the new process writes for itself
    // (ai-title, agent-name, mode) is not replayed and would only dilute the
    // ratio with ids the predecessor could never have.
    if (record.type !== 'user' && record.type !== 'assistant') continue
    if (typeof record.uuid === 'string' && isSessionUuid(record.uuid)) uuids.push(record.uuid)
  }
  return uuids
}

/** The cwd a replayed head stamps, or null when it carries none. */
export function headCwd(headLines: readonly string[]): string | null {
  for (const line of headLines) {
    try {
      const record = JSON.parse(line) as ReplayRecord
      if (typeof record.cwd === 'string' && record.cwd.length > 0) return record.cwd
    } catch {
      continue
    }
  }
  return null
}

/** How much of a candidate's head the bound file already contains. */
export interface ReplayOverlap {
  /** Candidate head message uuids seen. */
  total: number
  /** How many of them the predecessor already had. */
  shared: number
  ratio: number
}

export function replayOverlap(
  candidateUuids: readonly string[],
  predecessorUuids: ReadonlySet<string>
): ReplayOverlap {
  const shared = candidateUuids.reduce(
    (count, uuid) => (predecessorUuids.has(uuid) ? count + 1 : count),
    0
  )
  return {
    total: candidateUuids.length,
    shared,
    ratio: candidateUuids.length === 0 ? 0 : shared / candidateUuids.length
  }
}

/** Does this overlap clear BOTH bars — enough evidence, and enough of it? */
export function isReplayContinuation(overlap: ReplayOverlap): boolean {
  return overlap.total >= ROTATION_RESUME_MIN_UUIDS && overlap.ratio >= ROTATION_RESUME_MIN_OVERLAP
}

interface ReplayRecord {
  type?: string
  uuid?: string
  cwd?: string
}

/** One session file as the scan sees it, before its head is read. */
export interface SessionFileEntry {
  file: string
  sessionId: string
  mtimeMs: number
  size: number
}

/**
 * Filesystem access, injected so the scan is testable without a real dir.
 * Asynchronous by contract, not by convenience: the real implementation must
 * be free to keep its bytes off the main thread, so no caller may assume a
 * head is available without yielding.
 */
export interface RotationFs {
  listSessions(dir: string): Promise<SessionFileEntry[]>
  /**
   * Complete lines from the head of a file. `maxLines` widens the window for
   * the replay shape, which needs conversation records rather than a marker;
   * an implementation that ignores it still works for the compact shape, so
   * existing fakes keep passing.
   */
  readHead(file: string, maxLines?: number): Promise<string[]>
  /**
   * Complete lines from the TAIL of a file, where claude appends its own
   * `continued-in` marker. Optional so existing fakes keep passing; without
   * it the scan has only the heuristic shapes.
   */
  readTail?(file: string, maxBytes?: number): Promise<string[]>
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
   *
   * Read BEFORE the scan's I/O, so this set is a cheap early refusal and NOT
   * the authority: by the time a chain comes back, another node may have taken
   * one of its hops. The authority is `rotationCommitVerdict`, re-reading the
   * store after the last await.
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
export async function resolveRotationChain(
  options: RotationScanOptions
): Promise<string[] | null> {
  const fs = options.fs ?? defaultRotationFs
  if (!isSessionUuid(options.sessionId)) return null
  // Path derivation only — one realpath on a directory the app already has
  // open, not the megabytes this probe exists to move off the main thread.
  const dir = claudeProjectDir(options.cwd, options.projectsDir)
  const here = realCwd(options.cwd)

  const entries = await fs.listSessions(dir)
  const stale = entries.find((entry) => entry.sessionId === options.sessionId)
  if (!stale) return null

  // CLAUDE'S OWN STATEMENT FIRST. A `continued-in` marker at the tail of the
  // bound file names the successor outright, and it is the one shape the
  // heuristics below cannot see: a continuation file is created at the
  // compaction, hours before the switch, with a head that names nothing —
  // so it is neither newer than the stale file nor a declared successor.
  if (fs.readTail) {
    const byId = new Map(entries.map((entry) => [entry.sessionId, entry]))
    const declared: string[] = []
    const seen = new Set<string>([options.sessionId])
    let at: SessionFileEntry | undefined = stale
    while (at && declared.length <= ROTATION_MAX_HOPS) {
      const next = continuedInOf(await fs.readTail(at.file))
      if (!next || seen.has(next)) break
      const file = byId.get(next)
      if (!file) break
      if (options.claimed?.has(next)) return null // another node owns it
      seen.add(next)
      declared.push(next)
      at = file
    }
    if (declared.length > 0) return declared
  }
  // No stale file at all means there is no rotation to follow — a missing
  // binding is a different repair (resolveClaudeSessionId owns that one).
  const candidates = entries
    .filter(
      (entry) =>
        entry.sessionId !== options.sessionId &&
        entry.size > 0 &&
        entry.mtimeMs + ROTATION_MTIME_SLACK_MS >= stale.mtimeMs
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, ROTATION_CANDIDATE_CAP)

  // EVERY candidate is read, ambiguity being the whole point: a predecessor
  // with two claimants is only knowable once both heads have been seen, so
  // there is no early exit to be had here — only a cap on how many of these
  // reads are in flight at once.
  //
  // ONE read per candidate, at the wider window, and BOTH shapes are derived
  // from it. The compact marker lives in the first lines either way, so the
  // wide read costs no extra opens and no extra bytes (ROTATION_HEAD_BYTES
  // still binds first on the big heads) — while a second narrow pass would
  // have doubled the opens for every probe that falls through to the replay.
  const heads = new Map<string, string[]>()
  const declaredEdges = await readEdgesBounded(fs, candidates, heads)

  // AN INHERITED PAIR DECLARES NOTHING. The bound file's own head is read once
  // here (the replay scan would read it anyway) so a candidate whose
  // compaction pair is the bound file's pair — same predecessor, same stamp —
  // is judged as a replay of the bound file, not as a declared successor of
  // its grandparent. Without this, the real successor of a rotated session was
  // excluded from the replay scan for "declaring" an edge it merely copied.
  //
  // Read LAZILY: an inherited pair can only name a session other than the
  // bound one (the bound file's pair names its own predecessor), so the extra
  // head is paid for only when some candidate declares such an edge. A fleet
  // whose rotations all declare the bound session pays nothing here.
  const suspect = declaredEdges.some(
    ({ edge }) => edge !== null && edge.predecessorId !== options.sessionId
  )
  const staleHead = suspect ? await fs.readHead(stale.file, ROTATION_RESUME_HEAD_LINES) : null
  if (staleHead) heads.set(stale.file, staleHead)
  const edges = declaredEdges.map(({ candidate, edge }) =>
    edge !== null &&
    staleHead !== null &&
    inheritsCompactionOf(heads.get(candidate.file) ?? [], staleHead)
      ? { candidate, edge: null }
      : { candidate, edge }
  )

  // predecessor id → successor ids claiming it.
  const claimants = new Map<string, string[]>()
  for (const { candidate, edge } of edges) {
    if (edge === null) continue
    // The file's name is its identity; a head that disagrees with it has been
    // copied or rewritten, and is not evidence of anything.
    if (edge.sessionId !== candidate.sessionId) continue
    if (edge.cwd !== null && realCwd(edge.cwd) !== here) continue
    claimants.set(edge.predecessorId, [...(claimants.get(edge.predecessorId) ?? []), edge.sessionId])
  }

  // Files that NAME their predecessor are judged by that name alone. Letting
  // one also match on replay would let a compaction successor of session X be
  // adopted as the resume successor of session Y purely because both share the
  // records X replayed.
  const declaring = new Set(
    edges.flatMap(({ candidate, edge }) => (edge === null ? [] : [candidate.sessionId]))
  )
  const replay = new ReplayScan(fs, entries, candidates, declaring, here, heads)

  const chain: string[] = []
  const visited = new Set<string>([options.sessionId])
  let current = options.sessionId
  while (chain.length <= ROTATION_MAX_HOPS) {
    const next = claimants.get(current) ?? []
    if (next.length > 1) return null // ambiguous — never guess which is live
    // The declared shape wins wherever it speaks: it is claude's own statement
    // of the edge, while a replay is an inference from inherited ids.
    const successor = next[0] ?? (await replay.successorOf(current))
    if (!successor) return chain.length > 0 ? chain : null
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

interface CandidateEdge {
  candidate: SessionFileEntry
  edge: RotationEdge | null
}

/**
 * The replay shape, resolved lazily and memoised per file.
 *
 * Lazy because it is the fallback: a fleet where every rotation is a
 * compaction must not pay for these wider reads at all. Memoised because the
 * walk revisits files — each hop's predecessor was some earlier hop's
 * candidate — and a head is worth reading once per probe.
 *
 * Refuses exactly what the declared shape refuses: no claimant, TWO claimants
 * (a resumed-twice session leaves two files replaying the same records, and
 * which one the pane is actually driving is not knowable from disk), and a
 * stamped cwd that is not this terminal's.
 */
class ReplayScan {
  constructor(
    private readonly fs: RotationFs,
    private readonly entries: readonly SessionFileEntry[],
    private readonly candidates: readonly SessionFileEntry[],
    private readonly declaring: ReadonlySet<string>,
    private readonly here: string,
    /**
     * Heads the edge pass already read, keyed by file. Every candidate is in
     * here; the only file this scan ever opens for itself is the predecessor,
     * which is not a candidate for its own successor.
     */
    private readonly heads: Map<string, string[]>
  ) {}

  /** The one candidate replaying `predecessorId`'s records, or null. */
  async successorOf(predecessorId: string): Promise<string | null> {
    const predecessor = this.entries.find((entry) => entry.sessionId === predecessorId)
    if (!predecessor) return null
    const known = new Set(await this.headUuidsOf(predecessor))
    if (known.size < ROTATION_RESUME_MIN_UUIDS) return null

    const matches: string[] = []
    for (const candidate of this.candidates) {
      if (candidate.sessionId === predecessorId) continue
      if (this.declaring.has(candidate.sessionId)) continue
      if (candidate.mtimeMs <= predecessor.mtimeMs) continue
      // Operand order is the proof's direction (Sol round-2 P0): the CANDIDATE
      // head is the numerator/denominator — every replayed record it opens
      // with must already exist in the predecessor. Reversed, a candidate
      // holding the predecessor's records PLUS unrelated history scores 1.0
      // (false rebind onto a stranger), while a short-but-genuine subset
      // replay of a long predecessor scores shared/|predecessor| (false
      // refusal). replayOverlap's own contract: (candidateUuids, predecessorSet).
      const overlap = replayOverlap(await this.headUuidsOf(candidate), known)
      if (!isReplayContinuation(overlap)) continue
      const cwd = await this.cwdOf(candidate)
      if (cwd !== null && realCwd(cwd) !== this.here) continue
      matches.push(candidate.sessionId)
      if (matches.length > 1) return null // two replays — unprovable
    }
    return matches[0] ?? null
  }

  private async headUuidsOf(entry: SessionFileEntry): Promise<string[]> {
    return headMessageUuids(await this.head(entry))
  }

  private async cwdOf(entry: SessionFileEntry): Promise<string | null> {
    return headCwd(await this.head(entry))
  }

  private async head(entry: SessionFileEntry): Promise<string[]> {
    const cached = this.heads.get(entry.file)
    if (cached) return cached
    const head = await this.fs.readHead(entry.file, ROTATION_RESUME_HEAD_LINES)
    this.heads.set(entry.file, head)
    return head
  }
}

/** Every candidate's declared edge, in candidate order; heads kept for reuse. */
async function readEdgesBounded(
  fs: RotationFs,
  candidates: readonly SessionFileEntry[],
  heads: Map<string, string[]>
): Promise<CandidateEdge[]> {
  return mapBounded(candidates, async (candidate) => {
    const head = await fs.readHead(candidate.file, ROTATION_RESUME_HEAD_LINES)
    heads.set(candidate.file, head)
    return { candidate, edge: rotationEdgeOf(head) }
  })
}

/**
 * `Promise.all` with a ceiling on how many jobs are in flight, in input order.
 * Chunked rather than a rolling window: the jobs here are same-shaped (one
 * capped head, one stat), so chunks finish within a hair of each other and the
 * extra machinery would buy nothing.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  job: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  for (let at = 0; at < items.length; at += ROTATION_READ_CONCURRENCY) {
    results.push(...(await Promise.all(items.slice(at, at + ROTATION_READ_CONCURRENCY).map(job))))
  }
  return results
}

/** Why a proven chain may still not be committed. */
export type RotationCommitVerdict = 'commit' | 'empty-chain' | 'binding-moved' | 'claimed'

export interface RotationCommitCheck {
  /** The binding the probe was started FROM (read before its first await). */
  boundBefore: string
  /** The binding the store reports NOW, after the probe's last await. */
  boundNow: string | null | undefined
  /** The chain the probe proved, oldest hop first. */
  chain: readonly string[]
  /** Sessions owned by other nodes, re-read NOW: bindings AND lineage. */
  claimed: ReadonlySet<string>
}

/**
 * THE SYNCHRONOUS-COMMIT INVARIANT — the price of moving the scan off-thread.
 *
 * While the probe's bytes were on the threadpool, the main thread kept
 * running: another terminal's own probe could have committed, a node could
 * have been recovered, forked, killed or rebound by hand. So a chain proven at
 * T is a statement about the DIRECTORY at T, never about the STORE at T+1, and
 * committing it blind would resurrect exactly the cross-wiring the 1:1 rule
 * exists to prevent — two rails on one conversation, which no later probe can
 * detect and no user can see.
 *
 * The invariant, therefore: the caller re-reads the store AFTER the last await
 * and passes what it read here, then applies the patch in the SAME JS turn as
 * this verdict — no await between them. Because the store is only ever mutated
 * from the main thread, that turn is atomic with respect to every other writer,
 * and this becomes the whole of the race window.
 *
 * Refused when:
 *   - the chain is empty (nothing to bind to — the scan already says null)
 *   - the binding MOVED under the probe: the node no longer sits on the
 *     session we asked about, so the answer is about a conversation this
 *     terminal has left. Dropped, not re-aimed — the next quiet window
 *     re-probes from wherever the node actually is.
 *   - any hop is now claimed by another node. Every hop, not just the last:
 *     the whole chain lands on this node's lineage, and an earlier segment
 *     belonging to a peer is as much a cross-wire as its live binding is.
 *     This is strictly stronger than the pre-scan `claimed` prefilter and
 *     strictly stronger than a last-hop `isRefOwned` check.
 */
export function rotationCommitVerdict(check: RotationCommitCheck): RotationCommitVerdict {
  if (check.chain.length === 0) return 'empty-chain'
  if (check.boundNow !== check.boundBefore) return 'binding-moved'
  if (check.chain.some((hop) => check.claimed.has(hop))) return 'claimed'
  return 'commit'
}

/**
 * Complete lines from the head of a file, byte- and line-capped. Exported so
 * the real-corpus tests read heads exactly the way the scan does — a head
 * reader that quietly stopped short would otherwise pass its own test.
 */
export async function readHeadLines(
  file: string,
  maxLines: number = ROTATION_HEAD_LINES
): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, 'r')
  } catch {
    return []
  }
  try {
    const chunks: Buffer[] = []
    let read = 0
    let lineCount = 0
    const lineCap = Math.max(1, maxLines)
    // One buffer for the whole read: the awaits below are sequential, so no
    // second read can be filling it while this chunk is being copied out.
    const buffer = Buffer.alloc(64 * 1024)
    while (read < ROTATION_HEAD_BYTES) {
      // Each await is a yield point — the 64KB is copied by a threadpool
      // thread and the main thread is free until it lands.
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, read)
      if (bytesRead === 0) break
      const chunk = Buffer.from(buffer.subarray(0, bytesRead))
      chunks.push(chunk)
      read += bytesRead
      // Counted per chunk, never re-scanned: session heads are hundreds of
      // KB and this runs over every candidate on every probe.
      lineCount += countNewlines(chunk)
      if (lineCount >= lineCap) break
    }
    // Drop the trailing element: it is a partial line whenever we stopped
    // on a cap rather than at EOF, and an empty string when we stopped at a
    // final newline. Either way it is not a complete record.
    const lines = Buffer.concat(chunks).toString('utf8').split('\n')
    return lines.slice(0, Math.min(lines.length - 1, lineCap))
  } catch {
    return []
  } finally {
    await handle.close().catch(() => undefined)
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
  async listSessions(dir) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    // Names are filtered BEFORE any stat: a project dir holds one file per
    // session, and statting the non-sessions among them would be threadpool
    // work spent on files this scan can never use.
    const sessions = names.flatMap((name) => {
      if (!name.endsWith('.jsonl')) return []
      const sessionId = name.slice(0, -'.jsonl'.length)
      return isSessionUuid(sessionId) ? [{ file: path.join(dir, name), sessionId }] : []
    })
    const entries = await mapBounded(sessions, async ({ file, sessionId }) => {
      try {
        const info = await stat(file)
        return info.isFile() ? [{ file, sessionId, mtimeMs: info.mtimeMs, size: info.size }] : []
      } catch {
        return []
      }
    })
    return entries.flat()
  },
  readHead: (file, maxLines) => readHeadLines(file, maxLines),
  readTail: (file, maxBytes) => readTailLines(file, maxBytes ?? 16 * 1024 * 1024)
}

/**
 * Lines from the tail of a file that hold a continuation marker, searching
 * backwards in chunks and stopping at the first chunk that has one — a file
 * resumed after its marker carries a stray branch past it (520 KB on the
 * day this was written), so the last few KB are not enough.
 */
export async function readTailLines(file: string, maxBytes: number): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(file, 'r')
    const size = (await handle.stat()).size
    const floor = Math.max(0, size - maxBytes)
    const chunk = 256 * 1024
    let end = size
    let carry = ''
    while (end > floor) {
      const start = Math.max(floor, end - chunk)
      const buffer = Buffer.alloc(end - start)
      await handle.read(buffer, 0, end - start, start)
      const lines = (buffer.toString('utf8') + carry).split('\n')
      carry = start > floor ? (lines.shift() ?? '') : ''
      const whole = lines.filter((line) => line.length > 0)
      if (whole.some((line) => line.includes('"continued-in"'))) return whole
      end = start
    }
    return []
  } catch {
    return []
  } finally {
    await handle?.close()
  }
}
