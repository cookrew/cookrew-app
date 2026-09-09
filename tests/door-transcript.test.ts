import { describe, expect, it } from 'vitest'
import { DoorTranscript, type DoorTarget } from '../src/main/door-transcript'
import type { TurnRecord } from '../src/shared/turn'

/**
 * The record behind a remote card, read from the door. What matters is not
 * that it fetches — it is what it SAYS when the door answers something other
 * than the record, because an empty rail with no sentence next to it is the
 * lie this client exists to end.
 */

const TARGET: DoorTarget = { origin: 'http://127.0.0.1:4242', slug: '@drej/cookrew-alpha' }

const turn = (index: number, over: Partial<TurnRecord> = {}): TurnRecord => ({
  index,
  prompt: `prompt ${index}`,
  reply: `reply ${index}`,
  startedAt: 1000 + index,
  endedAt: 2000 + index,
  ...over
})

interface Script {
  /** path (with query) → a queue of answers, consumed in order; the last repeats. */
  answers: Record<string, Array<{ status: number; body?: unknown }>>
  calls: string[]
  auth: string[]
}

function door(script: Omit<Script, 'calls' | 'auth'>['answers']): {
  fetcher: typeof fetch
  calls: string[]
  auth: string[]
} {
  const calls: string[] = []
  const auth: string[] = []
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const key = `${url.pathname}${url.search}`.replace(`/${TARGET.slug}`, '')
    calls.push(key)
    auth.push(String((init?.headers as Record<string, string>)?.authorization ?? ''))
    const queue = script[key] ?? [{ status: 404, body: {} }]
    const answer = queue.length > 1 ? (queue.shift() as { status: number; body?: unknown }) : queue[0]
    return new Response(JSON.stringify(answer.body ?? null), { status: answer.status })
  }) as typeof fetch
  return { fetcher, calls, auth }
}

const signIn = async (): Promise<string> => 'tok-1'

describe('reading the record', () => {
  it('turns, index, markers and a trace page come back as the door sent them', async () => {
    const history = [turn(1), turn(2), turn(3)]
    const at = door({
      '/turns': [{ status: 200, body: history }],
      '/turns?limit=1': [{ status: 200, body: { turns: [turn(3)], total: 3, offset: 2 } }],
      '/trace/index': [{ status: 200, body: history.map((t) => ({ index: t.index, title: t.prompt })) }],
      '/trace/markers': [{ status: 200, body: [{ kind: 'compact', afterIndex: 2 }] }],
      '/trace?aroundIndex=2&limit=5': [
        { status: 200, body: { blocks: [{ id: 'u2', index: 2, prompt: 'p', reply: 'r', activity: [], startedAt: 1, endedAt: 2 }], total: 3, source: 'claude' } }
      ]
    })
    const client = new DoorTranscript(TARGET, { signIn, fetcher: at.fetcher })
    expect(await client.turns()).toEqual(history)
    expect((await client.traceIndex()).map((e) => e.index)).toEqual([1, 2, 3])
    expect(await client.traceMarkers()).toEqual([{ kind: 'compact', afterIndex: 2 }])
    expect(await client.tracePage({ aroundIndex: 2, limit: 5 })).toMatchObject({
      blocks: [{ index: 2 }],
      total: 3,
      source: 'claude'
    })
    expect(await client.latest()).toEqual({ prompt: 'prompt 3', reply: 'reply 3' })
    expect(client.state().kind).toBe('ok')
    // Every read carried the caller's Bearer — never an unauthenticated one.
    expect(at.auth.every((h) => h === 'Bearer tok-1')).toBe(true)
  })

  it('a window is paged AT THE DOOR, by identity; the whole history only when nothing narrower was asked', async () => {
    const history = [turn(1), turn(2), turn(3), turn(4)]
    const at = door({
      '/turns': [{ status: 200, body: history }],
      '/turns?limit=1&beforeIndex=3': [{ status: 200, body: { turns: [turn(2)], total: 4, offset: 1 } }]
    })
    const client = new DoorTranscript(TARGET, { signIn, fetcher: at.fetcher })
    const page = await client.turnsPage({ beforeIndex: 3, limit: 1 })
    expect(page).toMatchObject({ turns: [{ index: 2 }], total: 4, offset: 1 })
    expect(at.calls).toEqual(['/turns?limit=1&beforeIndex=3'])
    expect((await client.turnsPage()).turns).toHaveLength(4)
    expect(at.calls).toEqual(['/turns?limit=1&beforeIndex=3', '/turns'])
  })

  it('the poll and the idle preview read ONE record, never the history', async () => {
    let clock = 0
    const at = door({
      '/turns': [{ status: 200, body: [turn(1), turn(2)] }],
      '/turns?limit=1': [{ status: 200, body: { turns: [turn(2)], total: 2, offset: 1 } }]
    })
    const client = new DoorTranscript(TARGET, { signIn, fetcher: at.fetcher, now: () => clock, memoMs: 1000 })
    expect(await client.latest()).toEqual({ prompt: 'prompt 2', reply: 'reply 2' })
    expect(await client.fingerprint()).toBe('ok:2:2:')
    // Two reads in the memo window, one request — and it was the tail.
    expect(at.calls).toEqual(['/turns?limit=1'])
    clock = 1500
    await client.fingerprint()
    expect(at.calls).toEqual(['/turns?limit=1', '/turns?limit=1'])
    expect(at.calls).not.toContain('/turns')
  })

  it('a body past the ceiling is refused without being held', async () => {
    const huge = `[${Array.from({ length: 200000 }, (_, i) => JSON.stringify(turn(i))).join(',')}]`
    let read = 0
    const fetcher = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = huge.slice(read, read + 65536)
          read += chunk.length
          if (chunk.length === 0) controller.close()
          else controller.enqueue(new TextEncoder().encode(chunk))
        }
      })
      return new Response(stream, { status: 200 })
    }) as typeof fetch
    const client = new DoorTranscript(TARGET, { signIn, fetcher })
    expect(await client.turns()).toEqual([])
    expect(client.state().kind).toBe('unreachable')
    // The reader stopped near the cap; the whole ~20 MB was never pulled.
    expect(read).toBeLessThan(10 * 1024 * 1024)
    // And a declared size past the cap is refused before a byte is read.
    const declared = (async () => new Response('[]', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } })) as typeof fetch
    const refused = new DoorTranscript(TARGET, { signIn, fetcher: declared })
    expect(await refused.turns()).toEqual([])
  })
})

describe('what it says when it cannot read (P10)', () => {
  it('404 before any answer = no session yet; 404 after = the session ended, rows kept', async () => {
    const at = door({
      '/turns': [
        { status: 404, body: {} },
        { status: 200, body: [turn(1), turn(2)] },
        { status: 404, body: {} }
      ]
    })
    let clock = 0
    const client = new DoorTranscript(TARGET, { signIn, fetcher: at.fetcher, now: () => clock, memoMs: 0 })
    expect(await client.turns()).toEqual([])
    expect(client.state()).toEqual({ kind: 'no-session' })
    clock += 10
    expect(await client.turns()).toHaveLength(2)
    expect(client.state().kind).toBe('ok')
    clock += 10
    // The door forgot us. The rows it once gave do not vanish — they are
    // history — but the state says the session is over, and the card says so.
    expect(await client.turns()).toHaveLength(2)
    expect(client.state()).toEqual({ kind: 'ended' })
  })

  it('a 401 gets ONE fresh sign-in; a second refusal is "signed out", not a blank', async () => {
    let minted = 0
    const rotating = async (): Promise<string> => `tok-${++minted}`
    const at = door({
      '/turns': [{ status: 200, body: [turn(1)] }, { status: 401 }, { status: 200, body: [turn(1), turn(2)] }]
    })
    let clock = 0
    const client = new DoorTranscript(TARGET, { signIn: rotating, fetcher: at.fetcher, now: () => clock, memoMs: 0 })
    expect(await client.turns()).toHaveLength(1)
    clock += 10
    expect(await client.turns()).toHaveLength(2)
    expect(client.state().kind).toBe('ok')
    expect(at.auth).toEqual(['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2'])

    const stubborn = door({ '/turns': [{ status: 401 }] })
    const refused = new DoorTranscript(TARGET, { signIn: rotating, fetcher: stubborn.fetcher, memoMs: 0 })
    expect(await refused.turns()).toEqual([])
    expect(refused.state()).toEqual({ kind: 'signed-out' })
    expect(stubborn.calls).toHaveLength(2)
  })

  it('402 is the session ending; 503 is the conductor missing; a dead door is unreachable', async () => {
    for (const [status, kind] of [
      [402, 'ended'],
      [503, 'unavailable'],
      [500, 'unreachable']
    ] as const) {
      const at = door({ '/turns': [{ status }] })
      const client = new DoorTranscript(TARGET, { signIn, fetcher: at.fetcher })
      expect(await client.turns()).toEqual([])
      expect(client.state().kind).toBe(kind)
    }
  })

  it('the relay saying the name is unserved is "not serving", not "ended" — on 404 and on 502', async () => {
    for (const status of [404, 502]) {
      const at = door({
        '/turns': [{ status: 200, body: [turn(1)] }, { status, body: { error: 'not-serving' } }]
      })
      let clock = 0
      const client = new DoorTranscript(TARGET, { signIn, fetcher: at.fetcher, now: () => clock, memoMs: 0 })
      expect(await client.turns()).toHaveLength(1)
      clock += 10
      expect(await client.turns()).toHaveLength(1)
      expect(client.state(), String(status)).toEqual({ kind: 'not-serving' })
    }
    // A 502 that is merely the relay failing is "unreachable", rows kept.
    const at = door({ '/turns': [{ status: 200, body: [turn(1)] }, { status: 502, body: { error: 'relay' } }] })
    let clock = 0
    const client = new DoorTranscript(TARGET, { signIn, fetcher: at.fetcher, now: () => clock, memoMs: 0 })
    await client.turns()
    clock += 10
    expect(await client.turns()).toHaveLength(1)
    expect(client.state()).toEqual({ kind: 'unreachable', status: 502 })
  })

  it('a door that cannot be signed in to at all is "not serving"', async () => {
    const at = door({})
    const client = new DoorTranscript(TARGET, {
      signIn: async () => {
        throw new Error('this door did not say who it is')
      },
      fetcher: at.fetcher
    })
    expect(await client.traceIndex()).toEqual([])
    expect(client.state()).toEqual({ kind: 'not-serving' })
    expect(at.calls).toEqual([])
  })

  it('a 200 in the wrong shape is not an empty history — and does not count as "up"', async () => {
    const at = door({ '/turns': [{ status: 200, body: { nope: true } }, { status: 404, body: {} }] })
    let clock = 0
    const client = new DoorTranscript(TARGET, { signIn, fetcher: at.fetcher, now: () => clock, memoMs: 0 })
    expect(await client.turns()).toEqual([])
    expect(client.state()).toEqual({ kind: 'unreachable', status: 200 })
    clock += 10
    await client.turns()
    // Never in shape, so a 404 now is "no session yet", not "ended".
    expect(client.state()).toEqual({ kind: 'no-session' })
    // A trace page whose blocks are not blocks is refused the same way.
    const bad = door({ '/trace': [{ status: 200, body: { blocks: [{ index: 'x' }], total: 1, source: 'claude' } }] })
    const page = new DoorTranscript(TARGET, { signIn, fetcher: bad.fetcher })
    expect(await page.tracePage()).toEqual({ blocks: [], total: 0, source: null })
  })

  it('the fingerprint changes exactly when the card should redraw', async () => {
    const at = door({
      '/turns?limit=1': [
        { status: 200, body: { turns: [turn(1)], total: 1, offset: 0 } },
        { status: 200, body: { turns: [turn(1)], total: 1, offset: 0 } },
        { status: 200, body: { turns: [turn(2)], total: 2, offset: 1 } },
        { status: 404 }
      ]
    })
    let clock = 0
    const client = new DoorTranscript(TARGET, { signIn, fetcher: at.fetcher, now: () => clock, memoMs: 0 })
    const a = await client.fingerprint()
    clock += 10
    const b = await client.fingerprint()
    clock += 10
    const c = await client.fingerprint()
    clock += 10
    const d = await client.fingerprint()
    expect(a).toBe(b)
    expect(c).not.toBe(b)
    expect(d).not.toBe(c)
    expect(d.startsWith('ended:')).toBe(true)
  })
})
