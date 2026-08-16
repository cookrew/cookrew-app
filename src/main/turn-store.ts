// Disk persistence for per-terminal turn history, so the card pager and
// fork-from-turn survive app restarts (terminal ids are stable across runs —
// they live in workspace.json and their tmux sessions persist too).
//
// ONE LINE PER RECORD under ~/.cookrew/turns/<terminalId>.jsonl. History is
// not capped, which is only affordable because the common case — a turn
// finished, nothing else changed — appends a single line instead of rewriting
// the file. The previous format was one pretty-printed JSON array rewritten in
// full on every turn: O(n) per turn and O(n²) over a session, which is the
// reason a cap existed at all.
//
// TAIL OVERLAY LINES (Sol r7 P1). The open turn's record grows and finalizes
// in place, and the parser lane reports that every ~2s — so "replace the last
// line" is the second-hottest write after the append. Rewriting the whole
// file atomically for it (the r6 shape) made every tail delta O(total
// history): a long active turn against a large ledger copied the entire file
// per poll. A tail change is now itself an APPEND — a versioned overlay line
//
//   {"__tail":true,"supersedes":<index>,<…the record's own fields…>}
//
// meaning "the newest version of checkpoint <index> is this line". Readers
// apply last-wins per index; superseded lines are dead weight that a bounded
// fold clears: when overlay lines reach TAIL_OVERLAY_COMPACT_MIN_LINES and
// their bytes reach half the file, ONE atomic full rewrite folds them away —
// SCHEDULED, never performed inline (Sol r8 P1 / r9 P1): both the load that
// finds a heavy file and the flush that crosses the threshold queue an async
// task that reads, parses, serializes and writes in bounded chunks, yielding
// the event loop between each, and commits with fsync+rename+dir-fsync only
// when no write raced it (see foldNow for the race discipline). Amortized,
// every write is O(changed bytes): the fold's O(file) cost is paid for by an
// equal weight of dead bytes it removes. TurnStore is the ONLY reader of
// these files (board, search, rebuild-diff all go through load/loadAll;
// ledger-rebuild reads harness transcripts) — anything new that parses the
// raw JSONL must apply the same last-wins rule.
//
// Writes are debounced per terminal; TurnTracker flushes on app quit.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
// The FOLD's durable I/O rides fs/promises FileHandles (Sol r10 P1):
// open/read/write/sync run on the libuv threadpool, so the temp write, its
// fsync and the parent-directory fsync — the fold's slow-storage hazards —
// no longer block Electron main the way writeSync/fsyncSync did. The HOT
// write path (flush/append/writeAll) stays synchronous on purpose: its units
// are O(changed bytes) and its callers depend on flush() completing within
// one event-loop turn (the fold's race discipline is built on that).
import { open, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { mergeAnnotation, splitAnnotation, type TurnRecord } from '../shared/turn'
import { AnnotationStore, fsyncDirDurable, renameLanded, writeFileAtomic } from './turn-annotations'
// The OVERSIZED-record codec (Sol r11 P1): JSON.parse/stringify of any record
// past 1 MB rides a worker thread, so the fold's one remaining unbounded
// synchronous unit — the giant tool reply round 10 explicitly left on main —
// leaves Electron main entirely. Worker death falls back to the synchronous
// path, loudly, without touching correctness.
import { FoldRecordCodec, OVERSIZED_RECORD_BYTES } from './turn-store-fold-worker'

const SAVE_DEBOUNCE_MS = 300

/**
 * The fold's event-loop budget (Sol r9 P1, byte-bounded per Sol r10 P1). The
 * fold reads, parses, serializes and writes in bounded chunks with a yield
 * between each, so the O(total history) rewrite never blocks Electron's main
 * thread for more than one chunk's worth of work — renderer IPC, PTY handling
 * and other agents keep running through a 91 MB compaction instead of
 * freezing for it. BOTH budgets are BYTES: the r9 shape bounded serialization
 * by record COUNT, and 200 ten-megabyte records serialized as one unbounded
 * stretch. The round-10 residual — a SINGLE oversized record parsing and
 * stringifying synchronously — is CLOSED (Sol r11 P1): past
 * OVERSIZED_RECORD_BYTES the JSON work rides the fold worker
 * (turn-store-fold-worker), and only linear memcpy-class steps (utf8 decode,
 * Buffer.from, the write) remain on this thread, still isolated in their own
 * unit with a yield before and after. Records between one chunk and the
 * worker bound keep the r10 discipline: in-thread, alone between yields.
 */
const FOLD_READ_CHUNK_BYTES = 256 * 1024
const FOLD_SERIALIZE_CHUNK_BYTES = 256 * 1024

/**
 * Directory-fsync debt retry cadence (Sol r10 P1): base doubles per failed
 * attempt, capped, on unref'd timers — a debt-only retry independent of new
 * turns, because a fold-created debt on a quiet ledger has no later flush to
 * ride (compaction is exactly the moment new records stop).
 */
const DIR_DEBT_RETRY_BASE_MS = 500
const DIR_DEBT_RETRY_MAX_MS = 30_000

/**
 * Codes that POSITIVELY mean this filesystem cannot fsync a directory —
 * mirrored from turn-annotations' fsyncDirDurable (its set is private to
 * that module): every retry would fail identically, so they are tolerated.
 */
const DIR_FSYNC_UNSUPPORTED = new Set(['EISDIR', 'ENOTSUP', 'EINVAL'])

/**
 * Directories whose ASYNC post-rename fsync already failed once this process
 * — the same repeat-escalation discipline as fsyncDirDurable's, tracked for
 * the fold's threadpool-backed fsync path. A repeat is surfaced as a LOUD
 * PERSISTENT STORAGE FAULT; cleared by the next success on the directory.
 */
const asyncDirFsyncFaulted = new Set<string>()

/** Hand the event loop back between fold chunks — setImmediate as a promise. */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** An unref'd wait — the shutdown drain's cap must never hold the app open. */
const sleepUnref = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })

/**
 * Is this text past the worker bound (Sol r11 P1)? UTF-8 bytes are never
 * fewer than UTF-16 units, so the cheap length check clears ordinary lines
 * without an O(n) byte scan — only a line long enough to possibly cross the
 * bound pays Buffer.byteLength, and that scan is trivial next to the parse
 * it gates.
 */
const oversizedText = (text: string): boolean =>
  text.length * 4 > OVERSIZED_RECORD_BYTES &&
  (text.length > OVERSIZED_RECORD_BYTES || Buffer.byteLength(text, 'utf8') > OVERSIZED_RECORD_BYTES)

/**
 * Overlay-fold floor. Below this many overlay lines the dead weight cannot be
 * worth a full rewrite, however small the file; at or above it, the fold
 * fires once overlay bytes reach half the file — the doubling policy that
 * makes the fold's O(file) cost amortized O(changed) per write.
 */
export const TAIL_OVERLAY_COMPACT_MIN_LINES = 64

/** Byte-exact prefix of every overlay line this writer produces. */
const TAIL_MARKER_PREFIX = '{"__tail":true,"supersedes":'

/** Build the overlay line for a record's canonical conversation line. */
function tailOverlayLine(index: number, recordLine: string): string {
  // Splice the marker fields into the record's own JSON object, so the exact
  // record bytes are recoverable by stripping the marker prefix back off.
  return `${TAIL_MARKER_PREFIX}${index},${recordLine.slice(1)}`
}

/**
 * Recognize an overlay line, recovering the EXACT record line it carries —
 * '{' plus everything past the marker — and the index it supersedes. Null for
 * a plain record line, or for anything not in this writer's canonical shape.
 */
function parseOverlay(raw: string): { supersedes: number; line: string } | null {
  if (!raw.startsWith(TAIL_MARKER_PREFIX)) return null
  const comma = raw.indexOf(',', TAIL_MARKER_PREFIX.length)
  if (comma === -1) return null
  const digits = raw.slice(TAIL_MARKER_PREFIX.length, comma)
  if (!/^\d+$/.test(digits)) return null
  return { supersedes: Number(digits), line: `{${raw.slice(comma + 1)}` }
}

/** The bounded fold policy — one place, used by load and the write path. */
function foldDue(overlayLines: number, overlayBytes: number, fileBytes: number): boolean {
  return overlayLines >= TAIL_OVERLAY_COMPACT_MIN_LINES && overlayBytes * 2 >= fileBytes
}

/** Shape check for records read back from disk (files are user-editable). */
function isTurnRecord(value: unknown): value is TurnRecord {
  const r = value as TurnRecord
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.index === 'number' &&
    typeof r.prompt === 'string' &&
    typeof r.reply === 'string' &&
    typeof r.startedAt === 'number' &&
    typeof r.endedAt === 'number'
  )
}

/** What the last flush left on disk, so the next one can tell append from edit. */
interface Written {
  /** LOGICAL records — physical lines minus the overlays that supersede one. */
  count: number
  /** Raw bytes of the last PHYSICAL line — the overlay append verifies the
   *  file still ends with exactly these before superseding anything. */
  lastLine: string
  /** Exact record line of the last LOGICAL record: `lastLine` itself, or the
   *  record bytes inside it when that line is an overlay. An edit to the
   *  record this fails to match forces the safe full rewrite. */
  tailLine: string
  /** Checkpoint index of the last logical record — an overlay may only ever
   *  supersede this one. */
  lastIndex: number
  /** Overlay lines currently in the file — the fold trigger's input. */
  overlayLines: number
  /** Their bytes (newlines included) — the fold trigger's other input. */
  overlayBytes: number
}

export class TurnStore {
  private timers = new Map<string, NodeJS.Timeout>()
  private pending = new Map<string, TurnRecord[]>()
  private written = new Map<string, Written>()
  /**
   * What changed since the last flush, per terminal (Sol r5 P1). 'all' — a
   * full save (scheduleSave) whose flush must scan and may rewrite anything.
   * A map of checkpoint index → latest changed record — a delta save
   * (scheduleDelta) whose flush touches ONLY those records: the annotation
   * pass folds them in incrementally, and the conversation write appends (or
   * replaces just the last line) instead of visiting the other N records.
   * A later scheduleSave overrides any accumulated delta; a delta never
   * downgrades an 'all'.
   */
  private dirty = new Map<string, Map<number, TurnRecord> | 'all'>()
  /**
   * Terminals whose last read found overlay weight past the fold policy —
   * load() folds them with ONE atomic rewrite as soon as it holds the
   * hydrated records, i.e. outside every hot write path.
   */
  private foldOnLoad = new Set<string>()
  /**
   * Terminals whose WRITE path crossed the fold policy (Sol r8 P1). The flush
   * that crosses the threshold keeps appending overlays — correctness is
   * unaffected, readers are last-wins per index — and the O(total history)
   * rewrite runs here instead: an unref'd idle task, single-flight per
   * terminal, off every flush stack. Overlay growth between the threshold and
   * the scheduled fold is bounded by the scheduling delay — one macrotask, so
   * at most the overlays of one additional flush cycle (~2s of parser
   * reports), never unbounded accumulation. A process that dies before the
   * task runs is covered by the load-time fold (foldOnLoad/maybeFold), and an
   * unref'd timer never holds the app open for it.
   */
  private pendingCompact = new Map<string, NodeJS.Timeout>()
  /** Terminals whose ASYNC fold is currently in flight — the single-flight
   *  guard for the chunked task itself (Sol r9 P1). */
  private folding = new Set<string>()
  /**
   * The in-flight fold PROMISES per terminal (Sol r11 P1) — what drainFolds
   * awaits. flushAll's debt sweep is point-in-time: a fold still running when
   * it looked could rename afterwards and mint a directory-fsync debt nobody
   * would settle before quit. Tracking the promise makes shutdown a bounded
   * drain instead of a snapshot.
   */
  private readonly foldRuns = new Map<string, Promise<void>>()
  /**
   * The shutdown latch (Sol r11 P1): once drainFolds has started, no NEW
   * fold may be scheduled or begun — draining a set that keeps refilling is
   * not a drain. Overlay weight left unreclaimed is recovered by the
   * load-time fold on the next boot, exactly like a quit before a scheduled
   * fold ever was.
   */
  private foldsDraining = false
  /**
   * The oversized-record codec (Sol r11 P1): one lazily-spawned worker
   * shared by every fold of this store. Not readonly-by-module on purpose —
   * a store owns its worker's lifetime the way it owns its timers.
   */
  private readonly foldCodec = new FoldRecordCodec()
  /**
   * Physical write generation per terminal (Sol r9 P1) — bumped by every
   * append, rewrite, fold commit and removal. The async fold captures it at
   * start and COMMITS only if it is unchanged at rename time: flushes keep
   * appending to the ORIGINAL file mid-fold (readers stay correct, last-wins
   * per index), and a fold whose input those writes outran aborts its temp
   * and reschedules rather than renaming their bytes away.
   */
  private writeGen = new Map<string, number>()
  /**
   * Post-rename durability DEBT (Sol r9 P1), tracked APART from the logical
   * written-tail. When writeAll's rename lands but the directory fsync
   * fails, the file already holds the new records — the written tail below
   * is truthful about bytes, and a retry must NOT re-append lines the file
   * carries — but the directory entry is unproven and a crash can still
   * lose the whole ledger. The old shape let the retry see a current tail,
   * write nothing, and clear the retained work as success. Now the debt
   * survives independently: every flush retries the parent-directory fsync
   * (fsyncDirDurable, which escalates a repeat as a PERSISTENT STORAGE
   * FAULT), and only a flush whose debt is settled may clear pending/dirty.
   */
  private dirDebt = new Set<string>()
  /**
   * The debt-only retry timers (Sol r10 P1), one per indebted terminal —
   * unref'd, backoff-doubling, independent of new turns. A fold-created debt
   * on a ledger that then goes QUIET had no retry trigger at all: only
   * flush() settled debt, and a file that just compacted has no pending
   * flush, so a crash could still lose the renamed directory entry and a
   * persistent fault never reached the repeat-failure escalation. flushAll
   * (app quit) settles or escalates whatever is still outstanding.
   */
  private debtTimers = new Map<string, NodeJS.Timeout>()
  /** Failed retry attempts per indebted terminal — the backoff's exponent. */
  private debtAttempts = new Map<string, number>()
  /**
   * Cached LOGICAL record count per terminal (Sol r9 P2): seeded by the
   * first full read (readLines or count()'s own recovery parse — the same
   * recovery rules), kept current by every append/overlay/rewrite/fold, so
   * count() never reparses the ledger it already measured. This process is
   * the only writer, the same trust the written-tail and loadAll caches
   * already rest on.
   */
  private counts = new Map<string, number>()
  /**
   * Whole-ledger cache for loadAll(). Built once and kept warm by write-through
   * from flush()/remove() — this process is the only writer, so re-reading every
   * file per board or search request would be pure waste on the request path.
   * The map handed back is the LIVE cache: read only.
   */
  private all: Map<string, TurnRecord[]> | null = null

  /**
   * Cookrew's own fields (title / seenAt / scrollLine) live here instead of on
   * the conversation lines. This is a STORAGE split only: records go in whole
   * and come back out whole, so nothing above this class can tell.
   */
  private annotations: AnnotationStore

  /**
   * Where the annotations went. Exposed so the one invariant that matters can
   * be asserted rather than assumed: this path is NEVER inside `dir`.
   */
  readonly annotationsDir: string

  /**
   * `annotationsDir` defaults to a SIBLING of the turns directory, never a child
   * of it. This is the whole point: the ledger is derived and will be documented
   * as safe to delete, so anything a transcript cannot regenerate has to live
   * where `rm -rf <turns>` cannot reach it. Deriving from the given `dir` rather
   * than hard-coding the home path keeps that true for every construction — a
   * caller with its own turns directory gets its own sibling, not the real one.
   */
  constructor(
    private dir = path.join(homedir(), '.cookrew', 'turns'),
    annotationsDir = path.resolve(dir, '..', 'checkpoint-annotations'),
  ) {
    this.annotationsDir = annotationsDir
    this.annotations = new AnnotationStore(annotationsDir)
  }

  private safeId(terminalId: string): string {
    return terminalId.replace(/[^a-zA-Z0-9_-]/g, '')
  }

  private fileFor(terminalId: string): string {
    return path.join(this.dir, `${this.safeId(terminalId)}.jsonl`)
  }

  /** Pre-JSONL format: one pretty-printed array per terminal. */
  private legacyFileFor(terminalId: string): string {
    return path.join(this.dir, `${this.safeId(terminalId)}.json`)
  }

  /**
   * Put Cookrew's fields back on the conversation records — the read half of
   * the storage split, so every public getter returns what it always did.
   *
   * The annotation wins where it has a value, but a record keeps anything the
   * annotation lacks. That is what lets a file written BEFORE the split, with
   * title/seenAt still inline on the line, read back unchanged until the next
   * flush moves them across.
   */
  private hydrate(terminalId: string, records: TurnRecord[]): TurnRecord[] {
    const byIndex = this.annotations.load(this.safeId(terminalId))
    if (byIndex.size === 0) return records
    return records.map((record) => mergeAnnotation(record, byIndex.get(record.index)))
  }

  /**
   * Read the lines file, dropping any line that will not parse. A single
   * corrupt line must not blank an agent's whole history. An overlay line
   * (see the header) replaces the record it supersedes IN PLACE — last wins
   * per checkpoint index — so callers see the logical history whatever mix of
   * plain and overlay lines the file holds.
   *
   * COLD-START SEEDING (Sol r6 P1): a CLEAN read — every line parsed, file
   * newline-terminated, overlays canonical, final line carrying the final
   * logical record — also seeds the written-tail metadata, with the RAW
   * last line as it sits on disk. Without this the first scheduleDelta after
   * a restart found no `written` entry and fell through to a whole-file
   * rewrite, making persistence O(delta) only until the next boot. Raw bytes,
   * not a re-serialization, so the extend/append decision and the tail
   * verification compare against exactly what the file holds; a hand-edited
   * line that no longer serializes identically simply fails the boundary
   * check and takes the safe full rewrite. A NON-clean read (corrupt or
   * truncated lines the parse dropped, non-canonical overlays) clears the
   * entry instead: appending relative to a shape the file does not actually
   * have would land records in the wrong place.
   */
  private readLines(terminalId: string, file: string): TurnRecord[] {
    const records: TurnRecord[] = []
    const at = new Map<number, number>() // checkpoint index → position
    const text = readFileSync(file, 'utf8')
    let clean = text === '' || text.endsWith('\n')
    let lastLine = ''
    let lastRecord: TurnRecord | null = null
    let overlayLines = 0
    let overlayBytes = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const overlay = parseOverlay(line)
      try {
        const parsed: unknown = JSON.parse(overlay?.line ?? line)
        if (!isTurnRecord(parsed)) {
          clean = false
          continue
        }
        if (overlay !== null) {
          overlayLines += 1
          overlayBytes += Buffer.byteLength(line, 'utf8') + 1
          if (overlay.supersedes !== parsed.index) clean = false
          const pos = at.get(parsed.index)
          if (pos !== undefined) {
            records[pos] = parsed
          } else {
            // An overlay whose base line is gone (corrupt, hand-assembled):
            // keep the newest version of the record — losing data to a shape
            // quibble is worse — but distrust the file as an append base.
            at.set(parsed.index, records.length)
            records.push(parsed)
            clean = false
          }
        } else {
          at.set(parsed.index, records.length)
          records.push(parsed)
        }
        lastLine = line
        lastRecord = parsed
      } catch {
        // one bad line, not the file
        clean = false
      }
    }
    // The append/overlay machinery assumes the final physical line carries
    // the final logical record; a file where it does not is not extendable.
    if (records.length > 0 && lastRecord !== records[records.length - 1]) clean = false
    // The logical count is what this read just measured — clean or not, it is
    // exactly what count() would recover with the same rules (Sol r9 P2).
    this.counts.set(terminalId, records.length)
    if (!clean) {
      this.written.delete(terminalId)
      return records
    }
    this.written.set(terminalId, {
      count: records.length,
      lastLine,
      tailLine: parseOverlay(lastLine)?.line ?? lastLine,
      lastIndex: records.length > 0 ? records[records.length - 1].index : -1,
      overlayLines,
      overlayBytes,
    })
    if (foldDue(overlayLines, overlayBytes, Buffer.byteLength(text, 'utf8'))) {
      this.foldOnLoad.add(terminalId)
    }
    return records
  }

  /**
   * The load-time half of overlay compaction. Load SCHEDULES the fold rather
   * than performing it (Sol r9 P1): the rewrite is O(total history), and a
   * boot that paid it synchronously froze app launch for exactly the ledgers
   * the fold exists to serve. The scheduled task is the same chunked,
   * yield-between-chunks fold the write path uses; until it commits, readers
   * keep getting the correct last-wins history from the unfolded file.
   */
  private maybeFold(terminalId: string): void {
    if (!this.foldOnLoad.delete(terminalId)) return
    this.scheduleFold(terminalId)
  }

  /**
   * Convert a legacy array file to lines, once, on first touch. Returns the
   * records so the caller does not pay for a second read.
   */
  private migrate(terminalId: string): TurnRecord[] | null {
    const legacy = this.legacyFileFor(terminalId)
    if (!existsSync(legacy)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(legacy, 'utf8'))
      const records = Array.isArray(parsed) ? parsed.filter(isTurnRecord) : []
      // A legacy file carries title/seenAt inline. writeAll strips them off the
      // lines, so they have to be moved across in the same breath or the
      // migration would quietly drop every recap it just read.
      this.annotations.save(this.safeId(terminalId), records)
      this.writeAll(terminalId, records)
      // Keep the original as .migrated rather than deleting it — this is the
      // only copy of history that predates the lines format.
      renameSync(legacy, `${legacy}.migrated`)
      return records
    } catch (error) {
      console.error('Failed to migrate turn history:', error)
      return null
    }
  }

  load(terminalId: string): TurnRecord[] {
    const pending = this.pending.get(terminalId)
    if (pending) return pending
    try {
      const file = this.fileFor(terminalId)
      if (existsSync(file)) {
        const records = this.hydrate(terminalId, this.readLines(terminalId, file))
        this.maybeFold(terminalId)
        return records
      }
      return this.migrate(terminalId) ?? []
    } catch (error) {
      console.error('Failed to load turn history:', error)
      return []
    }
  }

  /**
   * How many checkpoints this agent has, counted with the SAME recovery rules
   * readLines applies (Sol r8 P2): a line that does not parse as a record is
   * dropped, a canonical overlay supersedes an existing record without adding
   * one, and an orphan overlay — whose base line is gone — still counts as
   * the record the reader preserves. The previous substring scan subtracted
   * every marker-shaped physical line and counted every corrupt one, so the
   * pager's count diverged from the loaded history on exactly the corruption
   * this store promises to tolerate; the count and the reader must not use
   * incompatible recovery rules.
   *
   * SERVED FROM CACHE (Sol r9 P2): the recovery parse below runs only for
   * the COLD seed — before this store has read or written the terminal at
   * all. Every read seeds `counts` and every append/overlay/rewrite/fold
   * updates it, so a pager or activity projection polling count() costs a
   * map lookup, never a synchronous reparse of an uncapped ledger.
   */
  count(terminalId: string): number {
    const pending = this.pending.get(terminalId)
    if (pending) return pending.length
    const cached = this.counts.get(terminalId)
    if (cached !== undefined) return cached
    try {
      const file = this.fileFor(terminalId)
      if (!existsSync(file)) return this.migrate(terminalId)?.length ?? 0
      const present = new Set<number>()
      let logical = 0
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const overlay = parseOverlay(line)
        try {
          const parsed: unknown = JSON.parse(overlay?.line ?? line)
          if (!isTurnRecord(parsed)) continue
          // Mirrors readLines exactly: only an overlay that supersedes a
          // record already seen replaces instead of adding.
          if (overlay !== null && present.has(parsed.index)) continue
          present.add(parsed.index)
          logical += 1
        } catch {
          // one bad line, not the file — the reader drops it too
        }
      }
      this.counts.set(terminalId, logical)
      return logical
    } catch {
      return 0
    }
  }

  /**
   * The newest `n` checkpoints. Cards and the rail open on the recent end, so
   * attaching to a 5,000-turn agent parses 200 records rather than all of them;
   * older windows are fetched on demand.
   */
  loadTail(terminalId: string, n: number): TurnRecord[] {
    const all = this.load(terminalId)
    return n >= all.length ? all : all.slice(all.length - n)
  }

  /**
   * Every agent's checkpoints, across every workspace — the board's L3 ledger
   * layer and the corpus checkpoint search runs over. Terminals with no usable
   * records are omitted, pending writes are layered on so a search never misses
   * the turn that just finished, and one unreadable file is isolated rather
   * than aborting the walk.
   */
  loadAll(): Map<string, TurnRecord[]> {
    if (this.all) return this.withPending(this.all)
    const all = new Map<string, TurnRecord[]>()
    try {
      if (existsSync(this.dir)) {
        for (const name of readdirSync(this.dir)) {
          const isLines = name.endsWith('.jsonl')
          const isLegacy = name.endsWith('.json')
          if (!isLines && !isLegacy) continue
          const terminalId = name.slice(0, name.lastIndexOf('.'))
          if (isLegacy && existsSync(this.fileFor(terminalId))) continue
          try {
            let records: TurnRecord[]
            if (isLines) {
              records = this.hydrate(
                terminalId,
                this.readLines(terminalId, path.join(this.dir, name)),
              )
              this.maybeFold(terminalId)
            } else {
              records = this.load(terminalId)
            }
            // Terminals with no usable records are OMITTED — the board's L3
            // layer relies on never having to filter empties itself.
            if (records.length > 0) all.set(terminalId, records)
          } catch {
            // one corrupt file, not the whole ledger
          }
        }
      }
    } catch (error) {
      console.error('Failed to walk the turn ledger:', error)
    }
    this.all = all
    return this.withPending(all)
  }

  /**
   * Layer debounced writes over a snapshot, so a search never misses the turn
   * that just finished — without baking them into the cache, which must stay a
   * faithful picture of what is actually on disk.
   */
  private withPending(base: Map<string, TurnRecord[]>): Map<string, TurnRecord[]> {
    if (this.pending.size === 0) return base
    const warm = new Map(base)
    for (const [terminalId, records] of this.pending) warm.set(this.safeId(terminalId), records)
    return warm
  }

  scheduleSave(terminalId: string, records: TurnRecord[]): void {
    this.pending.set(terminalId, records)
    this.dirty.set(terminalId, 'all')
    if (this.timers.has(terminalId)) return
    this.timers.set(
      terminalId,
      setTimeout(() => this.flush(terminalId), SAVE_DEBOUNCE_MS),
    )
  }

  /**
   * The delta pipeline's save (Sol r5 P1): the tracker names EXACTLY which
   * records changed, so flush can persist an append or a tail edit without
   * visiting the other N. `records` may be the tracker's live (tracker-owned)
   * buffer rather than a point-in-time copy — that is fine here because every
   * mutation of that buffer arrives through another scheduleDelta before the
   * debounced flush runs, so the dirty set always covers what the buffer
   * holds at flush time; like loadAll's cache, what this class holds is a
   * live picture, read through single-threaded event-loop turns.
   *
   * CONTRACT: `changed` must cover every record whose content differs from
   * the last save, and the change must be expressible as "records were
   * appended and/or the previously-last record changed". A mid-history edit
   * EXCEPTION: annotation-only mid-history edits (a Sous title landing on an
   * old record) are safe — no conversation line changes, so the tail check
   * stays valid; finalizeTitle relies on this.
   * or a shrink is NOT — those go through scheduleSave, the full path.
   */
  scheduleDelta(
    terminalId: string,
    records: TurnRecord[],
    changed: readonly TurnRecord[],
  ): void {
    this.pending.set(terminalId, records)
    const held = this.dirty.get(terminalId)
    if (held !== 'all') {
      const merged = held ?? new Map<number, TurnRecord>()
      for (const record of changed) merged.set(record.index, record)
      this.dirty.set(terminalId, merged)
    }
    if (this.timers.has(terminalId)) return
    this.timers.set(
      terminalId,
      setTimeout(() => this.flush(terminalId), SAVE_DEBOUNCE_MS),
    )
  }

  /**
   * The conversation half of a record, as one line. Cookrew's fields are
   * stripped out here and written to the annotations file instead — which is
   * also why an annotation-only change no longer alters any line.
   */
  private line(record: TurnRecord): string {
    return JSON.stringify(splitAnnotation(record).conversation)
  }

  private writeAll(terminalId: string, records: TurnRecord[]): void {
    mkdirSync(this.dir, { recursive: true })
    const body = records.map((r) => `${this.line(r)}\n`).join('')
    try {
      // Atomic (Sol r6 P2): a crash mid-rewrite must leave the previous
      // ledger, not a truncated hybrid — this file is the only durable copy
      // until the native transcript is re-parsed.
      writeFileAtomic(this.fileFor(terminalId), body)
    } catch (error) {
      // Ambiguous failure AFTER the rename landed (Sol r8 P1, the dir-fsync
      // window): the file now holds exactly `records` — only the directory
      // entry's durability is unproven. Remember that truthfully before
      // rethrowing: a retry that still believed the OLD tail would re-append
      // lines the file already carries, and duplicate physical records
      // corrupt the logical history — worse than the missed fsync retry.
      // The unproven durability itself is recorded as SEPARATE debt (Sol r9
      // P1), so the truthful tail cannot double as a claim of success: the
      // next flush must land the directory fsync before it may clear.
      if (renameLanded(error)) {
        this.dirDebt.add(terminalId)
        this.bumpGen(terminalId)
        this.remember(terminalId, records)
        this.cache(terminalId, records)
      }
      throw error
    }
    this.dirDebt.delete(terminalId) // writeFileAtomic proved the entry durable
    this.bumpGen(terminalId)
    this.remember(terminalId, records)
    this.cache(terminalId, records)
  }

  /** One physical mutation of this terminal's ledger file happened. */
  private bumpGen(terminalId: string): void {
    this.writeGen.set(terminalId, this.genOf(terminalId) + 1)
  }

  private genOf(terminalId: string): number {
    return this.writeGen.get(terminalId) ?? 0
  }

  /**
   * Keep loadAll()'s cache current rather than invalidating it, which would
   * force a full re-read of the ledger on the next request.
   */
  private cache(terminalId: string, records: TurnRecord[]): void {
    if (!this.all) return
    const key = this.safeId(terminalId)
    if (records.length > 0) this.all.set(key, records)
    else this.all.delete(key)
  }

  /** After a full rewrite: no overlays left, the last line IS the last record. */
  private remember(terminalId: string, records: TurnRecord[]): void {
    const last = records.length > 0 ? this.line(records[records.length - 1]) : ''
    this.written.set(terminalId, {
      count: records.length,
      lastLine: last,
      tailLine: last,
      lastIndex: records.length > 0 ? records[records.length - 1].index : -1,
      overlayLines: 0,
      overlayBytes: 0,
    })
    this.counts.set(terminalId, records.length)
  }

  private flush(terminalId: string): void {
    const timer = this.timers.get(terminalId)
    if (timer) clearTimeout(timer)
    this.timers.delete(terminalId)
    const records = this.pending.get(terminalId)
    this.pending.delete(terminalId)
    const dirty = this.dirty.get(terminalId) ?? 'all'
    this.dirty.delete(terminalId)
    if (!records) return

    // Cookrew's fields first: they are the only copy, whereas the conversation
    // below is a copy of the transcript. If one of the two writes fails, lose
    // the reproducible one. A delta save names its changed records, so the
    // annotation pass folds in exactly those instead of scanning every
    // checkpoint (Sol r5 P1); a full save still rebuilds from everything.
    // Both now REPORT failure instead of swallowing it (Sol r6 P1).
    const annotated =
      dirty === 'all'
        ? this.annotations.save(this.safeId(terminalId), records)
        : this.annotations.update(this.safeId(terminalId), [...dirty.values()])

    let conversed = false
    try {
      this.persistConversation(terminalId, records, dirty)
      // A current tail is not the whole truth (Sol r9 P1): a previous rename
      // may have landed with its directory entry unproven. Settle that debt
      // — retry the parent-directory fsync — before this flush may report
      // success; a throw here retains the work exactly like a failed write.
      this.settleDirDebt(terminalId)
      conversed = true
    } catch (error) {
      console.error('Failed to save turn history:', error)
    }
    // Fail closed (Sol r6 P1): anything that did not land goes back on the
    // dirty pile and the debounce retries it. Retrying the half that DID land
    // is free — the annotation store diffs to zero ops and the conversation
    // pass sees an already-current tail and writes nothing.
    if (!annotated || !conversed) this.retain(terminalId, records, dirty)
  }

  /**
   * Retry the parent-directory fsync a landed-but-unproven rename still owes
   * (see dirDebt). fsyncDirDurable throws on failure — and says PERSISTENT
   * STORAGE FAULT out loud on a repeat — so a standing durability hole keeps
   * the retained work retrying instead of being declared saved.
   */
  private settleDirDebt(terminalId: string): void {
    if (!this.dirDebt.has(terminalId)) return
    fsyncDirDurable(this.dir)
    this.dirDebt.delete(terminalId)
    // The debt is proven durable — any standing debt-only retry is moot.
    this.clearDebtRetry(terminalId)
  }

  /** Stop (and forget) the debt-only retry for a terminal. */
  private clearDebtRetry(terminalId: string): void {
    const timer = this.debtTimers.get(terminalId)
    if (timer) clearTimeout(timer)
    this.debtTimers.delete(terminalId)
    this.debtAttempts.delete(terminalId)
  }

  /**
   * Arm the debt-only retry (Sol r10 P1): an unref'd timer, doubling from
   * DIR_DEBT_RETRY_BASE_MS per failed attempt, capped. Single-flight per
   * terminal; a no-op when the debt is already settled. Fired by the fold's
   * dir-fsync failure — the one producer of debt with no later flush
   * guaranteed to retry it.
   */
  private scheduleDirDebtRetry(terminalId: string): void {
    if (!this.dirDebt.has(terminalId) || this.debtTimers.has(terminalId)) return
    const attempt = this.debtAttempts.get(terminalId) ?? 0
    const delay = Math.min(DIR_DEBT_RETRY_BASE_MS * 2 ** attempt, DIR_DEBT_RETRY_MAX_MS)
    const timer = setTimeout(() => {
      this.debtTimers.delete(terminalId)
      void this.retryDirDebt(terminalId)
    }, delay)
    timer.unref?.()
    this.debtTimers.set(terminalId, timer)
  }

  /** One debt-only retry attempt: settle the fsync or re-arm with backoff. */
  private async retryDirDebt(terminalId: string): Promise<void> {
    if (!this.dirDebt.has(terminalId)) {
      // A flush (or flushAll) settled it while the timer waited.
      this.debtAttempts.delete(terminalId)
      return
    }
    try {
      await this.fsyncDirAsync(this.dir)
      this.dirDebt.delete(terminalId)
      this.debtAttempts.delete(terminalId)
    } catch {
      // fsyncDirAsync already said PERSISTENT STORAGE FAULT out loud on a
      // repeat; the debt stays and the backoff doubles — retries stop only
      // when the fsync lands or the process ends (flushAll escalates last).
      this.debtAttempts.set(terminalId, (this.debtAttempts.get(terminalId) ?? 0) + 1)
      this.scheduleDirDebtRetry(terminalId)
    }
  }

  /**
   * fsyncDirDurable's ASYNC twin (Sol r10 P1) — same tolerance list, same
   * repeat-escalation contract, but the fsync runs on the libuv threadpool
   * via a FileHandle instead of blocking Electron main. Lives here rather
   * than widening turn-annotations: the synchronous callers (flush-time
   * settle, writeFileAtomic) keep their one shared implementation.
   */
  private async fsyncDirAsync(parent: string): Promise<void> {
    if (process.platform === 'win32') return // directories cannot be opened for fsync
    let handle: FileHandle | null = null
    try {
      handle = await open(parent, 'r')
      await handle.sync()
      asyncDirFsyncFaulted.delete(parent)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== undefined && DIR_FSYNC_UNSUPPORTED.has(code)) return
      if (asyncDirFsyncFaulted.has(parent)) {
        console.error(
          `PERSISTENT STORAGE FAULT: directory fsync keeps failing for ${parent} ` +
            `(${code ?? 'unknown'}) — renames are landing but their durability cannot be ` +
            'guaranteed; check permissions and disk health',
        )
      }
      asyncDirFsyncFaulted.add(parent)
      throw error
    } finally {
      // close() must not mask the fsync verdict either way.
      if (handle !== null) await handle.close().catch(() => {})
    }
  }

  /**
   * Put a failed flush's work back so the next flush retries it. flush() is
   * fully synchronous, so nothing can have re-populated pending/dirty between
   * its take and this restore. Bounded honesty: retries stop when the process
   * does — a write still failing at quit is logged, not silently dropped from
   * memory before then.
   */
  private retain(
    terminalId: string,
    records: TurnRecord[],
    dirty: Map<number, TurnRecord> | 'all',
  ): void {
    this.pending.set(terminalId, records)
    this.dirty.set(terminalId, dirty)
    if (this.timers.has(terminalId)) return
    this.timers.set(
      terminalId,
      setTimeout(() => this.flush(terminalId), SAVE_DEBOUNCE_MS),
    )
  }

  /**
   * The conversation half of one flush. Append when the history only GREW and
   * its previous last record is byte-identical to what we wrote; append an
   * OVERLAY superseding the tail when a delta save proved the change stops at
   * the previously-last record; otherwise rewrite. Every branch is O(changed
   * bytes) — the fold that clears overlay weight runs OUTSIDE this path (load
   * time or the scheduled idle task, Sol r8 P1). Throws on I/O failure — the
   * caller retains the un-landed records and retries.
   *
   * WHY THE FALLBACK STAYS after the annotation split. Two of the three edit
   * sources are gone from these lines — a seenAt stamp and a late Sous title
   * now change only the sidecar — but phantom-echo dedupe and session
   * reconcile still shrink and rewrite the conversation itself, and those must
   * not be silently appended over. The guard costs nothing when it does not
   * fire, so it stays until the scrape stops writing durable history at all
   * (step 4 of the design); only then are these lines truly append-only.
   */
  private persistConversation(
    terminalId: string,
    records: TurnRecord[],
    dirty: Map<number, TurnRecord> | 'all',
  ): void {
    const known = this.written.get(terminalId)
    const file = this.fileFor(terminalId)
    const extendable =
      known !== undefined && known.count > 0 && records.length >= known.count && existsSync(file)

    if (extendable) {
      const boundary = known.count - 1
      const boundaryRecord = records[boundary]
      if (this.line(boundaryRecord) === known.tailLine) {
        // Pure growth — or an annotation-only change, whose conversation
        // bytes are untouched and need no write at all. Overlay bookkeeping
        // carries over: nothing already in the file moved.
        if (records.length > known.count) {
          const added = records.slice(known.count).map((r) => `${this.line(r)}\n`)
          appendFileSync(file, added.join(''), 'utf8')
          this.bumpGen(terminalId)
          const lastLine = added[added.length - 1].slice(0, -1)
          this.written.set(terminalId, {
            ...known,
            count: records.length,
            lastLine,
            tailLine: lastLine,
            lastIndex: records[records.length - 1].index,
          })
          this.counts.set(terminalId, records.length)
        }
        this.cache(terminalId, records)
        return
      }
      // The last written line changed. On the delta path — where the dirty
      // set proves nothing BELOW that line changed — supersede just the tail
      // instead of rewriting every record (Sol r5 P1 / r7 P1): the common
      // shape is the open tail growing, or its finalized re-carry plus the
      // records behind it.
      const tailOnly =
        dirty !== 'all' && [...dirty.keys()].every((index) => index >= boundaryRecord.index)
      if (
        tailOnly &&
        boundaryRecord.index === known.lastIndex &&
        this.appendTailOverlay(terminalId, file, known, records, boundary)
      ) {
        this.cache(terminalId, records)
        return
      }
    }
    this.writeAll(terminalId, records)
  }

  /**
   * The tail-update leg of the delta path: ONE appended overlay line marks
   * the previously-last record superseded, then any newly-appended records
   * follow as plain lines — O(changed bytes), never a copy of the ledger
   * (Sol r7 P1; the r6 shape rewrote the whole file atomically per tail
   * delta, O(total history) every ~2s of a long active turn).
   *
   * Refuses (returns false, caller rewrites) unless the file still ENDS with
   * exactly the bytes the last flush left: the file is user-editable, and an
   * overlay landed on faith would shadow a record this process never knew
   * about. The check reads only the final line's length from the file — the
   * whole point is that nothing here scales with history size.
   *
   * When this overlay pushes the dead weight past the fold policy, the append
   * still happens — last-wins keeps every reader correct however many
   * overlays stack up — and the fold is SCHEDULED (see pendingCompact)
   * instead of performed here: the flush that crosses the threshold must
   * never pay the O(total history) rewrite on the hot path (Sol r8 P1; the
   * r7 shape refused the append and fell through to writeAll inside this
   * very flush, one tail observation copying the whole uncapped ledger).
   */
  private appendTailOverlay(
    terminalId: string,
    file: string,
    known: Written,
    records: TurnRecord[],
    boundary: number,
  ): boolean {
    if (!this.tailBytesMatch(file, Buffer.from(`${known.lastLine}\n`, 'utf8'))) return false
    const replacement = this.line(records[boundary])
    const overlay = tailOverlayLine(records[boundary].index, replacement)
    const overlayAdded = Buffer.byteLength(overlay, 'utf8') + 1
    const overlayLines = known.overlayLines + 1
    const overlayBytes = known.overlayBytes + overlayAdded
    const added = records.slice(boundary + 1).map((r) => `${this.line(r)}\n`)
    appendFileSync(file, `${overlay}\n${added.join('')}`, 'utf8')
    this.bumpGen(terminalId)
    const lastLine = added.length > 0 ? added[added.length - 1].slice(0, -1) : overlay
    this.written.set(terminalId, {
      count: records.length,
      lastLine,
      tailLine: added.length > 0 ? lastLine : replacement,
      lastIndex: records[records.length - 1].index,
      overlayLines,
      overlayBytes,
    })
    this.counts.set(terminalId, records.length)
    if (foldDue(overlayLines, overlayBytes, statSync(file).size)) {
      this.scheduleFold(terminalId)
    }
    return true
  }

  /**
   * Single-flight idle scheduling for the fold (load-time and write-path
   * alike). setTimeout(0) rather than the flush stack starts the ASYNC task
   * one macrotask later; the task itself then yields between every chunk, so
   * neither the flush that crossed the threshold nor any later event-loop
   * turn pays the O(total history) rewrite in one stretch (Sol r9 P1).
   * Unref'd so a pending fold never holds the app open — a quit before it
   * commits is recovered by the load-time fold on the next boot (temp +
   * rename keeps every intermediate state crash-safe).
   */
  private scheduleFold(terminalId: string): void {
    // The drain latch outranks everything (Sol r11 P1): shutdown is
    // draining folds, and a fresh one scheduled behind the drain would be
    // exactly the unowned debt-minting task the drain exists to end.
    if (this.foldsDraining) return
    if (this.pendingCompact.has(terminalId) || this.folding.has(terminalId)) return
    const timer = setTimeout(() => {
      this.pendingCompact.delete(terminalId)
      void this.foldNow(terminalId)
    }, 0)
    timer.unref?.()
    this.pendingCompact.set(terminalId, timer)
  }

  /**
   * The scheduled fold: one chunked, event-loop-friendly atomic rewrite of
   * the current logical records. Best-effort — a failure costs only the dead
   * bytes it would have cleared — and single-flight per terminal for the
   * WHOLE async run, not just the timer.
   *
   * THE RACE, AND THE CHOICE MADE (Sol r9 P1): flushes keep appending to the
   * ORIGINAL file while the fold runs — readers stay correct throughout,
   * last-wins per index — so a rename over a file that grew mid-fold would
   * silently drop those appends. This fold COMMITS ONLY ON A QUIET FILE: it
   * drains any queued flush first (synchronous, O(delta)), captures the
   * write generation, and re-verifies it in the same synchronous block as
   * the rename. A generation that moved aborts the temp and reschedules —
   * chosen over buffering-and-replaying racing appends because the abort
   * path has nothing to merge and therefore nothing to get wrong; under
   * sustained writes the overlays simply keep accumulating (correct, just
   * un-reclaimed) until a quiet window lets a fold land.
   */
  private foldNow(terminalId: string): Promise<void> {
    if (this.folding.has(terminalId) || this.foldsDraining) return Promise.resolve()
    // The promise is REGISTERED before it is awaited (Sol r11 P1), so a
    // drain that starts mid-fold has something to wait on; the entry dies
    // with the run itself.
    const run = this.runFold(terminalId).finally(() => {
      if (this.foldRuns.get(terminalId) === run) this.foldRuns.delete(terminalId)
    })
    this.foldRuns.set(terminalId, run)
    return run
  }

  /** The fold body foldNow registers — single-flight via `folding`. */
  private async runFold(terminalId: string): Promise<void> {
    this.folding.add(terminalId)
    let retry = false
    try {
      retry = !(await this.foldChunked(terminalId))
    } catch (error) {
      console.error('Failed to fold turn ledger tail overlays:', error)
    } finally {
      this.folding.delete(terminalId)
    }
    // Re-queue OUTSIDE the folding guard, or the reschedule would be
    // swallowed by the very single-flight that protects the task.
    if (retry) this.refold(terminalId)
  }

  /** An aborted fold re-queues itself while overlay weight remains. */
  private refold(terminalId: string): void {
    const known = this.written.get(terminalId)
    if (known === undefined || known.overlayLines === 0) return
    this.scheduleFold(terminalId)
  }

  /**
   * The fold body: read + parse in bounded chunks, serialize + write the
   * temp in bounded chunks, one yield between each, then commit with
   * fsync + rename + parent-dir fsync. Returns false ONLY when racing
   * writes outran the fold (the caller reschedules); true otherwise —
   * including the nothing-to-do exits.
   */
  private async foldChunked(terminalId: string): Promise<boolean> {
    // Drain the queued flush first (synchronous, O(delta)): the fold then
    // works from the current file with no pending records it could
    // double-persist, and the generation below covers everything after.
    if (this.timers.has(terminalId)) this.flush(terminalId)
    const file = this.fileFor(terminalId)
    if (!existsSync(file)) return true
    const known = this.written.get(terminalId)
    if (known !== undefined && known.overlayLines === 0) return true
    const gen = this.genOf(terminalId)
    const records = await this.readRecordsChunked(file)
    if (records.length === 0) return true
    if (this.genOf(terminalId) !== gen) return false
    return this.replaceChunked(terminalId, file, records, gen)
  }

  /**
   * readLines' recovery rules — drop what does not parse, last-wins per
   * checkpoint index, keep orphan overlays — applied in bounded chunks with
   * a yield after each, and with NO cache side effects: the fold commit
   * publishes its own bookkeeping, and an aborted fold must leave every
   * cache exactly as the live write path maintains it. Chunks split on the
   * newline BYTE, never mid-character: a UTF-8 code point can straddle a
   * read boundary, and decoding it early would corrupt the line.
   */
  private async readRecordsChunked(file: string): Promise<TurnRecord[]> {
    const records: TurnRecord[] = []
    const at = new Map<number, number>() // checkpoint index → position
    const place = (parsed: unknown, overlay: { supersedes: number } | null): void => {
      if (!isTurnRecord(parsed)) return
      if (overlay !== null) {
        const pos = at.get(parsed.index)
        if (pos !== undefined) {
          records[pos] = parsed
        } else {
          at.set(parsed.index, records.length)
          records.push(parsed)
        }
      } else {
        at.set(parsed.index, records.length)
        records.push(parsed)
      }
    }
    const apply = async (line: string): Promise<void> => {
      if (line.trim() === '') return
      const overlay = parseOverlay(line)
      const parsed = await this.parseFoldLine(overlay?.line ?? line)
      // null = the line does not parse — one bad line, not the file.
      if (parsed !== null) place(parsed.value, overlay)
    }
    // Oversized isolation (Sol r10 P1): a completed line region larger than
    // one read chunk means a single record line spans chunks. Its JSON.parse
    // is no longer the stated irreducible residual — past the 1 MB bound it
    // rides the fold worker (Sol r11 P1) — but the region's utf8 DECODE is
    // still one linear main-thread stretch, so the giant region keeps its
    // own unit between two yields.
    const applyRegion = async (region: Buffer): Promise<void> => {
      const oversized = region.length > FOLD_READ_CHUNK_BYTES
      if (oversized) await yieldToLoop()
      for (const line of region.toString('utf8').split('\n')) await apply(line)
      if (oversized) await yieldToLoop()
    }
    const handle = await open(file, 'r')
    try {
      const chunk = Buffer.allocUnsafe(FOLD_READ_CHUNK_BYTES)
      // The carry accumulates CHUNKS, concatenated ONCE per completed line
      // region (Sol r10 P1): the previous shape Buffer.concat'ed the whole
      // unterminated carry on every read, making one 10 MB line O(n²) in
      // copies. Invariant: no chunk in `carry` contains a newline, so only
      // the freshly read chunk needs searching.
      let carry: Buffer[] = []
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead <= 0) break
        const view = chunk.subarray(0, bytesRead)
        const cut = view.lastIndexOf(0x0a)
        if (cut === -1) {
          // Copies, because the read buffer is reused next iteration.
          carry.push(Buffer.from(view))
        } else {
          const region =
            carry.length > 0
              ? Buffer.concat([...carry, view.subarray(0, cut)])
              : view.subarray(0, cut)
          carry = []
          const rest = view.subarray(cut + 1)
          if (rest.length > 0) carry.push(Buffer.from(rest))
          await applyRegion(region)
        }
        await yieldToLoop()
      }
      if (carry.length > 0) {
        await applyRegion(carry.length === 1 ? carry[0] : Buffer.concat(carry))
      }
    } finally {
      await handle.close().catch(() => {})
    }
    return records
  }

  /**
   * JSON.parse for the fold (Sol r11 P1): ordinary lines in-thread, lines
   * past OVERSIZED_RECORD_BYTES in the worker. A worker-down answer falls
   * back to the synchronous parse — the codec already said so loudly, and
   * correctness never depended on the worker. Null = the line does not
   * parse under either engine; the caller drops it, exactly as readLines
   * does.
   */
  private async parseFoldLine(text: string): Promise<{ value: unknown } | null> {
    if (oversizedText(text)) {
      const answer = await this.foldCodec.parseOversized(text)
      if (answer.ok === true) return { value: answer.value }
      if (answer.ok === 'invalid') return null
    }
    try {
      return { value: JSON.parse(text) }
    } catch {
      return null
    }
  }

  /**
   * The record's conversation line for the fold's write half (Sol r11 P1):
   * the annotation split stays on this thread (O(fields)), and past the
   * worker bound the byte-proportional JSON.stringify crosses to the fold
   * worker — the returned line lands back as a memcpy. Worker down = the
   * synchronous stringify, correct at the old cost.
   */
  private async serializeFoldRecord(record: TurnRecord): Promise<string> {
    const conversation = splitAnnotation(record).conversation
    const answer = await this.foldCodec.serializeOversized(conversation)
    return answer.ok === true ? answer.value : JSON.stringify(conversation)
  }

  /**
   * The write half of the fold: BYTE-bounded serialization (Sol r10 P1 —
   * record-count chunks let 200 oversized records serialize as one stretch)
   * into a temp file of its own (`.fold.tmp` — writeFileAtomic's `.tmp` may
   * be claimed by a racing synchronous rewrite), written and fsync'ed
   * through an fs/promises FileHandle so the bytes and the durability wait
   * ride the libuv threadpool, never Electron main. Then ONE synchronous
   * commit block — verify the generation, rename, tail bookkeeping — with
   * no await between the verification and the rename: flush() runs on this
   * same thread, so nothing can append between the check and the swap (nor
   * between the swap and remember()). The parent-directory fsync is async
   * and AFTER the debt is recorded: a failure inside it cannot lose the
   * retry obligation, and it is settled by the next flush OR by the
   * debt-only retry timer (a quiet ledger has no next flush).
   */
  private async replaceChunked(
    terminalId: string,
    file: string,
    records: TurnRecord[],
    gen: number,
  ): Promise<boolean> {
    const temp = `${file}.fold.tmp`
    let mode: number | null = null
    try {
      mode = statSync(file).mode & 0o777
    } catch {
      // no file being replaced: the temp keeps the platform default
    }
    const handle = await open(temp, 'w')
    let closed = false
    try {
      if (mode !== null) await handle.chmod(mode)
      const writeOut = async (body: Buffer): Promise<void> => {
        let landed = 0
        while (landed < body.length) {
          const { bytesWritten } = await handle.write(body, landed, body.length - landed)
          if (bytesWritten <= 0) throw new Error(`short write folding ${temp}`)
          landed += bytesWritten
        }
      }
      let buffered: string[] = []
      let bufferedBytes = 0
      const flushBuffered = async (): Promise<void> => {
        if (bufferedBytes === 0) return
        const body = Buffer.from(buffered.join(''), 'utf8')
        buffered = []
        bufferedBytes = 0
        await writeOut(body)
        await yieldToLoop()
      }
      for (const record of records) {
        const weight = record.reply.length + record.prompt.length
        // Past the WORKER bound the stringify itself leaves this thread
        // (Sol r11 P1): round 10 called the giant record's JSON.stringify
        // the write side's irreducible residual, and the fold worker is the
        // stated way off. The line comes back as a memcpy; Buffer.from and
        // the write below are linear, bounded by the ordinary chunk
        // discipline's own units.
        if (weight >= OVERSIZED_RECORD_BYTES) {
          await flushBuffered()
          await yieldToLoop()
          await writeOut(Buffer.from(`${await this.serializeFoldRecord(record)}\n`, 'utf8'))
          await yieldToLoop()
          continue
        }
        // Oversized-but-under-the-worker-bound: detection BEFORE the
        // stringify, off the record's own text lengths — it runs ALONE
        // between two yields instead of on top of a full buffer's
        // serialization (Sol r10 P1).
        if (weight >= FOLD_SERIALIZE_CHUNK_BYTES) {
          await flushBuffered()
          await yieldToLoop()
          await writeOut(Buffer.from(`${this.line(record)}\n`, 'utf8'))
          await yieldToLoop()
          continue
        }
        const line = `${this.line(record)}\n`
        const bytes = Buffer.byteLength(line, 'utf8')
        if (bufferedBytes > 0 && bufferedBytes + bytes > FOLD_SERIALIZE_CHUNK_BYTES) {
          await flushBuffered()
        }
        buffered.push(line)
        bufferedBytes += bytes
      }
      await flushBuffered()
      // Durability on the handle, off-main: fsyncSync here blocked the event
      // loop for as long as slow storage cared to take (Sol r10 P1).
      await handle.sync()
      await handle.close()
      closed = true
    } catch (error) {
      if (!closed) await handle.close().catch(() => {})
      try {
        unlinkSync(temp)
      } catch {
        // the orphan is truncated and reused by the next fold attempt
      }
      throw error
    }
    // COMMIT — synchronous from here through the bookkeeping.
    if (this.genOf(terminalId) !== gen) {
      try {
        unlinkSync(temp)
      } catch {
        // the orphan is truncated and reused by the next fold attempt
      }
      return false
    }
    try {
      renameSync(temp, file)
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        // the orphan is truncated and reused by the next fold attempt
      }
      throw error
    }
    this.bumpGen(terminalId)
    // Debt FIRST, then the async fsync (Sol r10 P1): the directory entry is
    // unproven until the fsync lands, and recording the debt before any
    // await means neither a failure inside the async fsync nor a crash can
    // lose the retry obligation. The tail bookkeeping shares the rename's
    // synchronous stretch — a flush racing the awaited fsync below sees a
    // current written-tail, never a stale one.
    this.dirDebt.add(terminalId)
    this.remember(terminalId, records)
    this.cache(terminalId, this.hydrate(terminalId, records))
    try {
      await this.fsyncDirAsync(this.dir)
      this.dirDebt.delete(terminalId)
      this.clearDebtRetry(terminalId)
    } catch (error) {
      // The rename landed; only the entry's durability is unproven — the
      // same debt writeAll records. A flush settles it if one ever comes;
      // the debt-only retry covers the quiet ledger that never flushes
      // again (Sol r10 P1). A flush that settled it DURING the await above
      // makes this stale news: nothing left to schedule.
      if (this.dirDebt.has(terminalId)) {
        console.error(
          'Turn-ledger fold renamed but its directory entry is not yet durable:',
          error,
        )
        this.scheduleDirDebtRetry(terminalId)
      }
    }
    return true
  }

  /** Does the file end with exactly these bytes? Reads only that many. */
  private tailBytesMatch(file: string, expected: Buffer): boolean {
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size
      if (size < expected.length) return false
      const held = Buffer.allocUnsafe(expected.length)
      let got = 0
      while (got < expected.length) {
        const read = readSync(fd, held, got, expected.length - got, size - expected.length + got)
        if (read <= 0) return false
        got += read
      }
      return held.equals(expected)
    } finally {
      closeSync(fd)
    }
  }

  /** Drop a removed terminal's history file (node deletion). */
  remove(terminalId: string): void {
    const timer = this.timers.get(terminalId)
    if (timer) clearTimeout(timer)
    this.timers.delete(terminalId)
    const fold = this.pendingCompact.get(terminalId)
    if (fold) clearTimeout(fold)
    this.pendingCompact.delete(terminalId)
    // An in-flight ASYNC fold cannot be interrupted, but the bump makes its
    // commit-time generation check fail: it aborts its temp instead of
    // renaming the removed terminal's ledger back into existence.
    this.bumpGen(terminalId)
    this.pending.delete(terminalId)
    this.dirty.delete(terminalId)
    this.written.delete(terminalId)
    this.foldOnLoad.delete(terminalId)
    this.dirDebt.delete(terminalId)
    this.clearDebtRetry(terminalId)
    this.counts.delete(terminalId)
    this.all?.delete(this.safeId(terminalId))
    this.annotations.remove(this.safeId(terminalId))
    try {
      for (const file of [this.fileFor(terminalId), this.legacyFileFor(terminalId)]) {
        if (existsSync(file)) unlinkSync(file)
      }
    } catch (error) {
      console.error('Failed to remove turn history:', error)
    }
  }

  /** Bytes on disk for one agent — diagnostics for an uncapped history. */
  sizeOf(terminalId: string): number {
    try {
      const file = this.fileFor(terminalId)
      return existsSync(file) ? statSync(file).size : 0
    } catch {
      return 0
    }
  }

  /**
   * Write out every debounced save now (app quit) — and settle every
   * OUTSTANDING directory-fsync debt (Sol r10 P1): a fold-created debt has
   * no pending flush to ride, and quit is the last chance to prove its
   * rename durable or escalate the fault out loud. Synchronous on purpose:
   * shutdown must not await; fsyncDirDurable carries the repeat-escalation.
   *
   * POINT-IN-TIME by nature (Sol r11 P1): a fold still running when this
   * sweeps can rename AFTERWARDS and mint a debt this loop never saw. That
   * gap is drainFolds' job — the conductor awaits it in before-quit's async
   * tail, after this synchronous flush has landed the pending saves.
   */
  flushAll(): void {
    for (const terminalId of [...this.timers.keys()]) this.flush(terminalId)
    for (const terminalId of [...this.dirDebt]) {
      // A terminal whose flush just failed and RETAINED its work owns its
      // own retry (and already attempted this very fsync moments ago —
      // re-attempting here would turn one transient failure into an instant
      // repeat-escalation). This loop exists for the debt with no other
      // trigger: a fold-created debt on a quiet ledger.
      if (this.timers.has(terminalId)) continue
      try {
        this.settleDirDebt(terminalId)
      } catch (error) {
        console.error('Turn-ledger directory fsync still failing at final flush:', error)
      }
    }
  }

  /**
   * The shutdown drain for in-flight folds (Sol r11 P1). flushAll cannot
   * await, so its debt sweep misses exactly one shape: a fold that was
   * paused mid-write when the sweep ran, renamed afterwards, and had its
   * async directory fsync fail — a durability obligation minted AFTER the
   * last synchronous look. This closes it, bounded:
   *
   *   1. LATCH — no new fold may be scheduled or started, and every
   *      scheduled-but-unstarted timer is cancelled (its overlay weight is
   *      the load-time fold's to reclaim next boot);
   *   2. AWAIT — every in-flight fold, up to `capMs`;
   *   3. REVOKE — a fold still running past the cap has its generation
   *      bumped, so its commit-time check refuses the rename: after this
   *      line no rename, and therefore no new debt, can appear;
   *   4. SETTLE — every outstanding debt, through the synchronous
   *      fsyncDirDurable (repeat-escalation included), created before OR
   *      during the drain.
   *
   * The conductor awaits this in before-quit's async tail, alongside
   * cancelAllAsks, before app.quit. Also tears the fold worker down: past
   * the latch nothing can need it.
   */
  async drainFolds(capMs: number): Promise<void> {
    this.foldsDraining = true
    for (const timer of this.pendingCompact.values()) clearTimeout(timer)
    this.pendingCompact.clear()
    if (this.foldRuns.size > 0) {
      await Promise.race([
        Promise.all([...this.foldRuns.values()]).then(
          () => undefined,
          () => undefined
        ),
        sleepUnref(capMs)
      ])
    }
    // Revocation and the folds' own commit blocks share this thread: the
    // gen check + rename is one synchronous stretch, so after these bumps a
    // late fold aborts its temp instead of renaming behind the sweep below.
    for (const terminalId of this.foldRuns.keys()) this.bumpGen(terminalId)
    for (const terminalId of [...this.dirDebt]) {
      try {
        this.settleDirDebt(terminalId)
      } catch (error) {
        console.error('Turn-ledger directory fsync still failing at fold drain:', error)
      }
    }
    this.foldCodec.dispose()
  }
}
