import { describe, expect, it } from 'vitest'
// @ts-expect-error the installer lib ships no types; the test exercises runtime behaviour.
// install-cli-LIB, not install-cli: the executable carries a shebang, and
// vite-node on Windows inlines project .mjs imports — the unstripped `#!`
// killed the whole suite there with "Invalid or unexpected token".
import { launcherScript, pickBinDir, stableNodePath } from '../scripts/install-cli-lib.mjs'

/**
 * `cookrew` on the system PATH. Every assertion here is a failure that was
 * actually observed while installing it — the launcher runs in the shells least
 * likely to resemble a developer's.
 */

const NODE = '/opt/homebrew/Cellar/node/25.9.0_1/bin/node'
const RUNTIME = '/var/folders/xx/T/cookrew-runtime/cookrew.mjs'
const REPO = '/Users/x/workspace/cookrew-dev/cli/cookrew.mjs'

describe('launcherScript', () => {
  const script = launcherScript(RUNTIME, REPO, NODE)

  it('bakes an ABSOLUTE node path rather than trusting PATH', () => {
    // Measured: `exec: node: not found` from a minimal PATH. The shells that
    // reach for this CLI — GUI terminals, cron, `env -i` — are exactly the
    // ones without node on PATH.
    expect(script).toContain(`NODE="${NODE}"`)
  })

  it('still falls back to PATH if the baked interpreter is gone', () => {
    // A node upgrade moves the Cellar path; the launcher must not become a
    // brick.
    expect(script).toContain('command -v node')
  })

  it('prefers the REPO copy, because the app rewrites the runtime one', () => {
    // Measured: preferring runtime meant edits to cli/cookrew.mjs did not take
    // effect until the app restarted, and a stale runtime copy answered with
    // pre-edit behaviour. A packaged install has no repo path, so runtime wins
    // there by absence rather than by precedence.
    expect(script.indexOf('$REPO"')).toBeLessThan(script.indexOf('$RUNTIME"'))
  })

  it('is POSIX sh, not the user\'s shell', () => {
    expect(script.startsWith('#!/bin/sh')).toBe(true)
  })

  it('tells the user how to recover when nothing resolves', () => {
    expect(script).toContain('npm run install-cli')
  })
})

describe('stableNodePath', () => {
  it('bakes Homebrew\'s opt link, not the versioned keg — 2026-10-30, llhttp 9.4 broke node 25.9.0_1', () => {
    // The old keg stayed on disk and passed `-x`, so the PATH fallback never
    // ran and every call died in dyld.
    expect(stableNodePath(NODE, () => true)).toBe('/opt/homebrew/opt/node/bin/node')
  })

  it('keeps the keg when there is no opt link', () => {
    expect(stableNodePath(NODE, () => false)).toBe(NODE)
  })

  it('leaves any other install alone', () => {
    expect(stableNodePath('/Users/x/.nvm/versions/node/v22.1.0/bin/node', () => true)).toBe(
      '/Users/x/.nvm/versions/node/v22.1.0/bin/node'
    )
  })
})

describe('pickBinDir', () => {
  it('prefers a user-owned dir over one needing sudo', () => {
    const dirs = ['/home/u/.local/bin', '/usr/local/bin']
    expect(pickBinDir(dirs, (d: string) => d.startsWith('/home'))).toBe('/home/u/.local/bin')
  })

  it('falls through to the system dir when it is genuinely writable', () => {
    expect(pickBinDir(['/home/u/.local/bin', '/usr/local/bin'], (d: string) => d === '/usr/local/bin')).toBe(
      '/usr/local/bin'
    )
  })

  it('is null rather than guessing when nothing is writable', () => {
    // Guessing would install a launcher the user cannot run and report success.
    expect(pickBinDir(['/a', '/b'], () => false)).toBeNull()
  })
})
