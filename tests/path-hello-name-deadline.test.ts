// A NAME NEEDS LONGER THAN AN ADDRESS, BECAUSE A NAME IS LOOKED UP FIRST.
//
// HELLO_TIMEOUT_MS (800) was written for bare addresses: "it is on the same
// Wi-Fi or it is not". A trusted name is on the same Wi-Fi too — but before
// the first packet can leave, the phone's resolver walks cookrew.dev → the
// d.cookrew.dev servers → the record, cold, across whatever distance separates
// the phone's ISP from the registry. Measured 2026-10-11 from the owner's LAN:
// 564 ms for one fully cold chain through a Chinese public resolver, and the
// phone's own reports showed every candidate "timeout 800–804 ms", LAN and
// tailnet alike, once a minute, with the Mac three metres away. The deadline
// was the whole defect: the address was right, the zone answered, the Mac
// listened, and the clock ran out during the lookup.
//
// So a NAME gets a deadline that has room for a cold lookup, and an ADDRESS
// keeps the one it had. The race still runs in parallel with the plane in
// use, so patience here delays only the verdict "no", never the session.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  askHello,
  HELLO_TIMEOUT_MS,
  helloDeadlineMs,
  NAME_HELLO_TIMEOUT_MS
} from '../src/renderer/src/path/ask-hello'

const NAME = 'https://192-168-2-40.e03994f9-138d-80ff-9377-475cc59142b4.d.cookrew.dev:8643'
const TAILNET_NAME = 'https://100-68-81-64.e03994f9-138d-80ff-9377-475cc59142b4.d.cookrew.dev:8643'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('helloDeadlineMs', () => {
  it('a trusted name has room for a cold lookup; an address does not need it', () => {
    expect(helloDeadlineMs(NAME)).toBe(NAME_HELLO_TIMEOUT_MS)
    expect(helloDeadlineMs(TAILNET_NAME)).toBe(NAME_HELLO_TIMEOUT_MS)
    expect(helloDeadlineMs('https://192.168.2.40:8643')).toBe(HELLO_TIMEOUT_MS)
    expect(helloDeadlineMs('https://[fd7a:115c:a1e0::5401:51a4]:8643')).toBe(HELLO_TIMEOUT_MS)
    expect(helloDeadlineMs('http://localhost:8639')).toBe(HELLO_TIMEOUT_MS)
  })

  it('is measured against the owner\'s LAN, not guessed: a cold chain plus TLS plus the hello', () => {
    // 564 ms lookup (measured) + A and AAAA in parallel + a TLS handshake on
    // the LAN + the request. Twice the lookup is the floor; below it the
    // phone is back to timing out during DNS.
    expect(NAME_HELLO_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 564 + 200)
    // And still a probe, not a stall: the relay round trip itself was 747 ms.
    expect(NAME_HELLO_TIMEOUT_MS).toBeLessThanOrEqual(4000)
    expect(HELLO_TIMEOUT_MS).toBe(800)
  })

  it('an explicit timeoutMs still wins — tests and callers that set one are not re-timed', () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))
      })
    )
    const result = askHello(NAME, 'n', { timeoutMs: 5 })
    vi.advanceTimersByTime(6)
    return expect(result).resolves.toMatchObject({ ok: false, kind: 'timeout' })
  })

  it('a name that has not answered at 800 ms is still being waited for; at its own deadline it is a timeout', async () => {
    vi.useFakeTimers()
    let aborted = false
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('x', 'AbortError'))
        })
      })
    )
    const result = askHello(NAME, 'n')
    await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS + 1)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(NAME_HELLO_TIMEOUT_MS)
    expect(aborted).toBe(true)
    await expect(result).resolves.toMatchObject({ ok: false, kind: 'timeout' })
  })
})
