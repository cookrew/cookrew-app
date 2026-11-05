// THE BEACON WAITS ITS TURN (phone-beacon.ts). Every 3 s, whether or not the
// last one was answered, is how a stalled Mac lost ten relay slots to vitals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const planeFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/plane-fetch', () => ({ planeFetch }))
vi.mock('../src/renderer/src/api', () => ({ isRemoteMode: () => true }))
vi.mock('../src/renderer/src/auth-gate', () => ({ authHeaders: () => ({}) }))
vi.mock('../src/renderer/src/api-base', () => ({ apiPath: (path: string) => path }))
vi.mock('../src/renderer/src/sse-tap', () => ({ tapEventSource: (real: unknown) => real }))

beforeEach(() => {
  vi.useFakeTimers()
  planeFetch.mockReset()
  vi.stubGlobal('window', {
    fetch: () => Promise.resolve(),
    setInterval: (run: () => void, ms: number) => setInterval(run, ms),
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 3
  })
  vi.stubGlobal('document', { querySelectorAll: () => [], images: [] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the phone beacon', () => {
  it('sends no second beacon while the first is unanswered', async () => {
    planeFetch.mockReturnValue(new Promise(() => undefined))
    const { startPhoneBeacon } = await import('../src/renderer/src/phone-beacon')
    startPhoneBeacon()
    await vi.advanceTimersByTimeAsync(27_000)
    expect(planeFetch).toHaveBeenCalledTimes(1)
  })

  it('keeps its 3 s pace while the Mac answers', async () => {
    planeFetch.mockResolvedValue(new Response(null, { status: 204 }))
    const { startPhoneBeacon } = await import('../src/renderer/src/phone-beacon')
    startPhoneBeacon()
    await vi.advanceTimersByTimeAsync(9000)
    expect(planeFetch).toHaveBeenCalledTimes(4)
  })

  it('survives a page it cannot read', async () => {
    vi.stubGlobal('document', {
      querySelectorAll: () => {
        throw new Error('no document')
      }
    })
    const { startPhoneBeacon } = await import('../src/renderer/src/phone-beacon')
    expect(() => startPhoneBeacon()).not.toThrow()
    await vi.advanceTimersByTimeAsync(3000)
    expect(planeFetch).not.toHaveBeenCalled()
  })
})
