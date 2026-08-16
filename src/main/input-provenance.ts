// THE INPUT-PROVENANCE WAL (Sol r10 P0-1, hardened per Sol r11 P0-1/2/3):
// panes outlive the process, so the facts protecting their input boxes must
// too.
//
// Owner-editing and cancelled-paste contamination were process-memory marks on
// the ProducerLease — but an app quit or crash deliberately leaves the herdr
// pane and its REAL input box alive. The next process adopted the same pane
// with a fresh lease that called the box clean, and a dispatch or owner Enter
// could submit bytes beside residue no principal in this process ever wrote.
//
// This store is a tiny durable write-ahead record: per terminal id, a
// producer-qualified fact written ATOMICALLY-DURABLY — before the byte or
// paste crosses the pane boundary — and cleared durably only when a DOWNSTREAM
// witness proves the box consumed (the transcript landing the turn), the one
// proven single-line clear lands, or the pane is PROVEN dead. A new process
// consults it at first sight of a terminal id and adopts fail-closed.
//
// THE ASYMMETRY, on purpose: a crash between the WAL mark and the byte write
// leaves a FALSE-DIRTY record — the pane never received the byte, but the next
// process treats the box as the owner's until a witness/retire proves
// otherwise. That costs one refused dispatch and an easy remedy (submit or
// restart the terminal). The opposite order — byte first, mark second —
// would leave a FALSE-CLEAN record, and false-clean is exactly the
// combined-prompt submission this whole plane exists to prevent. Absence of a
// record is therefore EVIDENCE of a clean box: every dirtying write was
// WAL-first.
//
// FAIL-CLOSED STORAGE (Sol r11 P0-1). Three rules the r10 store broke:
// - A mark returns TRUE only after the atomic durable write landed (full temp
//   write, file fsync, rename, parent-dir fsync — writeFileAtomic). A mark
//   that cannot commit returns FALSE and the caller REFUSES the pane write:
//   protection never silently degrades to process memory.
// - A failed persist keeps its state and RETRIES on the next store operation
//   (`durable` tracks whether the file mirrors memory).
// - Only ENOENT is a clean first run. Any other read fault, and any
//   parse/schema corruption, poisons the load (`loadFaulted`): every terminal
//   id that asks afterwards adopts DIRTY, because an unreadable WAL proves
//   nothing about any surviving pane.
//
// Writes are debounced to state changes (a mark that is already durably
// recorded costs a map lookup, no I/O), so held-down typing into an
// already-dirty box never touches the disk.

import path from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, mkdirSync } from 'node:fs'
import { feedPromptBuffer } from '../shared/turn'
import { writeFileAtomic } from './turn-annotations'

/**
 * The three durable facts, ordered by strength (Sol r11 P0-3 — producer
 * identity survives the process):
 * - 'owner-dirty' — owner bytes may sit unsubmitted in the pane's input box;
 *   adopts as the owner-editing mark. Cleared by the transcript witness, the
 *   proven single-line clear, or proven pane death.
 * - 'dispatch-delivery' — a dispatch's paste is (or may be) in the box with
 *   its CR unconfirmed. Adopts as delivery residue that blocks EVERY
 *   submit-capable producer, owner included, until the transcript witnesses
 *   the delivered prompt consumed or the pane is proven dead. Shutdown
 *   upgrades an unresolved one to 'contaminated'.
 * - 'contaminated' — a cancelled delivery's paste is KNOWN stranded there.
 *   The only exit is proven pane death. Never downgraded.
 */
export type InputProvenanceFact = 'owner-dirty' | 'dispatch-delivery' | 'contaminated'

/** Strength order: a mark never downgrades an existing stronger fact. */
const STRENGTH: Record<InputProvenanceFact, number> = {
  'owner-dirty': 0,
  'dispatch-delivery': 1,
  contaminated: 2
}

/** What the WAL knows about one box — the witness needs kind, time and bytes. */
export interface ProvenanceDetail {
  readonly kind: InputProvenanceFact
  readonly markedAt: number
  /** The delivered paste body, for 'dispatch-delivery' prompt-identity witness. */
  readonly prompt?: string
}

interface PersistedShape {
  readonly version: 2
  readonly boxes: Record<string, ProvenanceDetail>
}

/** The r10 on-disk shape, still adoptable: 'dirty' maps to 'owner-dirty'. */
interface PersistedShapeV1 {
  readonly version: 1
  readonly boxes: Record<string, { fact: 'dirty' | 'contaminated'; markedAt: number }>
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
 * dirty the box — and so does a chunk whose content was consumed by its OWN
 * submit ('abc\r'). The r10 exemption for self-contained submits is GONE
 * (Sol r11 P0-2): proc.write is an asynchronous enqueue, and node-pty can die
 * (or EAGAIN-defer) after only 'abc' crossed while the CR never did — enqueue
 * is not consumption, so any content byte marks and only a downstream witness
 * clears. A truly empty submit (a bare '\r') still does not mark: whatever it
 * submits was marked when ITS bytes entered. The one exemption from the
 * held-marker rule is a bare ESC: it is the interrupt key at the live tail,
 * and a real split paste marks on the content chunk that follows anyway.
 */
export function dirtiesInputBox(data: string): boolean {
  const fed = feedPromptBuffer('', data)
  if (fed.buffer.length > 0 || fed.inPaste) return true
  if (fed.submitted.some((s) => s.length > 0)) return true
  return fed.held.length > 0 && fed.held !== '\x1b'
}

/** Strip bracketed-paste markers: the delivered BODY is the identity bytes. */
export function pastedBodyOf(data: string): string {
  return data.split('\x1b[200~').join('').split('\x1b[201~').join('')
}

/**
 * The durable store. All operations are synchronous — the WAL guarantee is
 * "the fact is durable before the byte is in the pane", and an async write
 * would reopen the exact crash window this exists to close.
 */
export class InputProvenanceStore {
  /** The current truth (mirrors the file WHEN `durable`). */
  private readonly records = new Map<string, ProvenanceDetail>()
  /**
   * Facts loaded from disk at construction that no consumer has adopted yet —
   * the previous process's dying words. `takeAdoptable` hands each out ONCE:
   * after adoption the fact lives as an ordinary in-memory mark on the lease,
   * governed by the normal clear rules, and re-adopting it would resurrect a
   * mark a witness already proved away.
   */
  private readonly adoptable = new Map<string, InputProvenanceFact>()
  /**
   * The load FAULTED (read error other than ENOENT, or corruption): the file
   * proves nothing about any pane, so every id that asks adopts DIRTY —
   * fail-closed — exactly once each (Sol r11 P0-1).
   */
  private readonly faulted: boolean
  /** Ids already handed their fault-adoption, so each adopts once. */
  private readonly faultAdopted = new Set<string>()
  /**
   * Ids whose box a LOCALLY OBSERVED submit consumed while the durable fact
   * still awaits its downstream witness. The next dirtying byte for such an
   * id RE-STAMPS the record's markedAt: bytes entering after a submit are a
   * NEW box lifetime, and a witness of the earlier submit must not clear the
   * fact protecting them (Sol r11 P0-2).
   */
  private readonly consumedLocally = new Set<string>()
  /** Does the file currently mirror `records`? False = persist owed, retried. */
  private durable = true
  /** Persist count, for the debounce gate — marks must not write per keystroke. */
  private writes = 0

  constructor(private readonly filePath: string = defaultInputProvenancePath()) {
    const loaded = loadRecords(filePath)
    this.faulted = loaded.faulted
    for (const [id, record] of loaded.records) {
      this.records.set(id, record)
      this.adoptable.set(id, record.kind)
    }
  }

  /**
   * WRITE-AHEAD dirty mark: call before the byte crosses the pane boundary.
   * When `data` is given, chunks that cannot leave box content (mouse,
   * arrows, a bare Enter) are ignored. Debounced: an existing record already
   * covers the fact — unless a locally observed submit consumed the box since
   * (consumedLocally), in which case the record is re-stamped at now.
   *
   * Returns TRUE only when the fact is DURABLE (or no fact was needed).
   * FALSE means the WAL could not commit: the caller MUST refuse the pane
   * write — delivering the byte anyway would be exactly the unprotected
   * false-clean crash window this store exists to close (Sol r11 P0-1).
   */
  markDirty(terminalId: string, data?: string): boolean {
    if (data !== undefined && !dirtiesInputBox(data)) return this.settled()
    const existing = this.records.get(terminalId)
    if (existing !== undefined) {
      const restamp = existing.kind === 'owner-dirty' && this.consumedLocally.has(terminalId)
      if (!restamp) return this.settled()
    }
    this.consumedLocally.delete(terminalId)
    this.records.set(terminalId, { kind: 'owner-dirty', markedAt: Date.now() })
    return this.persist()
  }

  /**
   * A dispatch's paste is about to cross the pane boundary (Sol r11 P0-3):
   * the fact carries the producer's identity AND the delivered body, so a
   * restart can block every submit-capable producer until the transcript
   * witnesses exactly this prompt consumed. Upgrades 'owner-dirty'; never
   * downgrades 'contaminated'. Same durable contract as markDirty.
   */
  markDispatchDelivery(terminalId: string, prompt?: string): boolean {
    const existing = this.records.get(terminalId)
    if (existing?.kind === 'contaminated') return this.settled()
    if (existing?.kind === 'dispatch-delivery' && !this.consumedLocally.has(terminalId)) {
      return this.settled()
    }
    this.consumedLocally.delete(terminalId)
    this.records.set(terminalId, {
      kind: 'dispatch-delivery',
      markedAt: Date.now(),
      ...(prompt !== undefined && prompt.length > 0 ? { prompt } : {})
    })
    return this.persist()
  }

  /**
   * A cancelled delivery's paste is stranded in the box (pasteAndSubmit's
   * cancel-between-paste-and-CR window). Upgrades everything weaker; never
   * downgraded by later marks.
   */
  markContaminated(terminalId: string): boolean {
    if (this.records.get(terminalId)?.kind === 'contaminated') return this.settled()
    this.consumedLocally.delete(terminalId)
    this.records.set(terminalId, { kind: 'contaminated', markedAt: Date.now() })
    return this.persist()
  }

  /**
   * A LOCALLY OBSERVED submit consumed the box (the input-stream echo). That
   * is an ENQUEUE observation, never consumption proof (Sol r11 P0-2), so the
   * record STANDS — this only opens the re-stamp window: the next dirtying
   * byte starts a fresh markedAt, so the eventual witness of THIS submit
   * cannot clear a fact protecting newer bytes.
   */
  noteLocalConsumption(terminalId: string): void {
    if (this.records.has(terminalId)) this.consumedLocally.add(terminalId)
  }

  /**
   * The box PROVABLY emptied — a downstream witness landed (the transcript
   * recorded the consuming turn), the one proven single-line clear happened,
   * or the pane is PROVEN dead. The record AND its unadopted fact both end
   * here; clearing nothing costs nothing (debounced). A clear that cannot
   * persist leaves a false-dirty on disk — the safe direction — and is
   * retried by the next store operation.
   */
  clear(terminalId: string): void {
    this.adoptable.delete(terminalId)
    this.consumedLocally.delete(terminalId)
    this.faultAdopted.delete(terminalId)
    if (!this.records.delete(terminalId)) {
      this.settled()
      return
    }
    this.persist()
  }

  /**
   * SHUTDOWN (Sol r11 P0-3): an unresolved 'dispatch-delivery' at quit time
   * was cancelled by the teardown itself — its CR can no longer be witnessed
   * by this process, so the paste is treated as KNOWN stranded: upgraded to
   * 'contaminated', whose only exit is proven pane death.
   */
  upgradeUnresolvedDeliveries(): void {
    let changed = false
    for (const [id, record] of this.records) {
      if (record.kind !== 'dispatch-delivery') continue
      this.records.set(id, { kind: 'contaminated', markedAt: record.markedAt })
      // A still-unadopted dying word upgrades in place; a fact minted THIS
      // process stays unadoptable — adoption is for the next process.
      if (this.adoptable.has(id)) this.adoptable.set(id, 'contaminated')
      changed = true
    }
    if (changed) this.persist()
    else this.settled()
  }

  /**
   * Hand the previous process's fact for this terminal to its adopter — once.
   * Null means no record AND a clean load: the box adopts CLEAN, and that
   * absence is evidence (every dirtying write was WAL-first). A FAULTED load
   * proves nothing, so every id adopts 'owner-dirty' fail-closed — and the
   * protection is re-recorded durably, since the unreadable file cannot
   * vouch for it (Sol r11 P0-1).
   */
  takeAdoptable(terminalId: string): InputProvenanceFact | null {
    const fact = this.adoptable.get(terminalId)
    if (fact !== undefined) {
      this.adoptable.delete(terminalId)
      return fact
    }
    if (this.faulted && !this.faultAdopted.has(terminalId)) {
      this.faultAdopted.add(terminalId)
      if (!this.records.has(terminalId)) {
        this.records.set(terminalId, { kind: 'owner-dirty', markedAt: Date.now() })
        this.persist()
      }
      return 'owner-dirty'
    }
    return null
  }

  /** The current durable fact for a terminal, or null. Diagnostics and tests. */
  recordOf(terminalId: string): InputProvenanceFact | null {
    return this.records.get(terminalId)?.kind ?? null
  }

  /** Full record — kind, mark time and delivered bytes — for the witness. */
  detailOf(terminalId: string): ProvenanceDetail | null {
    return this.records.get(terminalId) ?? null
  }

  /** Did construction fail to read a WAL that should have existed? */
  loadFaulted(): boolean {
    return this.faulted
  }

  /** How many times the file was actually written — the debounce gate. */
  persistCount(): number {
    return this.writes
  }

  /** No state change: TRUE when the file already mirrors memory, else retry. */
  private settled(): boolean {
    return this.durable ? true : this.persist()
  }

  /**
   * ATOMIC DURABLE persist (Sol r11 P0-1): full temp write, file fsync,
   * rename, parent-directory fsync — writeFileAtomic, the repo's one durable
   * replacement primitive. Returns whether the write landed; failure keeps
   * the in-memory state for retry and is said out loud, and the caller
   * refuses the pane write it was covering.
   */
  private persist(): boolean {
    try {
      const shape: PersistedShape = { version: 2, boxes: Object.fromEntries(this.records) }
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify(shape))
      this.durable = true
      this.writes += 1
      return true
    } catch (error) {
      this.durable = false
      console.error(
        'input-provenance WAL write failed — the covered pane write is REFUSED and the state retried:',
        error
      )
      return false
    }
  }
}

/**
 * Load the durable records. Only ENOENT is a clean first run. Any other read
 * fault — and any parse/schema corruption — returns `faulted: true`: the
 * previous process's facts are UNKNOWN, so every surviving pane must adopt
 * dirty rather than clean (Sol r11 P0-1; the r10 store mapped every fault to
 * "all boxes clean", the exact false-clean a WAL exists to prevent). A WAL
 * that half-wrote its own temp cannot self-corrupt (rename is atomic), so a
 * fault here is external truncation, permissions, or a schema from another
 * era — all adopt fail-closed, out loud.
 */
function loadRecords(filePath: string): {
  records: Map<string, ProvenanceDetail>
  faulted: boolean
} {
  const records = new Map<string, ProvenanceDetail>()
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records, faulted: false } // first run — no facts, every box adopts clean
    }
    console.error(
      'input-provenance WAL unreadable — adopting EVERY known pane dirty (fail-closed):',
      error
    )
    return { records, faulted: true }
  }
  try {
    const parsed = JSON.parse(raw) as PersistedShape | PersistedShapeV1
    if (typeof parsed.boxes !== 'object' || parsed.boxes === null) {
      throw new Error('unrecognized shape')
    }
    if (parsed.version === 1) {
      for (const [id, record] of Object.entries(parsed.boxes)) {
        if (record.fact === 'dirty' || record.fact === 'contaminated') {
          records.set(id, {
            kind: record.fact === 'dirty' ? 'owner-dirty' : 'contaminated',
            markedAt: Number(record.markedAt) || 0
          })
        }
      }
      return { records, faulted: false }
    }
    if (parsed.version !== 2) throw new Error('unrecognized version')
    for (const [id, record] of Object.entries(parsed.boxes)) {
      if (record.kind in STRENGTH) {
        records.set(id, {
          kind: record.kind,
          markedAt: Number(record.markedAt) || 0,
          ...(typeof record.prompt === 'string' ? { prompt: record.prompt } : {})
        })
      }
    }
    return { records, faulted: false }
  } catch (error) {
    console.error(
      'input-provenance WAL corrupt — adopting EVERY known pane dirty (fail-closed):',
      error
    )
    records.clear()
    return { records, faulted: true }
  }
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
