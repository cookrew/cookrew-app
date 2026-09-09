// THE DURABLE LINEAGE — one small append-only file per card.
//
// THE INCIDENT (2026-09-06, the fourth "I lost my checkpoints"). The chain of
// session ids a card has passed through lived in exactly one place: the
// `sessionLineage` array inside workspace.json, capped at 20 by
// `slice(len - CAP)`. Conductor was at 20. The next rebind would have dropped
// its oldest id, and a dropped id is a transcript — every checkpoint in it —
// that no rail, no rewind and no recovery can reach again, with nothing
// logged and nothing to notice.
//
// The array is append-only now (session-lineage.ts). This file is the second
// copy, because a single mutable blob is a single point of loss: preset-scrub
// clears sessionLineage, a team copy drops it, a workspace write can lose it,
// and none of those paths know they are destroying history. The rail reads
// node lineage ∪ spill, so either side alone is enough.
//
// GUARANTEES
//   append-only  ids are only ever added; nothing here removes one
//   idempotent   recording an id already present writes nothing at all
//   atomic       tmp + rename, so a crash leaves the previous chain intact
//   single-writer the merge re-reads INSIDE an O_EXCL lock, so two appends
//                cannot lose each other (atomic-file.ts)
//   never fatal  a failed spill is reported, never thrown at a rebind — a
//                mint that fails because a cache write failed is the mistake
//                this codebase has already made once (PR #65)

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFileAtomic, withFileLock } from './atomic-file'
import {
  SPILL_DIR_NAME,
  emptySpill,
  mergeSpill,
  parseSpill,
  serializeSpill,
  spillFileName,
  unionLineage
} from '../shared/lineage-spill-format.mjs'
import type { SpillRecord } from '../shared/lineage-spill-format.d.mts'

export type { SpillRecord }

export function defaultSpillDir(): string {
  return path.join(homedir(), '.cookrew', SPILL_DIR_NAME)
}

export interface SpillResult {
  ok: boolean
  /** Ids this call added. Empty on a no-op — the idempotent case. */
  appended: string[]
  error?: string
}

/** Test seams for the two gates that cannot be provoked from outside. */
export interface SpillHooks {
  /** Injected rename — the crash-between-temp-and-rename gate (L2). */
  rename?: (from: string, to: string) => void
  /** Runs inside the lock, before the re-read — the interleave gate (L2). */
  beforeMerge?: (terminalId: string) => void
  now?: () => Date
}

/** A node's lineage as the app holds it, reduced to what this needs. */
export interface LineageBearingNode {
  claudeSessionId?: string | null
  sessionLineage?: string[]
}

export class LineageSpill {
  constructor(
    private readonly dir: string = defaultSpillDir(),
    private readonly hooks: SpillHooks = {}
  ) {}

  private fileFor(terminalId: string): string | null {
    const name = spillFileName(terminalId)
    return name === null ? null : path.join(this.dir, name)
  }

  /** The record on disk, or null when there is none / the id is not usable. */
  read(terminalId: string): SpillRecord | null {
    const file = this.fileFor(terminalId)
    if (file === null) return null
    try {
      return parseSpill(readFileSync(file, 'utf8'), terminalId)
    } catch {
      // Absent is the common case (a card that never rotated). Unreadable is
      // handled by parseSpill; either way the caller merges on top.
      return null
    }
  }

  idsOf(terminalId: string): string[] {
    return this.read(terminalId)?.ids ?? []
  }

  /**
   * Append `ids` to this node's durable chain. Idempotent, atomic, locked.
   * Never throws: the caller is a session rebind, and a rebind must not fail
   * because a disk write did.
   */
  record(terminalId: string, ids: readonly string[]): SpillResult {
    const file = this.fileFor(terminalId)
    if (file === null) {
      return { ok: false, appended: [], error: `refusing unusable terminal id: ${terminalId}` }
    }
    const wanted = unionLineage(ids)
    if (wanted.length === 0) return { ok: true, appended: [] }
    // Fast path: nothing to add means no lock and no write. The rail asks for
    // the reachable chain on every expansion, and the steady state is that
    // every id is already recorded — taking a file lock to decide that would
    // put a filesystem round trip on a UI path for no reason. Skipping when
    // there is nothing to append is safe under any interleaving: a concurrent
    // writer can only ADD ids, never remove the ones we just saw.
    const known = this.read(terminalId)
    if (known && wanted.every((id) => known.ids.includes(id))) {
      return { ok: true, appended: [] }
    }
    try {
      return withFileLock(file, () => this.mergeLocked(terminalId, file, wanted), {
        rename: this.hooks.rename
      })
    } catch (error) {
      return {
        ok: false,
        appended: [],
        error: `lineage spill for ${terminalId} failed: ${(error as Error).message}`
      }
    }
  }

  /** Read-merge-write, all of it inside the lock. */
  private mergeLocked(terminalId: string, file: string, ids: string[]): SpillResult {
    this.hooks.beforeMerge?.(terminalId)
    const existing = this.read(terminalId) ?? emptySpill(terminalId)
    const at = (this.hooks.now?.() ?? new Date()).toISOString()
    const { record, appended } = mergeSpill(existing, ids, at)
    if (appended.length === 0) return { ok: true, appended: [] }
    try {
      writeFileAtomic(file, serializeSpill(record), { rename: this.hooks.rename })
      return { ok: true, appended }
    } catch (error) {
      return { ok: false, appended: [], error: (error as Error).message }
    }
  }

  /**
   * Every session id this card can still reach, oldest first — and the
   * MIGRATION.
   *
   * The first read after this lands records whatever the node already carries,
   * so a card sitting at the old cap of 20 gets a durable copy of those 20
   * before anything else can drop them. Purely additive: an existing record is
   * merged with, never replaced, so a chain that is longer on disk than on the
   * node (the exact shape a past truncation leaves) survives the migration.
   */
  reachable(terminalId: string, node: LineageBearingNode): string[] {
    const own = unionLineage(node.sessionLineage ?? [], node.claudeSessionId ? [node.claudeSessionId] : [])
    if (own.length > 0) this.record(terminalId, own)
    return unionLineage(this.idsOf(terminalId), own)
  }
}

/**
 * The process-wide sink, installed once by the main process at boot.
 *
 * A no-op until installed on purpose: the store calls this on every node patch
 * that touches a session binding, and a unit test that constructs a store must
 * not start writing into the owner's real ~/.cookrew.
 */
let installed: LineageSpill | null = null

export function installLineageSpill(spill: LineageSpill | null): void {
  installed = spill
}

export function lineageSpill(): LineageSpill | null {
  return installed
}

/** Record ids against a node. Silent no-op when nothing is installed. */
export function recordLineageIds(terminalId: string, ids: readonly string[]): SpillResult {
  return installed?.record(terminalId, ids) ?? { ok: true, appended: [] }
}

/** node lineage ∪ spill, oldest first — what every reader should ask for. */
export function reachableLineage(terminalId: string, node: LineageBearingNode): string[] {
  const own = unionLineage(
    node.sessionLineage ?? [],
    node.claudeSessionId ? [node.claudeSessionId] : []
  )
  return installed?.reachable(terminalId, node) ?? own
}
