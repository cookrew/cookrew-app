// THE INPUT-PROVENANCE WAL (Sol r10 P0-1): panes outlive the process, so the
// facts protecting their input boxes must too.
//
// Owner-editing and cancelled-paste contamination were process-memory marks on
// the ProducerLease — but an app quit or crash deliberately leaves the herdr
// pane and its REAL input box alive. The next process adopted the same pane
// with a fresh lease that called the box clean, and a dispatch or owner Enter
// could submit bytes beside residue no principal in this process ever wrote.
//
// This store is a tiny durable write-ahead record: per terminal id, a
// dirty/contaminated fact written SYNCHRONOUSLY — before the byte or paste
// crosses the pane boundary — and cleared durably only when one of the three
// proofs lands (an observed submit consumed the buffer, the one proven
// single-line clear, terminal retirement). A new process consults it at first
// sight of a terminal id and adopts fail-closed.
//
// THE ASYMMETRY, on purpose: a crash between the WAL mark and the byte write
// leaves a FALSE-DIRTY record — the pane never received the byte, but the next
// process treats the box as the owner's until a submit/retire proves
// otherwise. That costs one refused dispatch and an easy remedy (submit or
// restart the terminal). The opposite order — byte first, mark second — would
// leave a FALSE-CLEAN record, and false-clean is exactly the combined-prompt
// submission this whole plane exists to prevent. Absence of a record is
// therefore EVIDENCE of a clean box: every dirtying write was WAL-first.
//
// Writes are synchronous and debounced to state changes (a mark that is
// already recorded costs a map lookup, no I/O), so the common case — held-down
// typing into an already-dirty box — never touches the disk.

import path from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { feedPromptBuffer } from '../shared/turn'

/**
 * The two durable facts. 'dirty' — owner bytes (or a delivery's paste) may sit
 * unsubmitted in the pane's input box; adopts as the owner-editing mark.
 * 'contaminated' — a cancelled delivery's paste is KNOWN to be stranded there
 * (pasteAndSubmit's cancelled-between-paste-and-CR window); adopts as
 * contamination, whose only exit is terminal retirement. Contaminated is the
 * stronger fact and is never downgraded by a later dirty mark.
 */
export type InputProvenanceFact = 'dirty' | 'contaminated'

interface ProvenanceRecord {
  readonly fact: InputProvenanceFact
  readonly markedAt: number
}

interface PersistedShape {
  readonly version: 1
  readonly boxes: Record<string, ProvenanceRecord>
}

/**
 * Same home as the dispatch ledger (~/.cookrew/dispatches.jsonl): the one
 * per-user dir every Cookrew process can find without guessing.
 */
export function defaultInputProvenancePath(): string {
  return path.join(homedir(), '.cookrew', 'input-provenance.json')
}

/**
 * Could this chunk leave content in the pane's input box? The write paths ask
 * this before marking so pure navigation — SGR mouse reports, arrows, a bare
 * ESC interrupting the agent — does not brand every scrolled-but-untouched
 * terminal dirty for the next process.
 *
 * Modelled with the SAME feedPromptBuffer the tracker uses, from an empty
 * buffer: content left behind, an open paste, or a withheld partial marker all
 * dirty the box. A chunk whose every byte was consumed by its own submits
 * ('abc\r') does not — the pane receives the whole chunk from the kernel even
 * if this process dies right after the write, so the box it leaves is empty.
 * The one exemption from the held-marker rule is a bare ESC: it is the
 * interrupt key at the live tail, and a real split paste marks on the content
 * chunk that follows anyway.
 */
export function dirtiesInputBox(data: string): boolean {
  const fed = feedPromptBuffer('', data)
  if (fed.buffer.length > 0 || fed.inPaste) return true
  return fed.held.length > 0 && fed.held !== '\x1b'
}

/**
 * The durable store. All operations are synchronous — the WAL guarantee is
 * "the fact is on disk before the byte is in the pane", and an async write
 * would reopen the exact crash window this exists to close.
 */
export class InputProvenanceStore {
  /** The current durable truth (mirrors the file). */
  private readonly records = new Map<string, ProvenanceRecord>()
  /**
   * Facts loaded from disk at construction that no consumer has adopted yet —
   * the previous process's dying words. `takeAdoptable` hands each out ONCE:
   * after adoption the fact lives as an ordinary in-memory mark on the lease,
   * governed by the normal clear rules, and re-adopting it would resurrect a
   * mark the tracker already proved away.
   */
  private readonly adoptable = new Map<string, InputProvenanceFact>()
  /** Persist count, for the debounce gate — marks must not write per keystroke. */
  private writes = 0

  constructor(private readonly filePath: string = defaultInputProvenancePath()) {
    for (const [id, record] of loadRecords(filePath)) {
      this.records.set(id, record)
      this.adoptable.set(id, record.fact)
    }
  }

  /**
   * WRITE-AHEAD dirty mark: call before the byte crosses the pane boundary.
   * When `data` is given, chunks that cannot leave box content (mouse, arrows,
   * fully-consumed submits) are ignored. Debounced: an existing dirty or
   * contaminated record already covers the fact.
   */
  markDirty(terminalId: string, data?: string): void {
    if (data !== undefined && !dirtiesInputBox(data)) return
    if (this.records.has(terminalId)) return
    this.records.set(terminalId, { fact: 'dirty', markedAt: Date.now() })
    this.persist()
  }

  /**
   * A cancelled delivery's paste is stranded in the box (pasteAndSubmit's
   * cancel-between-paste-and-CR window). Upgrades a dirty record; never
   * downgraded by later dirty marks.
   */
  markContaminated(terminalId: string): void {
    if (this.records.get(terminalId)?.fact === 'contaminated') return
    this.records.set(terminalId, { fact: 'contaminated', markedAt: Date.now() })
    this.persist()
  }

  /**
   * The box PROVABLY emptied — an observed submit consumed it, the one proven
   * single-line clear landed, or the terminal (pane included) is permanently
   * gone. The record AND its unadopted fact both end here; clearing nothing
   * costs nothing (debounced).
   */
  clear(terminalId: string): void {
    this.adoptable.delete(terminalId)
    if (!this.records.delete(terminalId)) return
    this.persist()
  }

  /**
   * Hand the previous process's fact for this terminal to its adopter — once.
   * Null means no record: the box adopts CLEAN, and that absence is evidence
   * (see the header — every dirtying write was WAL-first).
   */
  takeAdoptable(terminalId: string): InputProvenanceFact | null {
    const fact = this.adoptable.get(terminalId)
    if (fact === undefined) return null
    this.adoptable.delete(terminalId)
    return fact
  }

  /** The current durable fact for a terminal, or null. Diagnostics and tests. */
  recordOf(terminalId: string): InputProvenanceFact | null {
    return this.records.get(terminalId)?.fact ?? null
  }

  /** How many times the file was actually written — the debounce gate. */
  persistCount(): number {
    return this.writes
  }

  /**
   * Atomic synchronous persist (tmp + rename, the repo's durable-file shape).
   * A failed write degrades to process-memory-only protection — the pre-WAL
   * world — and is said out loud rather than thrown: refusing the owner's
   * keystroke because a bookkeeping file is unwritable would be the wrong
   * fail-closed.
   */
  private persist(): void {
    try {
      const shape: PersistedShape = { version: 1, boxes: Object.fromEntries(this.records) }
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(shape))
      renameSync(tmp, this.filePath)
      this.writes += 1
    } catch (error) {
      console.error('input-provenance WAL write failed (protection degrades to process memory):', error)
    }
  }
}

/**
 * Load the durable records, tolerating absence and corruption. A corrupt file
 * loses the previous process's facts — the boxes it described adopt CLEAN,
 * which is the false-clean side of the asymmetry — but a WAL that half-wrote
 * its own tmp cannot self-corrupt (rename is atomic), so the only paths here
 * are first run, external truncation, or a schema from another era. All are
 * said out loud.
 */
function loadRecords(filePath: string): Map<string, ProvenanceRecord> {
  const loaded = new Map<string, ProvenanceRecord>()
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return loaded // first run — no facts, every box adopts clean
  }
  try {
    const parsed = JSON.parse(raw) as PersistedShape
    if (parsed.version !== 1 || typeof parsed.boxes !== 'object' || parsed.boxes === null) {
      throw new Error('unrecognized shape')
    }
    for (const [id, record] of Object.entries(parsed.boxes)) {
      if (record.fact === 'dirty' || record.fact === 'contaminated') {
        loaded.set(id, { fact: record.fact, markedAt: Number(record.markedAt) || 0 })
      }
    }
  } catch (error) {
    console.error('input-provenance WAL unreadable — previous facts lost, boxes adopt clean:', error)
    loaded.clear()
  }
  return loaded
}

/**
 * The process-wide store every producer shares in production, mirroring
 * defaultProducerLease: the WAL only proves anything when every dirtying
 * write and every clear consult the SAME file. Tests construct their own
 * stores on temp paths.
 */
let shared: InputProvenanceStore | null = null

export function defaultInputProvenance(): InputProvenanceStore {
  if (shared === null) shared = new InputProvenanceStore()
  return shared
}
