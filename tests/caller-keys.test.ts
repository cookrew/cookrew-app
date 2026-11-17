import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCK_STALE_MS,
  MAX_PENDING_FILES,
  pendingKeys,
  signInAtHome,
  withHomeLock,
  type SignInDeps
} from '../resources/caller-keys.mjs'

/**
 * ONE WALK FOR THE KEYS A DEVICE HOLDS FOR ONE DOOR (resources/caller-keys.mjs),
 * shared by the app and the card, held to six invariants:
 *  1. at most one pending key per home; never mint while one exists
 *  2. a challenge is fetched BEFORE a key is minted
 *  3. a pending key is deleted only after a DIFFERENT key succeeded here
 *  4. an existing home key is never replaced
 *  5. one sign-in per home at a time, across processes (<home>.lock)
 *  6. a cap on pending files in the folder
 * Keys here are plain strings; the door is a script of answers.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Answer = 'ok' | 'refuse' | 'down'
interface Rig {
  dir: string
  home: string
  deps: SignInDeps
  asserted: string[]
  challenged: number
  minted: string[]
  reports: string[]
  files: () => string[]
}

/** A door that answers each assert in turn from `answers` (then 'ok'), and a folder of string keys. */
function rig(answers: Answer[] = [], over: Partial<SignInDeps> = {}, challengeDown = false): Rig {
  const dir = mkdtempSync(path.join(tmpdir(), 'caller-keys-'))
  dirs.push(dir)
  const home = path.join(dir, 'svc.json')
  const state: Rig = {
    dir,
    home,
    asserted: [],
    challenged: 0,
    minted: [],
    reports: [],
    files: () => readdirSync(dir).sort(),
    deps: undefined as unknown as SignInDeps
  }
  let n = 0
  state.deps = {
    home,
    others: [],
    readKey: async (file) => (existsSync(file) ? { key: readFileSync(file, 'utf8'), raw: readFileSync(file, 'utf8') } : null),
    challenge: async () => {
      state.challenged += 1
      if (challengeDown) throw new Error('this door is not answering (500)')
      return `nonce-${state.challenged}`
    },
    assert: async (key) => {
      state.asserted.push(String(key))
      const answer = answers[n++] ?? 'ok'
      if (answer === 'down') throw new Error('this door could not sign anyone in just now (503)')
      return answer === 'ok' ? 'tok' : null
    },
    mint: () => {
      const key = `key-${state.minted.length + 1}`
      state.minted.push(key)
      return { key, raw: key }
    },
    savePending: async (file, raw) => writeFileSync(file, String(raw), { flag: 'wx' }),
    promote: async (from, to) => {
      linkSync(from, to)
      unlinkSync(from)
    },
    remove: (file) => rmSync(file, { force: true }),
    report: (message) => state.reports.push(message),
    ...over
  }
  return state
}

const keep = (r: Rig, suffix: string, key: string): string => {
  const file = `${r.home}.pending-${suffix}`
  writeFileSync(file, key)
  return file
}

describe('1 · at most one pending key per home: never mint while one exists', () => {
  it('a waiting key is offered as THE sign-up key, and no second key is ever made', async () => {
    const r = rig()
    keep(r, '0123456789ab', 'waiting')
    expect(await signInAtHome(r.deps)).toBe('tok')
    expect(r.minted).toEqual([])
    expect(r.asserted).toEqual(['waiting'])
    expect(readFileSync(r.home, 'utf8')).toBe('waiting')
    expect(pendingKeys(r.home)).toEqual([])
  })

  it('a waiting key the door refuses is refused AGAIN, not replaced: the sign-in says so and mints nothing', async () => {
    const r = rig(['refuse'])
    keep(r, '0123456789ab', 'waiting')
    await expect(signInAtHome(r.deps)).rejects.toThrow(/refused/)
    expect(r.minted).toEqual([])
    expect(pendingKeys(r.home)).toHaveLength(1)
  })
})

describe('2 · the challenge comes BEFORE a key is made', () => {
  it('a door that will not hand out a challenge gets no key minted and no file written', async () => {
    const r = rig([], {}, true)
    await expect(signInAtHome(r.deps)).rejects.toThrow(/500/)
    expect(r.minted).toEqual([])
    expect(r.files()).toEqual([])
  })
})

describe('3 · a pending key goes only once a DIFFERENT key has succeeded here', () => {
  it('a freshly minted key the door refuses is KEPT (the name may be someone else’s, or the 401 a spent challenge)', async () => {
    const r = rig(['refuse'])
    await expect(signInAtHome(r.deps)).rejects.toThrow(/refused/)
    expect(pendingKeys(r.home)).toHaveLength(1)
  })

  it('a busy door refuses nothing: the minted key stays and is the one offered next time', async () => {
    const r = rig(['down'])
    await expect(signInAtHome(r.deps)).rejects.toThrow(/503/)
    expect(await signInAtHome(r.deps)).toBe('tok')
    expect(r.minted).toEqual(['key-1'])
    expect(readFileSync(r.home, 'utf8')).toBe('key-1')
  })

  it('once the filed key succeeds, every waiting key goes: none of them can be this account', async () => {
    const r = rig()
    writeFileSync(r.home, 'filed')
    keep(r, '0123456789ab', 'stale')
    expect(await signInAtHome(r.deps)).toBe('tok')
    expect(r.files()).toEqual(['svc.json'])
  })
})

describe('4 · an existing home key is never replaced', () => {
  it('(c) a door that refuses the filed key and takes a new one leaves the filed key untouched, keeps both, and says so', async () => {
    const r = rig(['refuse', 'ok'])
    writeFileSync(r.home, 'my-only-key')
    expect(await signInAtHome(r.deps)).toBe('tok')
    expect(readFileSync(r.home, 'utf8')).toBe('my-only-key')
    expect(pendingKeys(r.home).map((file) => readFileSync(file, 'utf8'))).toEqual(['key-1'])
    expect(r.reports.join(' ')).toMatch(/left untouched/)
  })

  it('an address-filed key that succeeds is filed under the door only where nothing is filed yet', async () => {
    const legacy = rig()
    const old = path.join(legacy.dir, 'host-team.json')
    writeFileSync(old, 'legacy-key')
    expect(await signInAtHome({ ...legacy.deps, others: [old] })).toBe('tok')
    expect(readFileSync(legacy.home, 'utf8')).toBe('legacy-key')
    const held = rig(['refuse'])
    writeFileSync(held.home, 'filed')
    const other = path.join(held.dir, 'host-team.json')
    writeFileSync(other, 'legacy-key')
    expect(await signInAtHome({ ...held.deps, others: [other] })).toBe('tok')
    expect(readFileSync(held.home, 'utf8')).toBe('filed')
    expect(existsSync(other)).toBe(true)
  })

  it('a filing that fails is reported, never thrown: the key stays where it is', async () => {
    const r = rig([], { promote: async () => { throw new Error('EXDEV') } })
    expect(await signInAtHome(r.deps)).toBe('tok')
    expect(pendingKeys(r.home)).toHaveLength(1)
    expect(r.reports.join(' ')).toMatch(/EXDEV/)
  })
})

describe('(d) a lost reply', () => {
  it('the next sign-in uses the SAME key, and no second key is made', async () => {
    const r = rig(['down', 'ok'])
    await expect(signInAtHome(r.deps)).rejects.toThrow()
    expect(await signInAtHome(r.deps)).toBe('tok')
    expect(r.minted).toEqual(['key-1'])
    expect(new Set(r.asserted)).toEqual(new Set(['key-1']))
  })
})

describe('5 · one sign-in per home, across processes', () => {
  it('a second sign-in waits for the first, and the lock is gone after', async () => {
    const r = rig()
    const order: string[] = []
    await Promise.all([
      withHomeLock(r.home, async () => {
        order.push('a-in')
        await new Promise((resolve) => setTimeout(resolve, 80))
        order.push('a-out')
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        await withHomeLock(r.home, async () => order.push('b'), { pollMs: 5 })
      })()
    ])
    expect(order).toEqual(['a-in', 'a-out', 'b'])
    expect(existsSync(`${r.home}.lock`)).toBe(false)
  })

  it('a lock whose holder is dead, or that is older than LOCK_STALE_MS, is taken over', async () => {
    const r = rig()
    writeFileSync(`${r.home}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }))
    expect(await withHomeLock(r.home, async () => 'ran', { pollMs: 5 })).toBe('ran')
    writeFileSync(`${r.home}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() - LOCK_STALE_MS - 1000 }))
    expect(await withHomeLock(r.home, async () => 'ran', { pollMs: 5 })).toBe('ran')
  })

  it('a live, fresh lock is waited on, then given up with a clear message', async () => {
    const r = rig()
    writeFileSync(`${r.home}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }))
    await expect(withHomeLock(r.home, async () => 'ran', { waitMs: 50, pollMs: 5 })).rejects.toThrow(/another sign-in/)
    expect(existsSync(`${r.home}.lock`)).toBe(true)
  })
})

describe('6 · a cap on pending files in the folder', () => {
  it('refuses to mint once the folder holds MAX_PENDING_FILES, whichever doors they are for', async () => {
    const r = rig()
    for (let i = 0; i < MAX_PENDING_FILES; i += 1) writeFileSync(path.join(r.dir, `door-${i}.json.pending-${String(i).padStart(12, '0')}`), 'x')
    await expect(signInAtHome(r.deps)).rejects.toThrow(/too many/)
    expect(r.minted).toEqual([])
    expect(r.challenged).toBe(0)
  })
})
