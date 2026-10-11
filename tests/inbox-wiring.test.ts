import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wireInbox } from '../src/main/inbox-wiring'
import type { InboxRow } from '../src/shared/inbox-rank'

// THE REBUILD RATE (fix round 1, HIGH 5). The first round rebuilt the inbox on
// the main thread at herdr-observation rate with the box closed, and fed
// itself through its own `sous.decide` lines. These tests own the clock.

const row = (id: string): InboxRow => ({
  nodeId: id,
  nodeName: id,
  nodeKind: 'terminal',
  workspaceId: 'ws',
  workspaceName: 'Dev',
  kind: 'waiting',
  kinds: ['waiting'],
  reasons: ['asks you'],
  since: 0,
  waitMinutes: 1,
  served: false,
  blockedDownstream: 0,
  score: 1
})

function harness(initial: InboxRow[] = [row('a')]) {
  let current = initial
  const announced: InboxRow[][] = []
  let op: (o: { type: string }) => void = () => undefined
  let ev: (e: { type: string }) => void = () => undefined
  let probe: () => void = () => undefined
  const wiring = wireInbox({
    build: () => current,
    onStoreOp: (cb) => {
      op = cb
      return () => undefined
    },
    onEvent: (cb) => {
      ev = cb
      return () => undefined
    },
    onProbeChange: (cb) => {
      probe = cb
      return () => undefined
    },
    announce: (rows) => announced.push(rows)
  })
  return { wiring, announced, op: (type = 'terminal.created') => op({ type }), ev: (type: string) => ev({ type }), probe: () => probe(), set: (rows: InboxRow[]) => (current = rows) }
}

describe('wireInbox — only while held, debounced, never on its own events', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('50 probe announces in one second are at most 3 rebuilds (here: one, when the burst ends)', () => {
    const h = harness()
    const release = h.wiring.hold()
    for (let i = 0; i < 50; i++) {
      h.probe()
      vi.advanceTimersByTime(20)
    }
    expect(h.wiring.rebuilds()).toBe(0)
    vi.advanceTimersByTime(400)
    expect(h.wiring.rebuilds()).toBe(1)
    expect(h.wiring.rebuilds()).toBeLessThanOrEqual(3)
    expect(h.announced).toHaveLength(1)
    release()
  })

  it('a sous.decide line (the inbox feeding itself) is 0 rebuilds; a store op is one', () => {
    const h = harness()
    h.wiring.hold()
    h.ev('sous.decide')
    h.ev('sous.recruit')
    vi.advanceTimersByTime(2000)
    expect(h.wiring.rebuilds()).toBe(0)
    h.op()
    vi.advanceTimersByTime(400)
    expect(h.wiring.rebuilds()).toBe(1)
    h.ev('secret.requested')
    vi.advanceTimersByTime(400)
    expect(h.wiring.rebuilds()).toBe(2)
  })

  it('with nobody holding, signals build nothing; a one-shot read builds on demand', () => {
    const h = harness()
    h.op()
    h.probe()
    vi.advanceTimersByTime(5000)
    expect(h.wiring.rebuilds()).toBe(0)
    expect(h.wiring.read()).toEqual([row('a')])
    expect(h.wiring.rebuilds()).toBe(1)
    // the last release cancels a pending build
    const release = h.wiring.hold()
    h.op()
    release()
    vi.advanceTimersByTime(1000)
    expect(h.wiring.rebuilds()).toBe(1)
  })

  it('announces only when the words change', () => {
    const h = harness()
    h.wiring.hold()
    h.op()
    vi.advanceTimersByTime(400)
    h.op()
    vi.advanceTimersByTime(400)
    expect(h.wiring.rebuilds()).toBe(2)
    expect(h.announced).toHaveLength(1)
    h.set([row('a'), row('b')])
    h.op()
    vi.advanceTimersByTime(400)
    expect(h.announced).toHaveLength(2)
  })
})

describe('wireInbox — round 2: the STORE-op seam', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('Sous’s own notes arrive as store ops and rebuild nothing; a card op rebuilds once', () => {
    const h = harness()
    h.wiring.hold()
    h.op('sous.decide')
    h.op('sous.recruit')
    h.op('sous.ask')
    vi.advanceTimersByTime(2000)
    expect(h.wiring.rebuilds()).toBe(0)
    h.op('terminal.recruited')
    h.op('connection.added')
    vi.advanceTimersByTime(400)
    expect(h.wiring.rebuilds()).toBe(1)
  })
})
