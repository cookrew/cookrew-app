// A DEVICE ASKS, THIS MAC ANSWERS (D6) — the poll, the one notification, and
// the decision.
//
// Three things are worth a test here and they are all about restraint. The
// poll must be a poll and not a stampede; the notification must fire ONCE per
// request, because an OS toast repeating every twenty seconds is how a person
// learns to dismiss the approval prompt without reading it; and a registry
// that hiccups must not clear a request the owner was about to answer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Approvals, APPROVAL_POLL_MS } from '../src/main/approvals'
import type { AccountResult } from '../src/shared/account-v2'
import type { ApprovalRequest } from '../src/shared/account-approvals'

const NOW = 1_757_000_000_000

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'req-1',
  deviceName: 'Chrome on macOS in Sydney',
  kind: 'browser',
  address: '203.0.113.9',
  at: NOW - 12_000,
  expiresAt: NOW + 120_000,
  ...over,
})

interface Harness {
  approvals: Approvals
  calls: { path: string; init?: RequestInit & { parse?: boolean } }[]
  notes: { title: string; body: string; request: ApprovalRequest }[]
  changes: number
  answer: (path: string) => AccountResult<unknown>
  setAnswer: (fn: (path: string) => AccountResult<unknown>) => void
}

function harness(over: { account?: boolean; sessionLive?: boolean } = {}): Harness {
  const calls: Harness['calls'] = []
  const notes: Harness['notes'] = []
  let answer: (path: string) => AccountResult<unknown> = () => ({ ok: true, value: [] })
  const state = { changes: 0 }
  const approvals = new Approvals({
    accounts: {
      call: <T>(path: string, init?: RequestInit & { parse?: boolean }) => {
        calls.push({ path, ...(init ? { init } : {}) })
        return Promise.resolve(answer(path) as AccountResult<T>)
      },
      account: () => (over.account === false ? null : { username: 'drej' }),
      sessionLive: () => over.sessionLive !== false,
    },
    notify: (note) => void notes.push(note),
    onChange: () => void (state.changes += 1),
    now: () => NOW,
  })
  return {
    approvals,
    calls,
    notes,
    get changes() {
      return state.changes
    },
    answer: (path) => answer(path),
    setAnswer: (fn) => {
      answer = fn
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the poll', () => {
  it('asks once at once, then every twenty seconds', async () => {
    const h = harness()
    h.approvals.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].path).toBe('/v2/me/approvals')

    await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS - 1)
    expect(h.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 3)
    expect(h.calls).toHaveLength(5)
    h.approvals.stop()
    await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 3)
    expect(h.calls).toHaveLength(5)
  })

  it('starting twice does not double the cadence', async () => {
    const h = harness()
    h.approvals.start()
    h.approvals.start()
    await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS)
    expect(h.calls).toHaveLength(2)
    h.approvals.stop()
  })

  it('opens no socket at all without an account, and the count is zero', async () => {
    const h = harness({ account: false })
    h.approvals.start()
    await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 2)
    expect(h.calls).toHaveLength(0)
    expect(h.approvals.count).toBe(0)
    h.approvals.stop()
  })

  it('opens no socket while the session is dead — the owner cannot answer', async () => {
    const h = harness({ sessionLive: false })
    h.approvals.start()
    await vi.advanceTimersByTimeAsync(APPROVAL_POLL_MS * 2)
    expect(h.calls).toHaveLength(0)
    h.approvals.stop()
  })

  it('a refusal leaves the waiting request exactly where it was', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: [request()] }))
    await h.approvals.refresh()
    expect(h.approvals.count).toBe(1)
    h.setAnswer(() => ({ ok: false, reason: 'offline' }))
    await h.approvals.refresh()
    expect(h.approvals.count).toBe(1)
    expect(h.approvals.list()[0].id).toBe('req-1')
  })
})

describe('the notification, once per request (D6)', () => {
  it('says the D6 sentence, with the elapsed time and the address', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: [request()] }))
    await h.approvals.refresh()
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0].title).toBe('Cookrew')
    expect(h.notes[0].body).toBe(
      'Chrome on macOS in Sydney wants to sign in as @drej. Started 12 seconds ago · ' +
        '203.0.113.9 · no second factor on the account yet.',
    )
    expect(h.notes[0].request.id).toBe('req-1')
  })

  it('does NOT fire again for a request that is still waiting', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: [request()] }))
    await h.approvals.refresh()
    await h.approvals.refresh()
    await h.approvals.refresh()
    expect(h.notes).toHaveLength(1)
  })

  it('fires for the second device, and only for that one', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: [request()] }))
    await h.approvals.refresh()
    h.setAnswer(() => ({
      ok: true,
      value: [request(), request({ id: 'req-2', deviceName: 'iPhone in Tokyo' })],
    }))
    await h.approvals.refresh()
    expect(h.notes).toHaveLength(2)
    expect(h.notes[1].body).toContain('iPhone in Tokyo')
  })

  it('drops the factor clause once the account has a second factor', async () => {
    const notes: { body: string }[] = []
    const approvals = new Approvals({
      accounts: {
        call: <T>() => Promise.resolve({ ok: true, value: [request()] } as AccountResult<T>),
        account: () => ({ username: 'drej' }),
        sessionLive: () => true,
      },
      notify: (note) => void notes.push(note),
      hasSecondFactor: () => true,
      now: () => NOW,
    })
    await approvals.refresh()
    expect(notes[0].body).toBe(
      'Chrome on macOS in Sydney wants to sign in as @drej. Started 12 seconds ago · 203.0.113.9.',
    )
  })

  it('tells main the list changed, so the badge follows', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: [request()] }))
    await h.approvals.refresh()
    expect(h.changes).toBe(1)
    await h.approvals.refresh()
    // Nothing changed: no second push, so the renderer is not re-rendered
    // every twenty seconds for a queue that is standing still.
    expect(h.changes).toBe(1)
    h.setAnswer(() => ({ ok: true, value: [] }))
    await h.approvals.refresh()
    expect(h.changes).toBe(2)
    expect(h.approvals.count).toBe(0)
  })
})

describe('the decision', () => {
  it('posts the decision and then re-reads the queue', async () => {
    const h = harness()
    h.setAnswer((path) =>
      path === '/v2/me/approvals' ? { ok: true, value: [request()] } : { ok: true, value: undefined },
    )
    await h.approvals.refresh()
    h.calls.length = 0

    const result = await h.approvals.decide('req-1', 'approve')
    expect(result).toEqual({ ok: true, value: undefined })
    expect(h.calls[0].path).toBe('/v2/me/approvals/req-1')
    expect(h.calls[0].init?.method).toBe('POST')
    expect(h.calls[0].init?.body).toBe('{"decision":"approve"}')
    expect(h.calls[0].init?.parse).toBe(false)
    // The queue is RE-READ, not edited locally: "not me" cancels every other
    // waiting request too, so the registry's list is the only true one.
    expect(h.calls[1].path).toBe('/v2/me/approvals')
  })

  it('carries "not me" through as its own decision', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: [] }))
    await h.approvals.decide('req-9', 'not-me')
    expect(h.calls[0].init?.body).toBe('{"decision":"not-me"}')
  })

  it('escapes an id rather than pasting it into the path', async () => {
    const h = harness()
    h.setAnswer(() => ({ ok: true, value: [] }))
    await h.approvals.decide('../../me/password', 'deny')
    expect(h.calls[0].path).toBe('/v2/me/approvals/..%2F..%2Fme%2Fpassword')
  })

  it('answers the refusal and does NOT clear the queue', async () => {
    const h = harness()
    h.setAnswer((path) =>
      path === '/v2/me/approvals'
        ? { ok: true, value: [request()] }
        : { ok: false, reason: 'session-expired' },
    )
    await h.approvals.refresh()
    const result = await h.approvals.decide('req-1', 'approve')
    expect(result).toMatchObject({ ok: false, reason: 'session-expired' })
    expect(h.approvals.count).toBe(1)
  })

  it('refuses an empty id without a socket', async () => {
    const h = harness()
    await expect(h.approvals.decide('', 'approve')).resolves.toMatchObject({ ok: false })
    expect(h.calls).toHaveLength(0)
  })
})
