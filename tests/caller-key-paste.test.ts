import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCallerKey } from '../src/shared/caller-key'
import { AgentExportStore } from '../src/main/agent-export'
import { OwnerGrant } from '../src/main/owner-grant'

/**
 * ALL SIX WAYS A PASTE GOES WRONG (Velvet's deck §4).
 *
 * Five are caught here and cost the owner ten seconds. The sixth — a well-formed
 * key belonging to the wrong party — is not detectable and has no error, which
 * is the entire reason the fingerprint comparison exists and cannot be skipped,
 * defaulted or remembered. That asymmetry is asserted at the bottom of this file
 * rather than left as prose, because a future reader who "fixes" the missing
 * sixth check would be removing the honesty, not adding a feature.
 */

const publicKeyOf = () => generateKeyPairSync('ed25519')

describe('§4 · what arrived in the paste box', () => {
  it('accepts the shapes a counterparty actually sends', () => {
    const { publicKey } = publicKeyOf()
    const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const jwk = JSON.stringify(publicKey.export({ format: 'jwk' }))

    for (const [label, pasted] of [
      ['bare base64 SPKI', der],
      ['ed25519:-prefixed', `ed25519:${der}`],
      ['PEM public block', pem],
      ['JWK', jwk],
      ['with stray whitespace', `  ${der}\n`]
    ] as const) {
      const result = parseCallerKey(pasted)
      expect(result.ok, label).toBe(true)
      if (result.ok) expect(result.raw, label).toHaveLength(32)
    }
  })

  it('every accepted shape yields the SAME key — one person, one fingerprint', () => {
    const { publicKey } = publicKeyOf()
    const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const shapes = [der, `ed25519:${der}`, publicKey.export({ format: 'pem', type: 'spki' }).toString()]
    const raws = shapes.map((s) => {
      const r = parseCallerKey(s)
      return r.ok ? Buffer.from(r.raw).toString('hex') : 'failed'
    })
    expect(new Set(raws).size).toBe(1)
  })

  it('.notakey — that does not look like a public key', () => {
    for (const junk of ['hello there', '', '   ', 42, null, undefined, 'https://example.com/key']) {
      expect(parseCallerKey(junk as unknown), String(junk)).toEqual({
        ok: false,
        refusal: { reason: 'notakey' }
      })
    }
  })

  it('.wrongtype — NAMES the algorithm rather than saying "invalid"', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rsaResult = parseCallerKey(JSON.stringify(rsa.publicKey.export({ format: 'jwk' })))
    expect(rsaResult).toEqual({ ok: false, refusal: { reason: 'wrongtype', type: 'RSA' } })

    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const ecResult = parseCallerKey(JSON.stringify(ec.publicKey.export({ format: 'jwk' })))
    expect(ecResult.ok).toBe(false)
    if (!ecResult.ok && ecResult.refusal.reason === 'wrongtype') {
      expect(ecResult.refusal.type).toContain('P-256')
    }

    expect(parseCallerKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB')).toEqual({
      ok: false,
      refusal: { reason: 'wrongtype', type: 'RSA' }
    })

    // X25519 is an ed25519 look-alike — same family, wrong job. It must be named.
    const x = parseCallerKey(JSON.stringify({ kty: 'OKP', crv: 'X25519', x: 'AAAA' }))
    expect(x).toEqual({ ok: false, refusal: { reason: 'wrongtype', type: 'X25519' } })
  })

  it('.malformed — names the likely cause: cut off when copied', () => {
    const { publicKey } = publicKeyOf()
    const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    // A truncated SPKI: still valid base64, wrong length.
    expect(parseCallerKey(der.slice(0, 40))).toEqual({
      ok: false,
      refusal: { reason: 'malformed' }
    })
    expect(parseCallerKey(JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'AAAA' }))).toEqual({
      ok: false,
      refusal: { reason: 'malformed' }
    })
  })

  it('.private — a PRIVATE key is refused, in every shape it arrives in', () => {
    const { privateKey } = publicKeyOf()
    const shapes = [
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      JSON.stringify(privateKey.export({ format: 'jwk' })),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----'
    ]
    for (const shape of shapes) {
      expect(parseCallerKey(shape).ok).toBe(false)
      const result = parseCallerKey(shape)
      if (!result.ok) expect(result.refusal.reason).toBe('private')
    }
  })

  it('a private key is refused BEFORE any other parse can claim it', () => {
    // Order matters: a private JWK also has kty/crv, so a wrongtype or malformed
    // check running first would report the wrong thing and the owner would never
    // learn what they had just pasted into a chat window.
    const { privateKey } = publicKeyOf()
    const jwk = privateKey.export({ format: 'jwk' }) as Record<string, unknown>
    expect(jwk.d).toBeTypeOf('string')
    expect(jwk.crv).toBe('Ed25519') // it would otherwise parse happily
    const result = parseCallerKey(JSON.stringify(jwk))
    expect(result).toEqual({ ok: false, refusal: { reason: 'private' } })
  })
})

/**
 * ATLAS GATE 4 (deck §8): "A private key pasted is refused, the field is
 * cleared, and THE VALUE NEVER REACHES THE STORE — assert the store, not the
 * pixels." The field-clearing is Magpie's to drive; this is the half a unit test
 * proves better than a screenshot, because it can prove a value never arrived.
 */
describe('ATLAS gate 4 · a private key never reaches the store', () => {
  it('nothing is written, and no file is created', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-private-key-'))
    try {
      const store = new AgentExportStore(base)
      const grant = new OwnerGrant({ store })
      const { privateKey } = publicKeyOf()
      const pasted = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

      const parsed = parseCallerKey(pasted)
      expect(parsed.ok).toBe(false)
      // The surface enrols ONLY from a parsed key, so a refusal has nothing to
      // hand onward. Proven by the store's own state rather than by not calling.
      if (parsed.ok) grant.enrol('w1', 'buyer', parsed.jwk)

      expect(store.enrolledIn('w1')).toEqual([])
      const file = path.join(base, 'exports.json')
      expect(existsSync(file), 'a refused paste must not even create the file').toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('and no fragment of the private key is anywhere on disk', () => {
    // The stronger claim, and the one the owner actually cares about: not merely
    // "not enrolled" but "not written anywhere we could later leak it from".
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-private-key-'))
    try {
      const store = new AgentExportStore(base)
      const grant = new OwnerGrant({ store })
      const { privateKey, publicKey } = publicKeyOf()
      const secret = (privateKey.export({ format: 'jwk' }) as { d: string }).d

      const refused = parseCallerKey(JSON.stringify(privateKey.export({ format: 'jwk' })))
      expect(refused.ok).toBe(false)

      // A real enrolment afterwards, so the file definitely exists to search.
      const good = parseCallerKey(JSON.stringify(publicKey.export({ format: 'jwk' })))
      expect(good.ok).toBe(true)
      if (good.ok) grant.enrol('w1', 'buyer', good.jwk)

      const written = readFileSync(path.join(base, 'exports.json'), 'utf8')
      expect(written).not.toContain(secret)
      expect(written).not.toContain('"d"')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('the sixth case, which has no error and must not grow one', () => {
  it('a well-formed key from the WRONG party parses cleanly — by design', () => {
    // There is no check that can tell these apart, because there is no
    // difference to find. An attacker's key is a real key. The parser clears the
    // noise; the fingerprint comparison in §3 is the last thing standing, which
    // is why it cannot be skipped, defaulted, or remembered.
    const meant = publicKeyOf().publicKey
    const attacker = publicKeyOf().publicKey
    const asPaste = (k: typeof meant): string =>
      k.export({ format: 'der', type: 'spki' }).toString('base64')

    const a = parseCallerKey(asPaste(meant))
    const b = parseCallerKey(asPaste(attacker))
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)

    // Identical treatment, different fingerprints. The words are the only
    // thing that separates them, and only a human can do the separating.
    if (a.ok && b.ok) {
      expect(Buffer.from(a.raw).toString('hex')).not.toBe(Buffer.from(b.raw).toString('hex'))
    }
  })
})
