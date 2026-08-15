// PERMANENT route-manifest conformance gate (v4 §3/§4): the manifest is the
// ONE route table the wave-B gate will enforce, so it can never drift from
// the routes the server actually binds. Two nets, deliberately redundant:
// (a) a grep-driven sweep that fails the moment anyone ADDS a route literal
//     to mobile-api.ts/mobile-server.ts without classifying it, and
// (b) a pinned table that fails the moment a route's GROUP changes without
//     someone consciously editing this file. Do not weaken either to land a
//     route; classify it instead.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROUTE_MANIFEST, classifyRoute } from '../src/shared/route-manifest'

const MOBILE_API = readFileSync(path.join(__dirname, '../src/main/mobile-api.ts'), 'utf8')
const MOBILE_SERVER = readFileSync(path.join(__dirname, '../src/main/mobile-server.ts'), 'utf8')

/** `method === "X" && p|url.pathname === "PATH"` pairs — method is known exactly. */
function exactRoutes(src: string): Array<{ method: string; path: string }> {
  const found: Array<{ method: string; path: string }> = []
  const re = /(?:request\.)?method === ["'](GET|POST|PUT|DELETE|PATCH)["'] && \(?(?:p|url\.pathname) === ["'`](\/[^"'`]*)["'`]/g
  for (const m of src.matchAll(re)) found.push({ method: m[1], path: m[2] })
  return found
}

/** Bare `p === "PATH"` / `url.pathname === "PATH"` comparisons — method handled separately. */
function literalPaths(src: string): string[] {
  const re = /(?:p|url\.pathname) === ["'`](\/[^"'`]*)["'`]/g
  return [...src.matchAll(re)].map((m) => m[1])
}

/**
 * Regex-literal routes: `/^\/api\/...([^/]+)...$/`. Bracket expressions are
 * consumed whole so the `/` inside `[^/]` does not end the match early.
 * `([^/]+)` becomes a `:id` segment and a single alternation group
 * `(raw|resize|jump)` expands to one path per alternative.
 */
function regexPaths(src: string): string[] {
  const bodyRe = /\/((?:\\\/|\[[^\]]*\]|[^/[])+)\//g
  const paths: string[] = []
  for (const m of src.matchAll(bodyRe)) {
    let body = m[1]
    if (!body.startsWith('^\\/')) continue
    // Param first (its bracket holds a literal '/'), then unescape, then anchors.
    body = body
      .replace(/\(\[\^\/?\]\+\)/g, ':id')
      .replace(/\\\//g, '/')
      .replace(/\^|\$/g, '')
    const alt = body.match(/\(([^()]*\|[^()]*)\)/)
    if (alt) {
      for (const option of alt[1].split('|')) paths.push(body.replace(alt[0], option))
    } else {
      paths.push(body)
    }
  }
  return paths.filter((p) => p.startsWith('/api/'))
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const

describe('route-manifest conformance (grep-driven)', () => {
  it('every method-pinned route literal in both servers is classified', () => {
    const discovered = [...exactRoutes(MOBILE_API), ...exactRoutes(MOBILE_SERVER)]
    expect(discovered.length).toBeGreaterThan(20)
    for (const { method, path: p } of discovered) {
      expect(
        classifyRoute(method, p),
        `${method} ${p} has no manifest group — add a ROUTE_MANIFEST entry`
      ).not.toBeNull()
    }
  })

  it('every bare path literal and regex route in both servers is classified under some method', () => {
    const paths = new Set([
      ...literalPaths(MOBILE_API),
      ...literalPaths(MOBILE_SERVER),
      ...regexPaths(MOBILE_API),
      ...regexPaths(MOBILE_SERVER)
    ])
    expect(paths.size).toBeGreaterThan(30)
    for (const p of paths) {
      const classified = METHODS.some((method) => classifyRoute(method, p) !== null)
      expect(classified, `${p} matches no manifest entry — add a ROUTE_MANIFEST entry`).toBe(true)
    }
  })

  it('the manifest covers the WS upgrade surface (Sol F1/F2: the manifest owns HTTP + WS)', () => {
    expect(classifyRoute('GET', '/api/browser/browser-9/stream')).toBe('terminal-io')
  })

  it('manifest entries are unique per method+pattern', () => {
    const seen = new Set<string>()
    for (const entry of ROUTE_MANIFEST) {
      const key = `${entry.method} ${entry.pattern}`
      expect(seen.has(key), `duplicate manifest entry ${key}`).toBe(false)
      seen.add(key)
    }
  })
})

describe('classifyRoute matching semantics', () => {
  it(':id segments match exactly one path segment', () => {
    expect(classifyRoute('GET', '/api/terminal/t-1/turns')).toBe('observe')
    expect(classifyRoute('GET', '/api/terminal/t-1/turns/extra')).toBeNull()
    expect(classifyRoute('GET', '/api/terminal/turns')).toBeNull()
  })

  it('literal entries win over :id patterns on the same prefix', () => {
    // 'switch' is a legal workspace id shape — it must not be swallowed.
    expect(classifyRoute('POST', '/api/workspaces/switch')).toBe('orchestrate')
    expect(classifyRoute('GET', '/api/browser/capabilities')).toBe('observe')
  })

  it('method is part of the classification: same path, different groups', () => {
    expect(classifyRoute('GET', '/api/team/clip')).toBe('observe')
    expect(classifyRoute('POST', '/api/team/clip')).toBe('orchestrate')
    expect(classifyRoute('PUT', '/api/team/clip')).toBeNull()
  })

  it('method matching is case-insensitive, path matching is strict', () => {
    expect(classifyRoute('get', '/api/board')).toBe('observe')
    expect(classifyRoute('GET', '/api/board/')).toBeNull()
  })

  it('query strings do not affect classification', () => {
    expect(classifyRoute('GET', '/api/events/query?type=turn.completed&limit=50')).toBe('observe')
  })

  it('unknown /api paths classify null (deny-by-default), and so do non-/api paths', () => {
    expect(classifyRoute('GET', '/api/definitely-not-a-route')).toBeNull()
    expect(classifyRoute('DELETE', '/api/workspaces')).toBeNull()
    expect(classifyRoute('GET', '/assets/index-abc.js')).toBeNull()
  })
})

describe('pinned group table (the deliberate decisions)', () => {
  // Each row: [method, example path, group]. Editing a group here is a
  // conscious auth-model change — the row IS the record of the decision.
  const PINNED: Array<[string, string, string]> = [
    // public — bootstrap + the one status probe (v4 §4: only these are open;
    // /api/catalog stays OUT until its handler exists — D4)
    ['GET', '/', 'public'],
    ['GET', '/index.html', 'public'],
    ['GET', '/api/auth/status', 'public'],
    // observe — curated read projections a wall display or consumer may hold
    ['GET', '/api/state', 'observe'],
    ['GET', '/api/workspace', 'observe'],
    ['GET', '/api/workspaces', 'observe'],
    ['GET', '/api/board', 'observe'],
    ['GET', '/api/activity', 'observe'],
    ['GET', '/api/presets', 'observe'],
    ['GET', '/api/git', 'observe'],
    ['GET', '/api/teams', 'observe'],
    ['GET', '/api/roles', 'observe'],
    ['GET', '/api/team/clip', 'observe'],
    ['GET', '/api/agents', 'observe'],
    ['GET', '/api/events', 'observe'],
    ['GET', '/api/events/query', 'observe'],
    ['GET', '/api/terminal/t-1/turns', 'observe'],
    ['GET', '/api/terminal/t-1/trace', 'observe'],
    ['GET', '/api/terminal/t-1/trace/index', 'observe'],
    ['GET', '/api/terminal/t-1/trace/markers', 'observe'],
    ['GET', '/api/browser/capabilities', 'observe'],
    ['GET', '/api/browser/b-1/thumb', 'observe'],
    // dispatch — prompt an agent / follow a dispatch (bindings live here)
    ['POST', '/api/terminal/t-1/ask', 'dispatch'],
    ['POST', '/api/agents/a-1/dispatch', 'dispatch'],
    ['GET', '/api/dispatches/d-1', 'dispatch'],
    // terminal-io — the raw byte surface, structurally local (Sol F6)
    ['POST', '/api/terminal/t-1/input', 'terminal-io'],
    ['POST', '/api/terminal/t-1/raw', 'terminal-io'],
    ['POST', '/api/terminal/t-1/resize', 'terminal-io'],
    ['POST', '/api/terminal/t-1/jump', 'terminal-io'],
    ['GET', '/api/terminal/t-1/stream', 'terminal-io'],
    ['GET', '/api/terminal/t-1/output', 'terminal-io'],
    ['GET', '/api/browser/b-1/stream', 'terminal-io'],
    // orchestrate — every workspace/board/team/role mutation
    ['POST', '/api/workspaces', 'orchestrate'],
    ['POST', '/api/workspaces/switch', 'orchestrate'],
    ['POST', '/api/workspaces/rename', 'orchestrate'],
    ['DELETE', '/api/workspaces/ws-1', 'orchestrate'],
    ['POST', '/api/workspaces/ws-1/service', 'orchestrate'],
    ['POST', '/api/workspaces/ws-1/dirs', 'orchestrate'],
    ['DELETE', '/api/workspaces/ws-1/dirs', 'orchestrate'],
    ['POST', '/api/workspaces/ws-1/primary', 'orchestrate'],
    ['POST', '/api/nodes', 'orchestrate'],
    ['POST', '/api/nodes/n-1', 'orchestrate'],
    ['DELETE', '/api/nodes/n-1', 'orchestrate'],
    ['POST', '/api/connections', 'orchestrate'],
    ['DELETE', '/api/connections/c-1', 'orchestrate'],
    ['POST', '/api/terminals', 'orchestrate'],
    ['POST', '/api/team/fork', 'orchestrate'],
    ['POST', '/api/team/save', 'orchestrate'],
    ['POST', '/api/team/clip', 'orchestrate'],
    ['POST', '/api/team/paste', 'orchestrate'],
    ['POST', '/api/role/save', 'orchestrate'],
    ['POST', '/api/role/delete', 'orchestrate'],
    ['POST', '/api/attachments', 'orchestrate'],
    ['POST', '/api/terminal/t-1/cwd', 'orchestrate'],
    ['POST', '/api/terminal/t-1/seen', 'orchestrate'],
    ['POST', '/api/terminal/t-1/fork', 'orchestrate'],
    ['POST', '/api/agents/a-1/restore', 'orchestrate'],
    ['POST', '/api/agents/a-1/restore/undo', 'orchestrate'],
    ['POST', '/api/agents/a-1/recover', 'orchestrate'],
    ['POST', '/api/say', 'orchestrate'],
    ['POST', '/api/instances', 'orchestrate']
  ]

  for (const [method, path, group] of PINNED) {
    it(`${method} ${path} → ${group}`, () => {
      expect(classifyRoute(method, path)).toBe(group)
    })
  }

  it('every manifest entry is pinned above (the table is exhaustive, not sampled)', () => {
    expect(PINNED.length).toBe(ROUTE_MANIFEST.length)
  })
})
