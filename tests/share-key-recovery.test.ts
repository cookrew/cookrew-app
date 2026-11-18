// KEY RECOVERY v1 (lane Magpie, scope 4, as agreed with Relay): a durable intent
// with a random 128-bit name is written BEFORE `gateway-key add`; a failure
// revokes every key of that name by id; an intent is never cleared by itself and
// warns until the owner clears it, which is allowed only after one revoke pass
// and one process check both came back clean.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ShareKeys, type MagpieRun } from '../src/main/route/share-keys'
import { fileIntentStore, INTENT_NAME_RE, memoryIntentStore, type IntentStore } from '../src/main/route/share-intents'

const HEAD = 'ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS'
const KEY = `sk-magpie-key-${'k'.repeat(40)}abc123`

interface Row {
  id: string
  name: string
  tail: string
}

/** A Magpie that keeps keys in memory and masks them the way 0.1.3935 does. */
function fakeMagpie(opts: { addCode?: number; addThrows?: boolean; addOut?: string; extraSameName?: number } = {}): { run: MagpieRun; calls: string[][]; rows: Row[] } {
  const rows: Row[] = [{ id: '9ed61cf285e943f9a28bfb6a', name: 'solis-compare', tail: '5102ac' }]
  const calls: string[][] = []
  let n = 0
  const run: MagpieRun = async (args) => {
    calls.push(args)
    const [, verb, a1] = args
    if (verb === 'list') return { code: 0, stdout: `${HEAD}\n${rows.map((r) => `${r.id}  ${r.name}  enabled  sk-magpie-key-…${r.tail}  -  all  all  full`).join('\n')}\n`, stderr: '' }
    if (verb === 'add') {
      for (let i = 0; i <= (opts.extraSameName ?? 0); i += 1) {
        n += 1
        rows.push({ id: String(n).padStart(24, 'f'), name: a1, tail: i === 0 ? KEY.slice(-6) : 'zzzzzz' })
      }
      if (opts.addThrows) throw new Error('runner died after add')
      return { code: opts.addCode ?? 0, stdout: `${opts.addOut ?? KEY}\n`, stderr: opts.addCode ? 'timed out' : '' }
    }
    if (verb === 'remove') {
      const at = rows.findIndex((r) => r.id === a1)
      if (at >= 0) rows.splice(at, 1)
      return { code: 0, stdout: 'Gateway key removed\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls, rows }
}

const NONCE = '0123456789abcdef0123456789abcdef'
const keysWith = (run: MagpieRun, intents: IntentStore, processes: () => Promise<string[]> = async () => []): ShareKeys => new ShareKeys({ run, intents, nonce: () => NONCE, processes })

describe('issuing with a durable intent', () => {
  it('records the random name before Magpie is asked to add it, and drops it once the key is handed over', async () => {
    const magpie = fakeMagpie()
    const intents = memoryIntentStore()
    let atAdd: readonly unknown[] = []
    const run: MagpieRun = async (args) => {
      if (args[1] === 'add') atAdd = intents.read()
      return magpie.run(args)
    }
    const answer = await keysWith(run, intents).issue({ device: 'Laptop', dailyUsd: 5 })
    expect(answer).toMatchObject({ ok: true, key: KEY, shared: { device: 'laptop', name: `device-laptop--${NONCE}` } })
    expect(atAdd).toMatchObject([{ name: `device-laptop--${NONCE}`, device: 'laptop' }])
    expect(INTENT_NAME_RE.test(`device-laptop--${NONCE}`)).toBe(true)
    expect(intents.read()).toEqual([])
  })

  it('asks Magpie for nothing when the intent cannot be written or read', async () => {
    const magpie = fakeMagpie()
    const broken: IntentStore = { read: () => [], write: () => { throw new Error('disk full') } }
    expect(await keysWith(magpie.run, broken).issue({ device: 'laptop', dailyUsd: 5 })).toMatchObject({ ok: false })
    const unreadable: IntentStore = { read: () => { throw new Error('garbled') }, write: () => {} }
    expect(await keysWith(magpie.run, unreadable).issue({ device: 'laptop', dailyUsd: 5 })).toMatchObject({ ok: false })
    expect(magpie.calls.some((c) => c[1] === 'add')).toBe(false)
  })

  it.each([
    ['add exits non-zero', { addCode: 1 }],
    ['add throws', { addThrows: true }],
    ['add prints something that is not a key', { addOut: 'Usage: …' }],
    ['the listed key is not the one returned', { addOut: `sk-magpie-key-${'q'.repeat(46)}` }],
    ['two keys carry the name', { extraSameName: 1 }]
  ])('revokes every key of its name by id and keeps warning when %s', async (_why, opts) => {
    const magpie = fakeMagpie(opts)
    const intents = memoryIntentStore()
    const answer = await keysWith(magpie.run, intents).issue({ device: 'laptop', dailyUsd: 5 })
    expect(answer.ok).toBe(false)
    expect(magpie.rows.map((r) => r.name)).toEqual(['solis-compare'])
    expect(magpie.calls.filter((c) => c[1] === 'limit' || c[1] === 'concurrency')).toEqual([])
    expect(intents.read()).toMatchObject([{ name: `device-laptop--${NONCE}`, revoked: { left: 0 } }])
  })

  it('refuses another key for a device whose intent is still open', async () => {
    const magpie = fakeMagpie()
    const intents = memoryIntentStore([{ name: `device-laptop--${'a'.repeat(32)}`, device: 'laptop', at: '2026-11-18T00:00:00.000Z' }])
    expect(await keysWith(magpie.run, intents).issue({ device: 'laptop', dailyUsd: 5 })).toMatchObject({ ok: false })
    expect(magpie.calls.some((c) => c[1] === 'add')).toBe(false)
  })
})

describe('after a crash: the intent warns until cleared by hand', () => {
  const left = `device-laptop--${'b'.repeat(32)}`
  const start = (): { magpie: ReturnType<typeof fakeMagpie>; intents: IntentStore } => {
    const magpie = fakeMagpie()
    magpie.rows.push({ id: 'c'.repeat(24), name: left, tail: 'aaaaaa' }, { id: 'd'.repeat(24), name: left, tail: 'bbbbbb' })
    return { magpie, intents: memoryIntentStore([{ name: left, device: 'laptop', at: '2026-11-18T00:00:00.000Z' }]) }
  }

  it('lists the open intent and never clears it by itself, even when no key of its name is listed', async () => {
    const { magpie, intents } = start()
    magpie.rows.splice(1)
    const keys = keysWith(magpie.run, intents)
    expect((await keys.list()).pending).toMatchObject([{ name: left, device: 'laptop', clearable: false }])
    expect(intents.read()).toHaveLength(1)
  })

  it('refuses a clear before a revoke pass and a process check', async () => {
    const { magpie, intents } = start()
    expect(await keysWith(magpie.run, intents).clear(left)).toMatchObject({ ok: false })
    expect(intents.read()).toHaveLength(1)
  })

  it('revokes every key of the name by id, checks for a running add, then allows the clear', async () => {
    const { magpie, intents } = start()
    const keys = keysWith(magpie.run, intents)
    expect(await keys.resolve(left)).toMatchObject({ ok: true, left: 0, live: 0 })
    expect(magpie.calls.filter((c) => c[1] === 'remove').map((c) => c[2]).sort()).toEqual(['c'.repeat(24), 'd'.repeat(24)])
    expect((await keys.list()).pending).toMatchObject([{ name: left, clearable: true }])
    expect(await keys.clear(left)).toEqual({ ok: true })
    expect(intents.read()).toEqual([])
  })

  it('keeps the intent when a magpie add of that name is still running', async () => {
    const { magpie, intents } = start()
    const keys = keysWith(magpie.run, intents, async () => [`/Users/x/.local/bin/magpie gateway-key add ${left}`, 'magpie serve'])
    expect(await keys.resolve(left)).toMatchObject({ ok: true, live: 1 })
    expect(await keys.clear(left)).toMatchObject({ ok: false })
  })

  it('keeps the intent when the process check itself fails', async () => {
    const { magpie, intents } = start()
    const keys = keysWith(magpie.run, intents, async () => {
      throw new Error('ps is gone')
    })
    expect(await keys.resolve(left)).toMatchObject({ ok: false })
    expect(await keys.clear(left)).toMatchObject({ ok: false })
  })

  it('keeps the intent when a key of the name survives the revoke', async () => {
    const { magpie, intents } = start()
    const run: MagpieRun = async (args) => (args[1] === 'remove' ? { code: 1, stdout: '', stderr: 'locked' } : magpie.run(args))
    const keys = keysWith(run, intents)
    expect(await keys.resolve(left)).toMatchObject({ left: 2 })
    expect(await keys.clear(left)).toMatchObject({ ok: false })
  })

  it('touches only names that are intents', async () => {
    const { magpie, intents } = start()
    const keys = keysWith(magpie.run, intents)
    expect(await keys.resolve('solis-compare')).toMatchObject({ ok: false })
    expect(await keys.clear('solis-compare')).toMatchObject({ ok: false })
    expect(magpie.calls.some((c) => c[1] === 'remove')).toBe(false)
  })
})

describe('the intent file', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'share-intents-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('survives a new store on the same file, owner-only, and holds no key', () => {
    const file = path.join(dir, 'nested', 'share-intents.json')
    fileIntentStore(file).write([{ name: `device-laptop--${NONCE}`, device: 'laptop', at: 'x' }])
    expect(fileIntentStore(file).read()).toEqual([{ name: `device-laptop--${NONCE}`, device: 'laptop', at: 'x' }])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).not.toContain('sk-magpie')
  })

  it('reads a missing file as no intents, and refuses a garbled one', () => {
    const file = path.join(dir, 'share-intents.json')
    expect(fileIntentStore(file).read()).toEqual([])
    writeFileSync(file, '{"v":1,"intents":[{"name":"bad"}]}')
    expect(() => fileIntentStore(file).read()).toThrow()
    writeFileSync(file, 'not json')
    expect(() => fileIntentStore(file).read()).toThrow()
  })
})

describe('whose screen a key is shown on', () => {
  it('holds a key for the owner’s window only when the owner made it here, never one made for another computer over the seal', async () => {
    const magpie = fakeMagpie()
    const keys = keysWith(magpie.run, memoryIntentStore())
    const sealed = await keys.issue({ device: 'other-mac', dailyUsd: 5 }, () => true, { handover: false })
    expect(sealed.ok).toBe(true)
    expect((await keys.list()).handover).toBeNull()
  })
})

describe('review fixes: recovery waits its turn behind a key being made', () => {
  it('does not resolve or clear while an issue is between its intent and its add', async () => {
    const magpie = fakeMagpie()
    const intents = memoryIntentStore()
    let releaseAdd: () => void = () => {}
    const run: MagpieRun = async (args) => {
      if (args[1] === 'add') await new Promise<void>((r) => (releaseAdd = r))
      return magpie.run(args)
    }
    const keys = keysWith(run, intents)
    const issuing = keys.issue({ device: 'laptop', dailyUsd: 5 })
    for (let i = 0; i < 50 && intents.read().length === 0; i += 1) await new Promise((r) => setTimeout(r, 2))
    const name = intents.read()[0].name
    let resolved = false
    const resolving = keys.resolve(name).then((a) => {
      resolved = true
      return a
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(resolved).toBe(false)
    releaseAdd()
    expect((await issuing).ok).toBe(true)
    // Once the issue settled, its intent is gone: nothing is left to resolve.
    expect(await resolving).toMatchObject({ ok: false })
  })
})

describe('review round 2: a key made for another computer is not this panel\'s work', () => {
  it('does not show as issuing on the owner\'s panel', async () => {
    const magpie = fakeMagpie()
    let release: () => void = () => {}
    const run: MagpieRun = async (args) => {
      if (args[1] === 'add') await new Promise<void>((r) => (release = r))
      return magpie.run(args)
    }
    const keys = keysWith(run, memoryIntentStore())
    const sealed = keys.issue({ device: 'other-mac', dailyUsd: 5 }, () => true, { handover: false })
    await new Promise((r) => setTimeout(r, 10))
    expect((await keys.list()).issuing).toBe(false)
    release()
    expect((await sealed).ok).toBe(true)
  })
})
