import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('../src/renderer/src/path/seal-plane')
  vi.doUnmock('../src/renderer/src/api-base')
  vi.doUnmock('../src/renderer/src/auth-gate')
  vi.doUnmock('../src/renderer/src/machine-scope')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('an offer whose sealed route disappears', () => {
  it('is dropped rather than sent over the ordinary network', async () => {
    vi.doMock('../src/renderer/src/api-base', async (original) => ({
      ...(await original<typeof import('../src/renderer/src/api-base')>()),
      apiPath: () => 'https://relay.example/api/m/device/api/rtc/offer'
    }))
    vi.doMock('../src/renderer/src/auth-gate', async (original) => ({
      ...(await original<typeof import('../src/renderer/src/auth-gate')>()),
      authHeaders: () => ({})
    }))
    vi.doMock('../src/renderer/src/machine-scope', async (original) => ({
      ...(await original<typeof import('../src/renderer/src/machine-scope')>()),
      heldScope: () => () => true
    }))
    vi.doMock('../src/renderer/src/path/seal-plane', () => ({
      sealOutcome: () => 'sealed',
      probeSettled: async () => undefined,
      sealedFetchFor: () => null
    }))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { postRtcOffer } = await import('../src/renderer/src/path/rtc-offer')
    expect(await postRtcOffer('private candidate')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
