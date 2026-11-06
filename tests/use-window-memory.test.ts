// WHICH WINDOW A CARD HOLDS, ACROSS A RESTART (main/use-window-memory.ts).
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ownerSecretPaths } from '../src/main/owner-secrets'
import { fileWindowMemory, forgetCardWindow } from '../src/main/use-window-memory'

let dir = ''
let file = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'use-windows-'))
  file = path.join(dir, 'nested', 'use-windows.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const memo = { from: 7, id: 9, title: 'Weixin', pid: 200, alone: true }

describe('fileWindowMemory', () => {
  it('keeps one window per card, for its owner alone', () => {
    fileWindowMemory(file, 'a').write(memo)
    fileWindowMemory(file, 'b').write({ ...memo, id: 10 })
    expect(fileWindowMemory(file, 'a').read()).toEqual(memo)
    expect(fileWindowMemory(file, 'b').read()?.id).toBe(10)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('a card that goes takes its title with it', () => {
    fileWindowMemory(file, 'a').write(memo)
    fileWindowMemory(file, 'b').write(memo)
    forgetCardWindow(file, 'a')
    expect(fileWindowMemory(file, 'a').read()).toBeNull()
    expect(fileWindowMemory(file, 'b').read()).toEqual(memo)
    expect(() => forgetCardWindow(path.join(dir, 'none.json'), 'a')).not.toThrow()
  })

  it('remembers nothing for a card it never met', () => {
    expect(fileWindowMemory(file, 'a').read()).toBeNull()
  })

  it('a damaged file or entry is nothing remembered, and does not stop the next write', () => {
    fileWindowMemory(file, 'a').write(memo)
    writeFileSync(file, '{ not json')
    expect(fileWindowMemory(file, 'a').read()).toBeNull()
    writeFileSync(file, JSON.stringify({ a: { id: 'x' } }))
    expect(fileWindowMemory(file, 'a').read()).toBeNull()
    fileWindowMemory(file, 'b').write(memo)
    expect(JSON.parse(readFileSync(file, 'utf8')).b).toEqual(memo)
  })

  it('a write it cannot make is not the card\'s problem', () => {
    const blocked = path.join(dir, 'a-file')
    writeFileSync(blocked, '')
    expect(() => fileWindowMemory(path.join(blocked, 'x.json'), 'a').write(memo)).not.toThrow()
  })

  it('a served seat cannot read which windows the owner has', () => {
    const denied = ownerSecretPaths('/Users/me/.cookrew', '/Users/me', 'cookrew', {})
    expect(denied).toContain('/Users/me/.cookrew/use-windows.json')
    expect(denied).toContain('/Users/me/.cookrew/use-windows.json.tmp')
  })
})
