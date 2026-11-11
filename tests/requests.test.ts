// THE ONE QUEUE, ON THE DESKTOP (D11) — the poll, the one notification, and
// how a sign-in waiting for a nod is answered.
//
// What is worth a test here is restraint and honesty. The poll must be a poll
// and not a stampede; a notification must fire ONCE per row, because an OS
// toast repeating every twenty seconds is how a person learns to dismiss the
// approval prompt without reading it; a registry that hiccups must not clear a
// request the owner was about to answer; and the two kinds nothing raises
// since 0.6.0 (a phone asking for Wi-Fi, a guest asking for a seat) must be
// nothing here: not listed, not counted, not announced, not answerable, and
// never mistaken for a sign-in.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Requests, REQUESTS_POLL_MS, answeredStoreIn } from '../src/main/requests'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AccountResult } from '../src/shared/account-v2'
import type { AnsweredRow, QueueRow } from '../src/shared/account-requests'

const NOW = 1_757_000_000_000

const join = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: 'req-1',
  kind: 'join',
  device: 'Mac Studio',
  address: '203.0.113.9',
  at: NOW - 12_000,
  expiresAt: NOW + 120_000,
  state: 'pending',
  ...over,
})
/** The row an older registry sent for a phone asking for Wi-Fi: a kind this app no longer has. */
const strayReach = (): QueueRow =>
  ({
    id: 'reach-1',
    kind: 'reach',
    device: 'iPhone',
    address: 'iPhone',
    at: NOW - 12_000,
    expiresAt: NOW + 120_000,
    state: 'pending',
    askKey: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' },
  }) as unknown as QueueRow
/**
 * The row an older registry sent for a guest asking for a seat: also a kind
 * this app no longer has. `device` is a field a seat row never carried; it is
 * here so that a row dressed as a sign-in in every way but its kind is still
 * not taken for one.
 */
const straySeat = (over: Record<string, unknown> = {}): QueueRow =>
  ({
    id: 'seat-1',
    kind: 'seat',
    account: 'jkim',
    team: '@drej/alpha',
    address: 'jkim',
    at: NOW - 12_000,
    expiresAt: NOW + 120_000,
    state: 'pending',
    ...over,
  }) as unknown as QueueRow

interface Posted {
  path: string
  body: Record<string, unknown>
}

interface Harness {
  requests: Requests
  calls: { path: string; init?: RequestInit & { parse?: boolean } }[]
  posts: Posted[]
  notes: { title: string; body: string; requestId: string | null }[]
  events: { kind: string; sentence: string }[]
  answered: AnsweredRow[]
  changes: number
  setQueue: (rows: readonly QueueRow[]) => void
  setFeed: (events: readonly unknown[], cursor?: number) => void
  setAnswer: (fn: (path: string) => AccountResult<unknown>) => void
  /** What the registry answered the approvals POST with. 204 by default. */
  setApprovalAnswer: (status: number, body?: unknown) => void
}

function harness(over: { account?: boolean; sessionLive?: boolean } = {}): Harness {
  const calls: Harness['calls'] = []
  const posts: Posted[] = []
  const notes: Harness['notes'] = []
  const events: Harness['events'] = []
  const state = { changes: 0, answered: [] as AnsweredRow[], approval: { status: 204, body: undefined as unknown } }
  let queue: readonly QueueRow[] = []
  let feed: { events: readonly unknown[]; cursor: number } = { events: [], cursor: 0 }
  let answer: ((path: string) => AccountResult<unknown>) | null = null

  const requests = new Requests({
    accounts: {
      call: <T>(path: string, init?: RequestInit & { parse?: boolean }) => {
        calls.push({ path, ...(init ? { init } : {}) })
        if (init?.method === 'POST') {
          posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> })
          return Promise.resolve({ ok: true, value: undefined } as AccountResult<T>)
        }
        if (answer) return Promise.resolve(answer(path) as AccountResult<T>)
        if (path.startsWith('/v2/me/events')) {
          return Promise.resolve({ ok: true, value: feed } as AccountResult<T>)
        }
        return Promise.resolve({ ok: true, value: queue } as AccountResult<T>)
      },
      authedResponse: (path: string, init?: RequestInit) => {
        calls.push({ path, ...(init ? { init: init as RequestInit & { parse?: boolean } } : {}) })
        posts.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
        const { status, body } = state.approval
        return Promise.resolve({
          ok: true as const,
          response: new Response(body === undefined ? null : JSON.stringify(body), { status }),
        })
      },
      account: () => (over.account === false ? null : { username: 'drej', deviceId: 'mac-1' }),
      sessionLive: () => over.sessionLive !== false,
    },
    notify: (note) => void notes.push(note),
    onChange: () => void (state.changes += 1),
    onEvent: (event, sentence) => void events.push({ kind: event.kind, sentence }),
    answered: {
      read: () => state.answered,
      write: (rows) => {
        state.answered = [...rows]
      },
    },
    now: () => NOW,
  })

  return {
    requests,
    calls,
    posts,
    notes,
    events,
    get answered() {
      return state.answered
    },
    get changes() {
      return state.changes
    },
    setQueue: (rows) => {
      queue = rows
    },
    setFeed: (next, cursor = 1) => {
      feed = { events: next, cursor }
    },
    setAnswer: (fn) => {
      answer = fn
    },
    setApprovalAnswer: (status, body) => {
      state.approval = { status, body }
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the poll', () => {
  it('asks the queue and the feed at once, then every twenty seconds', async () => {
    const h = harness()
    h.requests.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls.map((c) => c.path)).toEqual(['/v2/me/requests', '/v2/me/events?since=0'])
    await vi.advanceTimersByTimeAsync(REQUESTS_POLL_MS)
    expect(h.calls).toHaveLength(4)
  })

  it('starting twice does not double the cadence', async () => {
    const h = harness()
    h.requests.start()
    h.requests.start()
    await vi.advanceTimersByTimeAsync(REQUESTS_POLL_MS)
    expect(h.calls).toHaveLength(4)
  })

  it('opens no socket at all without an account, and the count is zero', async () => {
    const h = harness({ account: false })
    await h.requests.refresh()
    expect(h.calls).toEqual([])
    expect(h.requests.count).toBe(0)
  })

  it('opens no socket while the session is dead — the owner cannot answer', async () => {
    const h = harness({ sessionLive: false })
    await h.requests.refresh()
    expect(h.calls).toEqual([])
  })

  it('a refusal leaves the waiting rows exactly where they were', async () => {
    const h = harness()
    h.setQueue([join()])
    await h.requests.refresh()
    expect(h.requests.count).toBe(1)
    h.setAnswer(() => ({ ok: false, reason: 'offline' }))
    await h.requests.refresh()
    expect(h.requests.count).toBe(1)
  })

  it('reads the feed forward from the cursor it was given', async () => {
    const h = harness()
    h.setFeed([], 7)
    await h.requests.refresh()
    await h.requests.refresh()
    expect(h.calls.map((c) => c.path)).toContain('/v2/me/events?since=7')
  })

  it('refuses a row the registry sent in a shape this app does not know', async () => {
    const h = harness()
    h.setQueue([join(), { ...join({ id: 'bad' }), kind: 'gossip' } as unknown as QueueRow])
    await h.requests.refresh()
    expect(h.requests.list().map((r) => r.id)).toEqual(['req-1'])
  })
})

describe('the badge and the lock screen', () => {
  it('counts every sign-in that is waiting', async () => {
    const h = harness()
    h.setQueue([join(), join({ id: 'req-2', device: 'iPhone' })])
    await h.requests.refresh()
    expect(h.requests.count).toBe(2)
  })

  it('names the devices waiting to JOIN, which is what a lock can act on', async () => {
    const h = harness()
    h.setQueue([join(), join({ id: 'req-2', device: 'iPhone' })])
    await h.requests.refresh()
    expect(h.requests.joinRequests().map((r) => r.deviceName)).toEqual(['Mac Studio', 'iPhone'])
  })

  it('tells main the list changed, so the badge follows', async () => {
    const h = harness()
    h.setQueue([join()])
    await h.requests.refresh()
    expect(h.changes).toBe(1)
    await h.requests.refresh()
    expect(h.changes).toBe(1)
  })
})

describe('what is announced', () => {
  it('says who is asking, once for each new row', async () => {
    const h = harness()
    h.setQueue([join(), join({ id: 'req-2', device: 'iPhone' })])
    await h.requests.refresh()
    expect(h.notes.map((n) => n.body)).toEqual([
      'Mac Studio wants to join @drej',
      'iPhone wants to join @drej',
    ])
    // The notification carries the row it is about, so a click can land on it.
    expect(h.notes.map((n) => n.requestId)).toEqual(['req-1', 'req-2'])
  })

  it('does NOT fire again for a row that is still waiting', async () => {
    const h = harness()
    h.setQueue([join()])
    await h.requests.refresh()
    await h.requests.refresh()
    expect(h.notes).toHaveLength(1)
  })

  it('announces every account:changed kind, and says nothing for one this build does not have', async () => {
    const h = harness()
    h.setFeed([
      { seq: 1, kind: 'joined', device: 'Mac Studio', at: NOW },
      { seq: 2, kind: 'revoked', device: 'iPhone', at: NOW },
      { seq: 3, kind: 'password-changed', at: NOW },
      { seq: 4, kind: 'door-moved', device: 'Mac Studio', address: 'alpha', at: NOW },
      { seq: 5, kind: 'not-me', at: NOW },
      // What an older registry sent when a row arrived (a seat ask). The row
      // announces itself; this build has no such kind and says nothing for it.
      { seq: 6, kind: 'request', at: NOW },
    ])
    await h.requests.refresh()
    expect(h.notes.map((n) => n.body)).toEqual([
      'Mac Studio joined @drej',
      expect.stringContaining('The iPhone stops opening this account'),
      expect.stringContaining('The password changed'),
      'alpha moved to Mac Studio. This Mac stopped serving it.',
      'A sign-in as @drej was denied on another device',
    ])
    // The renderer raises a toast for each of the same five.
    expect(h.events.map((e) => e.kind)).toEqual([
      'joined',
      'revoked',
      'password-changed',
      'door-moved',
      'not-me',
    ])
  })
})

describe('answering a sign-in (R3, the number)', () => {
  it('carries the two digits, and re-reads the queue afterwards', async () => {
    const h = harness()
    h.setQueue([join()])
    await h.requests.refresh()
    expect(await h.requests.decide('req-1', 'approve', '42')).toEqual({ ok: true })
    expect(h.posts[0]).toEqual({ path: '/v2/me/approvals/req-1', body: { decision: 'approve', match: '42' } })
    expect(h.calls.filter((c) => c.path === '/v2/me/requests')).toHaveLength(2)
  })

  it('hands back how much rope is left when the number was wrong', async () => {
    const h = harness()
    h.setQueue([join()])
    await h.requests.refresh()
    h.setApprovalAnswer(400, { error: 'bad_match', message: 'no', triesLeft: 2 })
    expect(await h.requests.decide('req-1', 'approve', '43')).toEqual({
      ok: false,
      reason: 'bad_match',
      triesLeft: 2,
    })
    // Nothing is recorded: the sign-in did not happen.
    expect(h.answered).toEqual([])
  })

  it('sends DENY and NOT ME without a number — an alarm is never harder than a mistake', async () => {
    const h = harness()
    h.setQueue([join()])
    await h.requests.refresh()
    await h.requests.decide('req-1', 'not-me')
    expect(h.posts[0].body).toEqual({ decision: 'not-me' })
  })

  it('escapes an id rather than pasting it into the path', async () => {
    const h = harness()
    h.setQueue([join({ id: 'a/b?c' })])
    await h.requests.refresh()
    await h.requests.decide('a/b?c', 'deny')
    expect(h.posts[0].path).toBe('/v2/me/approvals/a%2Fb%3Fc')
  })

  it('refuses a row it is not holding, without a socket', async () => {
    const h = harness()
    expect(await h.requests.decide('nobody', 'approve', '42')).toEqual({ ok: false, reason: 'not_found' })
    expect(h.posts).toEqual([])
  })
})

describe('the kinds nothing raises any more (0.6.0): a phone asking for Wi-Fi, a guest asking for a seat', () => {
  /** Each stray row, and the same seat row dressed up with a sign-in's own fields. */
  const STRAYS: readonly [string, () => QueueRow][] = [
    ['a phone asking for Wi-Fi', strayReach],
    ['a guest asking for a seat', () => straySeat()],
    ['a seat row carrying a device name', () => straySeat({ device: 'Mac Studio', address: '203.0.113.9' })]
  ]

  it('is not a row here: not listed, not counted, not announced, not on the lock screen', async () => {
    for (const [name, stray] of STRAYS) {
      const h = harness()
      h.setQueue([join(), stray()])
      await h.requests.refresh()
      expect(h.requests.list().map((r) => r.id), name).toEqual(['req-1'])
      expect(h.requests.list().every((r) => r.kind === 'join'), name).toBe(true)
      expect(h.requests.count, name).toBe(1)
      expect(h.notes.map((n) => n.requestId), name).toEqual(['req-1'])
      expect(h.notes.map((n) => n.body), name).toEqual(['Mac Studio wants to join @drej'])
      // Never mistaken for a sign-in: the lock screen names the one device that is really at the door.
      expect(h.requests.joinRequests().map((r) => r.id), name).toEqual(['req-1'])
    }
  })

  it('alone in the queue, it is an empty queue: no badge, no change told, no notification', async () => {
    for (const [name, stray] of STRAYS) {
      const h = harness()
      h.setQueue([stray()])
      await h.requests.refresh()
      expect(h.requests.list(), name).toEqual([])
      expect(h.requests.count, name).toBe(0)
      expect(h.changes, name).toBe(0)
      expect(h.notes, name).toEqual([])
      expect(h.requests.joinRequests(), name).toEqual([])
    }
  })

  it('cannot be answered: no button reaches it, with a number or without, and nothing is sent or kept', async () => {
    for (const [name, stray] of STRAYS) {
      const h = harness()
      const row = stray()
      h.setQueue([row])
      await h.requests.refresh()
      // The three buttons a row has, and the two a seat row once had.
      for (const action of ['approve', 'deny', 'not-me', 'seat-them', 'decline']) {
        expect(await h.requests.decide(row.id, action as never, '42'), `${name} ${action}`).toEqual({ ok: false, reason: 'not_found' })
      }
      // Above all, not sent to the approvals route as if it were a sign-in.
      expect(h.posts, name).toEqual([])
      expect(h.answered, name).toEqual([])
    }
  })

  it('leaves the sign-in beside it answerable, on the approvals route and no other', async () => {
    const h = harness()
    h.setQueue([strayReach(), join(), straySeat()])
    await h.requests.refresh()
    expect(await h.requests.decide('seat-1', 'approve', '42')).toEqual({ ok: false, reason: 'not_found' })
    expect(await h.requests.decide('req-1', 'approve', '42')).toEqual({ ok: true })
    expect(h.posts).toEqual([{ path: '/v2/me/approvals/req-1', body: { decision: 'approve', match: '42' } }])
    expect(h.answered.map((r) => [r.id, r.kind, r.outcome])).toEqual([['req-1', 'join', 'joined']])
  })

  it('a button a seat row once had is not a way to answer a sign-in', async () => {
    const h = harness()
    h.setQueue([join()])
    await h.requests.refresh()
    for (const action of ['seat-them', 'decline']) {
      expect(await h.requests.decide('req-1', action as never), action).toEqual({ ok: false, reason: 'unknown' })
    }
    expect(h.posts).toEqual([])
    expect(h.answered).toEqual([])
  })
})

describe('what this Mac remembers', () => {
  it('keeps a receipt for each outcome it can claim', async () => {
    const h = harness()
    h.setQueue([join(), join({ id: 'req-2', device: 'iPhone' })])
    await h.requests.refresh()
    await h.requests.decide('req-1', 'approve', '42')
    await h.requests.decide('req-2', 'deny')
    expect(h.answered.map((r) => [r.kind, r.outcome, r.subject])).toEqual([
      ['join', 'denied', 'iPhone'],
      ['join', 'joined', 'Mac Studio'],
    ])
    // A receipt is the device and what became of it, and nothing a seat row once added.
    expect(h.answered.every((r) => !('team' in r))).toBe(true)
  })

  it('records a denial as the disowned row, and nothing for an answer that was refused', async () => {
    const h = harness()
    h.setQueue([join(), join({ id: 'req-2', device: 'iPhone' })])
    await h.requests.refresh()
    await h.requests.decide('req-1', 'not-me')
    expect(h.answered.map((r) => r.outcome)).toEqual(['denied'])
    h.setApprovalAnswer(400, { error: 'bad_match', message: 'no', triesLeft: 2 })
    await h.requests.decide('req-2', 'approve', '43')
    // A sign-in that did not happen is not a thing this Mac may claim.
    expect(h.answered.map((r) => r.outcome)).toEqual(['denied'])
  })

  it('shows only the rows still inside their seven days', async () => {
    const h = harness()
    h.setQueue([join()])
    await h.requests.refresh()
    await h.requests.decide('req-1', 'approve', '42')
    expect(h.requests.history()).toHaveLength(1)
  })

  it('survives a restart, and a file it cannot read is simply empty', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-requests-'))
    try {
      const store = answeredStoreIn(base)
      expect(store.read()).toEqual([])
      const row: AnsweredRow = { id: 'a', kind: 'join', outcome: 'joined', subject: 'Mac Studio', at: NOW }
      store.write([
        row,
        { ...row, id: 'b', outcome: 'gossip' } as unknown as AnsweredRow,
        // A receipt an earlier build kept for a phone it let in on Wi-Fi.
        { ...row, id: 'c', kind: 'reach', outcome: 'allowed', subject: 'iPhone' } as unknown as AnsweredRow,
        // And the ones it kept for a guest it seated, in every mix of the old kind and the old outcome.
        { ...row, id: 'd', kind: 'seat', outcome: 'seated', subject: 'jkim', team: '@drej/alpha' } as unknown as AnsweredRow,
        { ...row, id: 'e', kind: 'seat', outcome: 'joined', subject: 'jkim' } as unknown as AnsweredRow,
        { ...row, id: 'f', kind: 'join', outcome: 'seated', subject: 'jkim' } as unknown as AnsweredRow,
      ])
      // What comes back is only what this app knows how to draw.
      expect(store.read()).toEqual([row])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
