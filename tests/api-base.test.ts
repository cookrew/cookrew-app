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
import { apiPath, clientBase, clientSlug } from '../src/renderer/src/api-base'
import { inConsole, relayBaseFor } from './support/console-scope'

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
 *
 * relay-gauges.ts addresses ANOTHER desktop, under that desktop's own relay
 * prefix: apiPath would point it at this Mac, the one wrong answer it must not
 * give. This Mac's own gauges go through apiPath, in remote-api.ts.
 */
const EXEMPT = new Set(['browser-stream.ts', 'relay-gauges.ts'])

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
    expect(clientBase()).toBe('')
    expect(apiPath('/api/state')).toBe('/api/state')
    expect(apiPath('/api/terminal/t1/input')).toBe('/api/terminal/t1/input')
  })
})

describe('apiPath on the console, with a machine in scope', () => {
  /**
   * Which machine is in scope is a value now (machine-scope.ts), not a global
   * read at load. Each case still loads its own module instance, so one
   * case's machine is never another's.
   */
  const MACHINE = '11111111-2222-3333-4444-555555555555'
  const OTHER = '99999999-2222-3333-4444-555555555555'
  const BASE = relayBaseFor(MACHINE)

  const consoleWith = async (machineId: string | null): Promise<typeof import('../src/renderer/src/api-base')> => {
    vi.resetModules()
    await inConsole(machineId)
    return import('../src/renderer/src/api-base')
  }

  afterEach(() => {
    delete (globalThis as { COOKREW_SLUG?: unknown }).COOKREW_SLUG
    vi.resetModules()
  })

  it('begins every request with the machine’s address on the relay', async () => {
    // Without it `/api/state` would be asked of the console's own origin, a
    // static host: the page would render and then talk to nobody.
    const api = await consoleWith(MACHINE)
    expect(api.clientBase()).toBe(BASE)
    expect(api.apiPath('/api/state')).toBe(`${BASE}/api/state`)
    expect(api.apiPath('/api/events')).toBe(`${BASE}/api/events`)
  })

  it('follows the machine in scope, with no reload in between', async () => {
    const api = await consoleWith(MACHINE)
    const { enterMachine } = await import('../src/renderer/src/machine-scope')
    enterMachine(OTHER)
    expect(api.apiPath('/api/state')).toBe(`${relayBaseFor(OTHER)}/api/state`)
    enterMachine(MACHINE)
    expect(api.apiPath('/api/state')).toBe(`${BASE}/api/state`)
  })

  it('refuses to build a path when no machine is in scope, rather than ask the console’s own host', async () => {
    const api = await consoleWith(null)
    expect(() => api.apiPath('/api/state')).toThrow(api.NoMachineInScope)
    const { enterMachine } = await import('../src/renderer/src/machine-scope')
    enterMachine(MACHINE)
    expect(api.apiPath('/api/state')).toBe(`${BASE}/api/state`)
    enterMachine(null)
    expect(() => api.apiPath('/api/state')).toThrow(api.NoMachineInScope)
  })

  it('asks the relay as another origin: no cookie, and no claim about the local network', async () => {
    const api = await consoleWith(MACHINE)
    expect(api.apiRequestInit()).toEqual({ mode: 'cors', credentials: 'omit' })
  })
})

describe('apiPath on a machine’s own page', () => {
  const ownPage = async (injected: Record<string, unknown>): Promise<typeof import('../src/renderer/src/api-base')> => {
    Object.assign(globalThis, injected)
    vi.resetModules()
    return import('../src/renderer/src/api-base')
  }

  afterEach(() => {
    delete (globalThis as { COOKREW_SLUG?: unknown }).COOKREW_SLUG
    delete (globalThis as { COOKREW_BASE?: unknown }).COOKREW_BASE
    vi.resetModules()
  })

  it('is the identity at the root, and same-origin', async () => {
    const api = await ownPage({ COOKREW_SLUG: '' })
    expect(api.clientBase()).toBe('')
    expect(api.apiPath('/api/state')).toBe('/api/state')
    expect(api.apiRequestInit()).toEqual({ credentials: 'same-origin' })
  })

  it('carries the workspace it was served for', async () => {
    const api = await ownPage({ COOKREW_SLUG: 'playground' })
    expect(api.clientSlug()).toBe('playground')
    expect(api.apiPath('/api/state')).toBe('/playground/api/state')
  })

  it('believes no injected base: a machine serves its page at its own root and nowhere else', async () => {
    // The relay once served a machine's page under a prefix and said so in this
    // global. Nothing is served that way now, and a page cannot be re-pointed by it.
    const api = await ownPage({ COOKREW_BASE: '/relay/@owner/desktop/11111111-2222-3333-4444-555555555555', COOKREW_SLUG: '' })
    expect(api.clientBase()).toBe('')
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
    // openEventSource (rtc-plane.ts) is how a stream is opened now: the same
    // EventSource, or the same stream over the direct link.
    const streams = source.match(/(?:new EventSource|openEventSource)\([^)]*\)/g) ?? []
    expect(streams.length).toBeGreaterThan(0)
    for (const stream of streams) expect(stream).toContain('apiPath(')
  })

  it('every stream gets its credential from the opener, on every plane', () => {
    // Reads are gated, so a stream with no token is a 401 the client retries for
    // ever. The opener adds it because the plane decides how: a query where
    // EventSource needs one, a header on the relay, whose URLs reach the ingress
    // log. A token added at a call site would land on the relay too.
    const opener = readFileSync(path.join(RENDERER, 'rtc-plane.ts'), 'utf8')
    const start = opener.indexOf('export const openEventSource')
    const body = opener.slice(start, opener.indexOf('\n}\n', start))
    expect(body).toMatch(/new RtcEventSource\(routed\.link, tokenParam\(routed\.path\)\)/)
    expect(body).toMatch(/new RtcEventSource\(headerStream\(url\), url\)/)
    expect(body).toMatch(/new EventSource\(tokenParam\(url\)\)/)
    // On the relay the stream goes by fetch: the machine's token and the account session, both in
    // headers, and the session judged by the address the stream is going to.
    expect(opener).toMatch(/headers: \{ \.\.\.headers, \.\.\.authHeaders\(\), \.\.\.relayHeadersForUrl\(url\) \}/)

    const carrying: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (/\.tsx?$/.test(entry.name) && !/rtc-plane\.ts$|auth-gate\.ts$/.test(file)) {
          if (/tokenParam\(/.test(readFileSync(file, 'utf8'))) carrying.push(path.relative(RENDERER, file))
        }
      }
    }
    walk(RENDERER)
    expect(carrying).toEqual([])
  })

  it('every stream opens through openEventSource, so it follows the direct link', () => {
    // A stream built with `new EventSource` directly would keep riding the
    // relay after the plane moved onto the WebRTC link (rtc-plane.ts) — the
    // badge would say LAN while the busiest connection never left cookrew.dev.
    const direct: string[] = []
    for (const file of sourceFiles(RENDERER)) {
      if (path.relative(RENDERER, file) === 'rtc-plane.ts') continue
      const code = stripComments(readFileSync(file, 'utf8'))
      code.split('\n').forEach((line, index) => {
        if (/new EventSource\(/.test(line)) direct.push(`${path.relative(RENDERER, file)}:${index + 1}`)
      })
    }
    expect(direct).toEqual([])
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

