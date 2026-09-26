// THE ONE QUEUE, ON THE DESKTOP (D11) — the poll, the one notification, and
// the three ways a row is answered.
//
// What is worth a test here is restraint and honesty. The poll must be a poll
// and not a stampede; a notification must fire ONCE per row, because an OS
// toast repeating every twenty seconds is how a person learns to dismiss the
// approval prompt without reading it; a registry that hiccups must not clear a
// request the owner was about to answer; and ALLOW must hand out a token
// minted for ONE phone, sealed to the key that asked, rather than the root
// credential every phone used to share.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { Requests, REQUESTS_POLL_MS, answeredStoreIn } from '../src/main/requests'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AccountResult } from '../src/shared/account-v2'
import type { AnsweredRow, QueueRow } from '../src/shared/account-requests'
import { reachSealInfo } from '../src/shared/account-requests'
import { openAtDevice, type SealedToDevice } from '../src/shared/device-seal'
import { deviceIdFor } from '../src/main/account-v2'

const NOW = 1_757_000_000_000

const askPair = generateKeyPairSync('ed25519')
const ASK_PUB = askPair.publicKey.export({ format: 'jwk' }) as Record<string, string>
const ASK_PRIV = askPair.privateKey.export({ format: 'jwk' }) as Record<string, string>

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
const reach = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: 'reach-1',
  kind: 'reach',
  device: 'iPhone',
  address: 'iPhone',
  at: NOW - 12_000,
  expiresAt: NOW + 120_000,
  state: 'pending',
  askKey: ASK_PUB,
  ...over,
})
const seat = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: 'seat-1',
  kind: 'seat',
  account: 'jkim',
  team: '@drej/alpha',
  address: 'jkim',
  at: NOW - 12_000,
  expiresAt: NOW + 120_000,
  state: 'pending',
  ...over,
})

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
  minted: { deviceId: string; name?: string }[]
  answered: AnsweredRow[]
  changes: number
  setQueue: (rows: readonly QueueRow[]) => void
  setFeed: (events: readonly unknown[], cursor?: number) => void
  setAnswer: (fn: (path: string) => AccountResult<unknown>) => void
  /** What the registry answered the approvals POST with. 204 by default. */
  setApprovalAnswer: (status: number, body?: unknown) => void
}

function harness(over: { account?: boolean; sessionLive?: boolean; reach?: boolean } = {}): Harness {
  const calls: Harness['calls'] = []
  const posts: Posted[] = []
  const notes: Harness['notes'] = []
  const events: Harness['events'] = []
  const minted: Harness['minted'] = []
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
    ...(over.reach === false
      ? {}
      : {
          reach: {
            admit: (device) => {
              minted.push(device)
              return { token: `tok-${device.deviceId.slice(0, 4)}` }
            },
            pairingUrlFor: (token) => `https://cookrew.dev/relay/@drej/desktop/mac-1/#pair=${token}`,
          },
        }),
    now: () => NOW,
  })

  return {
    requests,
    calls,
    posts,
    notes,
    events,
    minted,
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
  it('counts every kind, not only sign-ins', async () => {
    const h = harness()
    h.setQueue([join(), reach(), seat()])
    await h.requests.refresh()
    expect(h.requests.count).toBe(3)
  })

  it('names only the devices waiting to JOIN, which is what a lock can act on', async () => {
    const h = harness()
    h.setQueue([join(), reach(), seat()])
    await h.requests.refresh()
    expect(h.requests.joinRequests().map((r) => r.deviceName)).toEqual(['Mac Studio'])
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
  it('says what kind of asking each new row is', async () => {
    const h = harness()
    h.setQueue([join(), reach(), seat()])
    await h.requests.refresh()
    expect(h.notes.map((n) => n.body)).toEqual([
      'Mac Studio wants to join @drej',
      'iPhone wants to reach this Mac on Wi-Fi.',
      '@jkim asks for a seat at @drej/alpha.',
    ])
    // The notification carries the row it is about, so a click can land on it.
    expect(h.notes.map((n) => n.requestId)).toEqual(['req-1', 'reach-1', 'seat-1'])
  })

  it('does NOT fire again for a row that is still waiting', async () => {
    const h = harness()
    h.setQueue([join()])
    await h.requests.refresh()
    await h.requests.refresh()
    expect(h.notes).toHaveLength(1)
  })

  it('announces every account:changed kind — except the one a row already said', async () => {
    const h = harness()
    h.setFeed([
      { seq: 1, kind: 'joined', device: 'Mac Studio', at: NOW },
      { seq: 2, kind: 'revoked', device: 'iPhone', at: NOW },
      { seq: 3, kind: 'password-changed', at: NOW },
      { seq: 4, kind: 'door-moved', device: 'Mac Studio', address: 'alpha', at: NOW },
      { seq: 5, kind: 'not-me', at: NOW },
      // The arrival a row announces with its kind in the sentence. Saying it
      // twice in two vaguer words is how both get ignored.
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

describe('ALLOW hands one phone one token (R2)', () => {
  it('mints a token for the asking device and seals the pairing URL to its key', async () => {
    const h = harness()
    h.setQueue([reach()])
    await h.requests.refresh()
    expect(await h.requests.decide('reach-1', 'allow')).toEqual({ ok: true })

    // The token is minted for the key's own thumbprint, which is how the token
    // and the seal are guaranteed to name the same phone.
    expect(h.minted).toEqual([{ deviceId: deviceIdFor(ASK_PUB), name: 'iPhone' }])

    const post = h.posts.find((p) => p.path === '/v2/me/requests/reach-1')
    expect(post?.body.decision).toBe('approve')
    const sealed = post?.body.sealed as SealedToDevice
    // Only the phone that asked can read it — the registry relays bytes it
    // cannot open, and neither can anybody watching this post.
    const opened = openAtDevice(ASK_PRIV, reachSealInfo('reach-1'), sealed)
    expect(opened).toContain('#pair=')
    expect(opened).not.toContain('root')
    expect(JSON.stringify(post?.body)).not.toContain('#pair=')
    // A SECOND device of the same account opens nothing.
    const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as Record<string, string>
    expect(openAtDevice(other, reachSealInfo('reach-1'), sealed)).toBeNull()
  })

  it('never hands out the root credential: the URL carries the minted token', async () => {
    const h = harness()
    h.setQueue([reach()])
    await h.requests.refresh()
    await h.requests.decide('reach-1', 'allow')
    const sealed = h.posts.find((p) => p.path === '/v2/me/requests/reach-1')?.body.sealed as SealedToDevice
    expect(openAtDevice(ASK_PRIV, reachSealInfo('reach-1'), sealed)).toBe(
      `https://cookrew.dev/relay/@drej/desktop/mac-1/#pair=tok-${deviceIdFor(ASK_PUB).slice(0, 4)}`,
    )
  })

  it('NOT NOW declines and mints nothing', async () => {
    const h = harness()
    h.setQueue([reach()])
    await h.requests.refresh()
    await h.requests.decide('reach-1', 'not-now')
    expect(h.posts[0].body).toEqual({ decision: 'decline' })
    expect(h.minted).toEqual([])
  })

  it('refuses ALLOW on a row that carried no key, rather than sending the root', async () => {
    const h = harness()
    h.setQueue([reach({ askKey: undefined })])
    await h.requests.refresh()
    expect(await h.requests.decide('reach-1', 'allow')).toEqual({ ok: false, reason: 'no_key' })
    expect(h.posts).toEqual([])
  })

  it('refuses ALLOW on a Mac with no mobile server wired', async () => {
    const h = harness({ reach: false })
    h.setQueue([reach()])
    await h.requests.refresh()
    expect(await h.requests.decide('reach-1', 'allow')).toEqual({ ok: false, reason: 'not_wired' })
  })
})

describe('answering a seat (R1)', () => {
  it('SEAT THEM approves on the queue route, and DECLINE declines', async () => {
    const h = harness()
    h.setQueue([seat()])
    await h.requests.refresh()
    await h.requests.decide('seat-1', 'seat-them')
    expect(h.posts[0]).toEqual({ path: '/v2/me/requests/seat-1', body: { decision: 'approve' } })
    await h.requests.decide('seat-1', 'decline')
    expect(h.posts[1].body).toEqual({ decision: 'decline' })
  })
})

describe('what this Mac remembers', () => {
  it('keeps a receipt for each of the four outcomes it can claim', async () => {
    const h = harness()
    h.setQueue([join(), reach(), seat()])
    await h.requests.refresh()
    await h.requests.decide('req-1', 'approve', '42')
    await h.requests.decide('reach-1', 'allow')
    await h.requests.decide('seat-1', 'seat-them')
    expect(h.answered.map((r) => [r.kind, r.outcome, r.subject])).toEqual([
      ['seat', 'seated', 'jkim'],
      ['reach', 'allowed', 'iPhone'],
      ['join', 'joined', 'Mac Studio'],
    ])
    expect(h.answered.find((r) => r.kind === 'seat')?.team).toBe('@drej/alpha')
  })

  it('records a denial as the disowned row, and records nothing for a decline', async () => {
    const h = harness()
    h.setQueue([join(), seat()])
    await h.requests.refresh()
    await h.requests.decide('req-1', 'deny')
    expect(h.answered.map((r) => r.outcome)).toEqual(['denied'])
    await h.requests.decide('seat-1', 'decline')
    // A seat this owner declined is simply gone; the four over-states the
    // design names are the four this Mac may claim.
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
      store.write([row, { ...row, id: 'b', outcome: 'gossip' } as unknown as AnsweredRow])
      // What comes back is only what this app knows how to draw.
      expect(store.read()).toEqual([row])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
