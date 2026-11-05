import { afterEach, describe, expect, it, vi } from 'vitest'
import { failureReason, failureHtml, bootStep } from '../src/main/boot-failure'
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
