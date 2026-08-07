import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The behaviour the whole feature exists for: a refused credential must reach
 * the UI. Previously `req` threw a plain Error and `post` swallowed it, so an
 * unpaired phone looked like a working one.
 *
 * remote-api touches `window`, so a minimal shim stands in for a DOM — enough
 * to exercise the real module rather than a copy of its logic.
 */
function installWindow(): void {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage: storage,
    sessionStorage: storage,
    location: { search: '?token=paired-token', href: 'https://phone.local/' },
    history: { replaceState: () => undefined }
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as unknown as Response
}

beforeEach(() => {
  vi.resetModules()
  installWindow()
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  vi.unstubAllGlobals()
})

describe('remote api — a refused credential', () => {
  it('throws an AuthError, not a generic Error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'Unauthorized — open the pairing URL.' }))
    )
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const { isAuthError } = await import('../src/renderer/src/auth-gate')

    await expect(createRemoteApi().switchWorkspace('w1')).rejects.toSatisfy(isAuthError)
  })

  it('publishes the failure so the re-pair screen can appear', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'Unauthorized' })))
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const { authStore } = await import('../src/renderer/src/auth-gate')

    await createRemoteApi().switchWorkspace('w1').catch(() => undefined)
    expect(authStore().blocked()?.scope).toBe('none')
  })

  it('recognises a READ-ONLY refusal as its own state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'Unauthorized — this token is read-only.' }))
    )
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const { authStore } = await import('../src/renderer/src/auth-gate')

    await createRemoteApi().switchWorkspace('w1').catch(() => undefined)
    expect(authStore().blocked()?.scope).toBe('read-only')
  })

  it('reports a FIRE-AND-FORGET failure too — keystrokes had no error path at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'Unauthorized' })))
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const { authStore } = await import('../src/renderer/src/auth-gate')

    // ptyInput goes through post(), whose rejection nobody awaits.
    createRemoteApi().ptyInput('t1', 'hello')
    await vi.waitFor(() => expect(authStore().blocked()).not.toBeNull())
  })

  it('leaves non-auth errors alone — a 500 is not an unpaired device', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })))
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const { authStore, isAuthError } = await import('../src/renderer/src/auth-gate')

    await expect(createRemoteApi().switchWorkspace('w1')).rejects.toThrow('boom')
    await expect(createRemoteApi().switchWorkspace('w1')).rejects.not.toSatisfy(isAuthError)
    expect(authStore().blocked()).toBeNull()
  })

  it('sends the token as a header, never in the query string', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')

    await createRemoteApi().switchWorkspace('w1')
    const [path, options] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(path).not.toContain('token=')
    expect((options.headers as Record<string, string>).authorization).toBe('Bearer paired-token')
  })
})

describe('checkAuth', () => {
  it('reports the scope the server returns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { scope: 'read-only', required: true }))
    )
    const { checkAuth } = await import('../src/renderer/src/remote-api')
    expect(await checkAuth('some-token')).toBe('read-only')
  })

  it('treats a server with NO token configured as full access', async () => {
    // Otherwise a loopback embedder would sit behind a re-pair screen that no
    // token can ever satisfy.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { scope: 'none', required: false }))
    )
    const { checkAuth } = await import('../src/renderer/src/remote-api')
    expect(await checkAuth()).toBe('pairing')
  })

  it('throws when the check itself fails, rather than reporting "unpaired"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, {})))
    const { checkAuth } = await import('../src/renderer/src/remote-api')
    await expect(checkAuth('t')).rejects.toThrow(/503/)
  })
})
