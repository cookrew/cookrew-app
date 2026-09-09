import http from 'node:http'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

/**
 * THE REMOTE BOOT CONTRACT (perf lane L7, 2026-09-08).
 *
 * A phone opening its canvas through the relay pays one exchange per request,
 * so the boot must ask for each thing ONCE. Measured before this lane: the
 * workspace crossed three times (App and EventToast each pulled it, and the
 * event stream opened with the same snapshot), the workspace list twice.
 * These pin the two halves of the fix: GETs in flight are shared by the
 * client, and the stream's first connect skips its opening snapshot.
 */

const PAIRING = 'pairing-token-for-tests'

function fakeStore(): MobileApiDeps['store'] {
  const state = { id: 'w1', name: 'Boot', nodes: [], connections: [], dirs: [] }
  return {
    focusedState: state,
    workspaceState: () => state,
    on: () => undefined,
    off: () => undefined,
    removeListener: () => undefined
  } as unknown as MobileApiDeps['store']
}

async function openStream(port: number, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: `/api/events${query}`, headers: { authorization: `Bearer ${PAIRING}` } },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          text += chunk
          // The list frame follows the (optional) workspace frame; once it is
          // here the opening burst is complete.
          if (text.includes('event: workspaces')) {
            request.destroy()
            resolve(text)
          }
        })
        response.on('error', () => resolve(text))
      }
    )
    request.on('error', (error) => (error.message.includes('socket hang up') ? undefined : reject(error)))
  })
}

describe('the companion event stream at boot', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const start = async (): Promise<number> => {
    const deps = {
      pairingToken: PAIRING,
      store: fakeStore(),
      turns: { list: () => [], on: () => undefined, removeListener: () => undefined },
      ops: { listWorkspaces: () => ({ workspaces: [{ id: 'w1', name: 'Boot', dirs: [] }], activeId: 'w1' }) },
      presets: [],
      ptys: new Map()
    } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(418).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  it('opens with the workspace snapshot by default — how a dropped stream heals', async () => {
    const port = await start()
    const text = await openStream(port, '')
    expect(text).toContain('event: workspace\n')
    expect(text).toContain('event: workspaces\n')
  })

  it('skips the opening snapshot ONCE for a boot nonce — a reconnect on the same URL heals', async () => {
    const port = await start()
    const first = await openStream(port, '?boot=nonce-abc-123')
    expect(first).not.toContain('event: workspace\n')
    // The list still opens the stream: a kilobyte, and the switcher's truth.
    expect(first).toContain('event: workspaces\n')
    // EventSource re-dials the SAME URL when the browser reconnects by
    // itself; the nonce is spent, so this one carries the snapshot.
    const again = await openStream(port, '?boot=nonce-abc-123')
    expect(again).toContain('event: workspace\n')
  })

  it('treats an empty or oversized nonce as no nonce', async () => {
    const port = await start()
    expect(await openStream(port, '?boot=')).toContain('event: workspace\n')
    expect(await openStream(port, `?boot=${'x'.repeat(65)}`)).toContain('event: workspace\n')
  })
})

// ---------------------------------------------------------------------------
// The client half: remote-api shares GETs in flight and says boot=pull once.
// ---------------------------------------------------------------------------

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
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout,
    clearTimeout
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

class FakeEventSource {
  static urls: string[] = []
  static last: FakeEventSource | null = null
  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  /** EventSource.CLOSED — the state in which the stream reconnects itself. */
  readyState = 2
  constructor(url: string) {
    FakeEventSource.urls.push(url)
    FakeEventSource.last = this
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  removeEventListener(): void {}
  close(): void {}
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({})
  }
}

describe('remote-api at boot', () => {
  beforeEach(() => {
    vi.resetModules()
    installWindow()
    FakeEventSource.urls = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined, hidden: false })
  })
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
    vi.unstubAllGlobals()
  })

  it('shares a GET in flight, and a later GET is a fresh request', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchMock = vi.fn(async () => {
      await gate
      return jsonResponse(200, { id: 'w1', name: 'Boot', nodes: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const api = createRemoteApi()
    const calls = fetchMock.mock.calls.length
    const both = Promise.all([api.getWorkspace(), api.getWorkspace()])
    expect(fetchMock.mock.calls.length - calls).toBe(1)
    release()
    const [a, b] = await both
    expect(a).toBe(b)
    await api.getWorkspace()
    expect(fetchMock.mock.calls.length - calls).toBe(2)
  })

  it('forgets a GET after a write, so a re-read never answers from before it', async () => {
    let reads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (String(url).includes('/api/workspace') && (init?.method ?? 'GET') === 'GET') reads += 1
        return jsonResponse(200, { reads })
      })
    )
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const api = createRemoteApi()
    const before = api.getWorkspace()
    void api.updateNode('n1', { name: 'x' })
    const after = api.getWorkspace()
    expect(await before).not.toBe(await after)
    expect(reads).toBe(2)
  })

  it('does not share a failed GET with a retry after it', async () => {
    let workspaceCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!String(url).includes('/api/workspace')) return jsonResponse(200, {})
        return workspaceCalls++ === 0 ? jsonResponse(500, { error: 'boom' }) : jsonResponse(200, { ok: true })
      })
    )
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const api = createRemoteApi()
    await expect(api.getWorkspace()).rejects.toThrow('boom')
    await expect(api.getWorkspace()).resolves.toEqual({ ok: true })
  })

  it('says boot=<nonce> on the first stream connect only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {})))
    const { createRemoteApi } = await import('../src/renderer/src/remote-api')
    const api = createRemoteApi()
    api.onWorkspaceState(() => undefined)
    expect(FakeEventSource.urls).toHaveLength(1)
    expect(FakeEventSource.urls[0]).toMatch(/\/api\/events\?boot=[a-z0-9-]{8,36}&/)
    expect(FakeEventSource.urls[0]).toContain('token=')
    // The link drops and the stream reconnects after its backoff: plainly,
    // so the snapshot heals the client.
    vi.useFakeTimers()
    try {
      FakeEventSource.last?.fire('error')
      vi.advanceTimersByTime(120_000)
    } finally {
      vi.useRealTimers()
    }
    expect(FakeEventSource.urls.length).toBeGreaterThanOrEqual(2)
    for (const url of FakeEventSource.urls.slice(1)) expect(url).not.toContain('boot=')
  })
})

describe('the activity seed flag', () => {
  it('flips once and tells its listeners', async () => {
    vi.resetModules()
    const store = await import('../src/renderer/src/activity-thumb-store')
    store.resetActivitySeededForTests()
    expect(store.isActivitySeeded()).toBe(false)
    store.markActivitySeeded()
    expect(store.isActivitySeeded()).toBe(true)
    store.markActivitySeeded()
    expect(store.isActivitySeeded()).toBe(true)
  })
})

describe('git rides the push by carrying the pull', () => {
  it('keeps a terminal’s git when the pushed node says nothing, and only then', async () => {
    const { carryGit } = await import('../src/renderer/src/workspace-git-carry')
    const git = { isRepo: true, root: '/r', branch: 'main', dirty: false, ahead: 0, behind: 0 } as never
    const terminal = (id: string, extra: Record<string, unknown> = {}) =>
      ({ kind: 'terminal', id, name: id, preset: 'Claude', command: '', cwd: '/r', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, ...extra }) as never
    const previous = { name: 'w', dir: '/r', dirs: ['/r'], connections: [], nodes: [terminal('a', { git }), terminal('moved', { git })] }
    const pushed = { name: 'w', dir: '/r', dirs: ['/r'], connections: [], nodes: [terminal('a'), terminal('b'), terminal('moved', { cwd: '/elsewhere' })] }
    const out = carryGit(previous, pushed)
    const byId = Object.fromEntries(out.nodes.map((n) => [n.id, n as { git?: unknown }]))
    expect(byId.a.git).toBe(git)
    expect(byId.b.git).toBeUndefined()
    // A terminal that changed directory must not wear the old directory's branch.
    expect(byId.moved.git).toBeUndefined()
    expect(pushed.nodes[0]).not.toHaveProperty('git')
  })

  it('returns the push untouched when there is nothing to carry', async () => {
    const { carryGit } = await import('../src/renderer/src/workspace-git-carry')
    const pushed = { name: 'w', dir: '/r', dirs: ['/r'], connections: [], nodes: [] }
    expect(carryGit(null, pushed)).toBe(pushed)
    expect(carryGit({ ...pushed }, pushed)).toBe(pushed)
  })
})
