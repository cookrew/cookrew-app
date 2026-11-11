// A REQUEST ON A PLANE THAT WAS LEFT BEHIND IS ABANDONED (plane-fetch.ts).
// A fetch to a direct origin that stopped answering hangs for minutes on iOS;
// when the companion falls back, nothing may keep waiting on it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dataPlane, resetDataPlane, setDataPlane, fallBackToRelay } from '../src/renderer/src/data-plane'
import { planeFetch } from '../src/renderer/src/plane-fetch'
import { resetPlaneHealth } from '../src/renderer/src/plane-health'
import { setRtcLink } from '../src/renderer/src/rtc-plane'
import type { RtcLink } from '../src/renderer/src/path/rtc-link'

const TAILNET = 'https://100-68-81-64.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.d.cookrew.dev:8643'
const LAN_NAME = 'https://192-168-2-13.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.d.cookrew.dev:8643'

/** A fetch that hangs until aborted, as one on a dead tailnet does. */
const hangingFetch = (): ReturnType<typeof vi.fn> =>
  vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
  )

afterEach(() => {
  resetPlaneHealth()
  vi.unstubAllGlobals()
  resetDataPlane()
})

describe('leaving a direct plane', () => {
  it('aborts a request still waiting on it', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    const pending = planeFetch(`${TAILNET}/api/terminal/t1/raw`, { method: 'POST' })
    fallBackToRelay()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('leaves a relay request alone when the plane moves onto something better', async () => {
    let finish: (r: Response) => void = () => undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))))
    const pending = planeFetch('/api/board')
    setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    finish(new Response('{}', { status: 200 }))
    expect((await pending).status).toBe(200)
  })

  it('still honours the caller’s own abort, with the caller’s reason', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const abort = new AbortController()
    const pending = planeFetch('/api/board', { signal: abort.signal })
    abort.abort(new DOMException('no answer in time', 'TimeoutError'))
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})

// A READ CAUGHT BY A MOVE GOES AGAIN ON THE RELAY (owner 2026-11-11: on 5G the
// console drew "0 agents" and "no reading" while the plane fell back). The
// relay never went away; a GET that died with the direct path it was sent on
// is answered there instead of reaching the view as a failure.
describe('a read caught by a move', () => {
  const relayAnswer = (): ReturnType<typeof vi.fn> =>
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith(TAILNET)) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
      }
      return new Response(JSON.stringify({ via: url }), { status: 200 })
    })

  it('is asked again on the relay when its direct plane was left', async () => {
    const fetched = relayAnswer()
    vi.stubGlobal('fetch', fetched)
    setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    const pending = planeFetch(`${TAILNET}/api/board`)
    fallBackToRelay()
    const response = await pending
    expect(await response.json()).toEqual({ via: '/api/board' })
  })

  it('is asked again on the relay when the direct origin threw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith(TAILNET)) throw new TypeError('Failed to fetch')
        return new Response('{}', { status: 200 })
      })
    )
    setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    expect((await planeFetch(`${TAILNET}/api/board`)).status).toBe(200)
  })

  it('is asked again on the relay when the direct link closed under it', async () => {
    const fetched = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetched)
    let open = true
    const link = {
      isOpen: () => open,
      request: () => {
        open = false
        return Promise.reject(new Error('the direct link closed'))
      }
    }
    setRtcLink(link as unknown as RtcLink)
    setDataPlane({ origin: '', kind: 'lan', transport: 'rtc' })
    expect((await planeFetch('/api/board')).status).toBe(200)
    expect(fetched).toHaveBeenCalledWith('/api/board', expect.anything())
    setRtcLink(null)
  })

  it('a write is not asked twice: it may have been carried out', async () => {
    const fetched = relayAnswer()
    vi.stubGlobal('fetch', fetched)
    setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    const pending = planeFetch(`${TAILNET}/api/board`, { method: 'POST', body: '{}' })
    fallBackToRelay()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetched).toHaveBeenCalledTimes(1)
  })

  it('a read the caller gave up on is not asked again', async () => {
    const fetched = relayAnswer()
    vi.stubGlobal('fetch', fetched)
    setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    const abort = new AbortController()
    const pending = planeFetch(`${TAILNET}/api/board`, { signal: abort.signal })
    abort.abort(new DOMException('no answer in time', 'TimeoutError'))
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(fetched).toHaveBeenCalledTimes(1)
  })
})

// THE RETRY GOES TO THE RELAY ITSELF, not to whatever plane is current (review
// 2026-11-11): tied to the dead plane it was aborted by the very fallback it
// was meant to survive, and its success hid the dead plane from the watchdog.
describe('the relay retry', () => {
  it('survives the fallback that follows the failures', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith(TAILNET)) throw new TypeError('Failed to fetch')
        await gate
        return new Response('{}', { status: 200 })
      })
    )
    setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    const reads = [planeFetch(`${TAILNET}/api/a`), planeFetch(`${TAILNET}/api/b`), planeFetch(`${TAILNET}/api/c`)]
    await new Promise((resolve) => setTimeout(resolve, 0))
    fallBackToRelay()
    release()
    const statuses = (await Promise.allSettled(reads)).map((r) => (r.status === 'fulfilled' ? r.value.status : 'failed'))
    expect(statuses).toEqual([200, 200, 200])
  })

  it('leaves the dead plane counted as dead: the watchdog still falls back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith(TAILNET)) throw new TypeError('Failed to fetch')
        return new Response('{}', { status: 200 })
      })
    )
    setDataPlane({ origin: TAILNET, kind: 'tailnet' })
    // As a caller composes it (apiPath): on the plane current at the call.
    for (let i = 0; i < 6; i++) await planeFetch(`${dataPlane().origin}/api/board`)
    expect(dataPlane().kind).toBe('relay')
  })

  it('carries no local-network annotation: the relay is a public host', async () => {
    const fetched = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.startsWith(LAN_NAME)) throw new TypeError('Failed to fetch')
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetched)
    setDataPlane({ origin: LAN_NAME, kind: 'lan' })
    await planeFetch(`${LAN_NAME}/api/board`)
    const relayCall = fetched.mock.calls.find(([url]) => !String(url).startsWith(LAN_NAME))
    expect(relayCall?.[1]).not.toHaveProperty('targetAddressSpace')
  })

  it('does not "retry" a URL that names another direct origin', async () => {
    const fetched = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetched)
    setRtcLink({ isOpen: () => false, request: () => Promise.reject(new Error('closed')) } as unknown as RtcLink)
    setDataPlane({ origin: '', kind: 'lan', transport: 'rtc' })
    await expect(planeFetch(`${TAILNET}/api/board`)).rejects.toThrow()
    expect(fetched).toHaveBeenCalledTimes(1)
    setRtcLink(null)
  })
})
