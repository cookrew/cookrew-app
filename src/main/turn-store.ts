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
// Writes are debounced per terminal; TurnTracker flushes on app quit.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { mergeAnnotation, splitAnnotation, type TurnRecord } from '../shared/turn'
import { AnnotationStore, writeFileAtomic } from './turn-annotations'

const SAVE_DEBOUNCE_MS = 300

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
  count: number
  /** Serialized form of the final record — an edit to it forces a rewrite. */
  lastLine: string
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
   * corrupt line must not blank an agent's whole history.
   *
   * COLD-START SEEDING (Sol r6 P1): a CLEAN read — every line parsed, file
   * newline-terminated — also seeds the written-tail metadata, with the RAW
   * last line as it sits on disk. Without this the first scheduleDelta after
   * a restart found no `written` entry and fell through to a whole-file
   * rewrite, making persistence O(delta) only until the next boot. Raw bytes,
   * not a re-serialization, so the extend/append decision and the tail
   * verification compare against exactly what the file holds; a hand-edited
   * line that no longer serializes identically simply fails the boundary
   * check and takes the safe full rewrite. A NON-clean read (corrupt or
   * truncated lines the parse dropped) clears the entry instead: appending
   * relative to a count the file does not actually have would land records
   * in the wrong place.
   */
  private readLines(terminalId: string, file: string): TurnRecord[] {
    const records: TurnRecord[] = []
    const text = readFileSync(file, 'utf8')
    let clean = text === '' || text.endsWith('\n')
    let lastLine = ''
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isTurnRecord(parsed)) {
          records.push(parsed)
          lastLine = line
        } else {
          clean = false
        }
      } catch {
        // one bad line, not the file
        clean = false
      }
    }
    if (clean) this.written.set(terminalId, { count: records.length, lastLine })
    else this.written.delete(terminalId)
    return records
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
      if (existsSync(file)) return this.hydrate(terminalId, this.readLines(terminalId, file))
      return this.migrate(terminalId) ?? []
    } catch (error) {
      console.error('Failed to load turn history:', error)
      return []
    }
  }

  /**
   * How many checkpoints this agent has, WITHOUT parsing any of them. This is
   * what makes an uncapped history affordable to display: the count is exact
   * even when only a tail is held in memory.
   */
  count(terminalId: string): number {
    const pending = this.pending.get(terminalId)
    if (pending) return pending.length
    try {
      const file = this.fileFor(terminalId)
      if (!existsSync(file)) return this.migrate(terminalId)?.length ?? 0
      let lines = 0
      const text = readFileSync(file, 'utf8')
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
      // A trailing newline is written after every record, so lines === records
      // unless the file ends mid-write.
      return text.endsWith('\n') ? lines : lines + 1
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
            const records = isLines
              ? this.hydrate(terminalId, this.readLines(terminalId, path.join(this.dir, name)))
              : this.load(terminalId)
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
    // Atomic (Sol r6 P2): a crash mid-rewrite must leave the previous ledger,
    // not a truncated hybrid — this file is the only durable copy until the
    // native transcript is re-parsed.
    writeFileAtomic(this.fileFor(terminalId), body)
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

  private remember(terminalId: string, records: TurnRecord[]): void {
    this.written.set(terminalId, {
      count: records.length,
      lastLine: records.length > 0 ? this.line(records[records.length - 1]) : '',
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
   * its previous last record is byte-identical to what we wrote; replace just
   * the tail when a delta save proved the change stops at the previously-last
   * record; otherwise rewrite. Throws on I/O failure — the caller retains the
   * un-landed records and retries.
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
      if (this.line(boundaryRecord) === known.lastLine) {
        // Pure growth — or an annotation-only change, whose conversation
        // bytes are untouched and need no write at all.
        if (records.length > known.count) {
          const added = records.slice(known.count).map((r) => `${this.line(r)}\n`)
          appendFileSync(file, added.join(''), 'utf8')
        }
        this.remember(terminalId, records)
        this.cache(terminalId, records)
        return
      }
      // The last written line changed. On the delta path — where the dirty
      // set proves nothing BELOW that line changed — replace just the tail
      // instead of rewriting every record (Sol r5 P1): the common shape is
      // a finalized re-carry of the open tail plus the records behind it.
      const tailOnly =
        dirty !== 'all' && [...dirty.keys()].every((index) => index >= boundaryRecord.index)
      if (tailOnly && this.rewriteTail(file, known.lastLine, records.slice(boundary))) {
        this.remember(terminalId, records)
        this.cache(terminalId, records)
        return
      }
    }
    this.writeAll(terminalId, records)
  }

  /**
   * Replace the file's LAST line and append from there — the tail-update leg
   * of the delta path. Refuses (returns false, caller rewrites) unless the
   * bytes about to be replaced are EXACTLY the line the last flush wrote:
   * the file is user-editable, and replacing on faith could eat a record
   * this process never knew about.
   *
   * ATOMIC, NOT IN-PLACE (Sol r6 P2). The previous shape — truncate the old
   * tail, then append the replacement — destroyed the only ledger copy's last
   * record BEFORE the new bytes existed: a crash or append failure in that
   * window lost it until a native re-parse happened to rebuild the file. Now
   * the prefix plus the new tail go to a temp file, fsync, rename
   * (writeFileAtomic): the old bytes stay durable until the replacement is.
   * THE TRADE-OFF, stated plainly: this makes the tail-change write O(file)
   * bytes where truncate+append was O(one line). It is bounded — one line per
   * turn, ~1.4 MB on the largest agent observed — and it buys the same
   * crash-safety contract the annotation sidecar and dispatch registry
   * already hold; the hot append path is untouched. If profiling ever shows
   * this copy mattering, the next step is a segment strategy, not a return to
   * the crash-lossy window.
   */
  private rewriteTail(file: string, lastLine: string, tail: readonly TurnRecord[]): boolean {
    const expected = Buffer.from(`${lastLine}\n`, 'utf8')
    const held = readFileSync(file)
    if (held.length < expected.length) return false
    if (!held.subarray(held.length - expected.length).equals(expected)) return false
    const prefix = held.subarray(0, held.length - expected.length)
    const replacement = Buffer.from(tail.map((r) => `${this.line(r)}\n`).join(''), 'utf8')
    writeFileAtomic(file, Buffer.concat([prefix, replacement]))
    return true
  }

  /** Drop a removed terminal's history file (node deletion). */
  remove(terminalId: string): void {
    const timer = this.timers.get(terminalId)
    if (timer) clearTimeout(timer)
    this.timers.delete(terminalId)
    this.pending.delete(terminalId)
    this.dirty.delete(terminalId)
    this.written.delete(terminalId)
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
