import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { readHelloReply, helloMessageV2, normaliseOrigin } from '../src/shared/hello-proof'
import { switchPlaneIfBetter, type HelloClaim, type PlaneSwitchDeps } from '../src/renderer/src/path/plane-switch'
import type { DataPlane } from '../src/renderer/src/data-plane'
import type { ReachCardLite } from '../src/renderer/src/path/switch'
import { verifyHelloClaim } from '../registry/src/hello-verify'
import { createHelloBurn } from '../registry/src/hello-nonces'

/**
 * THE CLIENT REFUSES A SIGNATURE MADE SOMEWHERE ELSE.
 *
 * The attack this file exists for, in one paragraph: a box on the LAN gets a
 * name pointed at itself. The companion dials it, sends a nonce, and the box
 * forwards the whole challenge to the real Mac and returns the real Mac's
 * answer. The device id is right, the nonce is right, the signature is real
 * and the registry — which was not on that connection — will say `{ok:true}`.
 * Version 1 has no way to notice, and the companion moves its data plane, and
 * its pairing token, to the attacker.
 *
 * The signature now names the endpoint the MAC answered at, so the relayed
 * answer says the real Mac's origin while the client knows what it dialled.
 * The test below uses a REAL Ed25519 key and a REAL registry verifier, so the
 * refusal cannot be an artefact of a stubbed signature: the claim it throws
 * away is one the registry would have blessed.
 */

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const REAL_MAC = `https://192-168-1-24.${DEVICE}.d.cookrew.dev:8643`
const ATTACKER = `https://10-0-0-9.${DEVICE}.d.cookrew.dev:8643`
const NOW = 1_800_000_000_000

const card: ReachCardLite = {
  deviceId: DEVICE,
  lan: [{ url: 'https://192.168.1.24:8643' }],
  tailnet: null,
  // The attacker's name is raced FIRST: it is the LAN name the card offers.
  trusted: [ATTACKER, REAL_MAC]
}

const RELAY: DataPlane = { origin: '', kind: 'relay' }

const mac = generateKeyPairSync('ed25519')
const jwk = mac.publicKey.export({ format: 'jwk' }) as Record<string, string>

/** A genuine answer from the real Mac, at the real Mac's own origin. */
const genuine = (nonce: string, origin = REAL_MAC, issuedAtMs = NOW) => ({
  v: 2,
  deviceId: DEVICE,
  origin,
  issuedAtMs,
  nonce,
  sig: sign(
    null,
    Buffer.from(helloMessageV2(DEVICE, origin, issuedAtMs, nonce), 'utf8'),
    mac.privateKey
  ).toString('base64url')
})

describe('a relayed answer', () => {
  it('is a claim the REGISTRY would bless — which is why the client must refuse it', () => {
    const relayed = genuine('a'.repeat(24))
    // Posted as-is, this verifies: right key, right device, fresh, unspent.
    expect(
      verifyHelloClaim({
        jwk,
        deviceId: DEVICE,
        reach: null,
        claim: relayed,
        now: NOW,
        burn: createHelloBurn(240_000)
      })
    ).toEqual({ ok: true })
  })

  it('is refused by the client, because its origin is not the one dialled', () => {
    const relayed = genuine('a'.repeat(24))
    const read = readHelloReply(relayed, {
      origin: ATTACKER,
      deviceId: DEVICE,
      nonce: 'a'.repeat(24)
    })
    expect(read).toEqual({ ok: false, reason: 'wrong_origin' })
  })

  it('never reaches the registry: the plane stays on the relay', async () => {
    let verified = 0
    let adopted: DataPlane | null = null
    const nonce = 'b'.repeat(24)
    const deps: PlaneSwitchDeps = {
      plane: () => RELAY,
      card: async () => card,
      // Whatever origin is asked, the box hands back the real Mac's answer.
      hello: async () => genuine(nonce),
      verify: async (_claim: HelloClaim) => {
        verified += 1
        return true
      },
      adopt: (plane) => void (adopted = plane),
      nonce: () => nonce
    }
    const outcome = await switchPlaneIfBetter(deps)
    // The attacker's name is refused on origin; the real Mac's name is dialled
    // next and its answer DOES match, so the honest path still wins.
    expect(outcome).toBe('switched')
    expect(adopted).toEqual({ origin: REAL_MAC, kind: 'lan' })
    // Exactly one verification: the relayed answer cost the registry nothing.
    expect(verified).toBe(1)
  })

  it('leaves the phone on the relay when the relay is all there is', async () => {
    let adopted: DataPlane | null = null
    const nonce = 'c'.repeat(24)
    const outcome = await switchPlaneIfBetter({
      plane: () => RELAY,
      card: async () => ({ ...card, trusted: [ATTACKER] }),
      hello: async () => genuine(nonce),
      verify: async () => true,
      adopt: (plane) => void (adopted = plane),
      nonce: () => nonce
    })
    expect(outcome).toBe('unreachable')
    expect(adopted).toBe(null)
  })
})

describe('what else the client throws away', () => {
  const expected = { origin: REAL_MAC, deviceId: DEVICE, nonce: 'd'.repeat(24) }

  it('refuses a version 1 answer outright — it has no origin to compare', () => {
    // A Mac on an older bundle. Its answer may be perfectly honest; there is
    // simply no way to tell it apart from the same answer relayed.
    expect(readHelloReply({ deviceId: DEVICE, nonce: expected.nonce, sig: 'x' }, expected)).toEqual({
      ok: false,
      reason: 'no_version'
    })
    expect(readHelloReply({ ...genuine(expected.nonce), v: 1 }, expected).ok).toBe(false)
  })

  it('refuses another Mac, a stale nonce, an empty signature and nothing at all', () => {
    expect(readHelloReply({ ...genuine(expected.nonce), deviceId: 'other' }, expected)).toEqual({
      ok: false,
      reason: 'wrong_device'
    })
    expect(readHelloReply({ ...genuine('e'.repeat(24)) }, expected)).toEqual({
      ok: false,
      reason: 'wrong_nonce'
    })
    expect(readHelloReply({ ...genuine(expected.nonce), sig: '' }, expected).ok).toBe(false)
    expect(readHelloReply({ ...genuine(expected.nonce), issuedAtMs: 'soon' }, expected).ok).toBe(false)
    expect(readHelloReply(null, expected)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('accepts the answer it actually dialled, and hands on exactly three fields', () => {
    const reply = genuine(expected.nonce)
    const read = readHelloReply(reply, expected)
    expect(read).toEqual({
      ok: true,
      proof: { origin: REAL_MAC, issuedAtMs: NOW, sig: reply.sig }
    })
  })

  it('treats the two spellings of a default port as one endpoint', () => {
    expect(normaliseOrigin('https://mac.test:443')).toBe(normaliseOrigin('https://mac.test'))
    const reply = genuine(expected.nonce, 'https://mac.test:443')
    expect(readHelloReply(reply, { ...expected, origin: 'https://mac.test' }).ok).toBe(true)
  })
})
