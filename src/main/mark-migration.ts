// THE MARK MIGRATION — phase T4 of "One stream"
// (docs/site/one-stream-2026-09-07.html, "The migration, and why nothing is
// lost").
//
// T1 rehearsed this and printed the numbers: 8,137 titles, 1,293 seenAt, 88
// pins (2 unplaceable), 9 forks (1 unplaceable) and 39 title-carrying records
// with no uuid. This module is the real thing — the one that WRITES — and it
// exists as a module rather than as script code so the three ways it can be
// wrong are testable without a ~/.cookrew anywhere near them:
//
//   1. A TITLE LANDING ON THE WRONG ROW. Every mark is placed by the identity
//      the STREAM will use: `record.uuid`, or — for the legacy records that
//      predate uuids — `checkpointIdentity({index, prompt})`, the very
//      function src/shared/stream-turns.ts:232 and trace-blocks.ts call. Not
//      a second implementation of the digest; the same one, imported. The
//      design names this as the migration's stated risk ("the migration must
//      use the same function or old titles detach") and importing it is the
//      only answer that cannot rot.
//   2. A SECOND RUN DOUBLING EVERYTHING. Marks are append-only and last-wins,
//      so a re-run would be harmless but would still grow the ledger without
//      end. So the plan is DIFFED against the ledger already on disk and only
//      the fields that actually differ are written. A second run writes zero
//      lines — the property tests/mark-migration.test.ts pins.
//   3. A MARK NOBODY CAN SEE. Writing is not the finish line: the run ends by
//      reading the marks back THROUGH the stream (stream-marks.checkpoints)
//      and naming every identity that resolves to no row. An orphan is
//      reported with a reason, never dropped — swallowing one is how 400
//      checkpoints looked destroyed on 2026-09-06.
//
// WHAT IS CARRIED, AND FROM WHERE
//   title, seenAt   the old store's records, hydrated with their annotation
//                   sidecar by TurnStore's own reader.
//   anchor          the record's `scrollLine`. NOT in T1's rehearsal, and
//                   added deliberately: stream-adapters.ts answers /turns with
//                   `scrollLine ← mark.anchor`, so a migration that skipped it
//                   would blank the scroll anchor on every legacy row the
//                   moment the adapters came on. It is one of the mark's own
//                   five fields; leaving it behind would have been the only
//                   silent loss in this whole phase.
//   pin             ~/.cookrew/pins/<id>.json. `atUuid` is the anchor when
//                   present; a legacy pin carries only `atIndex` and is
//                   resolved through the record at that index. One that
//                   resolves to nothing is REPORTED, never guessed.
//   fork            a node's `forkOf` {sourceId, turnIndex}: the reference
//                   lives on the CHILD and points back at the SOURCE card's
//                   turn, so the mark belongs on the source at that identity.
//
// NOTHING ELSE IS CARRIED, because nothing else needs to be: prompt, reply and
// the timestamps are the transcript, and the transcript is still on disk. The
// writer would refuse them anyway (marks.ts CONVERSATION_KEYS).

import { checkpointIdentity } from '../shared/session-turns'
import type { TurnRecord } from '../shared/turn'
import {
  readMarkLedger,
  writeMark,
  type Mark,
  type MarkField,
  type MarkOptions,
  type MarkPatch
} from './marks'

/** A pin as it sits on disk — structurally, so this never needs the renderer's
 *  VersionPinRecord and its marketplace-lane dependencies. */
export interface MigrationPin {
  version: number
  atIndex?: number
  atUuid?: string
}

/** One `forkOf` reference, already grouped under the SOURCE card. */
export interface MigrationFork {
  /** The forked card's terminal id — what the mark carries. */
  child: string
  /** The source card's turn the fork was taken after. */
  turnIndex: number
}

/** Everything one card contributes, gathered by the caller. */
export interface CardSource {
  terminalId: string
  records: readonly TurnRecord[]
  pins: readonly MigrationPin[]
  forks: readonly MigrationFork[]
}

/** Something the migration could not place, named so a person can go look. */
export interface Unplaceable {
  terminalId: string
  kind: 'pin' | 'fork'
  /** The index the item named — the only coordinate it has. */
  index: number
  reason: string
}

export interface CardCounts {
  /** Distinct identities that would carry at least one field. */
  marks: number
  titles: number
  seenAt: number
  anchors: number
  pins: number
  forks: number
  /** Records placed by the derived digest rather than a uuid. */
  derivedIdentities: number
}

export interface CardPlan {
  terminalId: string
  /** One patch per identity, in stream order — never a patch per field. */
  patches: readonly MarkPatch[]
  counts: CardCounts
  unplaceable: readonly Unplaceable[]
}

const EMPTY_COUNTS: CardCounts = {
  marks: 0,
  titles: 0,
  seenAt: 0,
  anchors: 0,
  pins: 0,
  forks: 0,
  derivedIdentities: 0
}

/**
 * The identity the STREAM will show this record on.
 *
 * `uuid` when the record has one — which IS checkpointIdentity's own answer
 * for a record that carries it. When it does not, the same derived digest the
 * stream computes for the same exchange: `claude-<index>-<prompt digest>`.
 * The 39 records T1 counted as unplaceable are placeable exactly here, and
 * whether the digest agrees with the stream's is not asserted — it is VERIFIED
 * at the end of the run, per identity, and reported when it does not.
 */
export function migrationIdentityOf(record: TurnRecord): string {
  return checkpointIdentity({ index: record.index, prompt: record.prompt, uuid: record.uuid })
}

/** The fields one record contributes. Absent fields are not "cleared" — a
 *  migration adds what the old store knew and asserts nothing about the rest. */
function fieldsOfRecord(record: TurnRecord): Partial<MarkPatch> {
  return {
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.seenAt === 'number' ? { seenAt: record.seenAt } : {}),
    ...(typeof record.scrollLine === 'number' ? { anchor: record.scrollLine } : {})
  }
}

/** Accumulate field sets per identity, preserving first-seen order. */
class PatchBuilder {
  private readonly byIdentity = new Map<string, Partial<MarkPatch>>()

  add(identity: string, fields: Partial<MarkPatch>): void {
    if (Object.keys(fields).length === 0) return
    this.byIdentity.set(identity, { ...(this.byIdentity.get(identity) ?? {}), ...fields })
  }

  patches(): MarkPatch[] {
    return [...this.byIdentity].map(([identity, fields]) => ({ identity, ...fields }))
  }
}

/** Place the pins, reporting every one that names an index no record holds. */
function placePins(
  source: CardSource,
  byIndex: ReadonlyMap<number, string>,
  builder: PatchBuilder
): { placed: number; unplaceable: Unplaceable[] } {
  const unplaceable: Unplaceable[] = []
  let placed = 0
  for (const pin of source.pins) {
    const identity = pin.atUuid ?? (pin.atIndex === undefined ? undefined : byIndex.get(pin.atIndex))
    if (identity === undefined) {
      unplaceable.push({
        terminalId: source.terminalId,
        kind: 'pin',
        index: pin.atIndex ?? -1,
        reason:
          `V${pin.version} is keyed by checkpoint index ${pin.atIndex ?? '?'}, and no record ` +
          'in the old store holds that index — the turn it was cut at is gone from the ledger'
      })
      continue
    }
    placed += 1
    builder.add(identity, { pin: pin.version })
  }
  return { placed, unplaceable }
}

/** Place the fork references the same way, on the SOURCE card's turn. */
function placeForks(
  source: CardSource,
  byIndex: ReadonlyMap<number, string>,
  builder: PatchBuilder
): { placed: number; unplaceable: Unplaceable[] } {
  const unplaceable: Unplaceable[] = []
  let placed = 0
  for (const fork of source.forks) {
    const identity = byIndex.get(fork.turnIndex)
    if (identity === undefined) {
      unplaceable.push({
        terminalId: source.terminalId,
        kind: 'fork',
        index: fork.turnIndex,
        reason:
          `${fork.child.slice(0, 8)} was forked after turn ${fork.turnIndex}, which no record ` +
          'in the old store holds — the source card was re-numbered or trimmed since'
      })
      continue
    }
    placed += 1
    builder.add(identity, { fork: fork.child })
  }
  return { placed, unplaceable }
}

/**
 * What ONE card would have written — computed whole before a byte is written,
 * so a dry run and a real run differ only in whether applyPlan is called.
 */
export function planCard(source: CardSource): CardPlan {
  const builder = new PatchBuilder()
  const byIndex = new Map<number, string>()
  const counts = { ...EMPTY_COUNTS }

  for (const record of source.records) {
    const identity = migrationIdentityOf(record)
    // Last record wins an index collision, matching the old store's own
    // last-write-wins read: a duplicate index is a phantom the reader already
    // resolved that way, and disagreeing here would place a title differently
    // from where the ledger showed it.
    byIndex.set(record.index, identity)
    if (record.uuid === undefined) counts.derivedIdentities += 1
    const fields = fieldsOfRecord(record)
    if (fields.title !== undefined) counts.titles += 1
    if (fields.seenAt !== undefined) counts.seenAt += 1
    if (fields.anchor !== undefined) counts.anchors += 1
    builder.add(identity, fields)
  }

  const pins = placePins(source, byIndex, builder)
  const forks = placeForks(source, byIndex, builder)
  const patches = builder.patches()
  return {
    terminalId: source.terminalId,
    patches,
    counts: { ...counts, marks: patches.length, pins: pins.placed, forks: forks.placed },
    unplaceable: [...pins.unplaceable, ...forks.unplaceable]
  }
}

/** The fields of `patch` that the ledger does not already agree with. */
function novelFields(patch: MarkPatch, held: Mark | undefined): MarkPatch | null {
  const fields: MarkField[] = ['title', 'seenAt', 'pin', 'anchor', 'fork']
  const next: MarkPatch = { identity: patch.identity }
  let carried = 0
  for (const field of fields) {
    const value = patch[field]
    if (value === undefined || value === null) continue
    if (held?.[field] === value) continue
    carried += 1
    Object.assign(next, { [field]: value })
  }
  return carried > 0 ? next : null
}

export interface ApplyResult {
  /** Patches actually appended to a ledger. */
  written: number
  /** Patches the ledger already agreed with — the idempotence property. */
  unchanged: number
  /** Write failures, with the writer's own sentence. A mark is a nicety: a
   *  failed one is reported and the run continues (marks.ts MarkResult). */
  failures: { terminalId: string; identity: string; error: string }[]
}

/**
 * Write one card's plan, skipping every field the ledger already holds.
 *
 * The ledger is read ONCE per card and folded in memory, so the diff costs one
 * read rather than one per patch — and re-running the whole migration over 279
 * cards writes nothing and touches no file.
 */
export function applyPlan(plan: CardPlan, options: MarkOptions = {}): ApplyResult {
  const held = readMarkLedger(plan.terminalId, options).marks
  const failures: ApplyResult['failures'] = []
  let written = 0
  let unchanged = 0
  for (const patch of plan.patches) {
    const novel = novelFields(patch, held.get(patch.identity))
    if (novel === null) {
      unchanged += 1
      continue
    }
    const result = writeMark(plan.terminalId, novel, options)
    if (result.ok) written += 1
    else failures.push({ terminalId: plan.terminalId, identity: patch.identity, error: result.error ?? 'unknown' })
  }
  return { written, unchanged, failures }
}

/** A mark that reached disk but reaches no row. Reported, never deleted. */
export interface OrphanMark {
  terminalId: string
  identity: string
  reason: string
}

/** What the stream answered for a card, plus WHY it is empty when it is. */
export interface StreamRows {
  checkpoints: readonly { identity: string }[]
  /**
   * The caller's own sentence for an empty answer — "this card is in no
   * workspace" and "this card's chain has no file on disk" are different
   * facts, and an orphan report that cannot tell them apart sends the reader
   * looking in the wrong place.
   */
  note?: string
}

export interface VerifyDeps {
  /** The stream's own rail for a card. Injected so a test — and the dry run —
   *  can verify without the app. */
  checkpointsOf: (terminalId: string) => Promise<StreamRows>
}

/**
 * Read the marks back THROUGH the stream and name what cannot be seen.
 *
 * Deliberately NOT a re-read of the ledger compared against itself: the claim
 * this run has to earn is "every migrated title is visible on a stream row",
 * and only the stream can answer that. A card whose transcript this process
 * cannot walk yields one orphan per identity with that stated as the reason —
 * which is honest, and is exactly the shape of the 2 unplaceable pins: a
 * number to go and look at, not a silence.
 */
export async function verifyPlan(plan: CardPlan, deps: VerifyDeps): Promise<OrphanMark[]> {
  let answer: StreamRows
  try {
    answer = await deps.checkpointsOf(plan.terminalId)
  } catch (error) {
    return plan.patches.map((patch) => ({
      terminalId: plan.terminalId,
      identity: patch.identity,
      reason: `the stream could not be read for this card: ${messageOf(error)}`
    }))
  }
  const rows = answer.checkpoints
  const placed = new Set(rows.map((row) => row.identity))
  const reason =
    rows.length === 0
      ? (answer.note ?? 'this card has no walkable transcript, so the stream shows no rows at all')
      : `no block in this card's ${rows.length}-row stream carries this identity`
  return plan.patches
    .filter((patch) => !placed.has(patch.identity))
    .map((patch) => ({ terminalId: plan.terminalId, identity: patch.identity, reason }))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
