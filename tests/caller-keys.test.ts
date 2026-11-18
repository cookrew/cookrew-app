import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOMES_PER_ORIGIN,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  MAX_PENDING_FILES,
  PENDING_PER_ORIGIN,
  RETIRED_PER_ORIGIN,
  WALK_DEADLINE_MS,
  mayFile,
  originTag,
  pendingKeys,
  retiredKeys,
  signInAtHome,
  withHomeLock,
  type SignInDeps
} from '../resources/caller-keys.mjs'

/**
 * ONE WALK FOR THE KEYS A DEVICE HOLDS FOR ONE DOOR (resources/caller-keys.mjs),
 * shared by the app and the card. Safe even when a door lies about its
 * serviceId (which names the home file):
 *  - no key file is ever unlinked; what would have gone moves to retired/,
 *    still offered last, so recovery is a retry
 *  - at most one pending key per home; never mint while one exists
 *  - a challenge is fetched BEFORE a key is minted
 *  - a filed key is never replaced
 *  - a quota of pending and retired keys PER DOOR ORIGIN, so one door cannot
 *    crowd out another; a folder-wide cap only as a backstop
 *  - one sign-in per home across processes, under a walk deadline
 * Keys here are plain strings; the door is a script of answers.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ORIGIN = 'http://door.example:8639'
type Answer = 'ok' | 'refuse' | 'down'

/** A folder of string keys and a door answering asserts from `answer(key, n)` (default 'ok'). */
function rig(answer: (key: string, n: number) => Answer = () => 'ok', over: Partial<SignInDeps<string, string>> = {}, dir?: string) {
  const folder = dir ?? mkdtempSync(path.join(tmpdir(), 'caller-keys-'))
  if (!dir) dirs.push(folder)
  const state = { asserted: [] as string[], minted: [] as string[], reports: [] as string[], challenged: 0 }
  let n = 0
  const make = (serviceId: string, origin = ORIGIN, more: Partial<SignInDeps<string, string>> = {}): SignInDeps<string, string> => ({
    home: path.join(folder, `${serviceId}.json`),
    origin,
    others: [],
    readKey: async (file) => (existsSync(file) ? { key: readFileSync(file, 'utf8'), raw: readFileSync(file, 'utf8') } : null),
    challenge: async () => {
      state.challenged += 1
      return `nonce-${state.challenged}`
    },
    assert: async (key) => {
      state.asserted.push(key)
      const said = answer(key, ++n)
      if (said === 'down') throw new Error('this door could not sign anyone in just now (503)')
      return said === 'ok' ? 'tok' : null
    },
    mint: () => {
      const key = `key-${state.minted.length + 1}`
      state.minted.push(key)
      return { key, raw: key }
    },
    savePending: async (file, raw) => writeFileSync(file, raw, { flag: 'wx' }),
    promote: async (from, to) => {
      linkSync(from, to)
      unlinkSync(from)
    },
    report: (message) => state.reports.push(message),
    ...over,
    ...more
  })
  return { dir: folder, state, make, files: () => readdirSync(folder).sort() }
}

/** Every key on disk, anywhere in the folder (retired/ included): a key file is never unlinked. */
const keysOnDisk = (dir: string): string[] => {
  // Keys only: not retired/ (read below), the lock, this device's tag secret (.origin-key) or the origins/ notes.
  const top = readdirSync(dir)
    .filter((name) => name !== 'retired' && name !== 'origins' && !name.startsWith('.') && !name.endsWith('.lock'))
    .map((name) => readFileSync(path.join(dir, name), 'utf8'))
  const retired = existsSync(path.join(dir, 'retired')) ? readdirSync(path.join(dir, 'retired')).map((name) => readFileSync(path.join(dir, 'retired', name), 'utf8')) : []
  return [...top, ...retired].sort()
}

const keep = (home: string, origin: string, suffix: string, key: string): string => {
  const file = `${home}.pending-${originTag(origin, path.dirname(home))}-${suffix}`
  writeFileSync(file, key)
  return file
}

describe('no key file is ever unlinked', () => {
  it('(1) the PoC: a door spoofing A’s serviceId files K; A binds P; the spoofer signs in again. P survives, and A’s next sign-in succeeds', async () => {
    // One folder, two doors that both call themselves `svc-a`: the spoofer binds K, the real A binds P.
    let real = false
    const r = rig((key) => (real ? (key === 'key-2' ? 'ok' : 'refuse') : key === 'key-1' ? 'ok' : 'refuse'))
    const spoofer = r.make('svc-a', 'https://spoofer.example')
    const a = r.make('svc-a', 'https://a.example')
    expect(await signInAtHome(spoofer)).toBe('tok') // K = key-1, filed as home
    real = true
    expect(await signInAtHome(a)).toBe('tok') // K refused at A; P = key-2 bound, kept beside K
    real = false
    expect(await signInAtHome(spoofer)).toBe('tok') // K signs in: P would once have been DELETED here
    expect(keysOnDisk(r.dir)).toEqual(['key-1', 'key-2'])
    real = true
    expect(await signInAtHome(a)).toBe('tok') // and A gets in again, with P
    expect(r.state.asserted.at(-1)).toBe('key-2')
    expect(r.state.minted).toEqual(['key-1', 'key-2'])
  })

  it('once the filed key succeeds, a waiting key is RETIRED, not deleted, and still offered last', async () => {
    let filedWorks = true
    const r = rig((key) => ((filedWorks ? key === 'filed' : key === 'waiting') ? 'ok' : 'refuse'))
    const d = r.make('svc')
    writeFileSync(d.home, 'filed')
    keep(d.home, ORIGIN, '0123456789ab', 'waiting')
    expect(await signInAtHome(d)).toBe('tok')
    expect(pendingKeys(d.home)).toEqual([])
    expect(retiredKeys(d.home)).toHaveLength(1)
    // Now only the retired key opens it: offered after the filed one, it lets the account in.
    filedWorks = false
    expect(await signInAtHome(d)).toBe('tok')
    expect(r.state.asserted.at(-1)).toBe('waiting')
    expect(r.state.minted).toEqual([])
    expect(keysOnDisk(r.dir)).toEqual(['filed', 'waiting'])
  })
})

describe('one pending key per home; challenge first; a filed key never replaced', () => {
  it('a waiting key is THE sign-up key; one the door refuses is refused again, not replaced', async () => {
    const r = rig(() => 'refuse')
    const d = r.make('svc')
    keep(d.home, ORIGIN, '0123456789ab', 'waiting')
    await expect(signInAtHome(d)).rejects.toThrow(/refused/)
    expect(r.state.minted).toEqual([])
  })

  it('a door that will not hand out a challenge gets no key and no file', async () => {
    const r = rig(() => 'ok', { challenge: async () => { throw new Error('this door is not answering (500)') } })
    await expect(signInAtHome(r.make('svc'))).rejects.toThrow(/500/)
    expect(r.state.minted).toEqual([])
    expect(r.files()).toEqual([])
  })

  it('(c) a door that refuses the filed key and takes a new one leaves the filed key untouched', async () => {
    const r = rig((key) => (key === 'my-only-key' ? 'refuse' : 'ok'))
    const d = r.make('svc')
    writeFileSync(d.home, 'my-only-key')
    expect(await signInAtHome(d)).toBe('tok')
    expect(readFileSync(d.home, 'utf8')).toBe('my-only-key')
    expect(r.state.reports.join(' ')).toMatch(/left untouched/)
  })

  it('(d) a lost reply: the next sign-in uses the SAME key, and no second key is made', async () => {
    const r = rig((_key, n) => (n === 1 ? 'down' : 'ok'))
    const d = r.make('svc')
    await expect(signInAtHome(d)).rejects.toThrow(/503/)
    expect(await signInAtHome(d)).toBe('tok')
    expect(r.state.minted).toEqual(['key-1'])
    expect(readFileSync(d.home, 'utf8')).toBe('key-1')
  })
})

describe('(2) a quota per door origin: one door cannot crowd out another', () => {
  it('a door naming a new serviceId each time keeps at most PENDING_PER_ORIGIN pending, retires the rest, and is then refused ALONE', async () => {
    const r = rig(() => 'refuse')
    const rotating = 'https://rotating.example'
    let refused = 0
    for (let i = 0; i < PENDING_PER_ORIGIN + RETIRED_PER_ORIGIN + 5; i += 1) {
      await signInAtHome(r.make(`svc-${i}`, rotating)).catch((error: Error) => {
        if (/too many/.test(error.message)) refused += 1
      })
    }
    const tag = originTag(rotating, r.dir)
    expect(readdirSync(r.dir).filter((name) => name.includes(`.pending-${tag}-`))).toHaveLength(PENDING_PER_ORIGIN)
    expect(readdirSync(path.join(r.dir, 'retired'))).toHaveLength(RETIRED_PER_ORIGIN)
    expect(refused).toBeGreaterThan(0)
    // An honest new door is untouched by it.
    const honest = rig(() => 'ok', {}, r.dir)
    expect(await signInAtHome(honest.make('svc-b', 'https://b.example'))).toBe('tok')
    // Nothing was ever deleted: every key minted is still on disk.
    expect(keysOnDisk(r.dir)).toHaveLength(PENDING_PER_ORIGIN + RETIRED_PER_ORIGIN + 1)
  })

  it('keeps a folder-wide backstop well above any one door’s quota', () => {
    expect(MAX_PENDING_FILES).toBeGreaterThanOrEqual(PENDING_PER_ORIGIN * 32)
  })
})

describe('sixth review: crash leftovers, a keyed tag, hard bounds, filing from retired/, a careful release', () => {
  it('(B) a crash between link and unlink left one file under both names: the sign-in still succeeds, and the stray name goes', async () => {
    const r = rig((key) => (key === 'good' ? 'ok' : 'refuse'))
    const d = r.make('svc')
    writeFileSync(d.home, 'good')
    const pending = keep(d.home, ORIGIN, '0123456789ab', 'old')
    mkdirSync(path.join(r.dir, 'retired'))
    linkSync(pending, path.join(r.dir, 'retired', path.basename(pending)))
    expect(await signInAtHome(d)).toBe('tok')
    expect(pendingKeys(d.home)).toEqual([])
    expect(retiredKeys(d.home).map((file) => readFileSync(file, 'utf8'))).toEqual(['old'])
  })

  it('a DIFFERENT file already holding a retired name is kept, and this one is retired under a unique suffix, still offered', async () => {
    let filedWorks = true
    const r = rig((key) => ((filedWorks ? key === 'good' : key === 'mine') ? 'ok' : 'refuse'))
    const d = r.make('svc')
    writeFileSync(d.home, 'good')
    const pending = keep(d.home, ORIGIN, '0123456789ab', 'mine')
    mkdirSync(path.join(r.dir, 'retired'))
    writeFileSync(path.join(r.dir, 'retired', path.basename(pending)), 'someone else')
    expect(await signInAtHome(d)).toBe('tok')
    expect(retiredKeys(d.home).map((file) => readFileSync(file, 'utf8')).sort()).toEqual(['mine', 'someone else'])
    filedWorks = false
    expect(await signInAtHome(d)).toBe('tok')
    expect(r.state.asserted.at(-1)).toBe('mine')
  })

  it('a retirement that fails AFTER the door said yes is reported, never thrown', async () => {
    const r = rig()
    const d = r.make('svc')
    writeFileSync(d.home, 'good')
    keep(d.home, ORIGIN, '0123456789ab', 'old')
    // retired/ is a FILE: nothing can be moved into it.
    writeFileSync(path.join(r.dir, 'retired'), '')
    expect(await signInAtHome(d)).toBe('tok')
    expect(r.state.reports.join(' ')).toMatch(/could not be set aside/)
  })

  it('(D) the origin tag is keyed by a private secret of this device: 16 hex, different per device, not computable by a door', () => {
    const one = mkdtempSync(path.join(tmpdir(), 'caller-keys-'))
    const two = mkdtempSync(path.join(tmpdir(), 'caller-keys-'))
    dirs.push(one, two)
    expect(originTag(ORIGIN, one)).toMatch(/^[0-9a-f]{16}$/)
    expect(originTag(ORIGIN, one)).toBe(originTag(ORIGIN, one))
    expect(originTag(ORIGIN, one)).not.toBe(originTag(ORIGIN, two))
    const secret = readdirSync(one).find((name) => name.startsWith('.origin-key'))
    expect(secret).toBeDefined()
    if (process.platform !== 'win32') expect(statSync(path.join(one, secret as string)).mode & 0o777).toBe(0o600)
  })

  it('(A) the retired quota is a BOUND: a door alternating refusals and fresh binds never takes retired/ past it by more than one', async () => {
    const r = rig()
    let phase = 0
    let newest: string | null = null
    for (let i = 0; i < 60; i += 1) {
      newest = null
      const d = r.make('svc-evil', 'https://evil.example', {
        assert: async (key) => (phase === 0 ? key === newest : true) ? 'tok' : null,
        mint: () => {
          newest = `k-${i}`
          return { key: newest, raw: newest }
        }
      })
      await signInAtHome(d).catch(() => undefined)
      phase ^= 1
    }
    expect(readdirSync(path.join(r.dir, 'retired')).length).toBeLessThanOrEqual(RETIRED_PER_ORIGIN + 1)
  })

  it('(A2) one origin may make keys for at most HOMES_PER_ORIGIN doors (serviceIds); then it alone is refused', async () => {
    const r = rig()
    let refused = 0
    for (let i = 0; i < HOMES_PER_ORIGIN + 10; i += 1) {
      await signInAtHome(r.make(`svc-${i}`, 'https://rotating.example')).catch((error: Error) => {
        if (/too many teams/.test(error.message)) refused += 1
      })
    }
    expect(refused).toBe(10)
    expect(readdirSync(r.dir).filter((name) => name.endsWith('.json'))).toHaveLength(HOMES_PER_ORIGIN)
    expect(await signInAtHome(r.make('svc-b', 'https://b.example'))).toBe('tok')
  })

  it('(F) a key may be filed from retired/ into its own folder, and from nowhere else', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'caller-keys-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'retired'))
    const to = path.join(dir, 'svc.json')
    expect(mayFile(path.join(dir, 'svc.json.pending-x'), to)).toBe(true)
    expect(mayFile(path.join(dir, 'retired', 'svc.json.pending-x'), to)).toBe(true)
    expect(mayFile(path.join(dir, 'elsewhere', 'svc.json.pending-x'), to)).toBe(false)
    expect(mayFile(path.join(tmpdir(), 'svc.json.pending-x'), to)).toBe(false)
  })

  it('(G) a release whose put-back fails leaves the moved lock aside and unlinks NOTHING', async () => {
    const r = rig()
    const home = r.make('svc').home
    const lock = `${home}.lock`
    const someoneElses = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: 'P2' })
    const arrived = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: 'P3' })
    await withHomeLock(home, async () => {
      // While P1 runs, P2 took its lock over; as P1 releases, P3 makes a lock in the gap.
      writeFileSync(lock, someoneElses)
    }, { onAside: () => writeFileSync(lock, arrived, { flag: 'wx' }) })
    expect(readFileSync(lock, 'utf8')).toBe(arrived)
    const aside = readdirSync(r.dir).filter((name) => name.startsWith('svc.json.lock.'))
    expect(aside.map((name) => readFileSync(path.join(r.dir, name), 'utf8'))).toEqual([someoneElses])
  })

  it('(C) a lock is stamped when it is TAKEN, not when its holder started waiting', async () => {
    const r = rig()
    const home = r.make('svc').home
    const log: string[] = []
    const hold = (name: string, ms: number) => async () => {
      log.push(`${name} in`)
      await new Promise((resolve) => setTimeout(resolve, ms))
      log.push(`${name} out`)
    }
    const options = { staleMs: 500, pollMs: 10, waitMs: 5000 }
    const p1 = withHomeLock(home, hold('P1', 300), options)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const p2 = withHomeLock(home, hold('P2', 400), options)
    await new Promise((resolve) => setTimeout(resolve, 450))
    const p3 = withHomeLock(home, hold('P3', 50), options)
    await Promise.all([p1, p2, p3])
    expect(log).toEqual(['P1 in', 'P1 out', 'P2 in', 'P2 out', 'P3 in', 'P3 out'])
  })
})

describe('one sign-in per home, across processes, under a deadline', () => {
  it('a second sign-in waits for the first, and the lock is gone after', async () => {
    const r = rig()
    const home = r.make('svc').home
    const order: string[] = []
    await Promise.all([
      withHomeLock(home, async () => {
        order.push('a-in')
        await new Promise((resolve) => setTimeout(resolve, 80))
        order.push('a-out')
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        await withHomeLock(home, async () => order.push('b'), { pollMs: 5 })
      })()
    ])
    expect(order).toEqual(['a-in', 'a-out', 'b'])
    expect(existsSync(`${home}.lock`)).toBe(false)
  })

  it('takes over a stale lock by moving THAT lock: one that another taker replaced meanwhile is put back, not deleted', async () => {
    const r = rig()
    const home = r.make('svc').home
    const lock = `${home}.lock`
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - LOCK_STALE_MS - 1000 }))
    const fresh = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: 'the-other-taker' })
    let raced = false
    // Between judging it stale and taking it over, another taker already did: a fresh lock is there now.
    const onStale = (): void => {
      if (raced) return
      raced = true
      unlinkSync(lock)
      writeFileSync(lock, fresh)
    }
    await expect(withHomeLock(home, async () => 'ran', { pollMs: 5, waitMs: 60, onStale })).rejects.toThrow(/another sign-in/)
    expect(readFileSync(lock, 'utf8')).toBe(fresh)
  })

  it('a lock whose holder is dead, or that is older than LOCK_STALE_MS, is taken over', async () => {
    const r = rig()
    const home = r.make('svc').home
    writeFileSync(`${home}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }))
    expect(await withHomeLock(home, async () => 'ran', { pollMs: 5 })).toBe('ran')
    writeFileSync(`${home}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() - LOCK_STALE_MS - 1000 }))
    expect(await withHomeLock(home, async () => 'ran', { pollMs: 5 })).toBe('ran')
  })

  it('a walk that outlives its deadline gives up and lets the lock go; waiters wait longer than a walk may take', async () => {
    expect(WALK_DEADLINE_MS).toBeLessThan(LOCK_STALE_MS)
    expect(LOCK_WAIT_MS).toBeGreaterThan(WALK_DEADLINE_MS)
    const r = rig(() => 'ok', { assert: () => new Promise(() => undefined), lock: { deadlineMs: 50 } })
    const d = r.make('svc')
    await expect(signInAtHome(d)).rejects.toThrow(/took too long/)
    expect(existsSync(`${d.home}.lock`)).toBe(false)
    // The key it made before the stall is kept: the door may yet bind it.
    expect(pendingKeys(d.home)).toHaveLength(1)
    expect(retiredKeys(d.home)).toEqual([])
  })
})
