// Cookrew adds one key to a file Claude Code owns, and must leave the rest as it
// found it: a symlinked settings file stays a link, and a Claude that saved its
// own state between our read and our rename does not lose it.
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CachedConfig, updateConfigObject } from '../src/main/claude-config-file'

const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'claude-config-file-'))

describe('updateConfigObject', () => {
  it('writes through a symlink to its target and keeps the link', () => {
    const dir = scratch()
    const real = path.join(dir, 'dotfiles-settings.json')
    const link = path.join(dir, 'settings.json')
    writeFileSync(real, '{"theme":"light"}')
    symlinkSync(real, link)
    expect(updateConfigObject(link, (c) => ({ ...c, added: true }))).toBe('written')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ theme: 'light', added: true })
  })

  it("starts over from the file when someone wrote it mid-update, keeping both changes", () => {
    const file = path.join(scratch(), '.claude.json')
    writeFileSync(file, '{"numStartups":1}')
    let calls = 0
    const outcome = updateConfigObject(file, (c) => {
      calls += 1
      // The first time round, a live Claude saves its own state under us.
      if (calls === 1) writeFileSync(file, '{"numStartups":2,"tipsHistory":{"a":1}}')
      return { ...c, hasCompletedOnboarding: true }
    })
    expect(outcome).toBe('written')
    expect(calls).toBe(2)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ numStartups: 2, tipsHistory: { a: 1 }, hasCompletedOnboarding: true })
  })

  it('says unchanged, and writes nothing, when there is nothing to do', () => {
    const file = path.join(scratch(), 'x.json')
    writeFileSync(file, '{"a":1}')
    expect(updateConfigObject(file, () => null)).toBe('unchanged')
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}')
  })
})

describe('CachedConfig', () => {
  it('reads again only when the file changed', () => {
    const file = path.join(scratch(), 'x.json')
    writeFileSync(file, '{"a":1}')
    const cache = new CachedConfig()
    const first = cache.read(file)
    expect(cache.read(file)).toBe(first)
    writeFileSync(file, '{"a":22}')
    const second = cache.read(file)
    expect(second.state === 'ok' && second.value.a).toBe(22)
  })
})
