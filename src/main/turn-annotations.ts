// Cookrew's own per-checkpoint annotations, stored apart from the conversation.
//
// WHY A SEPARATE FILE
// -------------------
// A checkpoint is one identity (see docs/design/checkpoint-as-identity.html).
// The conversation belongs to the harness session file; the ledger under
// turns/ keeps a copy of it so search is a 65 ms scan instead of a two-gigabyte
// one, and that copy is derived — delete it and it can be rebuilt. Title,
// seenAt and scrollLine are NOT derivable from anything: they are read state
// and recaps that only Cookrew ever had. Mixing them into a derived index means
// the index cannot actually be treated as disposable.
//
// SNAPSHOT + OP LOG, NOT A WHOLE-FILE REWRITE
// -------------------------------------------
// The turns ledger is append-friendly because a finished turn is a new line.
// Annotations mutate EXISTING checkpoints: `seenAt` stamps one when the user
// looks at it, and a Sous title lands seconds after the turn it describes was
// already written. The previous shape — one sorted JSON object rewritten whole
// on any change — made every stamp enumerate, sort and serialize the COMPLETE
// map, however many checkpoints the agent had (Sol r6 P1). So each agent now
// has two files:
//
//   <id>.json        the compacted snapshot — the same sorted object as before
//   <id>.log.jsonl   the op log: one line per changed checkpoint;
//                    {"i":5,"a":{…}} sets, {"i":5} clears, later lines win
//
// The hot path (`update`) appends exactly the ops that changed — O(changed)
// bytes, like the conversation append. Reads replay snapshot then log. The log
// stays bounded the way the dispatch registry does: once its line count reaches
// the live annotation count (with a floor, ANNOTATION_LOG_COMPACT_MIN_OPS), at
// least half of what is on disk is replay weight, and the log is folded into a
// fresh snapshot via temp+fsync+rename. `save` stays the full-rebuild /
// compaction path for the operations that legitimately touch everything
// (reset, shrink, rewind, migration).
//
// EPOCHS: SNAPSHOT AND LOG SHARE A GENERATION (Sol r7 P1)
// -------------------------------------------------------
// Snapshot and log are two files, and no rename covers both — so a crash
// between "new snapshot renamed" and "old log unlinked" used to leave a NEWER
// snapshot with an OLDER log replaying over it, rolling a full save's
// title/read/scroll state backward on the next boot. The two files now share
// a generation: the snapshot envelope carries {epoch}, every op line carries
// {e: epoch}, and replay applies ONLY ops whose epoch matches the snapshot it
// replays over. A full save writes epoch+1, so surviving stale ops are inert
// the moment the rename lands — the unlink is mere byte reclamation and is
// best-effort (retried by the next compaction). A missing snapshot reads as
// epoch 0, which is also what log-only agents write. An EMPTY save publishes
// an epoch-bumped empty snapshot through the same atomic path (Sol r9 P2)
// rather than unlinking: unlinks return before the directory entries are
// durable, and a crash after them could resurrect both old files whole.
// Legacy files — bare-map snapshots, ops without `e` — both read as epoch 0
// and stay mutually consistent.
//
// FAIL-CLOSED (Sol r6 P1)
// -----------------------
// Both writers report success, and the in-memory picture is published ONLY
// when the bytes landed. A failed write retains the exact un-landed work — the
// ops for the incremental path, the whole rebuilt map for the full path — and
// the next save/update retries it. Before this, state was mutated first and
// persist swallowed its errors, so a failed write was remembered as saved:
// replaying the same annotation found no difference in memory and wrote
// nothing, silently losing it until some unrelated later change.
//
// THIS DIRECTORY IS NOT DERIVED AND IS NOT SAFE TO DELETE.
// ---------------------------------------------------------
// It is the sibling of turns/, not a child of it, and that is deliberate. Step 3
// of the design makes the ledger genuinely rebuildable and says so out loud —
// and "safe to delete" is an instruction someone will eventually follow against
// ~/.cookrew/turns/, by hand or by script. Nothing in here can be rebuilt from a
// transcript, because no transcript ever knew it:
//
//   title       every Sous recap ever generated
//   seenAt      which results have been read; losing it marks the history unread
//   scrollLine  the scrollback anchor each checkpoint restores to
//   (fork lineage moves here in a later step, and is likewise underivable)
//
// A comment does not survive contact with `rm -rf`. The separate path does.
//
// OPEN POINT FOR STEP 3. Deleting turns/ leaves these files intact, but the
// FIRST save after a rebuild replaces them from records the transcript produced
// — and a transcript has never heard of a recap or a read marker, so the
// annotations would be dropped one flush later. Surviving the delete is
// therefore necessary but not sufficient: the rebuild path has to re-attach
// these by checkpoint index before it saves. `save` is intentionally not doing
// that implicitly, because a store that silently inherits whatever is on disk
// can never clear anything either.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { hasAnnotation, type TurnAnnotation, type TurnRecord } from '../shared/turn'
import { splitAnnotation } from '../shared/turn'

/** Snapshot map body: checkpoint index (as a JSON key) → annotation. */
type AnnotationFile = Record<string, TurnAnnotation>

/**
 * On-disk snapshot: the map wrapped in a generation envelope. Files written
 * before the epoch (bare maps) parse as epoch 0 — see snapshotParts.
 */
interface AnnotationSnapshot {
  epoch: number
  annotations: AnnotationFile
}

/**
 * One op-log line: `a` present = set checkpoint `i`, absent = clear it.
 * `e` is the snapshot epoch the op extends; replay ignores ops whose epoch
 * does not match the snapshot on disk (legacy lines without `e` read as 0).
 */
interface AnnotationOp {
  i: number
  a?: TurnAnnotation
  e?: number
}

/**
 * Read a parsed snapshot file in either format. The envelope key "epoch" can
 * never collide with a checkpoint key — those are all String(number).
 */
function snapshotParts(parsed: unknown): { epoch: number; annotations: AnnotationFile } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { epoch: 0, annotations: {} }
  }
  const envelope = parsed as Partial<AnnotationSnapshot>
  if (typeof envelope.epoch === 'number' && Number.isFinite(envelope.epoch)) {
    const annotations = envelope.annotations
    if (typeof annotations === 'object' && annotations !== null && !Array.isArray(annotations)) {
      return { epoch: envelope.epoch, annotations }
    }
    return { epoch: envelope.epoch, annotations: {} }
  }
  return { epoch: 0, annotations: parsed as AnnotationFile }
}

/**
 * Log-compaction floor. The trigger mirrors the dispatch registry's
 * dead-fraction rule: compact once the log's line count reaches the live
 * annotation count — at that point at least half the persisted entries are
 * replay weight — but never for fewer than this many ops, so a tiny sidecar
 * is not churned through snapshot rewrites it does not need.
 */
export const ANNOTATION_LOG_COMPACT_MIN_OPS = 64

function isAnnotation(value: unknown): value is TurnAnnotation {
  if (typeof value !== 'object' || value === null) return false
  const a = value as TurnAnnotation
  return (
    (a.title === undefined || typeof a.title === 'string') &&
    (a.seenAt === undefined || typeof a.seenAt === 'number') &&
    (a.scrollLine === undefined || typeof a.scrollLine === 'number')
  )
}

/** Field-by-field equality — an annotation carries at most three scalars. */
function sameAnnotation(a: TurnAnnotation, b: TurnAnnotation): boolean {
  return a.title === b.title && a.seenAt === b.seenAt && a.scrollLine === b.scrollLine
}

/** Same picture, entry by entry — the full-save "nothing changed" skip. */
function sameState(a: Map<number, TurnAnnotation>, b: Map<number, TurnAnnotation>): boolean {
  if (a.size !== b.size) return false
  for (const [index, annotation] of a) {
    const other = b.get(index)
    if (other === undefined || !sameAnnotation(other, annotation)) return false
  }
  return true
}

/** Replay one op onto a picture — the single definition both read and write use. */
function applyOp(byIndex: Map<number, TurnAnnotation>, op: AnnotationOp): void {
  if (op.a !== undefined && hasAnnotation(op.a)) byIndex.set(op.i, op.a)
  else byIndex.delete(op.i)
}

/**
 * What a checkpoint currently reads as, durable state plus un-landed ops —
 * the diff basis, so a retry never queues a duplicate of an op it already
 * holds. Later ops win, exactly as log replay would have it.
 */
function effectiveGet(
  state: Map<number, TurnAnnotation>,
  pending: readonly AnnotationOp[],
  index: number,
): TurnAnnotation | undefined {
  for (let at = pending.length - 1; at >= 0; at -= 1) {
    if (pending[at].i === index) return pending[at].a
  }
  return state.get(index)
}

/**
 * Codes that POSITIVELY denote the platform/filesystem cannot fsync a
 * directory: EISDIR (platforms that refuse directory fds), ENOTSUP/EINVAL
 * (filesystems without directory fsync). Those are permanent facts about the
 * environment — every retry would fail identically — so they stay
 * best-effort. EACCES/EPERM are NOT here (Sol r8 P1): a permission failure
 * means this process was DENIED the operation that makes the rename durable,
 * not that the operation does not exist — a process can hold enough rights to
 * rename a directory entry while lacking open/read rights on the directory
 * itself, and in that state a crash can still lose the entry. Permission
 * failures propagate like EIO/ENOSPC, so callers retain their dirty state.
 */
const DIR_FSYNC_UNSUPPORTED = new Set(['EISDIR', 'ENOTSUP', 'EINVAL'])

/**
 * Directories whose post-rename fsync has already failed once this process.
 * A repeat is no longer a transient: it is surfaced as a LOUD persistent
 * storage fault, so a standing durability hole (revoked permissions, a dying
 * disk) cannot hide inside per-write retry noise. Cleared by the next
 * success on the same directory.
 */
const dirFsyncFaulted = new Set<string>()

/**
 * Did this writeFileAtomic failure happen AFTER the rename landed? Such an
 * error is AMBIGUOUS for callers: the target file already carries the new
 * bytes — visible to every reader — while their durability is unproven.
 * Callers that cache derived state about the target (the annotation store's
 * epoch, the turn store's written tail) must resync from the PUBLISHED file
 * before stamping anything else — see AnnotationStore.persistSnapshot and
 * TurnStore.writeAll.
 */
export function renameLanded(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { renamed?: unknown }).renamed === true
  )
}

/**
 * Fsync a directory so a rename into it is durable, with the shared fault
 * discipline: codes that POSITIVELY mean the filesystem cannot fsync a
 * directory (see DIR_FSYNC_UNSUPPORTED) are tolerated — every retry would
 * fail identically — everything else THROWS, and a repeat failure on the
 * same directory is surfaced as a LOUD persistent storage fault. Shared by
 * writeFileAtomic (immediately after its rename) and TurnStore's post-rename
 * durability-debt retries (Sol r9 P1): a rename whose directory entry was
 * never proven durable is retried through this until the fsync lands.
 */
export function fsyncDirDurable(parent: string): void {
  if (process.platform === 'win32') return // directories cannot be opened for fsync
  let dirFd: number | null = null
  try {
    dirFd = openSync(parent, 'r')
    fsyncSync(dirFd)
    dirFsyncFaulted.delete(parent)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== undefined && DIR_FSYNC_UNSUPPORTED.has(code)) return
    if (dirFsyncFaulted.has(parent)) {
      console.error(
        `PERSISTENT STORAGE FAULT: directory fsync keeps failing for ${parent} ` +
          `(${code ?? 'unknown'}) — renames are landing but their durability cannot be ` +
          'guaranteed; check permissions and disk health',
      )
    }
    dirFsyncFaulted.add(parent)
    throw error
  } finally {
    if (dirFd !== null) closeSync(dirFd)
  }
}

/**
 * Temp + fsync + rename replacement of a whole file — the dispatch-registry
 * compaction pattern (dispatch.ts). The old bytes stay durable until the
 * replacement is: a crash at ANY point leaves either the previous file or the
 * new one, never a truncated hybrid. Shared with TurnStore's full-rewrite and
 * tail-fold paths (Sol r6 P2).
 *
 * Sol r7 P1 hardening, both halves of "published as success":
 * - `writeSync` is not guaranteed to consume the whole buffer, so it loops
 *   until every byte lands or throws — a short write must never fsync+rename
 *   a truncated temp over the only copy.
 * - A parent-directory fsync failure now THROWS instead of logging: until the
 *   directory entry is durable the rename is not, and claiming success drops
 *   the caller's retry state exactly when it is still needed. Callers already
 *   treat a throw as "retain dirty work and retry" (AnnotationStore's
 *   persistSnapshot, TurnStore's flush/retain). Only codes that POSITIVELY
 *   mean the filesystem cannot fsync a directory are tolerated — see
 *   DIR_FSYNC_UNSUPPORTED — because they would fail every retry identically;
 *   permission denials propagate, and a failure thrown after the rename
 *   landed carries {renamed: true} (see renameLanded) because it publishes
 *   the new bytes without proving their durability.
 *
 * The replaced file's mode is preserved onto the temp (fchmod, so the umask
 * cannot dilute it) — a rename must not quietly widen a user-tightened 0600.
 */
export function writeFileAtomic(file: string, body: string | Buffer): void {
  const temp = `${file}.tmp`
  if (existsSync(temp)) {
    try {
      unlinkSync(temp)
    } catch {
      // stale temp from a crashed run: openSync 'w' below truncates it instead
    }
  }
  let mode: number | null = null
  try {
    mode = statSync(file).mode & 0o777
  } catch {
    // no file being replaced: the temp keeps the platform default
  }
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const fd = openSync(temp, 'w')
  try {
    if (mode !== null) fchmodSync(fd, mode)
    let landed = 0
    while (landed < bytes.length) {
      const wrote = writeSync(fd, bytes, landed, bytes.length - landed)
      if (wrote <= 0) {
        throw new Error(`short write: ${landed} of ${bytes.length} bytes reached ${temp}`)
      }
      landed += wrote
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, file)
  } catch (error) {
    // The original file is still byte-identical — only the temp is stale.
    try {
      unlinkSync(temp)
    } catch {
      // the orphan is removed (or overwritten) by the next attempt
    }
    throw error
  }
  try {
    fsyncDirDurable(path.dirname(file))
  } catch (error) {
    // The rename already landed — mark the throw so callers can tell this
    // ambiguous failure (new bytes published, durability unproven) from one
    // that left the previous file in place (Sol r8 P1).
    throw Object.assign(error as object, { renamed: true })
  }
}

export class AnnotationStore {
  /**
   * The DURABLE picture per terminal — exactly what snapshot + log on disk
   * replay to. Published only after a write lands (fail-closed); lazily
   * seeded from disk on first touch.
   */
  private state = new Map<string, Map<number, TurnAnnotation>>()

  /** Ops whose append FAILED, retried before anything new on the next flush. */
  private pendingOps = new Map<string, AnnotationOp[]>()

  /**
   * A full-rebuild candidate whose persist failed. While one is held, every
   * subsequent change folds into it and retries the FULL path: after a failed
   * rebuild the disk may hold stale keys that only a whole snapshot clears,
   * so incremental ops must not resume until the rebuild lands.
   */
  private pendingFull = new Map<string, Map<number, TurnAnnotation>>()

  /** Lines currently in each on-disk log — the compaction trigger's input.
   *  Stale-epoch lines COUNT: they are replay weight to read past, and the
   *  armed counter is what lazily retries their cleanup. */
  private logOps = new Map<string, number>()

  /**
   * The generation each agent's snapshot+log pair is currently on — what new
   * ops are stamped with and what the next full save bumps past. Seeded from
   * the snapshot envelope on first touch; 0 for a bare directory.
   */
  private epochs = new Map<string, number>()

  constructor(private dir: string) {}

  private fileFor(safeId: string): string {
    return path.join(this.dir, `${safeId}.json`)
  }

  /** The op log beside the snapshot. safeIds cannot contain dots, so this
   *  suffix can never collide with another agent's snapshot name. */
  private logFor(safeId: string): string {
    return path.join(this.dir, `${safeId}.log.jsonl`)
  }

  /**
   * Annotations for one agent, keyed by checkpoint index. Served from the
   * in-memory picture once one exists — including retained un-landed work, so
   * a read never loses what a failed write is still carrying — otherwise read
   * from disk. A missing or corrupt file reads as "no annotations" rather
   * than throwing: an unreadable recap must cost a recap, never the history
   * it describes.
   */
  load(safeId: string): Map<number, TurnAnnotation> {
    const full = this.pendingFull.get(safeId)
    if (full) return new Map(full)
    const held = this.state.get(safeId)
    if (held) {
      const effective = new Map(held)
      for (const op of this.pendingOps.get(safeId) ?? []) applyOp(effective, op)
      return effective
    }
    return this.readDisk(safeId)
  }

  /**
   * Snapshot, then log replay — the durable picture as the disk holds it.
   * Only ops on the SNAPSHOT'S epoch replay (Sol r7 P1): an op from before a
   * full save describes a state that save already superseded, and replaying
   * it would roll the newer snapshot backward. A missing/unreadable snapshot
   * reads as epoch 0, matching log-only agents' ops.
   */
  private readDisk(safeId: string): Map<number, TurnAnnotation> {
    const byIndex = new Map<number, TurnAnnotation>()
    let epoch = 0
    try {
      const file = this.fileFor(safeId)
      if (existsSync(file)) {
        const parts = snapshotParts(JSON.parse(readFileSync(file, 'utf8')))
        epoch = parts.epoch
        for (const [key, value] of Object.entries(parts.annotations)) {
          const index = Number(key)
          if (!Number.isFinite(index) || !isAnnotation(value)) continue
          if (hasAnnotation(value)) byIndex.set(index, value)
        }
      }
    } catch (error) {
      console.error('Failed to load checkpoint annotations:', error)
    }
    this.epochs.set(safeId, epoch)
    try {
      const log = this.logFor(safeId)
      let lines = 0
      if (existsSync(log)) {
        for (const line of readFileSync(log, 'utf8').split('\n')) {
          if (line.trim() === '') continue
          lines += 1
          try {
            const parsed = JSON.parse(line) as AnnotationOp
            if (typeof parsed !== 'object' || parsed === null) continue
            if (!Number.isFinite(parsed.i)) continue
            if (parsed.a !== undefined && !isAnnotation(parsed.a)) continue
            if (parsed.e !== undefined && typeof parsed.e !== 'number') continue
            if ((parsed.e ?? 0) !== epoch) continue // stale generation: inert
            applyOp(byIndex, parsed)
          } catch {
            // one bad op, not the log
          }
        }
      }
      this.logOps.set(safeId, lines)
    } catch (error) {
      console.error('Failed to replay checkpoint annotation log:', error)
    }
    return byIndex
  }

  /** Current generation, seeding from the snapshot envelope on first touch. */
  private epochOf(safeId: string): number {
    const held = this.epochs.get(safeId)
    if (held !== undefined) return held
    let epoch = 0
    try {
      const file = this.fileFor(safeId)
      if (existsSync(file)) epoch = snapshotParts(JSON.parse(readFileSync(file, 'utf8'))).epoch
    } catch {
      // an unreadable snapshot reads as epoch 0, exactly as readDisk treats it
    }
    this.epochs.set(safeId, epoch)
    return epoch
  }

  /**
   * Re-seed the epoch cache from the snapshot actually PUBLISHED on disk
   * (Sol r8 P1). Used after an ambiguous post-rename failure: the renamed
   * snapshot is already what every reader replays over, so a cache that kept
   * the pre-rename epoch would stamp later ops with a generation the visible
   * snapshot has superseded — a crash would then silently drop them.
   */
  private resyncEpoch(safeId: string): void {
    this.epochs.delete(safeId)
    this.epochOf(safeId)
  }

  /** The in-memory durable picture, seeded from disk the first time. */
  /**
   * Move annotations onto their checkpoints' NEW index numbers, matched by uuid.
   *
   * A checkpoint index is a POSITION in a lineage, not an identity. This file
   * keys by index, and the note at the top of it says why that makes the ledger
   * undisposable — which contradicts ledger-rebuild's claim that the ledger is
   * a derived index. Both cannot be true, and today the ledger genuinely is not
   * disposable: renumber it and every annotation stays on a number that now
   * names a different turn.
   *
   * That failure is not an orphan, it is a LIE. Nothing errors, nothing is
   * missing, and a Sous title simply describes the wrong conversation — which
   * the UI cannot falsify and the owner has no reason to suspect. Three things
   * renumber: a fold, a rewind, and recovering the checkpoints a compact
   * orphaned.
   *
   * The uuid is the identity that survives. Verified before relying on it:
   * across 36 real agents, 2,327 checkpoint uuids compared between the stored
   * ledger and a rebuild from the transcript, 2,327 identical — it is carried
   * from the conversation, not minted here.
   *
   * REFUSES RATHER THAN GUESSES. An annotation whose index matches no record,
   * or whose record has no uuid, or whose uuid appears more than once, is
   * reported in `unmatched` and LEFT WHERE IT IS. Losing one loudly beats
   * moving it quietly, which is the whole failure being repaired.
   *
   * Idempotent: re-running with the same pair moves nothing and reports 0.
   */
  rekeyByUuid(
    safeId: string,
    before: readonly TurnRecord[],
    after: readonly TurnRecord[]
  ): { moved: number; unmatched: number[] } {
    const current = new Map(this.load(safeId))
    if (current.size === 0) return { moved: 0, unmatched: [] }

    // uuid -> new index, refusing any uuid that is not unique on either side.
    const oldByIndex = new Map<number, string>()
    const ambiguousOld = new Set<string>()
    for (const record of before) {
      if (record.uuid === undefined) continue
      if ([...oldByIndex.values()].includes(record.uuid)) ambiguousOld.add(record.uuid)
      oldByIndex.set(record.index, record.uuid)
    }
    const newByUuid = new Map<string, number>()
    const ambiguousNew = new Set<string>()
    for (const record of after) {
      if (record.uuid === undefined) continue
      if (newByUuid.has(record.uuid)) ambiguousNew.add(record.uuid)
      else newByUuid.set(record.uuid, record.index)
    }

    const next = new Map<number, TurnAnnotation>()
    const unmatched: number[] = []
    let moved = 0
    for (const [index, annotation] of current) {
      const uuid = oldByIndex.get(index)
      const target = uuid === undefined ? undefined : newByUuid.get(uuid)
      if (uuid === undefined || target === undefined || ambiguousOld.has(uuid) || ambiguousNew.has(uuid)) {
        // Unplaceable. Keep it exactly where it is and say so.
        unmatched.push(index)
        next.set(index, annotation)
        continue
      }
      if (target !== index) moved += 1
      next.set(target, annotation)
    }

    if (moved > 0) {
      this.persistSnapshot(safeId, next)
      this.state.set(safeId, next)
      this.pendingOps.delete(safeId)
      this.pendingFull.delete(safeId)
    }
    return { moved, unmatched }
  }

  private stateOf(safeId: string): Map<number, TurnAnnotation> {
    const held = this.state.get(safeId)
    if (held) return held
    const loaded = this.readDisk(safeId)
    this.state.set(safeId, loaded)
    return loaded
  }

  /**
   * Persist the annotations carried by `records`, replacing what was there.
   *
   * The caller always hands over an agent's WHOLE history, so these records are
   * the complete picture: a checkpoint that no longer carries an annotation no
   * longer has one. That is what makes a rewind or a phantom-echo dedupe take
   * effect, and it costs nothing in practice because the tracker carries seenAt
   * and scrollLine forward explicitly on every save (turn-tracker.ts) — absence
   * here means the checkpoint genuinely never had one.
   *
   * Deliberately NOT a merge that keeps absent fields. Inheriting whatever was
   * on disk would make stale state sticky and unclearable, and this file
   * outlives the ledger it describes — see the note on rebuilds at the top.
   *
   * Skips the disk when nothing changed AND nothing is retained: seenAt is
   * stamped once but the history around it is saved on every turn, so most
   * full flushes are identical and would otherwise rewrite for no reason.
   *
   * Returns false when the write did not land; the rebuilt map is retained
   * and the next save/update retries it.
   */
  save(safeId: string, records: readonly TurnRecord[]): boolean {
    const next = new Map<number, TurnAnnotation>()
    for (const record of records) {
      const { annotation } = splitAnnotation(record)
      if (hasAnnotation(annotation)) next.set(record.index, annotation)
    }
    const clean =
      !this.pendingFull.has(safeId) && (this.pendingOps.get(safeId)?.length ?? 0) === 0
    if (clean && sameState(this.stateOf(safeId), next)) return true

    if (this.persistSnapshot(safeId, next)) {
      this.state.set(safeId, next)
      // The rebuild supersedes any retained work: `records` is the whole truth.
      this.pendingOps.delete(safeId)
      this.pendingFull.delete(safeId)
      return true
    }
    this.pendingFull.set(safeId, next)
    this.pendingOps.delete(safeId)
    return false
  }

  /**
   * The incremental half of `save` (Sol r5 P1): fold ONLY the changed records
   * in, as ops appended to the log — O(changed) records visited, O(changed)
   * bytes written, never a scan or a serialization of every checkpoint the
   * agent ever produced (Sol r6 P1). Absence still clears, per record: a
   * changed record that no longer carries an annotation appends a clear op,
   * exactly as the full rebuild would. Skips the disk entirely when none of
   * the changed records moved an annotation — the common append, whose fresh
   * record has no title/seenAt/scrollLine yet.
   *
   * Returns false when the append did not land; the ops are retained and
   * retried ahead of the next change. While a failed FULL rebuild is held,
   * changes fold into that candidate and retry the full path instead — see
   * `pendingFull`.
   */
  update(safeId: string, changed: readonly TurnRecord[]): boolean {
    const full = this.pendingFull.get(safeId)
    if (full) {
      for (const record of changed) {
        const { annotation } = splitAnnotation(record)
        if (hasAnnotation(annotation)) full.set(record.index, annotation)
        else full.delete(record.index)
      }
      if (!this.persistSnapshot(safeId, full)) return false
      this.state.set(safeId, full)
      this.pendingFull.delete(safeId)
      return true
    }

    const pending = this.pendingOps.get(safeId) ?? []
    if (changed.length === 0 && pending.length === 0) return true
    const state = this.stateOf(safeId)
    const ops: AnnotationOp[] = []
    for (const record of changed) {
      const { annotation } = splitAnnotation(record)
      const current = effectiveGet(state, pending, record.index)
      if (hasAnnotation(annotation)) {
        if (current === undefined || !sameAnnotation(current, annotation)) {
          ops.push({ i: record.index, a: annotation })
        }
      } else if (current !== undefined) {
        ops.push({ i: record.index })
      }
    }
    const toWrite = [...pending, ...ops]
    if (toWrite.length === 0) return true

    if (!this.appendOps(safeId, toWrite)) {
      this.pendingOps.set(safeId, toWrite)
      return false
    }
    // Publish only what landed, in log order (fail-closed).
    for (const op of toWrite) applyOp(state, op)
    this.pendingOps.delete(safeId)
    this.maybeCompact(safeId, state)
    return true
  }

  private appendOps(safeId: string, ops: readonly AnnotationOp[]): boolean {
    try {
      mkdirSync(this.dir, { recursive: true })
      // Epoch stamped at APPEND time, not creation: pending ops only survive
      // while the generation is stable (a full save clears them), so the
      // current epoch is always the one they extend.
      const epoch = this.epochOf(safeId)
      appendFileSync(
        this.logFor(safeId),
        ops.map((op) => `${JSON.stringify({ ...op, e: epoch })}\n`).join(''),
        'utf8',
      )
      this.logOps.set(safeId, (this.logOps.get(safeId) ?? 0) + ops.length)
      return true
    } catch (error) {
      console.error('Failed to append checkpoint annotation ops:', error)
      return false
    }
  }

  /**
   * Fold the log into a fresh snapshot once replay weight crosses the
   * threshold (see ANNOTATION_LOG_COMPACT_MIN_OPS). The ops are already
   * durable in the log, so a failed compaction costs no data that has landed
   * — but it is NOT free to ignore (Sol r8 P1): the failure may have left a
   * bumped-epoch snapshot published (rename landed, durability unproven), and
   * an incremental op appended after that with the cached epoch would be
   * inert to the very snapshot it extends. So an unresolved compaction
   * failure raises the pendingFull barrier: every subsequent change folds
   * into a retried FULL snapshot, which reconciles epoch and state in one
   * atomic replacement before any op line is stamped again.
   */
  private maybeCompact(safeId: string, state: Map<number, TurnAnnotation>): void {
    const ops = this.logOps.get(safeId) ?? 0
    if (ops < ANNOTATION_LOG_COMPACT_MIN_OPS || ops < state.size) return
    if (!this.persistSnapshot(safeId, state)) {
      this.pendingFull.set(safeId, new Map(state))
    }
  }

  /**
   * The full snapshot write — `save`'s path and the log's compaction. Temp +
   * fsync + rename (writeFileAtomic) with the epoch BUMPED in the envelope:
   * the moment the rename lands, every op line on disk carries a dead epoch
   * and replay ignores it (Sol r7 P1). The log unlink is therefore byte
   * reclamation, not a correctness step — best-effort, retried lazily by the
   * next compaction (the armed logOps counter keeps its trigger live), and a
   * crash anywhere between rename and unlink leaves a state that reads back
   * as exactly the new snapshot.
   *
   * An empty picture is PUBLISHED, never unlinked (Sol r9 P2). Raw unlinks
   * return before the directory entries are durable, so a crash after them
   * could restore BOTH old files whole — snapshot and its matching-epoch log
   * — resurrecting a title/seen/scroll state this store had already reported
   * cleared. The epoch-bumped EMPTY snapshot goes through the same atomic
   * durable path as any other save: the moment its rename lands, every
   * surviving op line carries a dead epoch and replay ignores it, so the log
   * unlink stays what it always was — byte reclamation, best-effort. A
   * directory holding neither file is already durably empty (epoch 0, no
   * ops) and nothing is written for it, so agents that never had an
   * annotation still leave no file behind.
   */
  private persistSnapshot(safeId: string, byIndex: Map<number, TurnAnnotation>): boolean {
    try {
      const file = this.fileFor(safeId)
      const log = this.logFor(safeId)
      if (byIndex.size === 0) {
        if (!existsSync(file) && !existsSync(log)) {
          this.epochs.set(safeId, 0)
          this.logOps.set(safeId, 0)
          return true
        }
        const epoch = this.epochOf(safeId) + 1
        mkdirSync(this.dir, { recursive: true })
        writeFileAtomic(file, JSON.stringify({ epoch, annotations: {} }))
        this.epochs.set(safeId, epoch)
        try {
          if (existsSync(log)) unlinkSync(log)
          this.logOps.set(safeId, 0)
        } catch {
          // Stale-epoch ops are inert; the counter stays armed so the next
          // compaction retries the reclamation.
        }
        return true
      }
      // Keys serialized in ascending checkpoint order, as before the log.
      const next: AnnotationFile = {}
      for (const index of [...byIndex.keys()].sort((a, b) => a - b)) {
        next[String(index)] = byIndex.get(index) as TurnAnnotation
      }
      const epoch = this.epochOf(safeId) + 1
      mkdirSync(this.dir, { recursive: true })
      writeFileAtomic(file, JSON.stringify({ epoch, annotations: next }))
      this.epochs.set(safeId, epoch)
      try {
        if (existsSync(log)) unlinkSync(log)
        this.logOps.set(safeId, 0)
      } catch {
        // Stale-epoch ops are inert; the counter stays armed so the next
        // compaction retries the reclamation.
      }
      return true
    } catch (error) {
      // Ambiguous post-rename failure (Sol r8 P1): the rename LANDED, so the
      // published snapshot already carries the bumped epoch while the cache
      // still holds the old one. Resync from the file on disk so nothing is
      // ever stamped with a generation the visible snapshot has superseded.
      if (renameLanded(error)) this.resyncEpoch(safeId)
      console.error('Failed to save checkpoint annotations:', error)
      return false
    }
  }

  /** Drop one agent's annotations (node deletion). */
  remove(safeId: string): void {
    this.state.delete(safeId)
    this.pendingOps.delete(safeId)
    this.pendingFull.delete(safeId)
    this.logOps.delete(safeId)
    this.epochs.delete(safeId)
    try {
      for (const file of [this.fileFor(safeId), this.logFor(safeId)]) {
        if (existsSync(file)) unlinkSync(file)
      }
    } catch (error) {
      console.error('Failed to remove checkpoint annotations:', error)
    }
  }
}
