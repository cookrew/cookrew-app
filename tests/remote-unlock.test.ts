// UNLOCKING THE MAC FROM A PHONE (owner 2026-11-05). A password crosses a relay
// that must not read it, so every rule here is about what happens to that one
// string: sealed to the Mac, good once, and never kept or said.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUnlockDoor, loadUnlockKey, UNLOCK_ATTEMPTS, UNLOCK_CHALLENGE_MS, UNLOCK_MISSES_MAX, UNLOCK_REST_MS, type UnlockDoorDeps } from '../src/main/remote-unlock'
import { generateSealKeyPair, packBody } from '../src/shared/relay-seal'
import { UNLOCK_INFO } from '../src/shared/remote-unlock'
import type { ViewerWho } from '../src/shared/remote-access'

const phone: ViewerWho = { key: 'device:p1', name: 'Phone', here: false }
const other: ViewerWho = { key: 'device:p2', name: 'Tablet', here: false }
const PASSWORD = 'correct horse'

function bed(over: Partial<UnlockDoorDeps> = {}) {
  const pair = generateSealKeyPair()
  const clock = { now: 1_800_000_000_000 }
  const mac = { locked: true, password: PASSWORD }
  const typed: string[] = []
  const record = vi.fn()
  const door = createUnlockDoor({
    keyPair: () => pair,
    refusal: () => null,
    locked: async () => mac.locked,
    wake: async () => undefined,
    type: async (password) => {
      typed.push(password)
      if (password === mac.password) mac.locked = false
    },
    record,
    now: () => clock.now,
    sleep: async () => undefined,
    ...over
  })
  const seal = (challenge: string, password: string): string => packBody(pair.publicKey, UNLOCK_INFO, JSON.stringify({ c: challenge, p: password }))
  const send = async (who: ViewerWho, password: string) => {
    const opened = await door.begin(who)
    if (!opened.ok) return opened
    return door.unlock(who, seal(opened.challenge, password))
  }
  return { door, pair, clock, mac, typed, record, seal, send }
}

describe('begin', () => {
  it('gives the Mac’s key and a challenge', async () => {
    const { door, pair } = bed()
    const opened = await door.begin(phone)
    expect(opened).toMatchObject({ ok: true, key: pair.publicKey })
    expect(opened.ok && opened.challenge.length).toBeGreaterThan(20)
  })

  it('refuses what the desk refuses, before anything else', async () => {
    const { door } = bed({ refusal: () => 'Remote control of this Mac is off.' })
    expect(await door.begin(phone)).toEqual({ ok: false, error: 'Remote control of this Mac is off.' })
  })

  it('says so when there is nothing to unlock', async () => {
    const t = bed()
    t.mac.locked = false
    expect(await t.door.begin(phone)).toMatchObject({ ok: false, outcome: 'not-locked' })
  })
})

describe('unlock', () => {
  it('types the sealed password and sees the Mac open', async () => {
    const t = bed()
    expect(await t.send(phone, PASSWORD)).toEqual({ ok: true, outcome: 'unlocked' })
    expect(t.typed).toEqual([PASSWORD])
  })

  it('wakes the display first: a sleeping Mac has no password field', async () => {
    const order: string[] = []
    const t = bed({ wake: async () => void order.push('wake'), type: async () => void order.push('type') })
    await t.send(phone, PASSWORD)
    expect(order).toEqual(['wake', 'type'])
  })

  it('a wrong password says so, and the Mac stays locked', async () => {
    const t = bed()
    expect(await t.send(phone, 'nope')).toMatchObject({ ok: false, outcome: 'wrong' })
    expect(t.mac.locked).toBe(true)
  })

  it('never takes anything that was not sealed to this Mac', async () => {
    const t = bed()
    const opened = await t.door.begin(phone)
    const stranger = generateSealKeyPair()
    const wire = packBody(stranger.publicKey, UNLOCK_INFO, JSON.stringify({ c: opened.ok ? opened.challenge : '', p: PASSWORD }))
    expect(await t.door.unlock(phone, wire)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(await t.door.unlock(phone, PASSWORD)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(t.typed).toEqual([])
  })

  it('a captured message is good once: replayed, nothing is typed', async () => {
    const t = bed()
    const opened = await t.door.begin(phone)
    const wire = t.seal(opened.ok ? opened.challenge : '', 'nope')
    await t.door.unlock(phone, wire)
    t.typed.length = 0
    expect(await t.door.unlock(phone, wire)).toMatchObject({ ok: false, outcome: 'refused' })
    expect(t.typed).toEqual([])
  })

  it('a challenge goes stale, and belongs to the device it was given to', async () => {
    const t = bed()
    const late = await t.door.begin(phone)
    t.clock.now += UNLOCK_CHALLENGE_MS + 1
    expect(await t.door.unlock(phone, t.seal(late.ok ? late.challenge : '', PASSWORD))).toMatchObject({ outcome: 'refused' })
    const mine = await t.door.begin(phone)
    expect(await t.door.unlock(other, t.seal(mine.ok ? mine.challenge : '', PASSWORD))).toMatchObject({ outcome: 'refused' })
    expect(t.typed).toEqual([])
  })

  it('refused by the desk at the moment of typing too: Stop can land between the two', async () => {
    let refusal: string | null = null
    const t = bed({ refusal: () => refusal })
    const opened = await t.door.begin(phone)
    refusal = 'Stopped at the Mac'
    expect(await t.door.unlock(phone, t.seal(opened.ok ? opened.challenge : '', PASSWORD))).toEqual({ ok: false, error: 'Stopped at the Mac' })
    expect(t.typed).toEqual([])
  })

  it('rests after three wrong passwords, for every device', async () => {
    const t = bed()
    for (let i = 0; i < UNLOCK_ATTEMPTS; i += 1) await t.send(phone, 'nope')
    t.typed.length = 0
    expect(await t.send(other, PASSWORD)).toMatchObject({ ok: false, outcome: 'resting' })
    expect(t.typed).toEqual([])
    t.clock.now += UNLOCK_REST_MS + 1
    expect(await t.send(other, PASSWORD)).toEqual({ ok: true, outcome: 'unlocked' })
  })

  it('a good password clears the count', async () => {
    const t = bed()
    await t.send(phone, 'nope')
    await t.send(phone, 'nope')
    await t.send(phone, PASSWORD)
    t.mac.locked = true
    await t.send(phone, 'nope')
    expect(await t.send(phone, 'nope')).toMatchObject({ outcome: 'wrong' })
  })

  it('types one at a time: a second ask is not a second set of keystrokes', async () => {
    let finish: () => void = () => undefined
    const t = bed({ type: () => new Promise<void>((resolve) => (finish = resolve)) })
    const a = await t.door.begin(phone)
    const first = t.door.unlock(phone, t.seal(a.ok ? a.challenge : '', PASSWORD))
    await new Promise((resolve) => setImmediate(resolve))
    const b = await t.door.begin(other)
    expect(b).toMatchObject({ ok: false, outcome: 'busy' })
    finish()
    await first
  })

  it('two devices cannot type at once, whatever the lock read takes', async () => {
    let answer: (locked: boolean) => void = () => undefined
    let reads = 0
    const t = bed({ locked: () => (++reads <= 2 ? Promise.resolve(true) : new Promise<boolean>((resolve) => (answer = resolve))) })
    const a = await t.door.begin(phone)
    const b = await t.door.begin(other)
    const first = t.door.unlock(phone, t.seal(a.ok ? a.challenge : '', PASSWORD))
    expect(await t.door.unlock(other, t.seal(b.ok ? b.challenge : '', PASSWORD))).toMatchObject({ outcome: 'busy' })
    answer(true)
    await new Promise((resolve) => setImmediate(resolve))
    answer(false)
    await first
  })

  it('asks the desk again after waking: Stop can land in those seconds', async () => {
    let refusal: string | null = null
    const t = bed({ refusal: () => refusal, wake: async () => void (refusal = 'Stopped at the Mac') })
    const opened = await t.door.begin(phone)
    expect(await t.door.unlock(phone, t.seal(opened.ok ? opened.challenge : '', PASSWORD))).toEqual({ ok: false, error: 'Stopped at the Mac' })
    expect(t.typed).toEqual([])
  })

  it('a Mac unlocked at its keyboard mid-way is no failure and no wrong password', async () => {
    const t = bed({
      type: async () => {
        t.mac.locked = false
        throw new Error('not locked')
      }
    })
    expect(await t.send(phone, PASSWORD)).toMatchObject({ ok: false, outcome: 'not-locked' })
  })

  it('a restart does not forgive wrong passwords: guessing 8 at a time still closes it', async () => {
    const held = { count: 0 }
    const misses = { read: () => held.count, write: (count: number) => { held.count = count } }
    const first = bed({ misses })
    for (let miss = 0; miss < UNLOCK_MISSES_MAX - 1; miss += 1) {
      await first.send(phone, 'nope')
      first.clock.now += UNLOCK_REST_MS + 1
    }
    expect(held.count).toBe(UNLOCK_MISSES_MAX - 1)
    const next = bed({ misses })
    await next.send(phone, 'nope')
    next.clock.now += UNLOCK_REST_MS + 1
    expect(await next.send(phone, PASSWORD)).toMatchObject({ ok: false, outcome: 'closed' })
  })

  it('someone at the Mac reopening it clears the count', async () => {
    const held = { count: UNLOCK_MISSES_MAX }
    const t = bed({ misses: { read: () => held.count, write: (count: number) => { held.count = count } } })
    expect(await t.send(phone, PASSWORD)).toMatchObject({ ok: false, outcome: 'closed' })
    t.door.reopen()
    expect(held.count).toBe(0)
    expect(await t.send(phone, PASSWORD)).toEqual({ ok: true, outcome: 'unlocked' })
  })

  it('the right password clears the count', async () => {
    const held = { count: 4 }
    const t = bed({ misses: { read: () => held.count, write: (count: number) => { held.count = count } } })
    expect(await t.send(phone, PASSWORD)).toEqual({ ok: true, outcome: 'unlocked' })
    expect(held.count).toBe(0)
  })

  it('a count it cannot read or save does not stop an unlock', async () => {
    const t = bed({ misses: { read: () => { throw new Error('no') }, write: () => { throw new Error('no') } } })
    expect(await t.send(phone, PASSWORD)).toEqual({ ok: true, outcome: 'unlocked' })
  })

  it('tells the desk once when it closes, so a restart cannot reopen it', async () => {
    let closes = 0

    const t = bed({ closed: () => { closes += 1 } })
    for (let miss = 0; miss < UNLOCK_MISSES_MAX; miss += 1) {
      await t.send(phone, 'nope')
      t.clock.now += UNLOCK_REST_MS + 1
    }
    expect(closes).toBe(1)
  })

  it('closes after too many wrong passwords, until someone at the Mac reopens it', async () => {
    const t = bed()
    for (let miss = 0; miss < UNLOCK_MISSES_MAX; miss += 1) {
      await t.send(phone, 'nope')
      t.clock.now += UNLOCK_REST_MS + 1
    }
    t.typed.length = 0
    expect(await t.send(phone, PASSWORD)).toMatchObject({ ok: false, outcome: 'closed' })
    expect(t.typed).toEqual([])
    expect(JSON.stringify(t.record.mock.calls)).toContain('closed')
    t.door.reopen()
    expect(await t.send(phone, PASSWORD)).toEqual({ ok: true, outcome: 'unlocked' })
  })

  it('a password no key can type says so, types nothing, and costs no attempt', async () => {
    const t = bed({ typable: () => false })
    const answer = await t.send(phone, PASSWORD)
    expect(answer).toMatchObject({ ok: false, outcome: 'failed' })
    expect(JSON.stringify(answer)).toContain('cannot be typed')
    expect(JSON.stringify(answer)).not.toContain(PASSWORD)
    expect(t.typed).toEqual([])
  })

  it('the record says who and how it went, and never the password', async () => {
    const t = bed()
    await t.send(phone, 'hunter2-wrong')
    await t.send(phone, PASSWORD)
    const said = JSON.stringify(t.record.mock.calls)
    expect(said).toContain('Phone')
    expect(said).not.toContain('hunter2')
    expect(said).not.toContain(PASSWORD)
  })

  it('a hand that fails reaches nobody as a password error, and costs no attempt', async () => {
    const t = bed({ type: async () => Promise.reject(new Error('the input helper stopped')) })
    expect(await t.send(phone, PASSWORD)).toMatchObject({ ok: false, outcome: 'failed' })
    for (let i = 0; i < UNLOCK_ATTEMPTS; i += 1) await t.send(phone, PASSWORD)
    expect(await t.send(phone, PASSWORD)).toMatchObject({ outcome: 'failed' })
  })
})

describe('loadUnlockKey', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'unlock-key-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('makes one key, keeps it, and only its owner can read it', () => {
    const file = path.join(dir, 'unlock-key.json')
    const first = loadUnlockKey(file)
    expect(loadUnlockKey(file)).toEqual(first)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toContain(first.publicKey)
  })
})
