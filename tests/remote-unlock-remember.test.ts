// REMEMBER ON THE CONSOLE, THE MAC'S SIDE (main/remote-unlock.ts + unlock-remembered.ts). The page keeps a box
// sealed to this Mac's unlock key holding the password and an id the Mac issued; the Mac takes a box only inside
// a cookrew-seal/2 session, and only while it still holds that id for that device.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUnlockDoor, FORGET_FAILED, type UnlockDoorDeps } from '../src/main/remote-unlock'
import { createRememberedUnlocks } from '../src/main/unlock-remembered'
import { generateSealKeyPair, packBody } from '../src/shared/relay-seal'
import { REMEMBER_INFO, UNLOCK_INFO } from '../src/shared/remote-unlock'
import type { ViewerWho } from '../src/shared/remote-access'

const phone: ViewerWho = { key: 'device:p1', name: 'Phone', here: false }
const other: ViewerWho = { key: 'device:p2', name: 'Tablet', here: false }
const PASSWORD = 'correct horse'
const V2 = { sealedV2: true }
const V1 = { sealedV2: false }

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function bed(over: Partial<UnlockDoorDeps> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'unlock-remember-'))
  dirs.push(dir)
  const pair = generateSealKeyPair()
  const mac = { locked: true, password: PASSWORD }
  const typed: string[] = []
  const remembered = createRememberedUnlocks(path.join(dir, 'unlock-remembered.json'), { currentCode: () => 'code-1' })
  const door = createUnlockDoor({
    keyPair: () => pair,
    refusal: () => null,
    locked: async () => mac.locked,
    wake: async () => undefined,
    type: async (password) => {
      typed.push(password)
      if (password === mac.password) mac.locked = false
    },
    record: vi.fn(),
    sleep: async () => undefined,
    remembered,
    ...over
  })
  const outer = (body: Record<string, unknown>): string => packBody(pair.publicKey, UNLOCK_INFO, JSON.stringify(body))
  /** What a page keeps: the password and the Mac's id, sealed to the Mac's key under the remember label. */
  const boxOf = (password: string, id: string): string => packBody(pair.publicKey, REMEMBER_INFO, JSON.stringify({ p: password, r: id }))
  const typedRemember = async (who: ViewerWho, road = V2, password = PASSWORD) => {
    const opened = await door.begin(who, road)
    if (!opened.ok) throw new Error('no begin')
    return door.unlock(who, outer({ c: opened.challenge, p: password, m: 1 }), road)
  }
  const withBox = async (who: ViewerWho, box: string, road = V2) => {
    const opened = await door.begin(who, road)
    if (!opened.ok) throw new Error('no begin')
    return door.unlock(who, outer({ c: opened.challenge, b: box }), road)
  }
  return { door, pair, mac, typed, remembered, outer, boxOf, typedRemember, withBox }
}

describe('Remember: who may, and the id the Mac issues', () => {
  it('says it can remember only inside a v2 session, and only with a store of ids', async () => {
    const { door } = bed()
    expect(await door.begin(phone, V2)).toMatchObject({ ok: true, remember: 1 })
    expect(await door.begin(phone, V1)).not.toHaveProperty('remember')
    expect(await door.begin(phone)).not.toHaveProperty('remember')
    expect(await bed({ remembered: undefined }).door.begin(phone, V2)).not.toHaveProperty('remember')
  })

  it('a typed password that opens the Mac, with Remember asked inside v2, gets an id held for that device', async () => {
    const { remembered, typedRemember } = bed()
    const answer = await typedRemember(phone)
    expect(answer).toMatchObject({ ok: true, outcome: 'unlocked' })
    const id = answer.ok ? answer.remembered : undefined
    expect(typeof id).toBe('string')
    expect(remembered.live(id as string, phone.key)).toBe(true)
    expect(remembered.live(id as string, other.key)).toBe(false)
  })

  it('an id that cannot be kept (a full disk) still answers the unlock, with nothing remembered', async () => {
    const { remembered } = bed()
    const failing = bed({ remembered: { ...remembered, issue: () => { throw new Error('disk full') } } })
    const answer = await failing.typedRemember(phone)
    expect(answer).toEqual({ ok: true, outcome: 'unlocked' })
  })

  it('no id outside v2, none without Remember asked, none for a wrong password', async () => {
    const { door, outer, mac, typedRemember } = bed()
    expect(await typedRemember(phone, V1)).not.toHaveProperty('remembered')
    mac.locked = true
    const opened = await door.begin(phone, V2)
    if (!opened.ok) throw new Error('no begin')
    expect(await door.unlock(phone, outer({ c: opened.challenge, p: PASSWORD }), V2)).not.toHaveProperty('remembered')
    mac.locked = true
    expect(await typedRemember(phone, V2, 'not it')).toMatchObject({ ok: false, outcome: 'wrong' })
  })
})

describe('Unlocking with a remembered box', () => {
  it('a live box opens the Mac with the password inside it, and issues no new id', async () => {
    const { typed, mac, boxOf, withBox, remembered, typedRemember } = bed()
    const first = await typedRemember(phone)
    const id = first.ok ? (first.remembered as string) : ''
    mac.locked = true
    const answer = await withBox(phone, boxOf(PASSWORD, id))
    expect(answer).toEqual({ ok: true, outcome: 'unlocked' })
    expect(typed).toEqual([PASSWORD, PASSWORD])
    expect(remembered.live(id, phone.key)).toBe(true)
  })

  it('outside v2 a box is refused, and nothing is typed', async () => {
    const { mac, boxOf, withBox, typed, typedRemember } = bed()
    const first = await typedRemember(phone)
    mac.locked = true
    typed.length = 0
    expect(await withBox(phone, boxOf(PASSWORD, first.ok ? (first.remembered as string) : ''), V1)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(typed).toEqual([])
  })

  it('an id the Mac no longer holds (rotation, Forget, another device) is "forgotten": nothing typed, nothing counted', async () => {
    const { mac, boxOf, withBox, typed, remembered, typedRemember } = bed()
    const first = await typedRemember(phone)
    const id = first.ok ? (first.remembered as string) : ''
    mac.locked = true
    typed.length = 0
    // Another device presenting this phone's box.
    expect(await withBox(other, boxOf(PASSWORD, id))).toMatchObject({ ok: false, outcome: 'forgotten' })
    remembered.clear()
    expect(await withBox(phone, boxOf(PASSWORD, id))).toMatchObject({ ok: false, outcome: 'forgotten' })
    expect(await withBox(phone, boxOf(PASSWORD, id))).toMatchObject({ ok: false, outcome: 'forgotten' })
    expect(typed).toEqual([])
    // Not a wrong password: the door does not rest after three of them.
    expect(await withBox(phone, boxOf(PASSWORD, id))).toMatchObject({ outcome: 'forgotten' })
  })

  it('a box message is good once: the same message again is refused, its challenge spent', async () => {
    const { door, outer, mac, boxOf, typed, typedRemember } = bed()
    const first = await typedRemember(phone)
    const id = first.ok ? (first.remembered as string) : ''
    mac.locked = true
    typed.length = 0
    const opened = await door.begin(phone, V2)
    if (!opened.ok) throw new Error('no begin')
    const message = outer({ c: opened.challenge, b: boxOf(PASSWORD, id) })
    expect(await door.unlock(phone, message, V2)).toMatchObject({ ok: true })
    mac.locked = true
    expect(await door.unlock(phone, message, V2)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(typed).toEqual([PASSWORD])
  })

  it('a "forgotten" answer spends the challenge too: the same challenge with a password is then refused', async () => {
    const { door, outer, mac, boxOf, typed, remembered, typedRemember } = bed()
    const first = await typedRemember(phone)
    const id = first.ok ? (first.remembered as string) : ''
    mac.locked = true
    typed.length = 0
    remembered.clear()
    const opened = await door.begin(phone, V2)
    if (!opened.ok) throw new Error('no begin')
    expect(await door.unlock(phone, outer({ c: opened.challenge, b: boxOf(PASSWORD, id) }), V2)).toMatchObject({ outcome: 'forgotten' })
    expect(await door.unlock(phone, outer({ c: opened.challenge, p: PASSWORD }), V2)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(typed).toEqual([])
  })

  it('a Forget that cannot be written fails with a fixed sentence, never a file system error or a path', async () => {
    const t = bed()
    const first = await t.typedRemember(phone)
    const id = first.ok ? (first.remembered as string) : ''
    const failing = bed({ remembered: { ...t.remembered, drop: () => { throw new Error("EACCES: permission denied, open '/Users/someone/.cookrew/unlock-remembered.json.tmp'") } } })
    expect(() => failing.door.forget(phone, id, V2)).toThrow(FORGET_FAILED)
    expect(FORGET_FAILED).not.toMatch(/\/|EACCES|cookrew\b/)
  })

  it('a wrong box whose id cannot be dropped (a full disk) is still answered as a wrong password', async () => {
    const t = bed()
    const first = await t.typedRemember(phone)
    const id = first.ok ? (first.remembered as string) : ''
    t.mac.locked = true
    t.mac.password = 'changed since'
    const failing = bed({ keyPair: () => t.pair, locked: async () => t.mac.locked, type: async () => undefined, remembered: { ...t.remembered, drop: () => { throw new Error('disk full') } } })
    const opened = await failing.door.begin(phone, V2)
    if (!opened.ok) throw new Error('no begin')
    // Sealed to the first Mac's key, which the failing door holds.
    expect(await failing.door.unlock(phone, t.outer({ c: opened.challenge, b: t.boxOf(PASSWORD, id) }), V2)).toMatchObject({ ok: false, outcome: 'wrong' })
  })

  it('a box whose password no longer opens the Mac is a wrong password, and its id is dropped', async () => {
    const { mac, boxOf, withBox, remembered, typedRemember } = bed()
    const first = await typedRemember(phone)
    const id = first.ok ? (first.remembered as string) : ''
    mac.locked = true
    mac.password = 'changed since'
    expect(await withBox(phone, boxOf(PASSWORD, id))).toMatchObject({ ok: false, outcome: 'wrong' })
    expect(remembered.live(id, phone.key)).toBe(false)
  })

  it('a box under another label, or one that does not open, is refused; a message with both a password and a box too', async () => {
    const { pair, mac, door, outer, withBox, boxOf, typed, typedRemember } = bed()
    const first = await typedRemember(phone)
    const id = first.ok ? (first.remembered as string) : ''
    mac.locked = true
    typed.length = 0
    // Sealed under the unlock label: a captured unlock message is not a box.
    expect(await withBox(phone, packBody(pair.publicKey, UNLOCK_INFO, JSON.stringify({ p: PASSWORD, r: id })))).toMatchObject({ outcome: 'refused' })
    expect(await withBox(phone, 'not-a-box')).toMatchObject({ outcome: 'refused' })
    const opened = await door.begin(phone, V2)
    if (!opened.ok) throw new Error('no begin')
    expect(await door.unlock(phone, outer({ c: opened.challenge, p: PASSWORD, b: boxOf(PASSWORD, id) }), V2)).toMatchObject({ outcome: 'refused' })
    expect(typed).toEqual([])
  })

  it('the page\'s own Forget drops its id, inside v2 and for its own device only', async () => {
    const { door, remembered, typedRemember } = bed()
    const first = await typedRemember(phone)
    const id = first.ok ? (first.remembered as string) : ''
    expect(door.forget(other, id, V2)).toBe(false)
    expect(door.forget(phone, id, V1)).toBe(false)
    expect(remembered.live(id, phone.key)).toBe(true)
    expect(door.forget(phone, id, V2)).toBe(true)
    expect(remembered.live(id, phone.key)).toBe(false)
  })
})
