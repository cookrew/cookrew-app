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
  splitSlugRoute
} from '../src/main/mobile-slug-route'

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
      '/',
      '/index.html',
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
      '/api/workspace',
      '/api/nodes/n1',
      '/api/terminal/t1/raw',
      '/api/terminal/t1/resize',
      '/api/terminal/t1/fork',
      '/api/terminal/t1/cwd',
      '/api/terminal/t1/stream',
      '/api/terminal/t1/jump',
      '/api/agents/a1/dispatch',
      '/api/agents/a1/recover',
      '/api/agents/a1/restore',
      '/api/workspaces/switch',
      '/api/events',
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
    // POST /playground/api/terminal/<id-from-cookrew-dev>/raw — /raw is not
    // scope-aware, so it is refused outright rather than reaching the handler.
    expect(scopedRouteSupported('/api/terminal/other-ws-terminal/raw')).toBe(false)
    // And the scoped variant that IS allowed still gets its node checked.
    expect(nodeIdOfRoute('/api/terminal/other-ws-terminal/input')).toBe('other-ws-terminal')
    expect(nodeInScope('ws-play', 'ws-dev')).toBe(false)
  })
})
