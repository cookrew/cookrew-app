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
    sidecars: [],
    liveTerminalIds: new Set<string>(),
    referencedAttachments: new Set<string>(),
    referencedSidecars: new Set<string>(),
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

describe('planStorageGc — team session sidecars are the third class', () => {
  // A sidecar key is the path the app resolves: <slug>-sessions/<file>. The
  // planner does not know about slugs; it only asks whether the key is in the
  // referenced set, which the scan built from every readable team JSON.
  const key = 'crew-sessions/a.jsonl'

  it('KEEPS a sidecar the owning team still names (live-named)', () => {
    const out = plan({ sidecars: [cand(key)], referencedSidecars: new Set([key]) })
    expect(out.remove).toEqual([])
    expect(out.kept.live).toBe(1)
  })

  it('removes a sidecar under a live team that no longer names it (orphan-in-live-team)', () => {
    const out = plan({
      sidecars: [cand(key), cand('crew-sessions/gone.jsonl', { bytes: 7 })],
      referencedSidecars: new Set([key])
    })
    expect(out.remove.map((c) => c.key)).toEqual(['crew-sessions/gone.jsonl'])
    expect(out.bytes).toBe(7)
  })

  it('removes every file of a sidecar dir whose team is missing (team-missing)', () => {
    const out = plan({
      sidecars: [cand('lost-sessions/a.jsonl'), cand('lost-sessions/b.jsonl')],
      referencedSidecars: new Set([key])
    })
    expect(out.remove.map((c) => c.key).sort()).toEqual(['lost-sessions/a.jsonl', 'lost-sessions/b.jsonl'])
  })

  it('the same file name under another team\'s dir is NOT a reference', () => {
    // cookrew-team names 1faa.jsonl; the copy in cookrew-core-sessions is one
    // no team can open, so it is a candidate — that is the live-store case.
    const out = plan({
      sidecars: [cand('cookrew-core-sessions/1faa.jsonl')],
      referencedSidecars: new Set(['cookrew-team-sessions/1faa.jsonl'])
    })
    expect(out.remove.map((c) => c.key)).toEqual(['cookrew-core-sessions/1faa.jsonl'])
  })

  it('an unreadable team store arrives as NO candidates, so nothing is planned (unreadable-team-aborts)', () => {
    // The scan expresses "I could not read every team" as sidecars: [] —
    // the planner has no policy of its own and plans exactly what it is given.
    const out = plan({ sidecars: [], referencedSidecars: new Set<string>() })
    expect(out.remove).toEqual([])
    expect(out.kept).toEqual({ live: 0, withinGrace: 0 })
  })

  it('never removes a sidecar younger than the grace period (grace-period-holds)', () => {
    const out = plan({ sidecars: [cand('lost-sessions/new.jsonl', { mtimeMs: NOW - 2 * DAY })] })
    expect(out.remove).toEqual([])
    expect(out.kept.withinGrace).toBe(1)
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

describe('planStorageGc — served sessions have their own live rule', () => {
  // A sandbox is live while its session is OPEN in the running instantiator.
  // Nothing on disk says that; the app hands the set in. Every other class is
  // referenced by a scan that can only over-read; this one is referenced by a
  // fact, and an absent fact is not the same as an empty one.
  const sandbox = (key: string, over: Partial<GcCandidate> = {}): GcCandidate =>
    cand(key, { path: `/store/sessions/${key}`, bytes: 6_000_000, ...over })

  it('keeps an OPEN session however old its newest write is', () => {
    const out = plan({
      servedSessions: [sandbox('svc-x/ana-1', { mtimeMs: NOW - 400 * DAY })],
      openServedSessions: new Set(['svc-x/ana-1'])
    })
    expect(out.remove).toEqual([])
    expect(out.kept.live).toBe(1)
  })

  it('removes an ENDED session once it is past grace — the whole sandbox, as one candidate', () => {
    const out = plan({
      servedSessions: [sandbox('svc-x/ana-1')],
      openServedSessions: new Set<string>()
    })
    expect(out.remove.map((c) => c.path)).toEqual(['/store/sessions/svc-x/ana-1'])
    expect(out.bytes).toBe(6_000_000)
  })

  it('grace holds an ended session that was written to recently', () => {
    const out = plan({
      servedSessions: [sandbox('svc-x/ana-1', { mtimeMs: NOW - 1 * DAY })],
      openServedSessions: new Set<string>()
    })
    expect(out.remove).toEqual([])
    expect(out.kept.withinGrace).toBe(1)
  })

  it('plans NOTHING for the class when no open set was given — unknown is not empty', () => {
    const out = plan({ servedSessions: [sandbox('svc-x/ana-1', { mtimeMs: NOW - 400 * DAY })] })
    expect(out.remove).toEqual([])
    // Not counted as live either: the class was not looked at.
    expect(out.kept).toEqual({ live: 0, withinGrace: 0 })
  })

  it('an open session on another service does not vouch for a same-named one here', () => {
    const out = plan({
      servedSessions: [sandbox('svc-x/ana-1'), sandbox('svc-y/ana-1')],
      openServedSessions: new Set(['svc-y/ana-1'])
    })
    expect(out.remove.map((c) => c.key)).toEqual(['svc-x/ana-1'])
  })
})
