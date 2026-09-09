// Every client request carries the workspace it was served for.
//
// The renderer bundle is the phone client and issues root-absolute /api/...
// requests. At `/` that is correct. At `/<slug>` it was not: the page rendered
// one workspace's URL while reading and writing whichever workspace the desktop
// happened to be looking at — which is why the server refused to serve the
// client under a slug at all (SCOPE_AWARE, re-review N1).
//
// A missed call site is INVISIBLE: it does not throw, it silently answers for
// the focused canvas. So the sweep below is exhaustive by construction rather
// than a spot check — it reads the source and fails on any root-absolute /api
// literal that is not wrapped.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_BASE, apiPath, clientSlug } from '../src/renderer/src/api-base'

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'src')

/**
 * Files whose /api URLs are DELIBERATELY unslugged, listed here rather than
 * hidden behind a regex hole so the exemption is reviewed like anything else.
 *
 * browser-stream.ts is where the stream's ROOT-ABSOLUTE path is spelled out
 * (`streamPath`), for a caller to scope. That is the point of the exemption
 * and the whole of it: the caller — useBrowserStream — now wraps it in
 * apiPath, which is asserted below rather than assumed. Phase C3 is what
 * forced the question the old exemption deferred: a socket built from the page
 * origin by hand was harmless while the page origin WAS the transport, and is
 * a silent bug the moment the data plane can move without the address bar.
 */
const EXEMPT = new Set(['browser-stream.ts'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

/** Strip comments so a doc mention of `/api/...` is not a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('apiPath at the unslugged root', () => {
  it('is the identity — nothing about the existing client changes', () => {
    // The test process has no injected COOKREW_SLUG, which is exactly the
    // shape of a client served at `/`.
    expect(clientSlug()).toBe('')
    expect(API_BASE).toBe('')
    expect(apiPath('/api/state')).toBe('/api/state')
    expect(apiPath('/api/terminal/t1/input')).toBe('/api/terminal/t1/input')
  })
})

describe('apiPath under a relay prefix', () => {
  /**
   * The globals are read ONCE at module load, deliberately — so a test that
   * wants a different client has to load a different module instance. That is
   * the same reason the app cannot be re-pointed at another workspace (or
   * another desktop) by mutating a global after boot.
   */
  const clientServedAt = async (
    injected: Record<string, unknown>
  ): Promise<typeof import('../src/renderer/src/api-base')> => {
    Object.assign(globalThis, injected)
    vi.resetModules()
    return import('../src/renderer/src/api-base')
  }

  afterEach(() => {
    delete (globalThis as { COOKREW_BASE?: unknown }).COOKREW_BASE
    delete (globalThis as { COOKREW_SLUG?: unknown }).COOKREW_SLUG
    vi.resetModules()
  })

  const BASE = '/relay/@owner/desktop/11111111-2222-3333-4444-555555555555'

  it('prefixes every request with the base the page was served under', async () => {
    // Pressing OPEN on /me lands the companion here. Without the prefix its
    // `/api/state` leaves the relay path and hits cookrew.dev's own routes —
    // the page renders and then talks to the registry instead of the Mac.
    const api = await clientServedAt({ COOKREW_BASE: BASE, COOKREW_SLUG: '' })
    expect(api.clientBase()).toBe(BASE)
    expect(api.API_BASE).toBe(BASE)
    expect(api.apiPath('/api/state')).toBe(`${BASE}/api/state`)
    expect(api.apiPath('/api/events')).toBe(`${BASE}/api/events`)
  })

  it('composes with the slug rather than replacing it', async () => {
    // Two different questions — where the app is served from, and which
    // workspace it is for. A relayed client under a slug needs both, and
    // preferring one would silently answer for the focused canvas.
    const api = await clientServedAt({ COOKREW_BASE: BASE, COOKREW_SLUG: 'playground' })
    expect(api.API_BASE).toBe(`${BASE}/playground`)
    expect(api.apiPath('/api/state')).toBe(`${BASE}/playground/api/state`)
  })

  it('tolerates a trailing slash on the injected base', async () => {
    const api = await clientServedAt({ COOKREW_BASE: `${BASE}/` })
    expect(api.apiPath('/api/state')).toBe(`${BASE}/api/state`)
  })

  it('is the identity again for a companion served at the root', async () => {
    const api = await clientServedAt({ COOKREW_BASE: '', COOKREW_SLUG: '' })
    expect(api.API_BASE).toBe('')
    expect(api.apiPath('/api/state')).toBe('/api/state')
  })
})

describe('conformance — no unwrapped root-absolute /api in the renderer', () => {
  it('every /api literal goes through apiPath', () => {
    const violations: string[] = []
    for (const file of sourceFiles(RENDERER)) {
      if (file.endsWith('api-base.ts')) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      code.split('\n').forEach((line, index) => {
        const where = `${path.relative(RENDERER, file)}:${index + 1}`
        if (EXEMPT.has(where.split(':')[0]) && /\/api\//.test(line)) return
        // A root-absolute /api literal in any quoting style...
        const rootAbsolute = /['"`]\/api\//.test(line)
        // ...or one built INSIDE a full URL, which the quote-anchored pattern
        // above cannot see. streamUrl is exactly that shape, and the sweep
        // missed it: `${scheme}://${host}/api/browser/...`. A blind spot in a
        // conformance sweep is worse than no sweep, because it reads as proof.
        const insideFullUrl = /:\/\//.test(line) && /\/api\//.test(line)
        if (!rootAbsolute && !insideFullUrl) return
        // Either way it is a violation unless apiPath wraps it.
        if (/apiPath\(/.test(line)) return
        violations.push(`${where}: ${line.trim()}`)
      })
    }
    expect(violations).toEqual([])
  })

  it('the sweep can actually see a violation', () => {
    // A conformance test that cannot fail is decoration. This proves the
    // detector fires on the exact shape it is meant to catch.
    const offending = `const url = '/api/state'`
    expect(/['"`]\/api\//.test(offending)).toBe(true)
    expect(/apiPath\(\s*['"`]\/api\//.test(offending)).toBe(false)
  })

  it('does not flag a correctly wrapped call', () => {
    const wrapped = "req<WorkspaceState>(apiPath('/api/workspace'))"
    expect(/apiPath\(\s*['"`]\/api\//.test(wrapped)).toBe(true)
  })
})

describe('the streams are covered too', () => {
  it('EventSource and stream URLs are wrapped in remote-api', () => {
    // The dangerous ones. A mis-scoped fetch usually fails visibly; a
    // mis-scoped EventSource connects happily and feeds the wrong canvas's
    // state forever.
    const source = readFileSync(path.join(RENDERER, 'remote-api.ts'), 'utf8')
    const streams = source.match(/new EventSource\([^)]*\)/g) ?? []
    expect(streams.length).toBeGreaterThan(0)
    for (const stream of streams) expect(stream).toContain('apiPath(')
  })

  it('every EventSource in the renderer also carries a token', () => {
    // Reads are gated now, and EventSource cannot set a header — so a stream
    // built without tokenParam is a 401 the client retries forever. That
    // failure is INVISIBLE in the same way the scope bug above was: the socket
    // opens, retries on its own, and the canvas simply never fills.
    //
    // Swept across the whole renderer rather than remote-api alone, because
    // the next stream will not necessarily be added there, and the cost of
    // getting this wrong is either a dead companion or somebody "fixing" it by
    // reopening the read gate.
    const violations: string[] = []
    for (const file of sourceFiles(RENDERER)) {
      const code = stripComments(readFileSync(file, 'utf8'))
      code.split('\n').forEach((line, index) => {
        if (!/new EventSource\(/.test(line)) return
        if (/tokenParam\(/.test(line)) return
        violations.push(`${path.relative(RENDERER, file)}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(violations).toEqual([])
  })

  it('the browser socket is scoped and follows the data plane', () => {
    // The one long-lived connection that is not an EventSource, and the one
    // that was building its own URL. It must compose through apiPath like
    // everything else, or a phone that switched onto the LAN would keep
    // streaming its browser frames through cookrew.dev.
    const source = readFileSync(path.join(RENDERER, 'useBrowserStream.ts'), 'utf8')
    expect(source).toContain('apiPath(streamPath(')
    // The desktop keeps its own route to the loopback companion server: it is
    // loaded from file:// or Vite and has no page origin to compose against.
    expect(source).toContain('DESKTOP_STREAM_ORIGIN')
  })

  it('every scoped fetch goes through planeFetch', () => {
    // planeFetch supplies the credential mode the current plane needs —
    // cookies same-origin through the relay, none at all cross-origin to the
    // Mac — and reports the transport failures that are the only evidence a
    // direct plane has died. Both are invisible when missed: the first 401s
    // every request, the second strands a phone on a dead path forever.
    //
    // The probes are deliberately NOT on this list and cannot be: askHello
    // talks to an address that has not yet proved it is the Mac, and the
    // registry's verify call is the one request in the client that is for
    // cookrew.dev itself. Neither is on the data plane.
    const violations: string[] = []
    for (const file of sourceFiles(RENDERER)) {
      const code = stripComments(readFileSync(file, 'utf8'))
      code.split('\n').forEach((line, index) => {
        if (!/(?:^|[^A-Za-z])fetch\(\s*apiPath\(/.test(line)) return
        if (/planeFetch\(/.test(line)) return
        violations.push(`${path.relative(RENDERER, file)}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(violations).toEqual([])
  })

  it('the planeFetch sweep can actually see a violation', () => {
    // Same discipline as the sweeps above: a conformance test that cannot
    // fail is decoration.
    const detector = /(?:^|[^A-Za-z])fetch\(\s*apiPath\(/
    expect(detector.test(`await fetch(apiPath('/api/state'))`)).toBe(true)
    expect(detector.test(`void fetch(apiPath('/api/beacon'), {`)).toBe(true)
    expect(detector.test(`await planeFetch(apiPath('/api/state'))`)).toBe(false)
  })

  it('the token sweep can actually see a violation', () => {
    // Same discipline as the /api sweep above: a conformance test that cannot
    // fail is decoration.
    const offending = `new EventSource(apiPath('/api/events'))`
    expect(/new EventSource\(/.test(offending)).toBe(true)
    expect(/tokenParam\(/.test(offending)).toBe(false)
  })
})

