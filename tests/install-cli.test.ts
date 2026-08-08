import { describe, expect, it } from 'vitest'
import { launcherScript, pickBinDir } from '../scripts/install-cli.mjs'

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

describe('pickBinDir', () => {
  it('prefers a user-owned dir over one needing sudo', () => {
    const dirs = ['/home/u/.local/bin', '/usr/local/bin']
    expect(pickBinDir(dirs, (d) => d.startsWith('/home'))).toBe('/home/u/.local/bin')
  })

  it('falls through to the system dir when it is genuinely writable', () => {
    expect(pickBinDir(['/home/u/.local/bin', '/usr/local/bin'], (d) => d === '/usr/local/bin')).toBe(
      '/usr/local/bin'
    )
  })

  it('is null rather than guessing when nothing is writable', () => {
    // Guessing would install a launcher the user cannot run and report success.
    expect(pickBinDir(['/a', '/b'], () => false)).toBeNull()
  })
})
