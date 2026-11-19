// REMEMBER ON THE CONSOLE, END TO END IN ONE PROCESS: the page's own flow (renderer use/unlock-flow.ts, unlock-vault)
// against the Mac's own door and id store (main/remote-unlock.ts, unlock-remembered.ts). What the page keeps is a box
// only the Mac opens; it is sent only on a v2 road; the Mac can take it back.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUnlockDoor } from '../src/main/remote-unlock'
import { createRememberedUnlocks } from '../src/main/unlock-remembered'
import { generateSealKeyPair, openBody } from '../src/shared/relay-seal'
import { REMEMBER_INFO, UNLOCK_INFO } from '../src/shared/remote-unlock'
import type { ViewerWho } from '../src/shared/remote-access'
import { forgetRemembered, prepareUnlock, runUnlock, type UnlockFlowDeps } from '../src/renderer/src/use/unlock-flow'
import { createUnlockVault, type VaultStore } from '../src/renderer/src/use/unlock-vault'

const PASSWORD = 'correct horse canary'
const who: ViewerWho = { key: 'root', name: 'A paired device', here: false }

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const memory = (): VaultStore => {
  const rows = new Map<string, unknown>()
  return { get: async (k) => rows.get(k), set: async (k, v) => void rows.set(k, v), del: async (k) => void rows.delete(k) }
}

function bed(opts: { v2?: boolean; clientV2?: boolean; codeId?: string; plainRemember?: boolean; macRemembers?: boolean } = {}) {
  const v2 = opts.v2 ?? true
  const dir = mkdtempSync(path.join(tmpdir(), 'unlock-remember-flow-'))
  dirs.push(dir)
  const pair = generateSealKeyPair()
  const mac = { locked: true, password: PASSWORD }
  const typed: string[] = []
  const idsFile = path.join(dir, 'ids.json')
  const remembered = createRememberedUnlocks(idsFile, { currentCode: () => 'code-1' })
  const door = createUnlockDoor({
    keyPair: () => pair,
    refusal: () => null,
    locked: async () => mac.locked,
    wake: async () => undefined,
    type: async (password) => {
      typed.push(password)
      if (password === mac.password) mac.locked = false
    },
    record: () => undefined,
    sleep: async () => undefined,
    ...(opts.macRemembers === false ? {} : { remembered })
  })
  const road = { sealedV2: v2 }
  const sent: string[] = []
  const vault = createUnlockVault(memory())
  const deps: UnlockFlowDeps = {
    api: {
      sealedV2: opts.clientV2 ?? v2,
      begin: () => door.begin(who, road),
      send: (sealed) => {
        sent.push(sealed)
        return door.unlock(who, sealed, road)
      },
      forget: async (id) => door.forget(who, id, road)
    },
    vault,
    machine: 'm',
    ...(opts.codeId === undefined ? { codeId: 'code-1' } : opts.codeId === '' ? {} : { codeId: opts.codeId }),
    ...(opts.plainRemember ? { plainRemember: true } : {})
  }
  /** What the page sent, as the Mac reads it. */
  const opened = (wire: string): Record<string, unknown> => JSON.parse(openBody(pair.privateKey, UNLOCK_INFO, wire) ?? '{}') as Record<string, unknown>
  const lock = (): void => void (mac.locked = true)
  return { pair, mac, typed, remembered, idsFile, door, vault, deps, sent, opened, lock }
}

/** First unlock: typed, Remember ticked. */
const rememberOnce = async (t: ReturnType<typeof bed>) => {
  const shown = await prepareUnlock(t.deps)
  if (shown.kind !== 'ready') throw new Error('not ready')
  return runUnlock(t.deps, { shownKey: shown.key, password: PASSWORD, remember: true })
}

describe('Remember on the console', () => {
  it('is offered only on a v2 road to a Mac that remembers, with the page\'s code known', async () => {
    expect(await prepareUnlock(bed().deps)).toMatchObject({ kind: 'ready', rememberable: true, saved: false })
    expect(await prepareUnlock(bed({ v2: false }).deps)).toMatchObject({ rememberable: false })
    expect(await prepareUnlock(bed({ codeId: '' }).deps)).toMatchObject({ rememberable: false })
    // A Mac from before Remember on the console (no remember: 1 in its begin), on a v2 session.
    expect(await prepareUnlock(bed({ macRemembers: false }).deps)).toMatchObject({ rememberable: false })
  })

  it('the page\'s own client must be v2: a Mac that says it remembers is not enough', async () => {
    const t = bed()
    await rememberOnce(t)
    t.lock()
    const kept = await t.vault.boxFor('m', 'code-1')
    // The Mac sees a v2 road and says remember: 1, but this page's client is not a v2 session.
    const notV2 = bed({ clientV2: false })
    await notV2.vault.pin('m', notV2.pair.publicKey)
    await notV2.vault.keepBox('m', { box: kept?.box ?? '', id: kept?.id ?? '', code: 'code-1' })
    expect(await prepareUnlock(notV2.deps)).toMatchObject({ saved: false, rememberable: false })
    expect(await runUnlock(notV2.deps, { shownKey: notV2.pair.publicKey, password: null, remember: false })).toMatchObject({ kind: 'error' })
    expect(notV2.sent).toEqual([])
    expect(await runUnlock(notV2.deps, { shownKey: notV2.pair.publicKey, password: PASSWORD, remember: true })).toEqual({ kind: 'done' })
    expect(notV2.opened(notV2.sent[0])).not.toHaveProperty('m')
  })

  it('a box is used only with a Mac that says it remembers: one kept for a Mac that no longer can is not sent', async () => {
    const t = bed()
    await rememberOnce(t)
    const kept = await t.vault.boxFor('m', 'code-1')
    const older = bed({ macRemembers: false })
    await older.vault.pin('m', older.pair.publicKey)
    await older.vault.keepBox('m', { box: kept?.box ?? '', id: kept?.id ?? '', code: 'code-1' })
    expect(await prepareUnlock(older.deps)).toMatchObject({ saved: false })
    expect(await runUnlock(older.deps, { shownKey: older.pair.publicKey, password: null, remember: false })).toMatchObject({ kind: 'error' })
    expect(older.sent).toEqual([])
  })

  it('a box that cannot be kept after the Mac opened is still an unlock, and its id goes back to the Mac', async () => {
    const t = bed()
    const failing: UnlockFlowDeps = { ...t.deps, vault: { ...t.vault, keepBox: async () => { throw new Error('storage full') } } }
    const shown = await prepareUnlock(failing)
    if (shown.kind !== 'ready') throw new Error('not ready')
    expect(await runUnlock(failing, { shownKey: shown.key, password: PASSWORD, remember: true })).toEqual({ kind: 'done' })
    const ids = JSON.parse(readFileSync(t.idsFile, 'utf8')) as { ids: Record<string, unknown> }
    expect(Object.keys(ids.ids)).toEqual([])
  })

  it('a Mac that cannot remember is never asked to, and the console keeps nothing', async () => {
    const t = bed({ macRemembers: false })
    expect(await runUnlock(t.deps, { shownKey: t.pair.publicKey, password: PASSWORD, remember: true })).toEqual({ kind: 'done' })
    expect(t.opened(t.sent[0])).not.toHaveProperty('m')
    expect(await t.vault.boxFor('m', 'code-1')).toBeNull()
    expect(await t.vault.recall('m')).toBeNull()
  })

  it('keeps a box only the Mac opens, never the password', async () => {
    const t = bed()
    expect(await rememberOnce(t)).toEqual({ kind: 'done' })
    expect(await t.vault.recall('m')).toBeNull()
    const kept = await t.vault.boxFor('m', 'code-1')
    expect(kept).not.toBeNull()
    expect(kept?.box).not.toContain(PASSWORD)
    expect(JSON.parse(openBody(t.pair.privateKey, REMEMBER_INFO, kept?.box ?? '') ?? '{}')).toMatchObject({ p: PASSWORD, r: kept?.id })
    expect(t.remembered.live(kept?.id ?? '', who.key)).toBe(true)
    // Asked on the typed message itself, inside the seal.
    expect(t.opened(t.sent[0])).toMatchObject({ p: PASSWORD, m: 1 })
  })

  it('the next unlock sends the box in place of the password, and the Mac types what is in it', async () => {
    const t = bed()
    await rememberOnce(t)
    t.lock()
    const shown = await prepareUnlock(t.deps)
    expect(shown).toMatchObject({ trust: 'same', saved: true })
    if (shown.kind !== 'ready') throw new Error('not ready')
    expect(await runUnlock(t.deps, { shownKey: shown.key, password: null, remember: false })).toEqual({ kind: 'done' })
    const second = t.opened(t.sent[1])
    expect(second).not.toHaveProperty('p')
    expect(typeof second.b).toBe('string')
    expect(t.typed).toEqual([PASSWORD, PASSWORD])
  })

  it('a box is never sent off a v2 road, even when one is kept', async () => {
    const t = bed()
    await rememberOnce(t)
    t.lock()
    const plain = bed({ v2: false })
    const kept = await t.vault.boxFor('m', 'code-1')
    await plain.vault.pin('m', plain.pair.publicKey)
    await plain.vault.keepBox('m', { box: kept?.box ?? '', id: kept?.id ?? '', code: 'code-1' })
    expect(await prepareUnlock(plain.deps)).toMatchObject({ saved: false })
    expect(await runUnlock(plain.deps, { shownKey: plain.pair.publicKey, password: null, remember: false })).toMatchObject({ kind: 'error' })
    expect(plain.sent).toEqual([])
  })

  it('the console never keeps the password itself, not even for a Mac that cannot remember', async () => {
    const t = bed({ v2: false })
    const shown = await prepareUnlock(t.deps)
    if (shown.kind !== 'ready') throw new Error('not ready')
    expect(await runUnlock(t.deps, { shownKey: shown.key, password: PASSWORD, remember: true })).toEqual({ kind: 'done' })
    expect(await t.vault.recall('m')).toBeNull()
    expect(await t.vault.boxFor('m', 'code-1')).toBeNull()
  })

  it('a box the Mac took back (rotation, Forget at the Mac) is dropped here, and the password is asked for again', async () => {
    const t = bed()
    await rememberOnce(t)
    t.lock()
    t.remembered.clear()
    const result = await runUnlock(t.deps, { shownKey: t.pair.publicKey, password: null, remember: false })
    expect(result).toMatchObject({ kind: 'error' })
    expect(t.typed).toEqual([PASSWORD])
    expect(await t.vault.boxFor('m', 'code-1')).toBeNull()
    expect(await prepareUnlock(t.deps)).toMatchObject({ saved: false })
  })

  it('a box whose password stopped working is dropped on both ends', async () => {
    const t = bed()
    await rememberOnce(t)
    const id = (await t.vault.boxFor('m', 'code-1'))?.id ?? ''
    t.lock()
    t.mac.password = 'changed'
    expect(await runUnlock(t.deps, { shownKey: t.pair.publicKey, password: null, remember: false })).toMatchObject({ kind: 'error' })
    expect(await t.vault.boxFor('m', 'code-1')).toBeNull()
    expect(t.remembered.live(id, who.key)).toBe(false)
  })

  it('Forget drops the box here and its id at the Mac', async () => {
    const t = bed()
    await rememberOnce(t)
    const id = (await t.vault.boxFor('m', 'code-1'))?.id ?? ''
    await forgetRemembered(t.deps)
    expect(await t.vault.boxFor('m', 'code-1')).toBeNull()
    expect(t.remembered.live(id, who.key)).toBe(false)
  })

  it('a page holding another code (re-paired) does not use the box, and drops it', async () => {
    const t = bed()
    await rememberOnce(t)
    t.lock()
    const repaired: UnlockFlowDeps = { ...t.deps, codeId: 'code-2' }
    expect(await prepareUnlock(repaired)).toMatchObject({ saved: false })
    expect(await t.vault.boxFor('m', 'code-1')).toBeNull()
  })

  it('the Mac\'s own page keeps its plain Remember until lane D retires it', async () => {
    const t = bed({ v2: false, plainRemember: true })
    const shown = await prepareUnlock(t.deps)
    if (shown.kind !== 'ready') throw new Error('not ready')
    await runUnlock(t.deps, { shownKey: shown.key, password: PASSWORD, remember: true })
    expect(await t.vault.recall('m')).toBe(PASSWORD)
  })
})
