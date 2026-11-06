// THE SWITCH THAT OUTLIVES A RESTART. An agent running as this user can write any
// file, so a file alone must never turn it on: only what the app's own key sealed.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ownerSecretPaths } from '../src/main/owner-secrets'
import { sealedSwitchMemory } from '../src/main/remote-switch-memory'

let dir = ''
let file = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'remote-switch-'))
  file = path.join(dir, 'nested', 'remote-switch')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Sealing as a keyed reverse: what a file writer cannot do without the key. */
const sealer = (key = 'k', available = true) => ({
  available: () => available,
  seal: (value: string) => Buffer.from(`${key}:${[...value].reverse().join('')}`),
  open: (box: Buffer) => {
    const text = box.toString()
    if (!text.startsWith(`${key}:`)) throw new Error('wrong key')
    return [...text.slice(key.length + 1)].reverse().join('')
  }
})

describe('sealedSwitchMemory', () => {
  it('remembers on, in a file only its owner can read', () => {
    const memory = sealedSwitchMemory(file, sealer())
    expect(memory.read()).toBe(false)
    memory.write(true)
    expect(memory.read()).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('off leaves nothing behind', () => {
    const memory = sealedSwitchMemory(file, sealer())
    memory.write(true)
    memory.write(false)
    expect(memory.read()).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  it('off is fine when it was never on', () => {
    expect(() => sealedSwitchMemory(file, sealer()).write(false)).not.toThrow()
  })

  it('a file written by anything else reads as off', () => {
    const memory = sealedSwitchMemory(file, sealer())
    memory.write(true)
    for (const forged of ['on', 'true', '1', '{"on":true}', Buffer.from('on').toString('base64')]) {
      writeFileSync(file, forged)
      expect(memory.read()).toBe(false)
    }
  })

  it('what another key sealed reads as off: a dev run and the packaged app do not share it', () => {
    sealedSwitchMemory(file, sealer('dev')).write(true)
    expect(sealedSwitchMemory(file, sealer('app')).read()).toBe(false)
  })

  it('a sealed value that is not ours reads as off', () => {
    const key = sealer()
    sealedSwitchMemory(file, key).write(true)
    writeFileSync(file, key.seal('something else').toString('base64'))
    expect(sealedSwitchMemory(file, key).read()).toBe(false)
  })

  it('with no key to seal under, it says so rather than writing it in the clear', () => {
    const memory = sealedSwitchMemory(file, sealer('k', false))
    expect(() => memory.write(true)).toThrow()
    expect(existsSync(file)).toBe(false)
    expect(memory.read()).toBe(false)
  })

  it('holds no readable word on disk', () => {
    sealedSwitchMemory(file, sealer()).write(true)
    expect(readFileSync(file, 'utf8')).not.toContain('remote-switch')
  })

  it('a served seat cannot read or copy it', () => {
    const denied = ownerSecretPaths('/Users/me/.cookrew', '/Users/me', 'cookrew', {})
    expect(denied).toContain('/Users/me/.cookrew/remote-switch')
    expect(denied).toContain('/Users/me/.cookrew/remote-switch.tmp')
  })
})
