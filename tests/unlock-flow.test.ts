// THE ORDER OF ONE UNLOCK: trust first, send after, remember last.
import { describe, expect, it, vi } from 'vitest'
import { generateSealKeyPair, openBody } from '../src/shared/relay-seal'
import { UNLOCK_INFO, type UnlockAnswer, type UnlockBegin } from '../src/shared/remote-unlock'
import { prepareUnlock, runUnlock, type UnlockFlowDeps } from '../src/renderer/src/use/unlock-flow'
import { createUnlockVault, type VaultStore } from '../src/renderer/src/use/unlock-vault'

const memory = (): VaultStore => {
  const rows = new Map<string, unknown>()
  return { get: async (k) => rows.get(k), set: async (k, v) => void rows.set(k, v), del: async (k) => void rows.delete(k) }
}

function bed(answer: UnlockAnswer = { ok: true, outcome: 'unlocked' }) {
  const mac = generateSealKeyPair()
  const offered = { key: mac.publicKey }
  const begin = vi.fn(async (): Promise<UnlockBegin> => ({ ok: true, key: offered.key, challenge: 'c1' }))
  const send = vi.fn(async (_sealed: string) => answer)
  const vault = createUnlockVault(memory())
  const deps: UnlockFlowDeps = { api: { begin, send }, vault, machine: 'm' }
  return { mac, offered, begin, send, vault, deps }
}

describe('runUnlock', () => {
  it('seals the password and the challenge to the Mac', async () => {
    const t = bed()
    expect(await runUnlock(t.deps, { shownKey: t.mac.publicKey, password: 'pw', remember: false })).toEqual({ kind: 'done' })
    const wire = t.send.mock.calls[0][0]
    expect(wire).not.toContain('pw"')
    expect(JSON.parse(openBody(t.mac.privateKey, UNLOCK_INFO, wire) ?? '{}')).toEqual({ c: 'c1', p: 'pw' })
  })

  it('pins the key the first time', async () => {
    const t = bed()
    await runUnlock(t.deps, { shownKey: t.mac.publicKey, password: 'pw', remember: false })
    expect(await t.vault.trust('m', t.mac.publicKey)).toBe('same')
  })

  it('a changed key sends nothing, saved password or not', async () => {
    const t = bed()
    await t.vault.pin('m', 'the-old-key')
    await t.vault.remember('m', 'pw')
    expect(await runUnlock(t.deps, { shownKey: t.mac.publicKey, password: null, remember: false })).toEqual({ kind: 'changed' })
    expect(t.send).not.toHaveBeenCalled()
  })

  it('a key swapped after the reader saw it sends nothing', async () => {
    const t = bed()
    t.offered.key = generateSealKeyPair().publicKey
    expect(await runUnlock(t.deps, { shownKey: t.mac.publicKey, password: 'pw', remember: false })).toEqual({ kind: 'changed' })
    expect(t.send).not.toHaveBeenCalled()
  })

  it('remembers only when asked, and only a password that worked', async () => {
    const yes = bed()
    await runUnlock(yes.deps, { shownKey: yes.mac.publicKey, password: 'pw', remember: true })
    expect(await yes.vault.recall('m')).toBe('pw')
    const no = bed()
    await runUnlock(no.deps, { shownKey: no.mac.publicKey, password: 'pw', remember: false })
    expect(await no.vault.recall('m')).toBeNull()
    const wrong = bed({ ok: false, outcome: 'wrong', error: 'nope' })
    await runUnlock(wrong.deps, { shownKey: wrong.mac.publicKey, password: 'pw', remember: true })
    expect(await wrong.vault.recall('m')).toBeNull()
  })

  it('uses a saved password, and drops it when it stops working', async () => {
    const t = bed({ ok: false, outcome: 'wrong', error: 'That password did not open this Mac.' })
    await t.vault.pin('m', t.mac.publicKey)
    await t.vault.remember('m', 'old')
    expect(await runUnlock(t.deps, { shownKey: t.mac.publicKey, password: null, remember: false })).toEqual({ kind: 'error', message: 'That password did not open this Mac.' })
    expect(JSON.parse(openBody(t.mac.privateKey, UNLOCK_INFO, t.send.mock.calls[0][0]) ?? '{}').p).toBe('old')
    expect(await t.vault.recall('m')).toBeNull()
  })

  it('a typed password that was wrong leaves a saved one alone', async () => {
    const t = bed({ ok: false, outcome: 'wrong', error: 'no' })
    await t.vault.pin('m', t.mac.publicKey)
    await t.vault.remember('m', 'saved')
    await runUnlock(t.deps, { shownKey: t.mac.publicKey, password: 'typed', remember: false })
    expect(await t.vault.recall('m')).toBe('saved')
  })

  it('a Mac already open is done', async () => {
    const t = bed()
    t.begin.mockResolvedValue({ ok: false, outcome: 'not-locked', error: 'not locked' })
    expect(await runUnlock(t.deps, { shownKey: 'k', password: 'pw', remember: false })).toEqual({ kind: 'done' })
    expect(t.send).not.toHaveBeenCalled()
  })
})

describe('prepareUnlock', () => {
  it('says what the device knows of this Mac', async () => {
    const t = bed()
    expect(await prepareUnlock(t.deps)).toEqual({ kind: 'ready', key: t.mac.publicKey, trust: 'new', saved: false })
    await t.vault.pin('m', t.mac.publicKey)
    await t.vault.remember('m', 'pw')
    expect(await prepareUnlock(t.deps)).toMatchObject({ trust: 'same', saved: true })
  })

  it('offers no saved password to a key it does not know', async () => {
    const t = bed()
    await t.vault.pin('m', 'the-old-key')
    await t.vault.remember('m', 'pw')
    expect(await prepareUnlock(t.deps)).toMatchObject({ trust: 'changed', saved: false })
  })
})
