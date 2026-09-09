// A FAILED PROBE HAS TO SAY WHY.
//
// The incident this pins: the owner's phone showed the "why this path" panel
// with four LAN candidates and the same three words under every one of them —
// "no answer" — above a 13,328 ms relay round trip. `askHello` answered null
// for an 800 ms timeout, for a TypeError thrown in 1 ms by a browser policy,
// for a refused certificate and for a 421, so nothing downstream could tell a
// slow network from a blocked request. Four rows, one word, no diagnosis.
//
// Four kinds, because they send a reader to four different places: 'blocked'
// to their site settings, 'network' to their Wi-Fi or their Mac, 'timeout' to
// patience, 'http' to whatever answered on that port.

import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  BLOCKED_UNDER_MS,
  classifyHelloFailure,
  helloDetail
} from '../src/renderer/src/path/hello-result'
import { askHello, HELLO_TIMEOUT_MS } from '../src/renderer/src/path/switch'

const URL_UNDER_TEST = 'https://192-168-1-24.aaaa.d.cookrew.dev:8643'

/** A clock the test drives, so a kind is decided by a number and not by luck. */
const clockAt = (...readings: readonly number[]): (() => number) => {
  const queue = [...readings]
  return () => (queue.length > 1 ? (queue.shift() as number) : queue[0])
}

afterEach(() => vi.unstubAllGlobals())

describe('askHello, on an answer', () => {
  it('hands back the parsed reply and nothing else', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ deviceId: 'a', nonce: 'n' })))
    const result = await askHello(URL_UNDER_TEST, 'n')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.reply).toEqual({ deviceId: 'a', nonce: 'n' })
  })
})

describe('askHello, on the four failures', () => {
  it('calls a TypeError thrown in a millisecond BLOCKED — the browser refused it', async () => {
    // Chrome's Local Network Access gate refusing without a prompt, a CSP, or
    // mixed content: all three refuse synchronously, before a socket exists.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    const result = await askHello(URL_UNDER_TEST, 'n', { now: clockAt(0, 1) })
    // The variants tried travel alongside the verdict (path-hello-hint.test.ts);
    // the verdict itself is unchanged, which is what this pins.
    expect(result).toMatchObject({
      ok: false,
      kind: 'blocked',
      ms: 1,
      detail: 'TypeError: Failed to fetch'
    })
  })

  it('calls the same TypeError after 50 ms NETWORK — something was dialled', async () => {
    // A DNS lookup, a TCP handshake or a TLS negotiation cannot fail this
    // fast, so a slow TypeError is evidence the request actually left.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    const result = await askHello(URL_UNDER_TEST, 'n', { now: clockAt(0, 240) })
    expect(result).toMatchObject({ ok: false, kind: 'network', ms: 240 })
  })

  it('calls a non-ok response HTTP, with the status something actually said', async () => {
    // 421 is the endpoint-bound hello refusing a relayed challenge; a 404 is
    // somebody else's server on port 8643. Neither is "no answer".
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 421 }))
    const result = await askHello(URL_UNDER_TEST, 'n', { now: clockAt(0, 12) })
    expect(result).toMatchObject({ ok: false, kind: 'http', status: 421, ms: 12 })
  })

  it('calls our own deadline TIMEOUT, whatever the browser names the abort', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))
      })
    )
    const result = await askHello(URL_UNDER_TEST, 'n', { timeoutMs: 5 })
    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
  })

  it('says http, not blocked, when an answer arrives that is not JSON', async () => {
    // It ANSWERED. Classifying a parse failure by the clock would call a fast
    // captive portal a blocked request and send the reader to site settings.
    vi.stubGlobal('fetch', async () => new Response('<html>captive portal</html>', { status: 200 }))
    const result = await askHello(URL_UNDER_TEST, 'n', { now: clockAt(0, 3) })
    expect(result).toMatchObject({ ok: false, kind: 'http', status: 200 })
  })
})

describe('the detail a row may carry', () => {
  it('is the error name and the first 80 characters of its message', () => {
    const long = 'x'.repeat(200)
    const detail = helloDetail(new TypeError(long))
    expect(detail).toBe(`TypeError: ${'x'.repeat(80)}`)
  })

  it('never carries a URL, a hostname or an address', () => {
    // This panel gets screenshotted and pasted into chats.
    const detail = helloDetail(
      new TypeError('connection to https://192-168-1-24.abc.d.cookrew.dev:8643/api/hello refused')
    )
    expect(detail).toBeDefined()
    expect(detail).not.toContain('cookrew.dev')
    expect(detail).not.toContain('192-168-1-24')
    expect(detail).not.toContain('://')
    expect(detail).toContain('TypeError')
  })

  it('survives a thrown value that is not an Error at all', () => {
    expect(helloDetail('a string')).toBe('Error')
    expect(helloDetail(undefined)).toBe('Error')
  })
})

describe('the boundary between blocked and network', () => {
  it('is 50 ms, and it is exclusive', () => {
    const at = (ms: number): string =>
      classifyHelloFailure({ error: new TypeError('Failed to fetch'), ms, timedOut: false }).kind
    expect(at(BLOCKED_UNDER_MS - 1)).toBe('blocked')
    expect(at(BLOCKED_UNDER_MS)).toBe('network')
  })

  it('calls a thrown value that is not a TypeError a network failure', () => {
    // Only a browser policy throws a TypeError instantly. Anything else fast
    // is a bug in our own code path and must not be reported as a refusal.
    const failure = classifyHelloFailure({ error: new RangeError('odd'), ms: 1, timedOut: false })
    expect(failure.kind).toBe('network')
  })

  it('prefers our own deadline flag over the error, always', () => {
    const failure = classifyHelloFailure({ error: new TypeError('Failed to fetch'), ms: 1, timedOut: true })
    expect(failure).toEqual({ ok: false, kind: 'timeout', ms: 1 })
  })
})

describe('the deadline', () => {
  it('is still 800 ms — this change adds words, not patience', () => {
    expect(HELLO_TIMEOUT_MS).toBe(800)
  })
})
