import { describe, expect, it } from 'vitest'
import { createHash, randomUUID, sign } from 'node:crypto'
import {
  ChallengeStore,
  parseRegistration,
  verifyAssertion,
  type StoredPasskey
} from '../registry/src/v2-passkeys'
import {
  attestationObject,
  authData as buildAuthData,
  b64u,
  cborInt,
  cborMap,
  clientData as makeClientData,
  ed25519,
  p256,
  type Pair
} from './support/webauthn'

/**
 * PASSKEYS, against real keys.
 *
 * Every fixture here is BUILT — a COSE key encoded into an authenticator data
 * blob, wrapped in an attestation object — and every signature is made by
 * node:crypto with a key pair minted in the test. Nothing is copied from a
 * browser capture, because a capture proves only that one browser once worked;
 * building the bytes proves we read the FORMAT, and signing with a real key
 * proves the verification is verification and not a shape check.
 */

const RP_ID = 'cookrew.dev'
const ORIGIN = 'https://cookrew.dev'
const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8')

/** The support module's authenticator data, with this suite's relying party. */
const authData = (input: { rpId?: string; flags: number; signCount: number; credentialId?: Buffer; cose?: Buffer }): Buffer =>
  buildAuthData({ ...input, rpId: input.rpId ?? RP_ID })

const attestation = attestationObject
const clientData = (input: { type: string; challenge: string; origin?: string }): string =>
  makeClientData({ ...input, origin: input.origin ?? ORIGIN })

const CHALLENGE = b64u(Buffer.alloc(32, 3))
const CREDENTIAL_ID = Buffer.alloc(20, 9)
const expect_ = { challenge: CHALLENGE, origin: ORIGIN, rpId: RP_ID }

const enrolled = (pair: Pair, flags = 0x41, signCount = 0): ReturnType<typeof parseRegistration> =>
  parseRegistration(
    {
      clientDataJSON: clientData({ type: 'webauthn.create', challenge: CHALLENGE }),
      attestationObject: attestation(authData({ flags, signCount, credentialId: CREDENTIAL_ID, cose: pair.cose }))
    },
    expect_
  )

/* ── registration ─────────────────────────────────────────────────────────── */

describe('passkey registration', () => {
  it('reads a P-256 credential out of an attestation object', () => {
    const pair = p256()
    const out = enrolled(pair)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.credentialId).toBe(b64u(CREDENTIAL_ID))
    expect(out.jwk).toEqual({ kty: 'EC', crv: 'P-256', x: pair.publicJwk.x, y: pair.publicJwk.y })
    expect(out.signCount).toBe(0)
  })

  it('reads an Ed25519 credential', () => {
    const pair = ed25519()
    const out = enrolled(pair)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.jwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: pair.publicJwk.x })
  })

  it('trusts the attestation statement on first use, whatever it says', () => {
    // TOFU: we do not check a manufacturer's certificate chain, so a format we
    // have never heard of is still a key we can verify assertions against.
    const pair = p256()
    const out = parseRegistration(
      {
        clientDataJSON: clientData({ type: 'webauthn.create', challenge: CHALLENGE }),
        attestationObject: attestation(
          authData({ flags: 0x41, signCount: 4, credentialId: CREDENTIAL_ID, cose: pair.cose }),
          'apple'
        )
      },
      expect_
    )
    expect(out.ok).toBe(true)
  })

  it('refuses the wrong ceremony, challenge, origin or relying party', () => {
    const pair = p256()
    const data = authData({ flags: 0x41, signCount: 0, credentialId: CREDENTIAL_ID, cose: pair.cose })
    const at = (clientDataJSON: string, attestationObject = attestation(data)) =>
      parseRegistration({ clientDataJSON, attestationObject }, expect_)
    expect(at(clientData({ type: 'webauthn.get', challenge: CHALLENGE }))).toMatchObject({ reason: 'bad_type' })
    expect(at(clientData({ type: 'webauthn.create', challenge: b64u(Buffer.alloc(32, 4)) }))).toMatchObject({
      reason: 'bad_challenge'
    })
    expect(
      at(clientData({ type: 'webauthn.create', challenge: CHALLENGE, origin: 'https://cookrew.dev.evil.test' }))
    ).toMatchObject({ reason: 'bad_origin' })
    expect(
      at(
        clientData({ type: 'webauthn.create', challenge: CHALLENGE }),
        attestation(authData({ rpId: 'evil.test', flags: 0x41, signCount: 0, credentialId: CREDENTIAL_ID, cose: pair.cose }))
      )
    ).toMatchObject({ reason: 'bad_rp' })
  })

  it('refuses a credential the person was not present for, and one with no key attached', () => {
    const pair = p256()
    expect(enrolled(pair, 0x40)).toMatchObject({ reason: 'not_present' })
    expect(
      parseRegistration(
        {
          clientDataJSON: clientData({ type: 'webauthn.create', challenge: CHALLENGE }),
          attestationObject: attestation(authData({ flags: 0x01, signCount: 0 }))
        },
        expect_
      )
    ).toMatchObject({ reason: 'no_credential' })
  })

  it('refuses a key it cannot verify with, and bytes that are not an attestation', () => {
    const rsa = cborMap([
      [1, cborInt(3)],
      [3, cborInt(-257)]
    ])
    expect(
      parseRegistration(
        {
          clientDataJSON: clientData({ type: 'webauthn.create', challenge: CHALLENGE }),
          attestationObject: attestation(authData({ flags: 0x41, signCount: 0, credentialId: CREDENTIAL_ID, cose: rsa }))
        },
        expect_
      )
    ).toMatchObject({ reason: 'unsupported_key' })
    expect(
      parseRegistration(
        { clientDataJSON: clientData({ type: 'webauthn.create', challenge: CHALLENGE }), attestationObject: 'not!base64url' },
        expect_
      )
    ).toMatchObject({ reason: 'malformed' })
    expect(
      parseRegistration({ clientDataJSON: b64u(utf8('{oops')), attestationObject: attestation(authData({ flags: 0x41, signCount: 0, credentialId: CREDENTIAL_ID, cose: p256().cose })) }, expect_)
    ).toMatchObject({ reason: 'bad_client_data' })
  })

  it('refuses an authenticator data blob that stops in the middle of a credential', () => {
    const pair = p256()
    const full = authData({ flags: 0x41, signCount: 0, credentialId: CREDENTIAL_ID, cose: pair.cose })
    expect(
      parseRegistration(
        {
          clientDataJSON: clientData({ type: 'webauthn.create', challenge: CHALLENGE }),
          attestationObject: attestation(full.subarray(0, 45))
        },
        expect_
      )
    ).toMatchObject({ reason: 'malformed' })
  })
})

/* ── assertion ────────────────────────────────────────────────────────────── */

const stored = (pair: Pair, signCount = 0): StoredPasskey => {
  const out = enrolled(pair)
  if (!out.ok) throw new Error(out.reason)
  return {
    id: randomUUID(),
    credentialId: out.credentialId,
    jwk: out.jwk,
    name: 'This Mac',
    signCount,
    addedAt: 0
  }
}

function assert_(pair: Pair, input: { signCount?: number; flags?: number; rpId?: string; origin?: string; challenge?: string } = {}) {
  const data = authData({ rpId: input.rpId, flags: input.flags ?? 0x01, signCount: input.signCount ?? 1 })
  const clientDataJSON = clientData({
    type: 'webauthn.get',
    challenge: input.challenge ?? CHALLENGE,
    origin: input.origin
  })
  const signed = Buffer.concat([data, createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest()])
  const signature = pair.alg === -8 ? sign(null, signed, pair.privateKey) : sign('sha256', signed, pair.privateKey)
  return {
    clientDataJSON,
    authenticatorData: b64u(data),
    signature: b64u(signature)
  }
}

describe('passkey assertion', () => {
  it('takes a real P-256 signature', () => {
    const pair = p256()
    const out = verifyAssertion(assert_(pair, { signCount: 5 }), stored(pair), expect_)
    expect(out).toEqual({ ok: true, signCount: 5 })
  })

  it('takes a real Ed25519 signature', () => {
    const pair = ed25519()
    expect(verifyAssertion(assert_(pair, { signCount: 2 }), stored(pair), expect_)).toEqual({ ok: true, signCount: 2 })
  })

  it('refuses a signature made by another key, and one bent by a byte', () => {
    const pair = p256()
    const other = p256()
    expect(verifyAssertion(assert_(other), stored(pair), expect_)).toMatchObject({ reason: 'bad_signature' })
    const good = assert_(pair)
    const bent = Buffer.from(good.signature, 'base64url')
    bent[bent.length - 1] ^= 0xff
    expect(verifyAssertion({ ...good, signature: b64u(bent) }, stored(pair), expect_)).toMatchObject({
      reason: 'bad_signature'
    })
  })

  it('refuses the wrong origin, the wrong relying party and an absent person', () => {
    const pair = p256()
    expect(verifyAssertion(assert_(pair, { origin: 'https://evil.test' }), stored(pair), expect_)).toMatchObject({
      reason: 'bad_origin'
    })
    expect(verifyAssertion(assert_(pair, { rpId: 'evil.test' }), stored(pair), expect_)).toMatchObject({
      reason: 'bad_rp'
    })
    expect(verifyAssertion(assert_(pair, { flags: 0x00 }), stored(pair), expect_)).toMatchObject({
      reason: 'not_present'
    })
    expect(verifyAssertion(assert_(pair, { challenge: b64u(Buffer.alloc(32, 8)) }), stored(pair), expect_)).toMatchObject(
      { reason: 'bad_challenge' }
    )
  })

  it('refuses a counter that did not move — a cloned authenticator', () => {
    const pair = p256()
    expect(verifyAssertion(assert_(pair, { signCount: 4 }), stored(pair, 4), expect_)).toMatchObject({
      reason: 'clone_warning'
    })
    expect(verifyAssertion(assert_(pair, { signCount: 3 }), stored(pair, 4), expect_)).toMatchObject({
      reason: 'clone_warning'
    })
  })

  it('accepts an authenticator that keeps no counter at all', () => {
    // Platform passkeys report 0 forever; refusing them would refuse Touch ID.
    const pair = p256()
    expect(verifyAssertion(assert_(pair, { signCount: 0 }), stored(pair, 0), expect_)).toEqual({ ok: true, signCount: 0 })
    expect(verifyAssertion(assert_(pair, { signCount: 0 }), stored(pair, 9), expect_)).toEqual({ ok: true, signCount: 9 })
  })
})

/* ── challenges ───────────────────────────────────────────────────────────── */

describe('challenges', () => {
  it('is single use, and only for the key it was issued to', () => {
    let now = 1_000_000
    const store = new ChallengeStore(120_000, 4, () => now)
    const challenge = store.issue('ip|203.0.113.9')
    expect(store.take('ip|203.0.113.9', challenge)).toBe(true)
    expect(store.take('ip|203.0.113.9', challenge)).toBe(false)
    const second = store.issue('ip|203.0.113.9')
    expect(store.take('ip|198.51.100.4', second)).toBe(false)
    expect(store.take('ip|203.0.113.9', second)).toBe(true)
  })

  it('expires, and holds only the last few per key', () => {
    let now = 1_000_000
    const store = new ChallengeStore(120_000, 2, () => now)
    const old = store.issue('me')
    now += 120_001
    expect(store.take('me', old)).toBe(false)
    const a = store.issue('me')
    const b = store.issue('me')
    const c = store.issue('me')
    expect(store.take('me', a)).toBe(false)
    expect(store.take('me', b)).toBe(true)
    expect(store.take('me', c)).toBe(true)
  })

  it('refuses a challenge that was never issued, whatever it looks like', () => {
    const store = new ChallengeStore()
    expect(store.take('me', b64u(Buffer.alloc(32, 1)))).toBe(false)
    expect(store.take('me', '')).toBe(false)
  })
})
