// THE ONE PLACE A CONVERSATION IS STILL COPIED (one-stream T4, 2026-09-07).
//
// The design's rule is that the transcript is the record and nothing about the
// conversation is written twice. It states the single exception in the same
// breath: "For a harness with no file ('scrape' in transcript-source.ts) the
// PTY tracker still provides it — that is the one place scraping remains."
// ledger-rebuild said the same thing before it was deleted: for a scrape-only
// harness "the ledger is the ONLY record and deleting it really does lose
// history". OpenCode is one; so is any agent binary no harness matches.
//
// So this exists, and it is as small as that job allows:
//
//   · IT IS NEVER REACHED FOR A 'file' OR 'door' CARD. TurnTracker calls it
//     only where writesFromFile() is false. That is not a convention — it is
//     the reason turn-store.ts could become a reader: the two writers this
//     module replaced (scheduleSave and scheduleDelta) were called from the
//     reconcile path, which is exactly the path that had a transcript behind
//     it all along.
//   · IT IS SYNCHRONOUS AND UNBUFFERED. The old store debounced at 300ms and
//     grew a pending map, a dirty map, a write-generation counter and a
//     shutdown drain around it — all to make a per-poll tail rewrite
//     affordable. A scrape card writes once per COMPLETED TURN (poll() calls
//     it after the reply settles), which is minute-scale, so the debounce
//     bought nothing and cost a flushAll on every exit path.
//   · IT APPENDS WHEN IT CAN. A completed turn is one new record on the end,
//     so the common write is one line. Anything else — a dedupe that dropped
//     a phantom twin, a record edited in place — is a full atomic rewrite,
//     which is affordable precisely because a scrape ledger is short.
//   · NO TAIL OVERLAYS. They existed because the parser lane rewrote the OPEN
//     turn every ~2s; a scrape record is only ever written once it is closed.
//     The overlay lines a pre-T4 ledger already holds are read back by
//     turn-store's parser and folded away by the first rewrite here.
//
// TITLES AND SEEN-ATS DO NOT COME THROUGH HERE. They go to the annotation
// sidecar (turn-annotations.ts), the same one turn-store reads back, so a
// Sous title landing on an old record touches no conversation line.
//
// IT READS BEFORE IT WRITES, ALWAYS. A freshly constructed writer pointed at
// an existing ledger once wrote 22 records over the 542 it had never opened.
// Rather than refuse that write, this reads the ledger through TurnStore's own
// reader on first touch — so "what is on disk" is a fact here, not a premise,
// and an append can only ever be an append.

import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { splitAnnotation, type TurnRecord } from '../shared/turn'
import { AnnotationStore, writeFileAtomic } from './turn-annotations'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './atomic-file'
import { TurnStore } from './turn-store'

/** What the last write left behind, so the next one can tell append from edit. */
interface Written {
  /** The exact conversation lines, in order, this writer believes are there. */
  lines: string[]
  /** The file's stat when it did — the premise the next append rests on. */
  stamp: string
}

export interface ScrapeHistoryResult {
  ok: boolean
  /** 'append' | 'rewrite' | 'unchanged', or the failure's message. */
  detail: string
}

/** Enough of TurnStore to learn what the ledger already holds. */
export type LedgerReader = Pick<TurnStore, 'load'>

export class ScrapeHistoryStore {
  private written = new Map<string, Written>()
  private annotations: AnnotationStore
  private reader: LedgerReader

  /**
   * Same directories as TurnStore, deliberately: this writes the ledger that
   * reader reads, under the one path the rollback route knows. The annotation
   * sidecar stays a SIBLING of the turns directory, never a child — the
   * ledger is documented as safe to delete and an annotation is not
   * regenerable.
   */
  constructor(
    private dir = path.join(homedir(), '.cookrew', 'turns'),
    annotationsDir = path.resolve(dir, '..', 'checkpoint-annotations'),
    reader?: LedgerReader
  ) {
    this.annotations = new AnnotationStore(annotationsDir)
    this.reader = reader ?? new TurnStore(dir, annotationsDir)
  }

  private safeId(terminalId: string): string {
    return terminalId.replace(/[^a-zA-Z0-9_-]/g, '')
  }

  private fileFor(terminalId: string): string {
    return path.join(this.dir, `${this.safeId(terminalId)}.jsonl`)
  }

  private stampOf(terminalId: string): string {
    try {
      const stat = statSync(this.fileFor(terminalId))
      return `${stat.size}:${stat.mtimeMs}:${stat.ino}`
    } catch {
      return 'absent'
    }
  }

  /** The conversation half of each record, one canonical JSON line each. */
  private linesOf(records: readonly TurnRecord[]): string[] {
    return records.map((record) => JSON.stringify(splitAnnotation(record).conversation))
  }

  /**
   * What this writer believes the ledger holds — read from disk the first
   * time, and re-read whenever the file has moved under it. Never a guess:
   * the append below splices relative to this list.
   */
  private currentLines(terminalId: string): string[] {
    const stamp = this.stampOf(terminalId)
    const held = this.written.get(terminalId)
    if (held !== undefined && held.stamp === stamp) return held.lines
    const lines = this.linesOf(this.reader.load(terminalId))
    this.written.set(terminalId, { lines, stamp })
    return lines
  }

  /**
   * Persist a scrape-owned history. Returns a result rather than throwing:
   * losing a scrape line must cost the line, never the turn that produced it.
   */
  save(terminalId: string, records: readonly TurnRecord[]): ScrapeHistoryResult {
    try {
      this.annotations.save(this.safeId(terminalId), records)
      const lines = this.linesOf(records)
      const current = this.currentLines(terminalId)
      if (sameLines(current, lines) && existsSync(this.fileFor(terminalId))) {
        return { ok: true, detail: 'unchanged' }
      }
      // A ledger that is not a .jsonl yet (absent, or still the pre-JSONL
      // array) has no prefix to append to — the whole history goes down once.
      return existsSync(this.fileFor(terminalId)) && extendsPrefix(current, lines)
        ? this.append(terminalId, lines, current.length)
        : this.rewrite(terminalId, lines)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`Failed to persist scraped history for ${terminalId}:`, error)
      return { ok: false, detail }
    }
  }

  private append(terminalId: string, lines: string[], from: number): ScrapeHistoryResult {
    const file = this.fileFor(terminalId)
    mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE })
    appendFileSync(file, `${lines.slice(from).join('\n')}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
      flag: 'a'
    })
    this.remember(terminalId, lines)
    return { ok: true, detail: 'append' }
  }

  private rewrite(terminalId: string, lines: string[]): ScrapeHistoryResult {
    const file = this.fileFor(terminalId)
    mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE })
    writeFileAtomic(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
    this.remember(terminalId, lines)
    return { ok: true, detail: 'rewrite' }
  }

  private remember(terminalId: string, lines: string[]): void {
    this.written.set(terminalId, { lines, stamp: this.stampOf(terminalId) })
  }

  /** Forget a removed terminal — a recycled id must not inherit a tail. */
  forget(terminalId: string): void {
    this.written.delete(terminalId)
  }
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, at) => line === b[at])
}

/** Is `next` `current` plus zero or more lines on the end? */
function extendsPrefix(current: readonly string[], next: readonly string[]): boolean {
  return next.length >= current.length && current.every((line, at) => line === next[at])
}
