import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runtimeDirFor } from '../src/main/runtime-dir'
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
const RUNTIME = '/var/folders/xx/T/cookrew-runtime'
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
    expect(script.indexOf('exec "$NODE" "$REPO"')).toBeGreaterThan(-1)
    expect(script.indexOf('exec "$NODE" "$REPO"')).toBeLessThan(script.indexOf('exec "$NODE" "$RUNTIME/cookrew.mjs"'))
  })

  it('is POSIX sh, not the user\'s shell', () => {
    expect(script.startsWith('#!/bin/sh')).toBe(true)
  })

  it('tells the user how to recover when nothing resolves', () => {
    expect(script).toContain('npm run install-cli')
  })
})

/**
 * WHICH COPY, on a machine with two people on it. /tmp is shared on Linux, so the
 * app keeps a dir per user (src/main/runtime-dir.ts), and a path baked at install
 * would name the first person's: EACCES for the second, and running a script
 * another user wrote if the dir were open. Run for real, with a stand-in node.
 */
describe('the runtime copy a launcher runs', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })
  const uid = process.getuid?.() ?? 0

  const box = () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cookrew-launcher-'))
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
    const node = path.join(tmp, 'node')
    writeFileSync(node, '#!/bin/sh\necho "$1"\n')
    chmodSync(node, 0o755)
    const launcher = path.join(tmp, 'cookrew')
    writeFileSync(launcher, launcherScript(path.join(tmp, 'cookrew-runtime'), path.join(tmp, 'no-repo.mjs'), node, path.join(tmp, 'no-pointer')))
    chmodSync(launcher, 0o755)
    const copyIn = (dir: string): string => {
      const at = path.join(tmp, dir)
      mkdirSync(at)
      writeFileSync(path.join(at, 'cookrew.mjs'), '')
      return path.join(at, 'cookrew.mjs')
    }
    const run = () => spawnSync('/bin/sh', [launcher], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmp } })
    return { tmp, copyIn, run }
  }

  it('finds the per-user dir the app really makes', () => {
    const { tmp, copyIn, run } = box()
    const made = runtimeDirFor({ tmp, platform: 'linux', uid, ownerOf: () => null })
    const copy = copyIn(path.basename(made))
    expect(run().stdout.trim()).toBe(copy)
  })

  it('prefers it over the shared name', () => {
    const { copyIn, run } = box()
    copyIn('cookrew-runtime')
    const own = copyIn(`cookrew-runtime-${uid}`)
    expect(run().stdout.trim()).toBe(own)
  })

  it('keeps the shared name for the person who owns it, and every Mac', () => {
    const { copyIn, run } = box()
    expect(run().status).toBe(1)
    const shared = copyIn('cookrew-runtime')
    expect(run().stdout.trim()).toBe(shared)
  })

  // A dir planted ahead of time can swap a link after the check: the dir must be
  // the caller's own too, and really a dir.
  it('never runs a copy through a dir that is only a link', () => {
    const { tmp, copyIn, run } = box()
    const elsewhere = copyIn('elsewhere')
    symlinkSync(path.dirname(elsewhere), path.join(tmp, `cookrew-runtime-${uid}`))
    const done = run()
    expect(done.stdout).toBe('')
    expect(done.status).toBe(1)
  })

  it('never runs a copy that is somebody else’s', () => {
    const { tmp, run } = box()
    mkdirSync(path.join(tmp, 'cookrew-runtime'))
    // Root's file, as near as a test gets to another user's.
    symlinkSync('/etc/hosts', path.join(tmp, 'cookrew-runtime', 'cookrew.mjs'))
    const done = run()
    expect(done.stdout).toBe('')
    expect(done.stderr).toContain('CLI not found')
    expect(done.status).toBe(1)
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
