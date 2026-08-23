import { readFileSync } from 'node:fs'
import { harnessFor } from './harness'
import type { TerminalNodeData } from '../shared/model'
import type { TurnRecord } from '../shared/turn'
import { sessionChain, refuseRenumber, walkRefusals, type JoinRefusal } from './lineage-ledger'

/**
 * Rebuild an agent's checkpoint history ACROSS its compacts, numbered
 * continuously.
 *
 * A compact ends one transcript and starts another, and the ledger is built
 * from the current file alone — so the numbering restarts at 1 and everything
 * earlier stops being addressable. Nothing was deleted: ledger-rebuild.ts says
 * the transcripts are the conversation and the ledger is an index over them.
 * This rebuilds the index over the WHOLE chain.
 *
 * Repeatable and node-agnostic on purpose. Every agent that has ever compacted
 * has the same hole, so a fix shaped as a script for one of them would have to
 * be written again for the next.
 */

export interface LineageRecovery {
  terminalId: string
  /** Session files walked, oldest first. */
  chain: string[]
  /** Records per file, in chain order — what each transcript contributed. */
  perFile: number[]
  /** The rebuilt history, renumbered continuously from 1. */
  records: TurnRecord[]
  /** What the ledger holds today, for comparison. */
  existing: number
  /** Why the walk stopped where it did, when it stopped at an inferred join. */
  refusals: readonly JoinRefusal[]
}

export type RecoveryOutcome =
  | { ok: true; recovery: LineageRecovery }
  | { ok: false; reason: 'refused' | 'no-harness' | 'no-chain'; detail: string }

export interface RecoverDeps {
  /** Version pins on this node. Non-zero REFUSES — see refuseRenumber. */
  pinCount: (terminalId: string) => number
  /** The ledger as it stands, for the before/after count. */
  existingRecords: (terminalId: string) => TurnRecord[]
  readFile?: (file: string) => string
  inferClearJoins?: boolean
  /** Transcript root. Injected so a recovery can be exercised without the
   *  caller's real ~/.claude — this tool rewrites history and must be testable
   *  somewhere that is not the owner's machine. */
  projectsDir?: string
}

/**
 * Walk, rebuild, renumber — WITHOUT writing anything.
 *
 * Deliberately separate from the write. A recovery that reports what it would
 * do, and can be read before it does it, is the difference between a repair and
 * a hope — and this one rewrites the owner's real history.
 */
export async function planRecovery(
  node: TerminalNodeData,
  deps: RecoverDeps
): Promise<RecoveryOutcome> {
  const refusal = refuseRenumber(node.id, deps.pinCount(node.id))
  if (refusal) return { ok: false, reason: 'refused', detail: refusal.detail }

  const harness = harnessFor(node.command ?? '')
  const parseTurns = harness?.parseTurns
  if (!harness || !parseTurns) {
    return { ok: false, reason: 'no-harness', detail: 'no transcript parser for this harness' }
  }
  const sessionId = node.claudeSessionId
  if (!sessionId) {
    return { ok: false, reason: 'no-chain', detail: 'node has no bound claude session' }
  }

  const chain = await sessionChain(node.cwd, sessionId, {
    inferClearJoins: deps.inferClearJoins === true,
    projectsDir: deps.projectsDir
  })
  if (chain.length === 0) {
    return { ok: false, reason: 'no-chain', detail: `no transcript for ${sessionId}` }
  }

  const read = deps.readFile ?? ((file: string) => readFileSync(file, 'utf8'))
  const records: TurnRecord[] = []
  const perFile: number[] = []
  for (const step of chain) {
    const parsed = parseTurns(read(step.file).split('\n'))
    perFile.push(parsed.length)
    // Renumber continuously across the join. Each transcript numbers its own
    // turns from 1; the position in the LINEAGE is what the rail shows and what
    // the owner counts, so it is assigned here rather than inherited.
    for (const record of parsed) records.push({ ...record, index: records.length + 1 })
  }

  return {
    ok: true,
    recovery: {
      terminalId: node.id,
      chain: chain.map((s) => s.sessionId),
      perFile,
      records,
      existing: deps.existingRecords(node.id).length,
      refusals: walkRefusals()
    }
  }
}
