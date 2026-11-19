// WHICH REMEMBERED PASSWORDS THIS MAC STILL TAKES (main/unlock-remembered.ts). A phone keeps a box only this Mac
// can open; the Mac keeps, per box, an id it can take back. Never the password.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expectMode } from './support/file-mode'
import { admissionEpoch, createRememberedUnlocks, REMEMBERED_MAX, REMEMBERED_PER_WHO } from '../src/main/unlock-remembered'

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

  it('an id is bound to the device\'s admission: forgotten and admitted again, its old ids are dead even if their drop failed', () => {
    let rows = [{ deviceId: 'p1', admittedAt: 100 }]
    const held = createRememberedUnlocks(fileIn(), { currentCode: () => CODE, epochOf: admissionEpoch(() => rows) })
    const id = held.issue('device:p1')
    const root = held.issue('root')
    expect(held.live(id, 'device:p1')).toBe(true)
    // Forgotten (its drop failed, so the id is still in the file): not admitted, not live.
    rows = []
    expect(held.live(id, 'device:p1')).toBe(false)
    // Admitted again: a new admission, and the old id stays dead.
    rows = [{ deviceId: 'p1', admittedAt: 900 }]
    expect(held.live(id, 'device:p1')).toBe(false)
    expect(held.live(held.issue('device:p1'), 'device:p1')).toBe(true)
    // The global token has no admission: its ids go with the code (rotation).
    expect(held.live(root, 'root')).toBe(true)
  })

  it('admissionEpoch: a device\'s admission time, "" for the global token, null for anything not admitted', () => {
    const epoch = admissionEpoch(() => [{ deviceId: 'p1', admittedAt: 100 }])
    expect(epoch('device:p1')).toBe('100')
    expect(epoch('device:p2')).toBeNull()
    expect(epoch('root')).toBe('')
    expect(epoch('something-else')).toBeNull()
  })

  it('a write that fails changes nothing: what is held stays what the file says', () => {
    const file = fileIn()
    let failing = false
    const held = createRememberedUnlocks(file, { currentCode: () => CODE, writeFile: (target, text) => {
      if (failing) throw new Error('disk full')
      writeFileSync(target, text)
    } })
    const id = held.issue('device:p1')
    failing = true
    expect(() => held.forgetWho('device:p1')).toThrow(/disk full/)
    expect(held.live(id, 'device:p1')).toBe(true)
    expect(createRememberedUnlocks(file, { currentCode: () => CODE }).live(id, 'device:p1')).toBe(true)
    failing = false
    held.forgetWho('device:p1')
    expect(held.live(id, 'device:p1')).toBe(false)
  })

  it('one device\'s ids never push another\'s out: past its own cap, only its own oldest goes', () => {
    let at = 1
    const held = createRememberedUnlocks(fileIn(), { currentCode: () => CODE, now: () => at++ })
    const others = held.issue('device:p2')
    const mine = Array.from({ length: REMEMBERED_PER_WHO + 1 }, () => held.issue('root'))
    expect(held.live(mine[0], 'root')).toBe(false)
    expect(mine.slice(1).every((id) => held.live(id, 'root'))).toBe(true)
    expect(held.live(others, 'device:p2')).toBe(true)
  })

  it('a file it cannot read takes no box (fail closed), and the oldest id goes past the cap', () => {
    const file = fileIn()
    writeFileSync(file, '{ not json')
    const broken = createRememberedUnlocks(file, { currentCode: () => CODE })
    expect(broken.live('anything', 'root')).toBe(false)
    let at = 1
    const held = createRememberedUnlocks(fileIn(), { currentCode: () => CODE, now: () => at++ })
    const first = held.issue('device:0')
    const rest = Array.from({ length: REMEMBERED_MAX }, (_, n) => [`device:${n + 1}`, held.issue(`device:${n + 1}`)] as const)
    expect(held.live(first, 'device:0')).toBe(false)
    expect(rest.every(([who, r]) => held.live(r, who))).toBe(true)
  })
})
