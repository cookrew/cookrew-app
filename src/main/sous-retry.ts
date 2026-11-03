// RETRY IS FOR A BRIEF THAT NEVER LANDED (fix/hp-decide round 2, HIGH). The
// first cut re-sent anything the ledger had a proposal for — a delivered
// brief included. A retry needs the ledger to say the delivery failed or was
// interrupted and the owner not to have dismissed it, and the EXACT-ACTION
// check the commit itself makes: the target is not a served seat, is not in
// the middle of a turn, and the owner is not typing into its box.

import type { SousLedgerRow } from './sous-ledger'

export interface RetryTargetFacts {
  served: boolean
  /** The tracker's phase; thinking/waiting = mid-turn. Undefined = not tracked (not busy). */
  phase: 'idle' | 'thinking' | 'waiting' | 'replied' | undefined
  ownerComposing: boolean
}

export type RetryVerdict = { ok: true; nodeId: string; text: string } | { ok: false; error: string }

export function retryVerdict(row: SousLedgerRow | undefined, facts: (nodeId: string) => RetryTargetFacts | null): RetryVerdict {
  if (!row || !row.proposalText || !row.deliveredTo) return { ok: false, error: 'no such proposal' }
  if (row.dismissed) return { ok: false, error: 'that proposal was dismissed' }
  if (row.outcome !== 'failed' && row.outcome !== 'interrupted') return { ok: false, error: `that brief ${row.outcome === 'delivered' ? 'already landed' : `is ${row.outcome}`}` }
  const target = facts(row.deliveredTo)
  if (!target) return { ok: false, error: 'the card is gone' }
  if (target.served) return { ok: false, error: 'a served seat takes no retry' }
  if (target.phase === 'thinking' || target.phase === 'waiting') return { ok: false, error: 'the card is mid-turn — retry when it is idle' }
  if (target.ownerComposing) return { ok: false, error: 'the owner is composing in that box' }
  return { ok: true, nodeId: row.deliveredTo, text: row.proposalText }
}
