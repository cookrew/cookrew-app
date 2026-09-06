import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * summarizeTurn against a stubbed fetch: what the request layer hands the
 * breaker. A server that answers 200 with something that is not JSON is
 * Ollama misbehaving and counts as a failure; a bug of ours rethrows.
 */
const input = { prompt: 'fix the login bug', tools: [], lines: ['looking at auth.ts'] }

describe('summarizeTurn and the breaker', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a 200 with an HTML body is a counted Sous failure, and three of them open the breaker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 200 }))
    )
    const { summarizeTurn, sousBreakerState } = await import('../src/main/sous')
    for (let i = 0; i < 3; i += 1) expect(await summarizeTurn(input)).toBeNull()
    const state = sousBreakerState()
    expect(state.state).toBe('open')
    expect(state.consecutiveFailures).toBe(3)
    expect(state.lastFailure).toBe('Ollama answered 200 with an unreadable body')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(await summarizeTurn(input)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(3) // refused, no request
  })

  it('a non-2xx and a refused connection count the same way, and a good answer closes it', async () => {
    let mode: 'refused' | '404' | 'ok' = 'refused'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (mode === 'refused') {
          const error = new TypeError('fetch failed')
          ;(error as { cause?: unknown }).cause = { code: 'ECONNREFUSED' }
          throw error
        }
        if (mode === '404') return new Response('{"error":"model not found"}', { status: 404 })
        return new Response(JSON.stringify({ response: 'Fixing login token expiry' }), { status: 200 })
      })
    )
    const { summarizeTurn, sousBreakerState, sousReadiness } = await import('../src/main/sous')
    await summarizeTurn(input)
    mode = '404'
    await summarizeTurn(input)
    expect(sousBreakerState().lastFailure).toMatch(/^Ollama returned 404 for model /)
    mode = 'refused'
    await summarizeTurn(input)
    expect(sousBreakerState().state).toBe('open')
    expect(sousBreakerState().lastFailure).toBe('TypeError: fetch failed (ECONNREFUSED)')
    expect(sousReadiness()).toBe('open')
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 30_000)
    mode = 'ok'
    expect(sousReadiness()).toBe('ready')
    expect(await summarizeTurn(input)).toBe('Fixing login token expiry')
    expect(sousBreakerState().state).toBe('closed')
    vi.useRealTimers()
  })
})
