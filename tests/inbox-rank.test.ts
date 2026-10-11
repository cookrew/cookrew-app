import { describe, expect, it } from 'vitest'
import { inboxScore, rankInbox, waitedFor, type InboxItem } from '../src/shared/inbox-rank'

const NOW = Date.parse('2026-10-11T10:00:00Z')
const min = (n: number): number => NOW - n * 60_000

const item = (patch: Partial<InboxItem> & Pick<InboxItem, 'nodeId' | 'kind'>): InboxItem => ({
  nodeName: patch.nodeId,
  nodeKind: 'terminal',
  workspaceId: 'ws',
  workspaceName: 'Cookrew Dev',
  reason: `${patch.kind} reason`,
  since: min(5),
  served: false,
  blockedDownstream: 0,
  ...patch
})

describe('rankInbox — one row per card, the most stuck first', () => {
  it('orders by score: blocked downstream and wait time both lift a row', () => {
    const rows = rankInbox(
      [
        item({ nodeId: 'a', kind: 'waiting', since: min(4), blockedDownstream: 2 }),
        item({ nodeId: 'b', kind: 'secret', since: min(1), blockedDownstream: 1 }),
        item({ nodeId: 'c', kind: 'signin', since: min(12), blockedDownstream: 0 })
      ],
      NOW
    )
    expect(rows.map((r) => r.nodeId)).toEqual(['a', 'c', 'b'])
    expect(rows[0].score).toBeCloseTo(3 * Math.log1p(4), 6)
    expect(rows[0].waitMinutes).toBeCloseTo(4, 6)
  })

  it('merges every signal about one card into one row and lets the strongest kind win the click', () => {
    const rows = rankInbox(
      [
        item({ nodeId: 'forge', kind: 'dispatch', since: min(10), reason: 'delivery refused — owner is composing' }),
        item({ nodeId: 'forge', kind: 'waiting', since: min(3), reason: 'asks you — "replace the headings too?"', blockedDownstream: 2 }),
        item({ nodeId: 'forge', kind: 'secret', since: min(1), reason: 'needs STRIPE_SECRET_KEY', slot: 'STRIPE_SECRET_KEY', noteId: 'n1' })
      ],
      NOW
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.kind).toBe('secret')
    expect(row.kinds).toEqual(['secret', 'waiting', 'dispatch'])
    expect(row.reasons).toEqual(['needs STRIPE_SECRET_KEY', 'asks you — "replace the headings too?"', 'delivery refused — owner is composing'])
    // the wait is the oldest signal's, the blockage the largest
    expect(row.since).toBe(min(10))
    expect(row.blockedDownstream).toBe(2)
    expect(row.slot).toBe('STRIPE_SECRET_KEY')
    expect(row.noteId).toBe('n1')
  })

  it('weights a served seat double — their wait costs money', () => {
    const rows = rankInbox(
      [
        item({ nodeId: 'mine', kind: 'waiting', since: min(8) }),
        item({ nodeId: 'theirs', kind: 'waiting', since: min(5), served: true })
      ],
      NOW
    )
    expect(rows.map((r) => r.nodeId)).toEqual(['theirs', 'mine'])
    expect(rows[0].score).toBeCloseTo(inboxScore({ blockedDownstream: 0, waitMinutes: 5, served: true }), 6)
    expect(inboxScore({ blockedDownstream: 0, waitMinutes: 5, served: true })).toBeCloseTo(2 * Math.log1p(5), 6)
  })

  it('breaks a tie by the longer wait, then the name — the list is stable between reads', () => {
    const rows = rankInbox(
      [item({ nodeId: 'b', nodeName: 'Beta', kind: 'waiting', since: min(3) }), item({ nodeId: 'a', nodeName: 'Alpha', kind: 'waiting', since: min(3) })],
      NOW
    )
    expect(rows.map((r) => r.nodeName)).toEqual(['Alpha', 'Beta'])
    expect(rankInbox([], NOW)).toEqual([])
  })

  it('prints the wait the way the box does', () => {
    expect(waitedFor(0.4)).toBe('now')
    expect(waitedFor(4.9)).toBe('4 m')
    expect(waitedFor(130)).toBe('2 h')
    expect(waitedFor(3 * 24 * 60 + 5)).toBe('3 d')
  })
})
