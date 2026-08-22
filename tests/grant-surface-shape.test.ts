// THE WIRE CARRIES THE CEREMONY AND THE CALL, NEVER THE GRANT.
//
// The grant surface is strictly MORE powerful than the gate it feeds: anyone
// who can reach it enrols themselves and exports every agent in the workspace,
// which makes every refusal downstream decorative. So the rule is not "we do
// not currently mount it" — it is that mounting it must FAIL THE BUILD.
//
// A comment saying a route must never appear does not fail when one appears.
// This sweep does. It reads the listener-reachable sources and refuses any
// reference to a grant mutator, the same shape as the absence-collapse proof
// and the /api conformance sweep.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(__dirname, '..')
const MAIN = path.join(ROOT, 'src', 'main')

/**
 * Modules that answer requests arriving from OUTSIDE this process — the mobile
 * listener, its API layer, the route splitter, and the registry service. If a
 * grant mutator is reachable from any of these, it is on the wire.
 */
const LISTENER_SOURCES = [
  path.join(MAIN, 'mobile-server.ts'),
  path.join(MAIN, 'mobile-api.ts'),
  path.join(MAIN, 'mobile-slug-route.ts'),
  path.join(MAIN, 'mobile-endpoints.ts'),
  path.join(MAIN, 'mobile-http.ts'),
  path.join(MAIN, 'socket-server.ts'),
  path.join(ROOT, 'registry', 'src')
]

/** The operations that decide who reaches the internet. */
const GRANT_MUTATORS = ['enrol', 'revoke', 'exportAgent', 'unexport']

function sourceFiles(target: string): string[] {
  if (!existsSync(target)) return []
  if (!statSync(target).isDirectory()) return [target]
  return readdirSync(target).flatMap((entry) => sourceFiles(path.join(target, entry)))
    .filter((f) => /\.tsx?$/.test(f))
}

/** Comments may DISCUSS the rule; only code may not call it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('no listener reaches a grant mutator', () => {
  it('no listener-reachable source calls enrol, revoke, exportAgent or unexport', () => {
    const violations: string[] = []
    for (const target of LISTENER_SOURCES) {
      for (const file of sourceFiles(target)) {
        const code = stripComments(readFileSync(file, 'utf8'))
        code.split('\n').forEach((line, index) => {
          for (const op of GRANT_MUTATORS) {
            // A CALL — `.enrol(`, `enrol(` — not the word in prose or a type.
            if (new RegExp(`\\b${op}\\s*\\(`).test(line)) {
              violations.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`)
            }
          }
        })
      }
    }
    expect(violations).toEqual([])
  })

  it('the sweep can actually see a violation', () => {
    // A conformance test that cannot fail is decoration — the same standard
    // the /api sweep had to meet after it was found blind to streamUrl.
    const offending = `  const r = deps.exports.exportAgent(grant)`
    const seen = GRANT_MUTATORS.some((op) => new RegExp(`\\b${op}\\s*\\(`).test(offending))
    expect(seen).toBe(true)
  })

  it('does not fire on prose or on a type reference', () => {
    // Over-firing would make the sweep something people turn off.
    const prose = `  // anyone who can call it can enrol themselves`
    const type = `  exports: AgentExport[]`
    for (const line of [stripComments(prose), type]) {
      const seen = GRANT_MUTATORS.some((op) => new RegExp(`\\b${op}\\s*\\(`).test(line))
      expect(seen).toBe(false)
    }
  })

  it('covers the listener sources it claims to cover', () => {
    // A sweep pointed at files that do not exist passes vacuously, which reads
    // as proof and is not. Every named source must be real.
    for (const target of LISTENER_SOURCES) {
      expect(existsSync(target), `missing listener source: ${target}`).toBe(true)
    }
    expect(LISTENER_SOURCES.flatMap(sourceFiles).length).toBeGreaterThan(5)
  })
})

describe('the grant IPC channels exist nowhere a request can reach', () => {
  it('no listener source mentions a grant channel name', () => {
    // The channel names are the other way in: a bridge that forwarded an HTTP
    // body to ipcMain would mount the grant without ever naming the mutator.
    const channels = ['grant:enrol', 'grant:revoke', 'grant:export', 'grant:unexport']
    const violations: string[] = []
    for (const target of LISTENER_SOURCES) {
      for (const file of sourceFiles(target)) {
        const code = stripComments(readFileSync(file, 'utf8'))
        for (const channel of channels) {
          if (code.includes(channel)) violations.push(`${path.relative(ROOT, file)}: ${channel}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
