import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import {
  accountFile,
  checkHandle,
  handleIsMintable,
  mintAccount,
  writeAccount
} from '../src/main/account'
import { bindPairedDevice } from '../src/main/pair-device'
import { createSeatStore, seatsFile } from '../src/main/session-seats'

/**
 * Hardening from the 2026-09-05 security review of the identity work: a
 * phone's key is held to the shapes a phone can mint, the account and seat
 * files are written whole or not at all, and a handle that would collide with
 * the door's reserved `acct-` namespace is not mintable.
 */

const jwkOf = (pair: {
  publicKey: { export: (o: { format: 'jwk' }) => unknown }
}): Record<string, unknown> => pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>

describe('the pairing bind admits only a phone-shaped key', () => {
  const noAccount = (): null => null
  const claim = (jwk: unknown): unknown => ({
    id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    jwk,
    kind: 'phone',
    name: 'iPhone'
  })

  it('accepts Ed25519 and P-256 public keys (then reaches the account check)', async () => {
    const ed = await bindPairedDevice(claim(jwkOf(generateKeyPairSync('ed25519'))), noAccount)
    const ec = await bindPairedDevice(
      claim(jwkOf(generateKeyPairSync('ec', { namedCurve: 'P-256' }))),
      noAccount
    )
    expect(ed.status).toBe(409)
    expect(ec.status).toBe(409)
  })

  it('refuses RSA, other curves, malformed coordinates and oversized members', async () => {
    const rsa = jwkOf(generateKeyPairSync('rsa', { modulusLength: 2048 }))
    const p384 = jwkOf(generateKeyPairSync('ec', { namedCurve: 'P-384' }))
    const good = jwkOf(generateKeyPairSync('ed25519'))
    for (const bad of [
      rsa,
      p384,
      { ...good, x: 'short' },
      { ...good, x: `${good.x as string}A` },
      { ...good, crv: 'X25519' },
      { ...good, a: 1, b: 2, c: 3, d2: 4, e: 5, f: 6, g: 7 }
    ]) {
      expect((await bindPairedDevice(claim(bad), noAccount)).status).toBe(400)
    }
  })
})

describe('account and seat files are written whole', () => {
  it('writeAccount leaves no temp file and a private mode', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'identity-hardening-'))
    const keys = generateKeyPairSync('ed25519')
    writeAccount(
      {
        handle: 'mira',
        deviceId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        kind: 'desktop',
        name: 'laptop',
        privateKeyJwk: keys.privateKey.export({ format: 'jwk' }) as Record<string, unknown>,
        publicKeyJwk: jwkOf(keys),
        registry: 'https://cookrew.dev',
        mintedAt: new Date(1).toISOString()
      },
      home
    )
    const file = accountFile(home)
    expect(existsSync(file)).toBe(true)
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    rmSync(home, { recursive: true, force: true })
  })

  it('a seat file is renamed into place, never left as a temp', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'identity-hardening-seats-'))
    const store = createSeatStore(home)
    store.write('svc-team', [{ accountId: 'acct-mira', ordinals: [1], open: [] }])
    const file = seatsFile('svc-team', home)
    expect(readdirSync(path.dirname(file))).toEqual(['seats.json'])
    expect(store.read('svc-team')).toEqual([{ accountId: 'acct-mira', ordinals: [1], open: [] }])
    rmSync(home, { recursive: true, force: true })
  })
})

describe('a handle in the reserved acct- namespace is not mintable', () => {
  it('is refused before the registry is ever asked', async () => {
    expect(handleIsMintable('acct-mira')).toBe(false)
    expect(handleIsMintable('mira')).toBe(true)
    let asked = 0
    const fetch = (async () => {
      asked++
      return new Response('{}', { status: 404 })
    }) as unknown as typeof globalThis.fetch
    expect(await checkHandle('acct-mira', { registry: 'https://r.test', fetch })).toBe('invalid')
    await expect(
      mintAccount({ handle: 'acct-mira', registry: 'https://r.test', fetch, baseDir: tmpdir() })
    ).rejects.toThrow(/username/)
    expect(asked).toBe(0)
  })
})
