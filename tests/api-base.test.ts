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
import { describe, expect, it } from 'vitest'
import { API_BASE, apiPath, clientSlug } from '../src/renderer/src/api-base'

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'src')

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

describe('conformance — no unwrapped root-absolute /api in the renderer', () => {
  it('every /api literal goes through apiPath', () => {
    const violations: string[] = []
    for (const file of sourceFiles(RENDERER)) {
      if (file.endsWith('api-base.ts')) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      code.split('\n').forEach((line, index) => {
        // A root-absolute /api literal in any quoting style...
        const literal = /['"`]\/api\//.exec(line)
        if (!literal) return
        // ...is a violation unless apiPath opens it on the same line.
        if (/apiPath\(\s*['"`]\/api\//.test(line)) return
        violations.push(`${path.relative(RENDERER, file)}:${index + 1}: ${line.trim()}`)
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
})
