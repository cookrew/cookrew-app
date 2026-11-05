import { afterEach, describe, expect, it, vi } from 'vitest'
import { failureReason, failureHtml, bootStep } from '../src/main/boot-failure'
import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ownerOf, runtimeDirFor } from '../src/main/runtime-dir'
import { launchBlock } from '../src/main/launch-check'
import { addPaneDirs, panePath, resetPaneDirs } from '../src/main/pane-path'

/**
 * A SECOND LINUX USER GOT A BLACK SCREEN (round 2, bug 13): /tmp/cookrew-runtime
 * belonged to the first. macOS's tmp is per user already, so its path stays, and
 * so does a Linux path this user already owns: live panes have it baked in.
 */

describe('the runtime dir', () => {
  const on = (over: Partial<Parameters<typeof runtimeDirFor>[0]> = {}) => runtimeDirFor({ tmp: '/tmp', platform: 'linux', uid: 1001, ownerOf: () => null, ...over })

  it('is per user on Linux', () => {
    expect(on()).toBe('/tmp/cookrew-runtime-1001')
  })

  it('steps round a dir another user holds', () => {
    expect(on({ ownerOf: (dir) => (dir === '/tmp/cookrew-runtime' ? 1000 : null) })).toBe('/tmp/cookrew-runtime-1001')
  })

  it('keeps the old path for the user who owns it: their panes have it baked in', () => {
    expect(on({ ownerOf: (dir) => (dir === '/tmp/cookrew-runtime' ? 1001 : null) })).toBe('/tmp/cookrew-runtime')
  })

  it('never takes a per-user path someone else planted in a shared tmp', () => {
    expect(() => on({ ownerOf: (dir) => (dir === '/tmp/cookrew-runtime-1001' ? 1000 : null) })).toThrow(/belongs to another user/)
  })

  it('stays as it is on macOS, where tmp is the user’s own', () => {
    expect(on({ platform: 'darwin', tmp: '/var/folders/x/T' })).toBe('/var/folders/x/T/cookrew-runtime')
  })
})

// A plain shell with no pointer file yet: the CLI's last guess must be the dir the
// app made for this user, or the second person is sent to the first one's.
describe('the CLI, guessing the socket', () => {
  const uid = process.getuid?.() ?? 0
  const guessFrom = async (dir: string): Promise<boolean> => {
    // Short: a unix socket path has a low limit.
    const tmp = mkdtempSync('/tmp/crs-')
    mkdirSync(path.join(tmp, dir))
    const server = net.createServer((socket) => socket.destroy())
    let reached = false
    server.on('connection', () => (reached = true))
    await new Promise<void>((resolve) => server.listen(path.join(tmp, dir, 'cookrew.sock'), resolve))
    const cli = spawn(process.execPath, [path.join(__dirname, '../cli/cookrew.mjs'), 'list', '--all'], { env: { PATH: '/usr/bin:/bin', HOME: tmp, TMPDIR: tmp }, stdio: 'ignore' })
    await new Promise((resolve) => cli.on('close', resolve))
    server.close()
    rmSync(tmp, { recursive: true, force: true })
    return reached
  }

  it('tries the per-user dir', async () => {
    expect(await guessFrom(`cookrew-runtime-${uid}`)).toBe(true)
  })

  it('keeps the shared name where that is the dir there is', async () => {
    expect(await guessFrom('cookrew-runtime')).toBe(true)
  })
})

describe('who owns a path', () => {
  it('reads a symlink as itself: a planted link must not borrow the owner of its target', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-owner-'))
    const link = path.join(root, 'link')
    symlinkSync('/', link)
    expect(ownerOf(link)).toBe(lstatSync(link).uid)
    expect(ownerOf(path.join(root, 'absent'))).toBeNull()
    expect(readFileSync(path.join(__dirname, '../src/main/runtime-dir.ts'), 'utf8')).toContain('lstatSync')
  })
})

describe('a launch that cannot go on', () => {
  it('says what happened in plain words', () => {
    const error = Object.assign(new Error("EACCES: permission denied, mkdir '/tmp/x'"), { code: 'EACCES', path: '/tmp/x' })
    expect(failureReason(error)).toMatch(/does not have permission to use \/tmp\/x/)
    expect(failureReason(new Error('boom'))).toContain('boom')
  })

  it('escapes what it shows', () => {
    expect(failureHtml(new Error('<img src=x onerror=alert(1)>'))).not.toContain('<img')
  })

  it('paints the reason once the app can, and still fails', async () => {
    const paint = vi.fn()
    expect(() => bootStep(() => { throw new Error('no') }, paint)).toThrow('no')
    expect(paint).toHaveBeenCalledTimes(1)
    expect(bootStep(() => 3, paint)).toBe(3)
  })
})

// agentToolReady was a second copy of Agent Truth's check: launchBlock answers now,
// over the PATH panes get.
describe('a tool for an agent to run', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-tool-'))
  const check = { cwd: dir, checkCommand: true, installLine: () => null }

  afterEach(() => resetPaneDirs())

  it('is refused where a pane would not find it, in the card’s own words', () => {
    expect(launchBlock({ ...check, command: 'first-run-no-such-tool --flag', path: panePath('/nowhere') })).toMatchObject({ kind: 'command-missing', why: 'Command not found: first-run-no-such-tool.' })
  })

  it('is found in a dir the tool check learned', () => {
    writeFileSync(path.join(dir, 'first-run-a-tool'), '#!/bin/sh\n', { mode: 0o755 })
    addPaneDirs([dir])
    expect(launchBlock({ ...check, command: 'first-run-a-tool --flag', path: panePath('/nowhere') })).toBeNull()
  })

  it('has nothing to look for in a shell', () => {
    expect(launchBlock({ ...check, command: '', path: '/nowhere' })).toBeNull()
  })
})
