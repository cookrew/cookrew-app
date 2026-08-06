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
// WHY WHOLE-FILE REWRITE, NOT APPEND
// ----------------------------------
// The turns ledger is append-friendly because a finished turn is a new line.
// Annotations are the opposite by definition: `seenAt` stamps an EXISTING
// checkpoint when the user looks at it, and a Sous title lands seconds after
// the turn it describes was already written. An append-only log of those edits
// would grow without bound for a fixed number of checkpoints and would need
// compaction to stay readable — a rewrite with extra steps.
//
// So this file is rewritten whole, and that is affordable precisely because of
// what it does NOT contain: no prompt, no reply, at most three small optional
// fields per checkpoint. On the largest agent on this machine the conversation
// is ~1.4 MB where its annotations are ~12 KB. The win is not that this write
// is cheap in isolation — it is that a seenAt stamp no longer rewrites a
// 5,000-line transcript to record that someone glanced at it.
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
// OPEN POINT FOR STEP 3. Deleting turns/ leaves this file intact, but the FIRST
// save after a rebuild replaces it from records the transcript produced — and a
// transcript has never heard of a recap or a read marker, so the annotations
// would be dropped one flush later. Surviving the delete is therefore necessary
// but not sufficient: the rebuild path has to re-attach these by checkpoint
// index before it saves. `save` is intentionally not doing that implicitly,
// because a store that silently inherits whatever is on disk can never clear
// anything either.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { hasAnnotation, type TurnAnnotation, type TurnRecord } from '../shared/turn'
import { splitAnnotation } from '../shared/turn'

/** On-disk shape: checkpoint index (as a JSON key) → annotation. */
type AnnotationFile = Record<string, TurnAnnotation>

function isAnnotation(value: unknown): value is TurnAnnotation {
  if (typeof value !== 'object' || value === null) return false
  const a = value as TurnAnnotation
  return (
    (a.title === undefined || typeof a.title === 'string') &&
    (a.seenAt === undefined || typeof a.seenAt === 'number') &&
    (a.scrollLine === undefined || typeof a.scrollLine === 'number')
  )
}

export class AnnotationStore {
  /** Last written state per terminal, so an unchanged flush touches no disk. */
  private written = new Map<string, string>()

  constructor(private dir: string) {}

  private fileFor(safeId: string): string {
    return path.join(this.dir, `${safeId}.json`)
  }

  /**
   * Annotations for one agent, keyed by checkpoint index. A missing or corrupt
   * file reads as "no annotations" rather than throwing: an unreadable recap
   * must cost a recap, never the history it describes.
   */
  load(safeId: string): Map<number, TurnAnnotation> {
    const byIndex = new Map<number, TurnAnnotation>()
    try {
      const file = this.fileFor(safeId)
      if (!existsSync(file)) return byIndex
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return byIndex
      for (const [key, value] of Object.entries(parsed as AnnotationFile)) {
        const index = Number(key)
        if (!Number.isFinite(index) || !isAnnotation(value)) continue
        if (hasAnnotation(value)) byIndex.set(index, value)
      }
    } catch (error) {
      console.error('Failed to load checkpoint annotations:', error)
    }
    return byIndex
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
   * Skips the write when nothing changed: seenAt is stamped once but the history
   * around it is saved on every turn, so most flushes are identical and would
   * otherwise rewrite the file for no reason.
   */
  save(safeId: string, records: readonly TurnRecord[]): void {
    const next: AnnotationFile = {}
    for (const record of records) {
      const { annotation } = splitAnnotation(record)
      if (hasAnnotation(annotation)) next[String(record.index)] = annotation
    }
    const body = JSON.stringify(next)
    if (this.written.get(safeId) === body) return

    try {
      const file = this.fileFor(safeId)
      const empty = Object.keys(next).length === 0
      if (empty) {
        // Nothing to remember: drop the file rather than leave an empty object
        // behind, so the directory only ever holds agents that have some.
        if (existsSync(file)) unlinkSync(file)
      } else {
        mkdirSync(this.dir, { recursive: true })
        // Write-then-rename: this is the only copy of read state and recaps, so
        // a crash mid-write must not be able to truncate it.
        const temp = `${file}.tmp`
        writeFileSync(temp, body, 'utf8')
        renameSync(temp, file)
      }
      this.written.set(safeId, body)
    } catch (error) {
      console.error('Failed to save checkpoint annotations:', error)
    }
  }

  /** Drop one agent's annotations (node deletion). */
  remove(safeId: string): void {
    this.written.delete(safeId)
    try {
      const file = this.fileFor(safeId)
      if (existsSync(file)) unlinkSync(file)
    } catch (error) {
      console.error('Failed to remove checkpoint annotations:', error)
    }
  }
}
