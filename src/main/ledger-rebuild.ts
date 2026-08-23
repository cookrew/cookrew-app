// The ledger is a DERIVED INDEX, and this is the proof.
//
// ~/.cookrew/turns/*.jsonl reads like THE record of every conversation. It is
// not, and after the checkpoint-as-identity transition it must not be treated
// as one: the harness session files ARE the conversation (~2 GB of
// transcripts), and the ledger is a 3.2 MB index over them that exists so
// checkpoint search is a 65 ms scan instead of a two-gigabyte one.
//
// Duplication is fine when it is a deliberate index. It stops being fine when
// nobody can tell the difference — so this module makes the claim falsifiable:
// regenerate an agent's records from its transcript and compare. If that
// round-trip holds, the ledger is safe to delete. If it drifts, the drift is a
// finding about the parser, not a reason to loosen the comparison.
//
// WHAT IS DERIVED, AND WHAT IS NOT
// --------------------------------
// The transcript owns the exchange: index, prompt, reply, identity, and the
// timestamps. It knows nothing about Cookrew's own annotations — the Sous
// title, the acknowledge-on-view marker, the scrollback anchor — which are a
// sidecar keyed by checkpoint index. A rebuild therefore restores the index
// and NOT the annotations, and `derivedFields` names that boundary in one
// place so a comparison cannot quietly drift into asserting the un-derivable.

import { existsSync, readFileSync } from 'node:fs'
import type { TerminalNodeData } from '../shared/model'
import type { TurnRecord } from '../shared/turn'
import { harnessFor, type HarnessId, type HarnessWatchOptions } from './harness'
import type { TurnStore } from './turn-store'

/**
 * Why an agent's ledger cannot be rebuilt. Deliberately a closed set of
 * reasons rather than an empty array: "no records" and "this harness keeps no
 * transcript" are different facts, and a caller that cannot tell them apart
 * will eventually delete a ledger it cannot regenerate.
 */
export type RebuildBlocker =
  /** The launch command matches no known harness (bare shell, custom binary). */
  | 'no-harness'
  /**
   * The harness declares `turns: 'scrape'` — its durable history comes from
   * PTY scraping, so there IS no transcript to derive from. This is a
   * conscious limitation of that harness (harness-integration-contract), not a
   * failure here: for these agents the ledger is the ONLY record and deleting
   * it really does lose history.
   */
  | 'scrape-only'
  /** File-harness, but this node has no usable session reference yet. */
  | 'unbound'
  /** The rebuild is SHORTER than the ledger it would replace — see below. */
  | 'would-shrink'
  /** The reference resolves to a path that is not on disk (pruned/moved). */
  | 'session-missing'
  /** The transcript exists but could not be read or parsed. */
  | 'unreadable'

export interface LedgerRebuildOk {
  ok: true
  terminalId: string
  harness: HarnessId
  /** The transcript this was derived from — quoted in drift reports. */
  sessionFile: string
  /** Records as the transcript alone defines them; no annotations. */
  records: TurnRecord[]
}

export interface LedgerRebuildBlocked {
  ok: false
  terminalId: string
  /** Null when the command matched no harness at all. */
  harness: HarnessId | null
  reason: RebuildBlocker
  /** Human-readable specifics — the path tried, the harness that refused. */
  detail: string
}

export type LedgerRebuild = LedgerRebuildOk | LedgerRebuildBlocked

/** Enough of a terminal node to locate a transcript. */
export type RebuildTarget = Pick<TerminalNodeData, 'id' | 'command' | 'cwd'> &
  Partial<TerminalNodeData>

/**
 * The fields the TRANSCRIPT owns — everything a rebuild can be expected to
 * reproduce, and therefore everything a derivation check may compare.
 *
 * `title`, `seenAt` and `scrollLine` are excluded on purpose: they are
 * Cookrew's annotations, live in the sidecar, and are not recoverable from a
 * conversation log. Comparing them would fail a rebuild that is in fact
 * correct — and quietly training someone to loosen the comparison is exactly
 * how a real drift gets waved through later.
 */
export function derivedFields(record: TurnRecord): {
  index: number
  prompt: string
  reply: string
  uuid?: string
  startedAt: number
  endedAt: number
} {
  return {
    index: record.index,
    prompt: record.prompt,
    reply: record.reply,
    ...(record.uuid !== undefined ? { uuid: record.uuid } : {}),
    startedAt: record.startedAt,
    endedAt: record.endedAt
  }
}

/**
 * Regenerate one agent's checkpoint records from its harness transcript.
 *
 * Reads nothing from the existing ledger — that is the point. The harness
 * registry decides both whether a rebuild is possible (`turns`) and where the
 * transcript lives (`watchFile`), so adding a harness stays registry-only.
 */
export function rebuildLedger(
  node: RebuildTarget,
  options: HarnessWatchOptions = {}
): LedgerRebuild {
  const harness = harnessFor(node.command ?? '')
  if (!harness) {
    return {
      ok: false,
      terminalId: node.id,
      harness: null,
      reason: 'no-harness',
      detail: `no harness matches command ${JSON.stringify(node.command ?? '')}`
    }
  }
  const blocked = (reason: RebuildBlocker, detail: string): LedgerRebuildBlocked => ({
    ok: false,
    terminalId: node.id,
    harness: harness.id,
    reason,
    detail
  })

  if (harness.turns !== 'file' || !harness.parseTurns || !harness.watchFile) {
    return blocked(
      'scrape-only',
      `${harness.id} declares turns: '${harness.turns}' — its history is PTY-scraped, ` +
        'so there is no transcript to derive from and its ledger is the only record'
    )
  }

  let sessionFile: string | null = null
  try {
    sessionFile = harness.watchFile(node as TerminalNodeData, options)
  } catch (error) {
    // A resolver that throws (tampered ref, unreadable sessions tree) is a
    // blocked rebuild, never a crash in a bulk walk over 200+ agents.
    return blocked('unbound', `${harness.id} session resolver failed: ${message(error)}`)
  }
  if (!sessionFile) {
    return blocked('unbound', `${harness.id} has no usable session reference for this node`)
  }
  if (!existsSync(sessionFile)) {
    return blocked('session-missing', `transcript not on disk: ${sessionFile}`)
  }

  try {
    const records = harness.parseTurns(readFileSync(sessionFile, 'utf8').split('\n'))
    return { ok: true, terminalId: node.id, harness: harness.id, sessionFile, records }
  } catch (error) {
    return blocked('unreadable', `failed to parse ${sessionFile}: ${message(error)}`)
  }
}

/**
 * Rebuild and WRITE into a store — the delete-and-regenerate path. Point it at
 * a TurnStore over any directory (a temp one in tests, the real one to repair
 * a lost ledger). Returns the same discriminated result; nothing is written
 * when the rebuild is blocked, so a scrape-only agent never gets an empty file
 * that would look like a real, empty history.
 */
export function rebuildLedgerInto(
  store: Pick<TurnStore, 'scheduleSave' | 'flushAll' | 'load'>,
  node: RebuildTarget,
  options: HarnessWatchOptions = {}
): LedgerRebuild {
  const result = rebuildLedger(node, options)
  if (!result.ok) return result

  /**
   * REFUSE TO WRITE A SHORTER HISTORY THAN THE ONE IT REPLACES.
   *
   * scheduleSave treats its argument as the WHOLE truth, so a rebuild that
   * comes back short does not merge — it deletes. This function reads only the
   * node's CURRENT transcript, while a ledger may legitimately span several of
   * them: after a compact, or after a lineage recovery. Pointed at a recovered
   * 613-record ledger it would regenerate the 16 turns of the newest file and
   * destroy the other 597, in the ledger and the annotation sidecar together.
   *
   * The honest guard is not "walk the lineage here" — that would need this sync
   * function and both its callers to become async. It is to notice that the
   * replacement is smaller than what it replaces and DECLINE, which turns a
   * data-destroying tool into a refusing one. A rebuild that is genuinely
   * shorter (a /rewind removed turns) is still available through the plain
   * rebuildLedger + an explicit save by a caller who has decided that is right.
   */
  const existing = store.load(result.terminalId)
  if (existing.length > result.records.length) {
    return {
      ok: false,
      terminalId: result.terminalId,
      harness: result.harness,
      reason: 'would-shrink',
      detail:
        `refusing to replace ${existing.length} stored records with ${result.records.length} ` +
        `rebuilt from ${result.sessionFile} alone. A ledger can span several transcripts ` +
        '(a compact, or a lineage recovery) and this rebuild reads only the current one, ' +
        'so writing it would DELETE the difference rather than merge it.'
    }
  }

  store.scheduleSave(result.terminalId, result.records)
  store.flushAll()
  return result
}

/** One record's worth of disagreement between the ledger and a rebuild. */
export interface LedgerDrift {
  index: number
  field: 'prompt' | 'reply' | 'uuid' | 'startedAt' | 'endedAt' | 'missing' | 'extra'
  stored: unknown
  rebuilt: unknown
}

/**
 * Compare a stored ledger against a rebuild over the transcript-owned fields
 * only. Empty means the ledger for that agent is fully derived — safe to
 * delete, because this run just proved it can be regenerated.
 *
 * Records are paired by checkpoint INDEX, not array position: a ledger capped
 * to its newest N records is not drift, it is a shorter index over the same
 * conversation, and pairing positionally would report every row as wrong.
 */
export function diffLedger(stored: TurnRecord[], rebuilt: TurnRecord[]): LedgerDrift[] {
  const drift: LedgerDrift[] = []
  const byIndex = new Map(rebuilt.map((r) => [r.index, r]))
  for (const record of stored) {
    const other = byIndex.get(record.index)
    if (!other) {
      // A stored checkpoint the transcript no longer contains: a rewind that
      // truncated the session, or a record the parser can no longer see.
      drift.push({ index: record.index, field: 'missing', stored: record.prompt, rebuilt: null })
      continue
    }
    const a = derivedFields(record)
    const b = derivedFields(other)
    for (const field of ['prompt', 'reply', 'uuid', 'startedAt', 'endedAt'] as const) {
      if (a[field] !== b[field]) {
        drift.push({ index: record.index, field, stored: a[field], rebuilt: b[field] })
      }
    }
  }
  return drift
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
