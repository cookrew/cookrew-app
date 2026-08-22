// Every workspace gets its own address: https://<host>/<slug>/...
//
// Step 3 of the multi-instance refactor (marketplace-architecture §11). The
// singleton served ONE canvas at /api/*, so a desktop focus change swapped the
// world out from under every connected phone. A slug in the path is what lets
// /cookrew-dev and /playground be read at the same time by different seats.
//
// Pinned here is the parse alone — pure, no server. The rule that matters is
// that the UNSLUGGED paths keep working untouched: every paired phone has a
// bookmark to /, and step 3 is additive or it is a regression.

import { describe, expect, it } from 'vitest'
import {
  nodeIdOfRoute,
  nodeInScope,
  resolveScopedRoute,
  scopedRouteSupported,
  splitSlugRoute,
  NODE_ROUTES,
  SCOPE_AWARE
} from '../src/main/mobile-slug-route'
import { RESERVED_SLUGS, deriveSlug } from '../src/main/workspace-slug'

describe('splitSlugRoute', () => {
  it('leaves an unslugged api path exactly as it found it', () => {
    expect(splitSlugRoute('/api/state')).toEqual({ slug: null, pathname: '/api/state' })
    expect(splitSlugRoute('/api/terminal/t1/input')).toEqual({
      slug: null,
      pathname: '/api/terminal/t1/input'
    })
  })

  it('leaves the root and the renderer index alone', () => {
    expect(splitSlugRoute('/')).toEqual({ slug: null, pathname: '/' })
    expect(splitSlugRoute('/index.html')).toEqual({ slug: null, pathname: '/index.html' })
  })

  it('never claims an asset path — the bundle is served once, not per slug', () => {
    expect(splitSlugRoute('/assets/index-abc123.js')).toEqual({
      slug: null,
      pathname: '/assets/index-abc123.js'
    })
  })

  it('splits a slugged api path into scope and remainder', () => {
    expect(splitSlugRoute('/cookrew-dev/api/state')).toEqual({
      slug: 'cookrew-dev',
      pathname: '/api/state'
    })
    expect(splitSlugRoute('/playground/api/terminal/t1/output')).toEqual({
      slug: 'playground',
      pathname: '/api/terminal/t1/output'
    })
  })

  it('treats a bare slug as that workspace index', () => {
    expect(splitSlugRoute('/playground')).toEqual({ slug: 'playground', pathname: '/' })
    expect(splitSlugRoute('/playground/')).toEqual({ slug: 'playground', pathname: '/' })
  })

  it('carries the agents route through — §9 mounts on this', () => {
    expect(splitSlugRoute('/cookrew-dev/agents/Atlas/ask')).toEqual({
      slug: 'cookrew-dev',
      pathname: '/agents/Atlas/ask'
    })
  })

  it('refuses a slug that could escape its own prefix', () => {
    // Path traversal via the scope segment would let one workspace's URL
    // address another's routes. Nothing that is not a minted slug shape wins.
    expect(splitSlugRoute('/../api/state').slug).toBeNull()
    expect(splitSlugRoute('/%2e%2e/api/state').slug).toBeNull()
    expect(splitSlugRoute('/a.b/api/state').slug).toBeNull()
    expect(splitSlugRoute('/UPPER/api/state').slug).toBeNull()
  })

  it('accepts exactly the shape deriveSlug mints', () => {
    expect(splitSlugRoute('/a/api/state').slug).toBe('a')
    expect(splitSlugRoute('/my-big-project-2/api/state').slug).toBe('my-big-project-2')
    expect(splitSlugRoute('/100-done/api/state').slug).toBe('100-done')
  })
})

describe('resolveScopedRoute', () => {
  const known = (slug: string): string | undefined =>
    ({ 'cookrew-dev': 'ws-dev', playground: 'ws-play' })[slug]

  it('leaves unslugged paths unscoped — the focused session answers, as before', () => {
    expect(resolveScopedRoute('/api/state', known)).toEqual({
      kind: 'unscoped',
      pathname: '/api/state'
    })
  })

  it('resolves a known slug to its workspace and strips the prefix', () => {
    expect(resolveScopedRoute('/playground/api/state', known)).toEqual({
      kind: 'scoped',
      workspaceId: 'ws-play',
      slug: 'playground',
      pathname: '/api/state'
    })
  })

  it('an UNKNOWN slug is its own outcome, never a fallback to focus', () => {
    // The whole point. A phone handed a canvas back has no way to tell it
    // asked for the wrong one, so this must 404 rather than serve something.
    const route = resolveScopedRoute('/deleted-workspace/api/state', known)
    expect(route.kind).toBe('unknown-slug')
    expect(route).not.toHaveProperty('workspaceId')
  })

  it('two slugs resolve to two different sessions concurrently', () => {
    const a = resolveScopedRoute('/cookrew-dev/api/state', known)
    const b = resolveScopedRoute('/playground/api/state', known)
    expect(a).toMatchObject({ kind: 'scoped', workspaceId: 'ws-dev' })
    expect(b).toMatchObject({ kind: 'scoped', workspaceId: 'ws-play' })
  })
})

describe('nodeInScope', () => {
  it('lets an unscoped request keep its existing reach', () => {
    expect(nodeInScope(null, 'ws-anything')).toBe(true)
    expect(nodeInScope(null, undefined)).toBe(true)
  })

  it('lets a scoped request touch its own workspace nodes', () => {
    expect(nodeInScope('ws-play', 'ws-play')).toBe(true)
  })

  it('REFUSES a node belonging to another workspace', () => {
    // Without this the slug is decoration:
    // /playground/api/terminal/<id-from-cookrew-dev>/input would drive a
    // terminal the URL does not name.
    expect(nodeInScope('ws-play', 'ws-dev')).toBe(false)
  })

  it('refuses a node that belongs to nothing at all', () => {
    expect(nodeInScope('ws-play', undefined)).toBe(false)
  })
})

describe('scopedRouteSupported — fail closed (review C2)', () => {
  it('allows the routes actually threaded through the scope', () => {
    for (const p of [
      '/api/state',
      '/api/terminal/t1/output',
      '/api/terminal/t1/input',
      '/api/terminal/t1/ask',
      '/api/browser/b1/thumb'
    ]) {
      expect(scopedRouteSupported(p)).toBe(true)
    }
  })

  it('REFUSES every route that still answers for focus', () => {
    // The reviewer's C2 list. Each of these would otherwise return the focused
    // workspace's answer to a URL naming a different one — a wrong answer that
    // looks right, which is worse than not having the route.
    for (const p of [
      '/api/nodes/n1',
      // /fork CREATES a terminal, and placement is a workspace decision, not a
      // property of the addressed node — a membership check on the source
      // proves nothing about where the fork lands.
      '/api/terminal/t1/fork',
      '/api/agents/a1/dispatch',
      '/api/agents/a1/recover',
      '/api/agents/a1/restore',
      '/api/workspaces/switch',
      '/api/board',
      '/api/team/fork'
    ]) {
      expect(scopedRouteSupported(p)).toBe(false)
    }
  })
})

describe('nodeIdOfRoute — one check for every scoped node route', () => {
  it('extracts the node id a scoped route addresses', () => {
    expect(nodeIdOfRoute('/api/terminal/t1/output')).toBe('t1')
    expect(nodeIdOfRoute('/api/terminal/t1/input')).toBe('t1')
    expect(nodeIdOfRoute('/api/terminal/t1/ask')).toBe('t1')
    expect(nodeIdOfRoute('/api/browser/b9/thumb')).toBe('b9')
  })

  it('is null for routes that address no node', () => {
    expect(nodeIdOfRoute('/api/state')).toBeNull()
    expect(nodeIdOfRoute('/')).toBeNull()
  })

  it("the reviewer's PoC: a raw drive on another workspace's terminal", () => {
    // /raw is scope-aware NOW (a slugged phone must be able to type), so the
    // refusal moves from the route to the NODE: the path is reachable, the id
    // is extracted, and membership is what stops it.
    expect(scopedRouteSupported('/api/terminal/other-ws-terminal/raw')).toBe(true)
    expect(nodeIdOfRoute('/api/terminal/other-ws-terminal/raw')).toBe('other-ws-terminal')
    expect(nodeInScope('ws-play', 'ws-dev')).toBe(false)
  })
})

describe('the renderer index, EARNED back (P2-B)', () => {
  it('serves the client under a slug now that the client is slug-aware', () => {
    // Refused at N1 because the bundle issued root-absolute /api/... requests.
    // Now window.COOKREW_SLUG is injected into both index paths and api-base
    // prefixes every request, with a conformance sweep proving no call site
    // was missed — so the page and its data finally name the same workspace.
    expect(scopedRouteSupported('/')).toBe(true)
    expect(scopedRouteSupported('/index.html')).toBe(true)
  })

  it('serves the canvas and the live stream a booted client needs', () => {
    expect(scopedRouteSupported('/api/workspace')).toBe(true)
    expect(scopedRouteSupported('/api/events')).toBe(true)
  })

  it('still allows the data routes a scoped client would call', () => {
    expect(scopedRouteSupported('/api/state')).toBe(true)
    expect(scopedRouteSupported('/api/terminal/t1/input')).toBe(true)
  })
})

describe('the dev renderer surface is not a workspace (live-window find)', () => {
  it('does NOT claim /src/* as a slug', () => {
    // Found by walking the live app under the flag. /src/main.tsx matched the
    // slug shape, resolved to no workspace, and answered
    // {"error":"No workspace at /src"} — so a phone in dev mode loaded an
    // index and then no modules at all. A blank page, and only under the flag,
    // because slug routing is gated.
    expect(splitSlugRoute('/src/main.tsx')).toEqual({ slug: null, pathname: '/src/main.tsx' })
    expect(splitSlugRoute('/src/renderer/App.tsx').slug).toBeNull()
  })

  it('does not claim /node_modules/* either', () => {
    // This one survived by ACCIDENT — '_' fails the slug shape. Relying on the
    // punctuation of a directory name is luck, not design, so it is on the
    // list explicitly now.
    expect(splitSlugRoute('/node_modules/.vite/deps/react.js').slug).toBeNull()
  })

  it('still does not claim /@vite/* (its punctuation never matched)', () => {
    expect(splitSlugRoute('/@vite/client').slug).toBeNull()
  })

  it('a workspace NAMED after a reserved segment gets a safe slug', () => {
    // The mint side of the same list: a workspace called "Src" must not be
    // handed an address that the server already owns.
    expect(deriveSlug('Src')).toBe('src-ws')
    expect(deriveSlug('node modules')).toBe('node-modules')
  })

  it('the two sides share ONE list', () => {
    // Two copies of a reserved-word list is how they drift.
    for (const reserved of RESERVED_SLUGS) {
      expect(splitSlugRoute(`/${reserved}/whatever`).slug).toBeNull()
    }
  })
})

describe('a slugged phone is a full SEAT, not a reader (Magpie)', () => {
  it('can TYPE — /raw is scope-aware', () => {
    // The gap Magpie found: /raw answered 501 under a slug, so a phone on
    // /playground could read a terminal and never type into it. §11 promises
    // a companion on a slug is a working seat; a seat that cannot type is not
    // one.
    expect(scopedRouteSupported('/api/terminal/t1/raw')).toBe(true)
  })

  it('has the rest of what a live seat needs', () => {
    for (const p of [
      '/api/terminal/t1/stream', // pane content
      '/api/terminal/t1/resize', // geometry
      '/api/terminal/t1/input',
      '/api/terminal/t1/ask',
      '/api/terminal/t1/output',
      '/api/terminal/t1/jump',
      '/api/terminal/t1/seen',
      '/api/terminal/t1/turns',
      '/api/terminal/t1/turns?page=2',
      '/api/terminal/t1/trace',
      '/api/terminal/t1/trace/index',
      '/api/terminal/t1/trace/markers',
      '/api/browser/b1/thumb'
    ]) {
      expect(scopedRouteSupported(p), p).toBe(true)
    }
  })

  it('does NOT claim /cwd — it reads node-addressed but resolves through focus', () => {
    // moveTerminalCwd goes through store.node() and validates against
    // store.focusedState.dirs, so a scoped call for a terminal in a
    // non-focused workspace would clear the membership gate and then answer
    // 400 for a terminal that exists. Allow-listing it would make the
    // "every claimed route is correct by construction" property above a
    // claim rather than a fact. It stays 501 until moveTerminalCwd takes a
    // workspace id — the same reasoning that keeps /fork out.
    expect(scopedRouteSupported('/api/terminal/t1/cwd')).toBe(false)
    expect(nodeIdOfRoute('/api/terminal/t1/cwd')).toBeNull()
  })

  it('EVERY scoped node route yields an id, so none can slip through ungated', () => {
    // The structural property. Allow-listing a node route without teaching the
    // extractor would let a slugged URL drive a node in ANOTHER workspace —
    // the decoration the scope check exists to prevent. One table now feeds
    // both, so this holds by construction rather than by vigilance.
    for (const p of [
      '/api/terminal/t1/raw',
      '/api/terminal/t1/stream',
      '/api/terminal/t1/resize',
      '/api/terminal/t1/jump',
      '/api/terminal/t1/seen',
      '/api/terminal/t1/turns?page=2',
      '/api/terminal/t1/trace/markers',
      '/api/browser/b1/thumb'
    ]) {
      expect(nodeIdOfRoute(p), p).not.toBeNull()
    }
  })

  it('does not yield an id for a route it does not claim', () => {
    // The inverse: gating a path the allow-list refuses would be dead code
    // that reads like protection.
    expect(nodeIdOfRoute('/api/terminal/t1/fork')).toBeNull()
    expect(nodeIdOfRoute('/api/state')).toBeNull()
  })
})

describe('the no-drift claim, enforced rather than asserted', () => {
  it('every node-shaped route in SCOPE_AWARE comes from NODE_ROUTES', () => {
    // I claimed one table meant the allow-list and the id extractor could not
    // drift. Then I simulated the drift — appending a node route to
    // SCOPE_AWARE directly, bypassing the table — and the suite stayed green.
    // The claim was aspirational; this is what makes it true. A node-addressed
    // path allow-listed outside the table would be reachable under a slug and
    // yield no id, so nothing would check membership: a slugged URL driving a
    // node in another workspace.
    const fromTable = new Set(NODE_ROUTES.map((r) => r.source))
    // Node-shaped = addresses a terminal or browser AND has an id segment.
    // That is what separates /api/browser/:id/thumb (node-addressed) from
    // /api/browser/capabilities (global, correctly absent from the table).
    const nodeShaped = SCOPE_AWARE.filter(
      (r) => /terminal|browser/.test(r.source) && r.source.includes('[^/]+')
    )
    for (const pattern of nodeShaped) {
      expect(fromTable.has(pattern.source), `not in NODE_ROUTES: ${pattern.source}`).toBe(true)
    }
    expect(nodeShaped.length).toBe(NODE_ROUTES.length)
  })
})
