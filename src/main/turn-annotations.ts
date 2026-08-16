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
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { hasAnnotation, type TurnAnnotation, type TurnRecord } from '../shared/turn'
import { splitAnnotation } from '../shared/turn'

/** On-disk snapshot shape: checkpoint index (as a JSON key) → annotation. */
type AnnotationFile = Record<string, TurnAnnotation>

/** One op-log line: `a` present = set checkpoint `i`, absent = clear it. */
interface AnnotationOp {
  i: number
  a?: TurnAnnotation
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
 * Temp + fsync + rename replacement of a whole file — the dispatch-registry
 * compaction pattern (dispatch.ts). The old bytes stay durable until the
 * replacement is: a crash at ANY point leaves either the previous file or the
 * new one, never a truncated hybrid. Shared with TurnStore's full-rewrite and
 * tail-replacement paths (Sol r6 P2). The parent-directory fsync is
 * best-effort and loud — the write itself already succeeded, and reporting it
 * failed would lie about the file's (correct) contents.
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
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const fd = openSync(temp, 'w')
  try {
    writeSync(fd, bytes)
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
    const dirFd = openSync(path.dirname(file), 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch (error) {
    console.error('Directory fsync failed (rename not yet durable):', error)
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

  /** Lines currently in each on-disk log — the compaction trigger's input. */
  private logOps = new Map<string, number>()

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

  /** Snapshot, then log replay — the durable picture as the disk holds it. */
  private readDisk(safeId: string): Map<number, TurnAnnotation> {
    const byIndex = new Map<number, TurnAnnotation>()
    try {
      const file = this.fileFor(safeId)
      if (existsSync(file)) {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed as AnnotationFile)) {
            const index = Number(key)
            if (!Number.isFinite(index) || !isAnnotation(value)) continue
            if (hasAnnotation(value)) byIndex.set(index, value)
          }
        }
      }
    } catch (error) {
      console.error('Failed to load checkpoint annotations:', error)
    }
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

  /** The in-memory durable picture, seeded from disk the first time. */
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
      appendFileSync(this.logFor(safeId), ops.map((op) => `${JSON.stringify(op)}\n`).join(''), 'utf8')
      this.logOps.set(safeId, (this.logOps.get(safeId) ?? 0) + ops.length)
      return true
    } catch (error) {
      console.error('Failed to append checkpoint annotation ops:', error)
      return false
    }
  }

  /**
   * Fold the log into a fresh snapshot once replay weight crosses the
   * threshold (see ANNOTATION_LOG_COMPACT_MIN_OPS). Best-effort: the ops are
   * already durable in the log, so a failed compaction costs replay time on
   * the next read, never data — and the counter keeps the trigger armed.
   */
  private maybeCompact(safeId: string, state: Map<number, TurnAnnotation>): void {
    const ops = this.logOps.get(safeId) ?? 0
    if (ops < ANNOTATION_LOG_COMPACT_MIN_OPS || ops < state.size) return
    this.persistSnapshot(safeId, state)
  }

  /**
   * The full snapshot write — `save`'s path and the log's compaction. Temp +
   * fsync + rename (writeFileAtomic), THEN the log is cleared: the snapshot
   * folds every logged op in, and stale ops replaying over a NEWER snapshot
   * would resurrect the values they carried. That is also why a failed log
   * clear fails the whole write — the retained candidate retries until both
   * land. (A crash between rename and clear leaves that stale window on disk;
   * it is closed by the retry, and never by silently accepting it.)
   *
   * An empty picture drops both files rather than leaving an empty object
   * behind, so the directory only ever holds agents that have annotations.
   */
  private persistSnapshot(safeId: string, byIndex: Map<number, TurnAnnotation>): boolean {
    try {
      const file = this.fileFor(safeId)
      const log = this.logFor(safeId)
      if (byIndex.size === 0) {
        if (existsSync(file)) unlinkSync(file)
        if (existsSync(log)) unlinkSync(log)
        this.logOps.set(safeId, 0)
        return true
      }
      // Keys serialized in ascending checkpoint order, as before the log —
      // the snapshot format is unchanged and older files read back as-is.
      const next: AnnotationFile = {}
      for (const index of [...byIndex.keys()].sort((a, b) => a - b)) {
        next[String(index)] = byIndex.get(index) as TurnAnnotation
      }
      mkdirSync(this.dir, { recursive: true })
      writeFileAtomic(file, JSON.stringify(next))
      if (existsSync(log)) unlinkSync(log)
      this.logOps.set(safeId, 0)
      return true
    } catch (error) {
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
    try {
      for (const file of [this.fileFor(safeId), this.logFor(safeId)]) {
        if (existsSync(file)) unlinkSync(file)
      }
    } catch (error) {
      console.error('Failed to remove checkpoint annotations:', error)
    }
  }
}
