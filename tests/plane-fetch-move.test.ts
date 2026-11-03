// A REQUEST ON A PLANE THAT WAS LEFT BEHIND IS ABANDONED (plane-fetch.ts).
// A fetch to a direct origin that stopped answering hangs for minutes on iOS;
// when the companion falls back, nothing may keep waiting on it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetDataPlane, setDataPlane, fallBackToRelay } from '../src/renderer/src/data-plane'
import { planeFetch } from '../src/renderer/src/plane-fetch'

const TAILNET = 'https://100-68-81-64.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.d.cookrew.dev:8643'

/** A fetch that hangs until aborted, as one on a dead tailnet does. */
const hangingFetch = (): ReturnType<typeof vi.fn> =>
  vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
  )

afterEach(() => {
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
