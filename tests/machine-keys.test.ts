import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMachineKeyStore, createRefusedMachines, enterMachines, type MachineKeysDeps } from '../src/main/machine-keys'
import { pairTranscript } from '../src/shared/account-pair'

/**
 * THE ACCOUNT'S MACHINES TRUST EACH OTHER (owner 2026-11-09, full control):
 * this machine collects a key for every other one, with its machine pass, at
 * each one's door down the relay.
 */

const store = () => createMachineKeyStore(path.join(mkdtempSync(path.join(tmpdir(), 'machine-keys-')), 'machine-keys.json'))

const deps = (over: Partial<MachineKeysDeps> = {}): MachineKeysDeps => {
  const signed: string[] = []
  return {
    self: () => ({ deviceId: 'self-id', name: 'MacBook Pro', jwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' } }),
    desktops: async () => [
      { id: 'self-id', name: 'MacBook Pro', online: true },
      { id: 'solis-id', name: 'Solis-Core', online: true },
      { id: 'away-id', name: 'Studio', online: false }
    ],
    grant: async () => 'MACHINE-PASS',
    relay: vi.fn(async (desktopId: string, route: string) =>
      route === 'api/pair/begin'
        ? { status: 200, body: { challengeId: 'c1', nonce: 'n1', desktopId, expiresAt: 1 } }
        : { status: 200, body: { ok: true, outcome: 'admitted', token: `key-for-${desktopId}`, desktopId, deviceId: 'self-id', until: 0 } }
    ),
    sign: (message: string) => (signed.push(message), `sig(${message})`),
    store: store(),
    ...over
  }
}

describe('a machine collecting keys for the account’s others', () => {
  it('enters every other online machine with its pass, signs that machine’s challenge, and keeps the key 0600', async () => {
    const d = deps()
    expect(await enterMachines(d)).toEqual(['solis-id'])
    expect(d.store.token('solis-id')).toBe('key-for-solis-id')
    expect(d.store.token('self-id')).toBeNull()
    const finish = (d.relay as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[1] === 'api/pair')
    expect(finish?.[2]).toMatchObject({
      grant: 'MACHINE-PASS',
      challengeId: 'c1',
      sig: `sig(${pairTranscript({ desktopId: 'solis-id', challengeId: 'c1', nonce: 'n1', deviceId: 'self-id' })})`
    })
    expect(statSync(d.store.file).mode & 0o777).toBe(0o600)
    expect(readFileSync(d.store.file, 'utf8')).toContain('Solis-Core')
  })

  it('a machine it already holds a key for is not asked again', async () => {
    const d = deps()
    await enterMachines(d)
    ;(d.relay as ReturnType<typeof vi.fn>).mockClear()
    expect(await enterMachines(d)).toEqual([])
    expect(d.relay).not.toHaveBeenCalled()
  })

  it('signs nothing for a machine answering in another’s name, and keeps no key it was not meant to get', async () => {
    const d = deps({
      relay: vi.fn(async () => ({ status: 200, body: { challengeId: 'c1', nonce: 'n1', desktopId: 'someone-else', expiresAt: 1 } }))
    })
    const sign = vi.spyOn(d, 'sign')
    expect(await enterMachines(d)).toEqual([])
    expect(sign).not.toHaveBeenCalled()
    expect(d.store.token('solis-id')).toBeNull()
  })

  it('a machine older than machine passes refuses; nothing is kept and the rest go on', async () => {
    const d = deps({ relay: vi.fn(async () => ({ status: 401, body: { ok: false, outcome: 'regrant', error: 'no' } })) })
    expect(await enterMachines(d)).toEqual([])
    expect(d.store.token('solis-id')).toBeNull()
  })

  it('no pass, no knocking', async () => {
    const d = deps({ grant: async () => null })
    expect(await enterMachines(d)).toEqual([])
    expect(d.relay).not.toHaveBeenCalled()
  })

  it('a machine revoked at the account is forgotten here', () => {
    const s = store()
    s.keep('solis-id', 'Solis-Core', 'k')
    s.forget(['solis-id'])
    expect(s.token('solis-id')).toBeNull()
  })
})

describe('machines forgotten on this one', () => {
  it('are remembered as refused, across a restart, until allowed again', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'machine-refused-')), 'machine-refused.json')
    const refused = createRefusedMachines(file)
    refused.add('Solis-ID')
    expect(createRefusedMachines(file).has('solis-id')).toBe(true)
    expect(refused.has('other')).toBe(false)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
