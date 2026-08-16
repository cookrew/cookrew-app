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
// their bytes reach half the file, ONE atomic full rewrite (writeAll) folds
// them away — at load time (the dispatch-registry pattern) or as a SCHEDULED
// idle task when a write crosses the line (Sol r8 P1: the flush that crosses
// the threshold never pays the rewrite itself). Amortized, every write is
// O(changed bytes): the fold's O(file) cost is paid for by an equal weight of dead
// bytes it removes. TurnStore is the ONLY reader of these files (board,
// search, rebuild-diff all go through load/loadAll; ledger-rebuild reads
// harness transcripts) — anything new that parses the raw JSONL must apply
// the same last-wins rule.
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
import { homedir } from 'node:os'
import path from 'node:path'
import { mergeAnnotation, splitAnnotation, type TurnRecord } from '../shared/turn'
import { AnnotationStore, renameLanded, writeFileAtomic } from './turn-annotations'

const SAVE_DEBOUNCE_MS = 300

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
   * The load-time half of overlay compaction: one atomic rewrite when the
   * last read flagged the fold, holding the HYDRATED records so the loadAll
   * cache (which stores records annotations-on) stays truthful. Best-effort —
   * a failed fold costs nothing but the dead bytes it would have cleared, and
   * the write-path fold retries the same policy.
   */
  private maybeFold(terminalId: string, hydrated: TurnRecord[]): void {
    if (!this.foldOnLoad.delete(terminalId)) return
    try {
      this.writeAll(terminalId, hydrated)
    } catch (error) {
      console.error('Failed to fold turn ledger tail overlays:', error)
    }
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
        this.maybeFold(terminalId, records)
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
   * incompatible recovery rules. Still lighter than load(): shapes only — no
   * hydration, no record retention, no append-tail metadata side effects.
   */
  count(terminalId: string): number {
    const pending = this.pending.get(terminalId)
    if (pending) return pending.length
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
              this.maybeFold(terminalId, records)
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
      if (renameLanded(error)) {
        this.remember(terminalId, records)
        this.cache(terminalId, records)
      }
      throw error
    }
    this.remember(terminalId, records)
    this.cache(terminalId, records)
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
          const lastLine = added[added.length - 1].slice(0, -1)
          this.written.set(terminalId, {
            ...known,
            count: records.length,
            lastLine,
            tailLine: lastLine,
            lastIndex: records[records.length - 1].index,
          })
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
    const lastLine = added.length > 0 ? added[added.length - 1].slice(0, -1) : overlay
    this.written.set(terminalId, {
      count: records.length,
      lastLine,
      tailLine: added.length > 0 ? lastLine : replacement,
      lastIndex: records[records.length - 1].index,
      overlayLines,
      overlayBytes,
    })
    if (foldDue(overlayLines, overlayBytes, statSync(file).size)) {
      this.scheduleFold(terminalId)
    }
    return true
  }

  /**
   * Single-flight idle scheduling for the write-path fold. setTimeout(0)
   * rather than the flush stack: the rewrite lands one macrotask later,
   * bounding overlay growth past the threshold to whatever that single delay
   * admits (in practice at most one more flush cycle). Unref'd so a pending
   * fold never holds the app open — a quit before it runs is recovered by the
   * load-time fold on the next boot.
   */
  private scheduleFold(terminalId: string): void {
    if (this.pendingCompact.has(terminalId)) return
    const timer = setTimeout(() => this.foldNow(terminalId), 0)
    timer.unref?.()
    this.pendingCompact.set(terminalId, timer)
  }

  /**
   * The scheduled half of the write-path fold: ONE atomic rewrite of the
   * current logical records, off every flush stack. Best-effort like the
   * load-time fold — a failure costs only the dead bytes it would have
   * cleared, and the overlay bookkeeping (still past the policy) reschedules
   * on the next overlay append.
   */
  private foldNow(terminalId: string): void {
    this.pendingCompact.delete(terminalId)
    try {
      // load() serves pending records when a flush is queued (they are the
      // newest truth and every reader already sees them), and may itself run
      // the load-time fold — in which case the bookkeeping below shows zero
      // overlays and this task has nothing left to do.
      const records = this.load(terminalId)
      const known = this.written.get(terminalId)
      if (known !== undefined && known.overlayLines === 0) return
      if (records.length === 0) return
      this.writeAll(terminalId, records)
    } catch (error) {
      console.error('Failed to fold turn ledger tail overlays:', error)
    }
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
    this.pending.delete(terminalId)
    this.dirty.delete(terminalId)
    this.written.delete(terminalId)
    this.foldOnLoad.delete(terminalId)
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

  /** Write out every debounced save now (app quit). */
  flushAll(): void {
    for (const terminalId of [...this.timers.keys()]) this.flush(terminalId)
  }
}
