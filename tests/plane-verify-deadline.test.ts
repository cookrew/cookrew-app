// A RACE THAT CANNOT END IS WORSE THAN A RACE THAT LOSES.
//
// The plane switch asks cookrew.dev to check the Mac's signature, and that
// request had no deadline while the hello beside it always had one. A registry
// that accepts the connection and never answers — measured for real when the
// relay's own streams filled the browser's six connections to that origin —
// left `switchPlaneIfBetter` awaiting forever: `probing(false)` never ran, the
// badge stuck on PROBING, the plane never moved, and the minute timer started
// another request that hung the same way and held another socket.

import { afterEach, describe, expect, it, vi } from 'vitest'

const stubPhone = (): void => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin: 'https://cookrew.dev', search: '', hash: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('verifying a hello', () => {
  it('ends when the registry never answers, rather than never ending: it could not ask, which is not a no', async () => {
    stubPhone()
    vi.stubGlobal(
      'fetch',
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const { verifyHello } = await import('../src/renderer/src/path/companion')
    // The deadline is the point: the await ends. What it ends with is "could not ask", which a
    // switch reads as "do not adopt" and a re-check as "leave the proved path alone".
    await expect(verifyHello({ deviceId: 'a', nonce: 'b', sig: 'c', origin: 'https://mac.test', issuedAtMs: 1 }, 20)).rejects.toMatchObject({ name: 'VerifyUnasked' })
  })

  it('still answers yes on a clean ok', async () => {
    stubPhone()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const { verifyHello } = await import('../src/renderer/src/path/companion')
    expect(await verifyHello({ deviceId: 'a', nonce: 'b', sig: 'c', origin: 'https://mac.test', issuedAtMs: 1 }, 1000)).toBe(true)
  })
})
