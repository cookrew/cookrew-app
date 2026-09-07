// THE OLD STORE, READ-ONLY (one-stream T4, 2026-09-07).
//
// ~/.cookrew/turns/<terminalId>.jsonl was a second copy of every conversation:
// 34 MB over 279 files, with tail overlays, a fold worker, a rebuild and a
// renumbering ledger stacked on top of it to keep the copy agreeing with the
// source. The design (docs/site/one-stream-2026-09-07.html) names that copy as
// the cause of every checkpoint incident this codebase has had — the 400+
// checkpoints that went unaddressable at a compact, the cap that deleted
// history on 2026-09-06, the phantom rail rows the renderer clamped around —
// and T4 stops writing it.
//
// WHAT IS LEFT, AND WHY IT IS LEFT. The design's migration step 2, verbatim:
// "the old store is kept read-only for one release under the same path, and
// the old routes keep answering from it behind a flag, so a regression is a
// flag flip, not a restore." COOKREW_STREAM_ADAPTERS=0 sends /turns, /latest
// and the three /trace routes back through this reader
// (stream-adapters.ts documents the rollback). T5 retires it.
//
// SO THERE IS NO WRITER HERE AT ALL, and that is enforced by absence rather
// than by a comment: scheduleSave, scheduleDelta, flush, writeAll, the tail
// overlay append, the bounded fold and its worker, the write-generation
// counter and the directory-fsync debt are gone with the copy they defended.
// A PTY-scraped agent still has no transcript to derive from and still needs
// its history persisted — that is scrape-history.ts, one small append-only
// writer with one job, never reached for a 'file' or 'door' card.
//
// IT STILL READS OVERLAYS. The ledgers ON DISK were written by the old writer
// and are full of them:
//
//   {"__tail":true,"supersedes":<index>,<…the record's own fields…>}
//
// meaning "the newest version of checkpoint <index> is this line". Last-wins
// per index. Deleting the parser with the writer would have blanked the tail
// of every ledger the rollback path reads — which is the one job this module
// still has.
//
// EVERY CACHE IS STAT-VALIDATED, and that is a change. The old caches were
// write-through: this process was the only writer, so what it had written was
// what the file held. It is not the only writer any more (scrape-history.ts
// is, and a repair tool may be), so `hot` and `all` now re-read whenever the
// file's size/mtime/inode has moved. A stat is microseconds; a wrong answer
// about an agent's history is the thing this whole phase exists to remove.

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { mergeAnnotation, type TurnRecord } from '../shared/turn'
import { AnnotationStore } from './turn-annotations'

/**
 * How many terminals' ledgers load() keeps parsed in its LRU (see `hot`).
 *
 * Sized for the agents actually taking turns — deliberately not for a board or
 * search sweep, whose one-shot pass over every agent must not leave a full copy
 * of every ledger resident. loadAll has its own cache for that.
 */
const HOT_LEDGERS = 8

/** Byte-exact prefix of every overlay line the retired writer produced. */
const TAIL_MARKER_PREFIX = '{"__tail":true,"supersedes":'

/**
 * Recognize an overlay line, recovering the EXACT record line it carries —
 * '{' plus everything past the marker — and the index it supersedes. Null for
 * a plain record line, or for anything not in that writer's canonical shape.
 */
function parseOverlay(raw: string): { supersedes: number; line: string } | null {
  if (!raw.startsWith(TAIL_MARKER_PREFIX)) return null
  const comma = raw.indexOf(',', TAIL_MARKER_PREFIX.length)
  if (comma === -1) return null
  const digits = raw.slice(TAIL_MARKER_PREFIX.length, comma)
  if (!/^\d+$/.test(digits)) return null
  return { supersedes: Number(digits), line: `{${raw.slice(comma + 1)}` }
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

/** A parsed ledger plus the stat it was taken at. */
interface CachedLedger {
  records: TurnRecord[]
  stamp: string
}

export class TurnStore {
  /**
   * Cached LOGICAL record count per terminal, keyed alongside the stamp it was
   * measured at. count() is polled by the activity projection, and a
   * synchronous reparse of an uncapped ledger per poll is what the cache
   * exists to avoid.
   */
  private counts = new Map<string, { count: number; stamp: string }>()

  /** Per-terminal LRU of parsed ledgers, each with the stat it came from. */
  private hot = new Map<string, CachedLedger>()

  /** Whole-ledger cache for loadAll(), UNBOUNDED and stat-validated per call. */
  private all = new Map<string, CachedLedger>()

  /**
   * The ledger file as it stood when this store last read it —
   * `size:mtimeMs:ino`. Never evicted: `hot` is LRU-bounded for memory, and
   * viewIsStale's answer must not change because a cache was trimmed.
   */
  private fileStamps = new Map<string, string>()

  /**
   * Cookrew's own fields (title / seenAt / scrollLine) live in a sidecar
   * instead of on the conversation lines. A STORAGE split only: records come
   * back out whole, so nothing above this class can tell.
   */
  private annotations: AnnotationStore

  /**
   * Where the annotations went. Exposed so the one invariant that matters can
   * be asserted rather than assumed: this path is NEVER inside `dir`.
   */
  readonly annotationsDir: string

  /**
   * `annotationsDir` defaults to a SIBLING of the turns directory, never a
   * child of it. The ledger is derived and documented as safe to delete, so
   * anything a transcript cannot regenerate has to live where `rm -rf <turns>`
   * cannot reach it.
   */
  constructor(
    /** Public so the one remaining writer (scrape-history.ts) can be built
     *  over the SAME two directories rather than re-deriving them. */
    readonly dir = path.join(homedir(), '.cookrew', 'turns'),
    annotationsDir = path.resolve(dir, '..', 'checkpoint-annotations')
  ) {
    this.annotationsDir = annotationsDir
    this.annotations = new AnnotationStore(annotationsDir)
  }

  private safeId(terminalId: string): string {
    return terminalId.replace(/[^a-zA-Z0-9_-]/g, '')
  }

  fileFor(terminalId: string): string {
    return path.join(this.dir, `${this.safeId(terminalId)}.jsonl`)
  }

  /** Pre-JSONL format: one pretty-printed array per terminal. */
  private legacyFileFor(terminalId: string): string {
    return path.join(this.dir, `${this.safeId(terminalId)}.json`)
  }

  /**
   * A stat-shaped fingerprint of the ledger file — size, mtime and inode.
   * Never a read, never a parse. 'absent' when there is no file, which is a
   * value like any other: it changes the moment one appears.
   */
  private stampOf(terminalId: string): string {
    try {
      const stat = statSync(this.fileFor(terminalId))
      return `${stat.size}:${stat.mtimeMs}:${stat.ino}`
    } catch {
      return 'absent'
    }
  }

  /**
   * Put Cookrew's fields back on the conversation records — the read half of
   * the storage split. The annotation wins where it has a value, but a record
   * keeps anything the annotation lacks, so a file written BEFORE the split
   * (title/seenAt still inline) reads back unchanged.
   */
  private hydrate(terminalId: string, records: TurnRecord[]): TurnRecord[] {
    const byIndex = this.annotations.load(this.safeId(terminalId))
    if (byIndex.size === 0) return records
    return records.map((record) => mergeAnnotation(record, byIndex.get(record.index)))
  }

  /**
   * Read the lines file, dropping any line that will not parse — a single
   * corrupt line must not blank an agent's whole history. An overlay line
   * replaces the record it supersedes IN PLACE, so callers see the logical
   * history whatever mix of plain and overlay lines the file holds.
   */
  private readLines(file: string): TurnRecord[] {
    const records: TurnRecord[] = []
    const at = new Map<number, number>() // checkpoint index → position
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const overlay = parseOverlay(line)
      try {
        const parsed: unknown = JSON.parse(overlay?.line ?? line)
        if (!isTurnRecord(parsed)) continue
        const pos = overlay === null ? undefined : at.get(parsed.index)
        if (pos !== undefined) {
          records[pos] = parsed
          continue
        }
        at.set(parsed.index, records.length)
        records.push(parsed)
      } catch {
        // one bad line, not the file
      }
    }
    return records
  }

  /**
   * A legacy array file, READ ONLY.
   *
   * The old store converted these to JSONL on first touch and renamed the
   * original to `.migrated`. A read-only store cannot: converting is a write,
   * and this is the only copy of a history that predates the lines format. So
   * the array is parsed and returned as it stands, every time — the file is
   * small by construction (it predates the uncapped era) and there is nothing
   * left that would ever grow it.
   */
  private readLegacy(terminalId: string): TurnRecord[] | null {
    const legacy = this.legacyFileFor(terminalId)
    if (!existsSync(legacy)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(legacy, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(isTurnRecord) : []
    } catch (error) {
      console.error('Failed to read the legacy turn history:', error)
      return null
    }
  }

  /** Remember a parse against the stat it came from, keeping the LRU bounded. */
  private warm(terminalId: string, records: TurnRecord[], stamp: string): void {
    this.fileStamps.set(terminalId, stamp)
    this.hot.delete(terminalId) // re-insert last: Map order is the LRU order
    this.hot.set(terminalId, { records, stamp })
    this.counts.set(terminalId, { count: records.length, stamp })
    while (this.hot.size > HOT_LEDGERS) {
      const oldest = this.hot.keys().next()
      if (oldest.done) break
      this.hot.delete(oldest.value)
    }
  }

  /**
   * The durable history for a terminal.
   *
   * SERVED FROM A STAT-VALIDATED CACHE. The read underneath is a full parse of
   * an uncapped ledger on the Electron main thread — measured at 64.7ms for
   * 5,000 records — and a caller that cannot trust its own copy has to ask
   * repeatedly. So the parse is skipped when the file is byte-for-byte the one
   * this store last read, and a stat is microseconds.
   *
   * A COPY is returned: callers keep and mutate what they get.
   */
  load(terminalId: string): TurnRecord[] {
    try {
      const file = this.fileFor(terminalId)
      if (!existsSync(file)) return this.readLegacy(terminalId) ?? []
      const stamp = this.stampOf(terminalId)
      const hot = this.hot.get(terminalId)
      if (hot && hot.stamp === stamp) {
        this.hot.delete(terminalId) // touch: re-insert last, so LRU order holds
        this.hot.set(terminalId, hot)
        return [...hot.records]
      }
      const records = this.hydrate(terminalId, this.readLines(file))
      this.warm(terminalId, records, stamp)
      return [...records]
    } catch (error) {
      console.error('Failed to load turn history:', error)
      return []
    }
  }

  /**
   * IS THIS STORE'S VIEW OF THE LEDGER STILL THE LEDGER? False means the file
   * is byte-for-byte the one it last read, so everything derived from it is
   * current. One stat, no parse.
   */
  viewIsStale(terminalId: string): boolean {
    const observed = this.fileStamps.get(terminalId)
    if (observed === undefined) return false
    return observed !== this.stampOf(terminalId)
  }

  /**
   * How many checkpoints this agent has, counted with the SAME recovery rules
   * readLines applies: a line that does not parse is dropped, a canonical
   * overlay supersedes an existing record without adding one. The count and
   * the reader must not use incompatible recovery rules — they diverged once,
   * on exactly the corruption this store promises to tolerate.
   */
  count(terminalId: string): number {
    const stamp = this.stampOf(terminalId)
    const cached = this.counts.get(terminalId)
    if (cached !== undefined && cached.stamp === stamp) return cached.count
    try {
      const file = this.fileFor(terminalId)
      if (!existsSync(file)) return this.readLegacy(terminalId)?.length ?? 0
      const count = this.readLines(file).length
      this.counts.set(terminalId, { count, stamp })
      return count
    } catch {
      return 0
    }
  }

  /**
   * The newest `n` checkpoints. Cards and the rail open on the recent end, so
   * attaching to a 5,000-turn agent hands back 200 records rather than all.
   */
  loadTail(terminalId: string, n: number): TurnRecord[] {
    const all = this.load(terminalId)
    return n >= all.length ? all : all.slice(all.length - n)
  }

  /**
   * Every agent's checkpoints, across every workspace — the board's ledger
   * layer and the corpus checkpoint search runs over.
   *
   * STAT-VALIDATED PER ENTRY rather than write-through. The old cache was
   * kept warm by this store's own flush, which was sound while this process
   * was the only writer; it is not any more (scrape-history.ts), so each
   * entry is re-read exactly when its file has moved. 258 stats is under a
   * millisecond and cannot be wrong.
   */
  loadAll(): Map<string, TurnRecord[]> {
    const answer = new Map<string, TurnRecord[]>()
    try {
      if (!existsSync(this.dir)) return answer
      for (const name of readdirSync(this.dir)) {
        const isLines = name.endsWith('.jsonl')
        const isLegacy = name.endsWith('.json')
        if (!isLines && !isLegacy) continue
        const terminalId = name.slice(0, name.lastIndexOf('.'))
        if (isLegacy && existsSync(this.fileFor(terminalId))) continue
        const records = this.forAll(terminalId, isLines, path.join(this.dir, name))
        // Terminals with no usable records are OMITTED — the board's ledger
        // layer relies on never having to filter empties itself.
        if (records.length > 0) answer.set(terminalId, records)
      }
    } catch (error) {
      console.error('Failed to walk the turn ledger:', error)
    }
    return answer
  }

  /** One loadAll entry, from the cache when its file has not moved. */
  private forAll(terminalId: string, isLines: boolean, file: string): TurnRecord[] {
    try {
      if (!isLines) return this.readLegacy(terminalId) ?? []
      const stamp = this.stampOf(terminalId)
      const cached = this.all.get(terminalId)
      if (cached !== undefined && cached.stamp === stamp) return cached.records
      const records = this.hydrate(terminalId, this.readLines(file))
      this.all.set(terminalId, { records, stamp })
      return records
    } catch {
      return [] // one corrupt file, not the whole ledger
    }
  }

  /**
   * Drop a removed terminal's history file (node deletion).
   *
   * The ONE thing this module still changes on disk, and it is an erasure, not
   * a write: a deleted card's conversation copy has no owner and no reader,
   * and leaving it is residue rather than history. Nothing here can create or
   * extend a ledger.
   */
  remove(terminalId: string): void {
    this.counts.delete(terminalId)
    this.hot.delete(terminalId)
    this.all.delete(terminalId)
    this.fileStamps.delete(terminalId)
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
}
