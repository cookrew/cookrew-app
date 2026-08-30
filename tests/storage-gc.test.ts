import { describe, expect, it } from 'vitest'
import { planStorageGc, type GcCandidate } from '../src/main/storage-gc'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const GRACE = 7 * DAY

const cand = (key: string, over: Partial<GcCandidate> = {}): GcCandidate => ({
  key,
  path: `/store/${key}`,
  bytes: 1000,
  mtimeMs: NOW - 30 * DAY,
  ...over
})

const plan = (over: Partial<Parameters<typeof planStorageGc>[0]> = {}) =>
  planStorageGc({
    ledgers: [],
    attachments: [],
    liveTerminalIds: new Set<string>(),
    referencedAttachments: new Set<string>(),
    now: NOW,
    graceMs: GRACE,
    ...over
  })

describe('planStorageGc — what may be reclaimed', () => {
  it('removes a ledger whose terminal is on no canvas and no saved team', () => {
    const out = plan({ ledgers: [cand('dead-1')] })
    expect(out.remove.map((c) => c.key)).toEqual(['dead-1'])
    expect(out.bytes).toBe(1000)
  })

  it('KEEPS a ledger whose terminal is still reachable', () => {
    // The live set is canvas nodes UNION every saved team's node ids: a
    // template you can still fork from is a live reference, even though the
    // card was deleted from the canvas months ago.
    const out = plan({ ledgers: [cand('alive')], liveTerminalIds: new Set(['alive']) })
    expect(out.remove).toEqual([])
    expect(out.kept.live).toBe(1)
  })

  it('removes an attachment nothing references', () => {
    const out = plan({ attachments: [cand('orphan.png')] })
    expect(out.remove.map((c) => c.key)).toEqual(['orphan.png'])
  })

  it('KEEPS an attachment a note or a saved team still points at', () => {
    const out = plan({
      attachments: [cand('used.png')],
      referencedAttachments: new Set(['used.png'])
    })
    expect(out.remove).toEqual([])
  })
})

describe('planStorageGc — the grace period is the safety net', () => {
  // Reference-by-scan cannot see intent. A card deleted a minute ago may be
  // undone; an image pasted a minute ago may not be referenced yet because the
  // turn carrying it has not flushed. Age is what separates "unreferenced" from
  // "abandoned", so nothing recent is ever collected however orphaned it looks.
  it('never removes a ledger younger than the grace period', () => {
    const out = plan({ ledgers: [cand('fresh', { mtimeMs: NOW - 1 * DAY })] })
    expect(out.remove).toEqual([])
    expect(out.kept.withinGrace).toBe(1)
  })

  it('never removes an attachment younger than the grace period', () => {
    const out = plan({ attachments: [cand('just-pasted.png', { mtimeMs: NOW - 60_000 })] })
    expect(out.remove).toEqual([])
    expect(out.kept.withinGrace).toBe(1)
  })

  it('treats the boundary as keep, not remove', () => {
    const out = plan({ ledgers: [cand('edge', { mtimeMs: NOW - GRACE })] })
    expect(out.remove).toEqual([])
  })

  it('a future mtime is never old enough — a clock skew must not delete data', () => {
    const out = plan({ ledgers: [cand('skewed', { mtimeMs: NOW + 10 * DAY })] })
    expect(out.remove).toEqual([])
  })
})

describe('planStorageGc — the plan is a report, not a side effect', () => {
  it('sums only what it would actually remove', () => {
    const out = plan({
      ledgers: [
        cand('dead-1', { bytes: 10 }),
        cand('alive', { bytes: 999 }),
        cand('fresh', { bytes: 999, mtimeMs: NOW })
      ],
      attachments: [cand('orphan.png', { bytes: 5 })],
      liveTerminalIds: new Set(['alive'])
    })
    expect(out.remove.map((c) => c.key).sort()).toEqual(['dead-1', 'orphan.png'])
    expect(out.bytes).toBe(15)
    expect(out.kept.live).toBe(1)
    expect(out.kept.withinGrace).toBe(1)
  })

  it('does not mutate its input', () => {
    const ledgers = [cand('dead-1')]
    const live = new Set<string>()
    plan({ ledgers, liveTerminalIds: live })
    expect(ledgers).toHaveLength(1)
    expect(live.size).toBe(0)
  })

  it('an empty store plans nothing rather than failing', () => {
    const out = plan()
    expect(out.remove).toEqual([])
    expect(out.bytes).toBe(0)
  })
})
