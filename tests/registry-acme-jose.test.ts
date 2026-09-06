import { afterAll, describe, expect, it } from 'vitest'
import { createHash, createHmac, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ACCOUNT_KEY_FILE,
  accountKey,
  derToRaw,
  dns01Digest,
  externalAccountBinding,
  keyAuthorization,
  signJws,
  thumbprintOf
} from '../registry/src/acme-jose'

/**
 * THE ACME KEY AND ITS SIGNATURES, on their own.
 *
 * The end-to-end test proves these against a CA that checks them; this file
 * pins the two things that test cannot see — that the account key is made once
 * and kept 0600, and that the External Account Binding (which no Let's Encrypt
 * order ever exercises, and which the failover to ZeroSSL will) is a real
 * HS256 JWS rather than a shape nobody has ever verified.
 */

const dirs: string[] = []
const dir = (): string => {
  const made = mkdtempSync(path.join(tmpdir(), 'acme-jose-'))
  dirs.push(made)
  return made
}

afterAll(() => {
  for (const one of dirs) rmSync(one, { recursive: true, force: true })
})

describe('the account key', () => {
  it('is made once, kept 0600, and is the same account on the way back', () => {
    const base = dir()
    const first = accountKey(base)
    expect(statSync(path.join(base, ACCOUNT_KEY_FILE)).mode & 0o777).toBe(0o600)
    expect(first.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' })

    // A SECOND CALL REUSES IT. Making a new one would silently orphan every
    // certificate the old account had ever ordered.
    const again = accountKey(base)
    expect(again.thumbprint).toBe(first.thumbprint)
    expect(again.jwk.x).toBe(first.jwk.x)

    // A different directory is a different account.
    expect(accountKey(dir()).thumbprint).not.toBe(first.thumbprint)
  })

  it('computes the RFC 7638 thumbprint over the three members, in order', () => {
    const jwk = { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'bbb' } as const
    const wanted = createHash('sha256')
      .update('{"crv":"P-256","kty":"EC","x":"aaa","y":"bbb"}', 'utf8')
      .digest()
      .toString('base64url')
    expect(thumbprintOf(jwk)).toBe(wanted)
  })
})

describe('signatures', () => {
  it('turns node’s DER pair into the r‖s ES256 wants, padding short integers', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    // Many signatures, so the case where r or s is short enough to need a
    // leading zero actually comes up rather than being hoped for.
    for (let i = 0; i < 40; i += 1) {
      const der = sign('sha256', Buffer.from(`message ${i}`), privateKey)
      const raw = derToRaw(der)
      expect(raw).not.toBeNull()
      expect(raw!.length).toBe(64)
    }
    expect(derToRaw(Uint8Array.from([1, 2, 3]))).toBeNull()
  })

  it('writes a flattened JWS whose POST-as-GET payload is empty, not "null"', () => {
    const base = dir()
    const account = accountKey(base)
    const asGet = JSON.parse(
      signJws(account.key, { alg: 'ES256', nonce: 'n', url: 'https://ca.test/authz/1', kid: 'k' }, null)
    ) as { protected: string; payload: string; signature: string }
    expect(asGet.payload).toBe('')
    const header = JSON.parse(Buffer.from(asGet.protected, 'base64url').toString('utf8')) as Record<string, unknown>
    expect(header).toMatchObject({ alg: 'ES256', nonce: 'n', kid: 'k' })
    expect(header.jwk).toBeUndefined()

    // And the signature is over `protected.payload`, verifiable by anyone.
    const raw = Buffer.from(asGet.signature, 'base64url')
    const der = Buffer.concat([
      Buffer.from([0x30, 0]),
      ...[raw.subarray(0, 32), raw.subarray(32)].map((half) => {
        const trimmed = half[0] & 0x80 ? Buffer.concat([Buffer.from([0]), half]) : half
        return Buffer.concat([Buffer.from([0x02, trimmed.length]), trimmed])
      })
    ])
    der[1] = der.length - 2
    expect(
      verify(
        'sha256',
        Buffer.from(`${asGet.protected}.`, 'utf8'),
        createPublicKey({ key: account.jwk as never, format: 'jwk' }),
        der
      )
    ).toBe(true)
  })
})

describe('the dns-01 answer and the external account binding', () => {
  it('publishes the DIGEST of the key authorisation, not the authorisation', () => {
    const thumbprint = 'a-thumbprint'
    expect(keyAuthorization('tok', thumbprint)).toBe(`tok.${thumbprint}`)
    const digest = dns01Digest('tok', thumbprint)
    expect(digest).toBe(createHash('sha256').update(`tok.${thumbprint}`, 'utf8').digest().toString('base64url'))
    // 32 bytes of base64url is 43 characters, and never a padding sign.
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(digest).not.toBe(keyAuthorization('tok', thumbprint))
  })

  it('binds an account to a CA-issued HMAC key, verifiably', () => {
    const hmacKey = Buffer.from('a shared secret from the CA').toString('base64url')
    const jwk = { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'bbb' } as const
    const url = 'https://ca.test/new-account'
    const binding = externalAccountBinding({ kid: 'kid-1', hmacKey }, jwk, url)
    const header = JSON.parse(Buffer.from(binding.protected, 'base64url').toString('utf8')) as Record<string, unknown>
    expect(header).toEqual({ alg: 'HS256', kid: 'kid-1', url })
    expect(JSON.parse(Buffer.from(binding.payload, 'base64url').toString('utf8'))).toEqual(jwk)
    const mac = createHmac('sha256', Buffer.from(hmacKey, 'base64url'))
      .update(`${binding.protected}.${binding.payload}`, 'utf8')
      .digest()
      .toString('base64url')
    expect(binding.signature).toBe(mac)
  })
})
