// WHICH REMEMBERED PASSWORDS THIS MAC STILL TAKES (main/unlock-remembered.ts). A phone keeps a box only this Mac
// can open; the Mac keeps, per box, an id it can take back. Never the password.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expectMode } from './support/file-mode'
import { createRememberedUnlocks, REMEMBERED_MAX } from '../src/main/unlock-remembered'

const dirs: string[] = []
const fileIn = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'unlock-remembered-'))
  dirs.push(dir)
  return path.join(dir, 'unlock-remembered.json')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CODE = 'code-id-1'

describe('remembered unlocks on the Mac', () => {
  it('issues an id for one device under one code, takes it from that device and code only, and keeps no password', () => {
    const file = fileIn()
    let code = CODE
    const held = createRememberedUnlocks(file, { currentCode: () => code })
    const r = held.issue('device:p1')
    expect(r).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(held.live(r, 'device:p1')).toBe(true)
    expect(held.live(r, 'device:p2')).toBe(false)
    expect(held.live('not-issued', 'device:p1')).toBe(false)
    // Read again from the file: it outlives a restart.
    expect(createRememberedUnlocks(file, { currentCode: () => code }).live(r, 'device:p1')).toBe(true)
    expectMode(file, 0o600)
    expect(readFileSync(file, 'utf8')).not.toMatch(/password|"p"/)
    // Another code is in force (a rotation whose clear did not happen): the id is not taken.
    code = 'code-id-2'
    expect(held.live(r, 'device:p1')).toBe(false)
  })

  it('drops one id (only for the device it was issued to), every id of a device, or all of them', () => {
    const held = createRememberedUnlocks(fileIn(), { currentCode: () => CODE })
    const [a, b, c] = [held.issue('device:p1'), held.issue('device:p1'), held.issue('root')]
    expect(held.drop(a, 'device:p2')).toBe(false)
    expect(held.live(a, 'device:p1')).toBe(true)
    expect(held.drop(a, 'device:p1')).toBe(true)
    expect(held.live(a, 'device:p1')).toBe(false)
    held.forgetWho('device:p1')
    expect(held.live(b, 'device:p1')).toBe(false)
    expect(held.live(c, 'root')).toBe(true)
    held.clear()
    expect(held.live(c, 'root')).toBe(false)
  })

  it('a file it cannot read takes no box (fail closed), and the oldest id goes past the cap', () => {
    const file = fileIn()
    writeFileSync(file, '{ not json')
    const broken = createRememberedUnlocks(file, { currentCode: () => CODE })
    expect(broken.live('anything', 'root')).toBe(false)
    let at = 1
    const held = createRememberedUnlocks(fileIn(), { currentCode: () => CODE, now: () => at++ })
    const first = held.issue('root')
    const rest = Array.from({ length: REMEMBERED_MAX }, () => held.issue('root'))
    expect(held.live(first, 'root')).toBe(false)
    expect(rest.every((r) => held.live(r, 'root'))).toBe(true)
  })
})
