// THE PROBE ASKS TWICE WHEN THE FIRST ASK WAS REFUSED BY THE HINT ITSELF.
//
// THE FACT, measured in Chrome 152 on the owner's Mac on 2026-09-08, on the
// real relay page: the LAN probe to
// `https://192-168-2-40.<id>.d.cookrew.dev:8643/api/hello` annotated
// `targetAddressSpace: 'local'` failed in 32 ms with `TypeError: Failed to
// fetch`, the permission state stayed 'prompt', and NO prompt was ever shown.
// That Chrome runs behind a system proxy (Clash). With a proxy in front of it
// Chrome never learns the resolved address, classifies the target as public,
// and Local Network Access fails a request whose declared space ('local') does
// not match — before any prompt. The same request WITHOUT the annotation is an
// ordinary public → public fetch, which is allowed, and the proxy's DIRECT
// rule for d.cookrew.dev delivers it to the Mac.
//
// So the hinted request keeps its place as the FIRST attempt — on a proxy-less
// network it is the only thing that raises the prompt — and the unhinted one
// is a second request made only when the first was refused before it connected.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { askHello } from '../src/renderer/src/path/switch'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`
const CGNAT = `https://100-68-81-64.${DEVICE}.d.cookrew.dev:8643`

/** A clock the test drives, so a kind is decided by a number and not by luck. */
const clockAt = (...readings: readonly number[]): (() => number) => {
  const queue = [...readings]
  return () => (queue.length > 1 ? (queue.shift() as number) : queue[0])
}

/** Every init the probe handed to fetch, in order. */
const spyFetch = (answer: (init: Record<string, unknown>) => unknown): Record<string, unknown>[] => {
  const seen: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (_url: string, init: Record<string, unknown>) => {
    seen.push(init)
    const said = answer(init)
    if (said instanceof Error) throw said
    return said as Response
  })
  return seen
}

const hello = (): Response =>
  new Response(JSON.stringify({ deviceId: DEVICE, nonce: 'n' }), { status: 200 })

const refusedFast = (): Error => new TypeError('Failed to fetch')

afterEach(() => vi.unstubAllGlobals())

describe('the fallback, when a proxy makes the hint fail the request', () => {
  it('asks again WITHOUT the annotation and says which variant answered', async () => {
    const seen = spyFetch((init) => (init.targetAddressSpace ? refusedFast() : hello()))
    const result = await askHello(LAN, 'n', { now: clockAt(0, 32) })
    expect(seen).toHaveLength(2)
    expect(seen[0].targetAddressSpace).toBe('local')
    expect(seen[1]).not.toHaveProperty('targetAddressSpace')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.hint).toBe('none')
  })

  it('keeps the hinted request FIRST, because it is what raises the prompt', async () => {
    const seen = spyFetch(() => hello())
    const result = await askHello(LAN, 'n')
    expect(seen).toHaveLength(1)
    expect(seen[0].targetAddressSpace).toBe('local')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.hint).toBe('local')
  })

  it('reuses the nonce — the first request never reached the Mac', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: Record<string, unknown>) => {
      urls.push(url)
      if (init.targetAddressSpace) throw refusedFast()
      return hello()
    })
    await askHello(LAN, 'a-nonce', { now: clockAt(0, 4) })
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('nonce=a-nonce')
    expect(urls[1]).toContain('nonce=a-nonce')
  })

  it('gives the second request its own deadline, not the tail of the first', async () => {
    const signals: (AbortSignal | undefined)[] = []
    vi.stubGlobal('fetch', async (_url: string, init: Record<string, unknown>) => {
      signals.push(init.signal as AbortSignal | undefined)
      if (init.targetAddressSpace) throw refusedFast()
      return hello()
    })
    await askHello(LAN, 'n', { now: clockAt(0, 3) })
    expect(signals).toHaveLength(2)
    expect(signals[0]).not.toBe(signals[1])
    expect(signals[1]?.aborted).toBe(false)
  })
})

describe('when both variants are refused', () => {
  it('stays blocked, and records that BOTH were tried', async () => {
    spyFetch(() => refusedFast())
    const result = await askHello(LAN, 'n', { now: clockAt(0, 32, 100, 132) })
    expect(result).toMatchObject({
      ok: false,
      kind: 'blocked',
      attempts: [
        { hint: 'local', kind: 'blocked', ms: 32 },
        { hint: 'none', kind: 'blocked', ms: 32 }
      ]
    })
  })

  it('reports the SECOND verdict when the unhinted request gets further', async () => {
    // A request that reaches DNS or TLS without the annotation was refused BY
    // the annotation, and 'network' is the honest word for where it then died.
    let call = 0
    vi.stubGlobal('fetch', async () => {
      call += 1
      throw new TypeError('Failed to fetch')
    })
    const result = await askHello(LAN, 'n', { now: clockAt(0, 3, 0, 240) })
    expect(call).toBe(2)
    expect(result).toMatchObject({ ok: false, kind: 'network' })
    if (!result.ok) expect(result.attempts?.map((one) => one.kind)).toEqual(['blocked', 'network'])
  })
})

describe('when the probe must NOT ask twice', () => {
  it('never retries a timeout — something held the socket for the whole deadline', async () => {
    let calls = 0
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      calls += 1
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))
      })
    })
    const result = await askHello(LAN, 'n', { timeoutMs: 5 })
    expect(calls).toBe(1)
    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
  })

  it('never retries a network failure — the request already left', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      throw new TypeError('Failed to fetch')
    })
    const result = await askHello(LAN, 'n', { now: clockAt(0, 240) })
    expect(calls).toBe(1)
    expect(result).toMatchObject({ ok: false, kind: 'network', attempts: [{ hint: 'local' }] })
  })

  it('never retries an HTTP status — something answered', async () => {
    const seen = spyFetch(() => new Response('nope', { status: 421 }))
    const result = await askHello(LAN, 'n', { now: clockAt(0, 12) })
    expect(seen).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, kind: 'http', status: 421 })
  })

  it('never retries an address that never carried the hint at all', async () => {
    // 100.64/10 is CGNAT and public by every browser's reckoning, so the probe
    // has already sent the unhinted variant. A second identical request would
    // be pure battery.
    const seen = spyFetch(() => refusedFast())
    const result = await askHello(CGNAT, 'n', { now: clockAt(0, 3) })
    expect(seen).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, kind: 'blocked', attempts: [{ hint: 'none' }] })
  })
})
