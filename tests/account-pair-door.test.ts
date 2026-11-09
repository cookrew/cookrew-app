import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccountPairDoor, type PairDoorDeps } from '../src/main/account-pair'
import { createAdmittedDeviceStore, type AdmittedDeviceStore } from '../src/main/admitted-devices'
import type { PairAnchors } from '../src/main/pair-anchors'
import { memoryPins, type PinStore } from '../src/main/account-pair-pins'
import { createHash } from 'node:crypto'
import {
  ACCOUNT_PAIR_INFO,
  ACCOUNT_PAIR_REST_MS,
  ACCOUNT_PAIR_STOP_MS,
  pairDeviceMessage,
  pairProofDigestInput,
  pairTranscript,
  sealedPasswordPlaintext,
  type PairProof,
  type PairChallenge
} from '../src/shared/account-pair'
import { packBody } from '../src/shared/relay-seal'
import { fakeAccount, tempBase } from './support/idv2'
import { b64u, ed25519, getAssertion, GET_FLAGS, GET_FLAGS_VERIFIED, type Pair } from './support/webauthn'

/**
 * ENTERING A MACHINE WITH THE ACCOUNT (owner 2026-11-09): the door, alone.
 *
 * Everything the machine decides is decided here, against real keys: a real
 * scrypt record from the registry's own hasher, a P-256 browser device key, a
 * passkey signed by node:crypto. The routes and the browser have their own
 * files; this one is the rules.
 */

const PASSWORD = 'correct horse battery staple'
const ORIGIN = 'https://cookrew.dev'
const RP_ID = 'cookrew.dev'

interface Phone {
  readonly id: string
  readonly jwk: Record<string, string>
  readonly key: KeyObject
}

/** A browser's device key as site.js mints it: P-256, signing r‖s. */
const phone = (): Phone => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>
  return { id: randomUUID(), jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, key: pair.privateKey }
}

const digest = (proof: PairProof): string => createHash('sha256').update(pairProofDigestInput(proof)).digest('base64url')

const signAs = (device: Phone, message: string): string =>
  b64u(sign('sha256', Buffer.from(message, 'utf8'), { key: device.key, dsaEncoding: 'ieee-p1363' }))

const CREDENTIAL = Buffer.from('passkey-credential-1')

describe('the account pair door', () => {
  let temp: { base: string; clean: () => void }
  let admitted: AdmittedDeviceStore
  let clock: number
  let anchors: PairAnchors | null
  let passkey: Pair
  let mine: Phone
  let lines: string[]
  let pins: PinStore
  // fakeAccount's verifier is of PASSWORD: a machine where the account password was typed.
  const account = fakeAccount({ username: 'anvztor' })

  const door = (over: Partial<PairDoorDeps> = {}) =>
    createAccountPairDoor({
      account: () => account,
      anchors: async () => anchors,
      localPassword: () => account.unlock,
      pins,
      admitted,
      origins: () => [ORIGIN],
      platform: 'linux',
      now: () => clock,
      log: (line) => lines.push(line),
      ...over
    })

  beforeEach(async () => {
    temp = tempBase()
    admitted = createAdmittedDeviceStore({ base: temp.base, now: () => clock })
    clock = 1_800_000_000_000
    lines = []
    passkey = ed25519()
    mine = phone()
    pins = memoryPins()
    anchors = {
      username: 'anvztor',
      rpId: RP_ID,
      locked: false,
      passkeys: [{ credentialId: b64u(CREDENTIAL), jwk: passkey.publicJwk, signCount: 0 }],
      devices: [{ id: mine.id, jwk: mine.jwk }]
    }
  })
  afterEach(() => temp.clean())

  const begin = async (d: ReturnType<typeof door>, device: Phone = mine, bridged: { deviceId: string } | null = null) => {
    const out = await d.begin({ body: { deviceId: device.id }, bridged })
    return out
  }

  const transcript = (challenge: PairChallenge, device: Phone = mine): string =>
    pairTranscript({ desktopId: challenge.desktopId, challengeId: challenge.challengeId, nonce: challenge.nonce, deviceId: device.id })

  const signed = (challenge: PairChallenge, proof: PairProof, device: Phone) => ({
    challengeId: challenge.challengeId,
    device: { deviceId: device.id, jwk: device.jwk, name: 'iPhone' },
    sig: signAs(device, pairDeviceMessage(transcript(challenge, device), digest(proof))),
    proof
  })

  const withPassword = (challenge: PairChallenge, password: string, device: Phone = mine, sealFor = challenge.challengeId) =>
    signed(challenge, { kind: 'password', sealed: packBody(challenge.key, ACCOUNT_PAIR_INFO, sealedPasswordPlaintext(sealFor, password)) }, device)

  const withPasskey = (challenge: PairChallenge, flags = GET_FLAGS_VERIFIED, origin = ORIGIN, device: Phone = mine) => {
    const asserted = getAssertion({
      pair: passkey,
      credentialId: CREDENTIAL,
      challenge: challenge.passkey?.challenge ?? '',
      origin,
      rpId: RP_ID,
      flags
    })
    return signed(challenge, { kind: 'passkey', credential: { id: asserted.id, ...asserted.response } }, device)
  }

  const challengeOf = async (d: ReturnType<typeof door>, device: Phone = mine): Promise<PairChallenge> => {
    const out = await begin(d, device)
    expect(out.status).toBe(200)
    return out.body as PairChallenge
  }

  it('offers both ways in, and says which machine this is', async () => {
    const offer = await door().offer()
    expect(offer).toEqual({ offered: true, reachable: true, desktopId: account.deviceId, platform: 'linux', methods: ['password', 'passkey'] })
  })

  it('offers nothing without an account, nothing with nothing to check against, and says when it cannot read the account', async () => {
    expect((await door({ account: () => null }).offer()).offered).toBe(false)
    anchors = { ...(anchors as PairAnchors), passkeys: [] }
    expect(await door({ localPassword: () => null }).offer()).toMatchObject({ offered: false, reachable: true })
    anchors = null
    expect(await door().offer()).toMatchObject({ offered: false, reachable: false })
  })

  it('checks a password only against this machine’s own verifier: cookrew.dev supplies no record', async () => {
    const d = door({ localPassword: () => null })
    const challenge = await challengeOf(d)
    expect(challenge.methods).toEqual(['passkey'])
    const out = await d.finish({ body: withPassword(challenge, PASSWORD), bridged: null })
    expect(out.status).toBe(409)
    expect(admitted.list()).toEqual([])
  })

  it('admits a device that brings the account password, sealed, and hands it its own token', async () => {
    const d = door()
    const challenge = await challengeOf(d)
    expect(challenge.methods).toEqual(['password', 'passkey'])
    expect(challenge.passkey?.allow).toEqual([b64u(CREDENTIAL)])
    const out = await d.finish({ body: withPassword(challenge, PASSWORD), bridged: null })
    expect(out.status).toBe(200)
    const answer = out.body as { ok: true; token: string; deviceId: string; desktopId: string }
    expect(answer.ok).toBe(true)
    expect(answer.deviceId).toBe(mine.id)
    expect(answer.desktopId).toBe(account.deviceId)
    expect(admitted.deviceFor(answer.token)).toBe(mine.id)
    expect(admitted.list()[0]).toMatchObject({ deviceId: mine.id, name: 'iPhone', via: 'password' })
  })

  it('admits a device that answers with one of the account passkeys, verified by a person', async () => {
    const d = door()
    const out = await d.finish({ body: withPasskey(await challengeOf(d)), bridged: null })
    expect(out.status).toBe(200)
    expect(admitted.list()[0]).toMatchObject({ deviceId: mine.id, via: 'passkey' })
  })

  it('refuses a passkey that was only tapped, not verified', async () => {
    const d = door()
    const out = await d.finish({ body: withPasskey(await challengeOf(d), GET_FLAGS), bridged: null })
    expect(out.status).toBe(401)
    expect(admitted.list()).toEqual([])
  })

  it('refuses a passkey answer made on a page this machine does not name', async () => {
    const d = door()
    const out = await d.finish({ body: withPasskey(await challengeOf(d), GET_FLAGS_VERIFIED, 'https://evil.example'), bridged: null })
    expect(out.status).toBe(401)
    expect(admitted.list()).toEqual([])
  })

  it('spends a challenge once: the same proof twice admits once', async () => {
    const d = door()
    const challenge = await challengeOf(d)
    const body = withPassword(challenge, PASSWORD)
    expect((await d.finish({ body, bridged: null })).status).toBe(200)
    const again = await d.finish({ body, bridged: null })
    expect(again.status).toBe(401)
    expect((again.body as { outcome: string }).outcome).toBe('refused')
  })

  it('binds the proof to the device it was issued for: another account device cannot spend it', async () => {
    const other = phone()
    anchors = { ...(anchors as PairAnchors), devices: [...(anchors as PairAnchors).devices, { id: other.id, jwk: other.jwk }] }
    const d = door()
    const challenge = await challengeOf(d)
    const stolen = withPassword(challenge, PASSWORD, other)
    const out = await d.finish({ body: stolen, bridged: null })
    expect(out.status).toBe(401)
    expect(admitted.list()).toEqual([])
  })

  it('refuses a key that is not the account key for that device id', async () => {
    const d = door()
    const challenge = await challengeOf(d)
    const impostor = { ...phone(), id: mine.id }
    const out = await d.finish({ body: withPassword(challenge, PASSWORD, impostor), bridged: null })
    expect(out.status).toBe(403)
    expect(admitted.list()).toEqual([])
  })

  it('refuses a device the account does not hold, before any secret is asked for', async () => {
    const stranger = phone()
    const out = await begin(door(), stranger)
    expect(out.status).toBe(403)
  })

  it('down the relay, the device must be the one cookrew.dev signed in', async () => {
    const d = door()
    const wrongStamp = await d.begin({ body: { deviceId: mine.id }, bridged: { deviceId: randomUUID() } })
    expect(wrongStamp.status).toBe(401)
    const right = await d.begin({ body: { deviceId: mine.id }, bridged: { deviceId: mine.id } })
    expect(right.status).toBe(200)
    const out = await d.finish({ body: withPassword(right.body as PairChallenge, PASSWORD), bridged: { deviceId: mine.id } })
    expect(out.status).toBe(200)
  })

  it('a session alone opens nothing: the stamp and the key without the secret are a wrong try', async () => {
    const d = door()
    const out = await d.finish({ body: withPassword(await challengeOf(d), 'not the password at all'), bridged: { deviceId: mine.id } })
    expect(out.status).toBe(401)
    expect(out.body).toMatchObject({ ok: false, outcome: 'wrong', triesLeft: 2 })
    expect(admitted.list()).toEqual([])
  })

  it('refuses a device signature that does not open, and does not count it as a guess', async () => {
    const d = door()
    const challenge = await challengeOf(d)
    const body = { ...withPassword(challenge, 'wrong wrong wrong'), sig: signAs(mine, 'some other line') }
    const out = await d.finish({ body, bridged: null })
    expect(out.status).toBe(401)
    expect(out.body).toMatchObject({ outcome: 'refused' })
    // Still three tries left: nothing secret was guessed.
    const next = await d.finish({ body: withPassword(await challengeOf(d), 'wrong wrong wrong'), bridged: null })
    expect(next.body).toMatchObject({ outcome: 'wrong', triesLeft: 2 })
  })

  it('refuses a password sealed for another challenge', async () => {
    const d = door()
    const challenge = await challengeOf(d)
    const out = await d.finish({ body: withPassword(challenge, PASSWORD, mine, 'another-challenge'), bridged: null })
    expect(out.status).toBe(401)
    expect(out.body).toMatchObject({ outcome: 'refused' })
  })

  it('three wrong passwords rest the device for a minute, then it may try again', async () => {
    const d = door()
    for (const left of [2, 1]) {
      const out = await d.finish({ body: withPassword(await challengeOf(d), 'wrong password one'), bridged: null })
      expect(out.body).toMatchObject({ outcome: 'wrong', triesLeft: left })
    }
    const third = await d.finish({ body: withPassword(await challengeOf(d), 'wrong password one'), bridged: null })
    expect(third.status).toBe(429)
    expect(third.body).toMatchObject({ outcome: 'resting', retryAfterMs: ACCOUNT_PAIR_REST_MS })
    const resting = await begin(d)
    expect(resting.status).toBe(429)
    clock += ACCOUNT_PAIR_REST_MS + 1
    const out = await d.finish({ body: withPassword(await challengeOf(d), PASSWORD), bridged: null })
    expect(out.status).toBe(200)
  })

  it('nine wrong in a row across devices rest the whole door for fifteen minutes, and a restart remembers', async () => {
    let held = 0
    let until = 0
    const misses = { read: () => ({ count: held, until }), write: (next: { count: number; until: number }) => ((held = next.count), (until = next.until)) }
    const phones = [mine, phone(), phone(), phone()]
    anchors = { ...(anchors as PairAnchors), devices: phones.map((p) => ({ id: p.id, jwk: p.jwk })) }
    const d = door({ misses })
    // Each device rests after three; step past the minute between them.
    const step = (): void => void (clock += 61_000)
    for (const device of phones.slice(0, 3)) {
      for (let i = 0; i < 3; i += 1) {
        await d.finish({ body: withPassword(await challengeOf(d, device), 'wrong password two', device), bridged: null })
      }
      if (device !== phones[2]) step()
    }
    // The stop starts and the count starts over: nine more are needed for the next one.
    expect(held).toBe(0)
    expect(until).toBe(clock + ACCOUNT_PAIR_STOP_MS)
    const fresh = door({ misses })
    const stopped = await begin(fresh, phones[3])
    expect(stopped.status).toBe(429)
    expect((stopped.body as { retryAfterMs: number }).retryAfterMs).toBe(ACCOUNT_PAIR_STOP_MS)
    clock += ACCOUNT_PAIR_STOP_MS + 1
    const wrongAfter = await fresh.finish({ body: withPassword(await challengeOf(fresh, phones[3]), 'still wrong now', phones[3]), bridged: null })
    expect(wrongAfter.body).toMatchObject({ outcome: 'wrong', triesLeft: 2 })
    const out = await fresh.finish({ body: withPassword(await challengeOf(fresh, phones[3]), PASSWORD, phones[3]), bridged: null })
    expect(out.status).toBe(200)
    expect(held).toBe(0)
  })

  it('says it cannot check when the registry cannot be read, and admits nothing', async () => {
    anchors = null
    const out = await begin(door())
    expect(out.status).toBe(503)
    expect(out.body).toMatchObject({ outcome: 'unavailable' })
  })

  it('an expired challenge opens nothing', async () => {
    const d = door()
    const challenge = await challengeOf(d)
    clock = challenge.expiresAt + 1
    const out = await d.finish({ body: withPassword(challenge, PASSWORD), bridged: null })
    expect(out.status).toBe(401)
    expect(admitted.list()).toEqual([])
  })

  it('never writes the password into a log line', async () => {
    const d = door()
    await d.finish({ body: withPassword(await challengeOf(d), 'a wrong one here!'), bridged: null })
    await d.finish({ body: withPassword(await challengeOf(d), PASSWORD), bridged: null })
    const all = lines.join('\n')
    expect(all).not.toContain(PASSWORD)
    expect(all).not.toContain('a wrong one here!')
    expect(all).toMatch(/admitted/)
  })

  it('runs one secret check at a time: a burst of finishes is not a burst of guesses', async () => {
    const d = door()
    const bodies = []
    for (let i = 0; i < 5; i += 1) {
      const other = phone()
      anchors = { ...(anchors as PairAnchors), devices: [...(anchors as PairAnchors).devices, { id: other.id, jwk: other.jwk }] }
      bodies.push(withPassword(await challengeOf(d, other), `burst guess ${i}`, other))
    }
    const answers = await Promise.all(bodies.map((body) => d.finish({ body, bridged: null })))
    const statuses = answers.map((a) => a.status).sort()
    // One was checked (a wrong password); the others were turned away unchecked.
    expect(statuses).toEqual([401, 429, 429, 429, 429])
  })

  it('a proof swapped in under a real signature is refused', async () => {
    const d = door()
    const challenge = await challengeOf(d)
    const real = withPassword(challenge, 'what the phone typed')
    const swapped = { ...real, proof: { kind: 'password', sealed: packBody(challenge.key, ACCOUNT_PAIR_INFO, sealedPasswordPlaintext(challenge.challengeId, PASSWORD)) } }
    const out = await d.finish({ body: swapped, bridged: null })
    expect(out.status).toBe(401)
    expect(out.body).toMatchObject({ outcome: 'refused' })
    expect(admitted.list()).toEqual([])
  })

  it('a passkey cookrew.dev adds after the first read opens nothing until someone here re-pins', async () => {
    const d = door()
    await challengeOf(d)
    expect(pins.read()?.passkeys.map((p) => p.credentialId)).toEqual([b64u(CREDENTIAL)])
    // The registry swaps in a key of its own under the same credential id.
    const planted = ed25519()
    const honest = passkey
    anchors = { ...(anchors as PairAnchors), passkeys: [{ credentialId: b64u(CREDENTIAL), jwk: planted.publicJwk, signCount: 0 }] }
    passkey = planted
    const challenge = await challengeOf(d)
    expect(challenge.passkey).toBeNull()
    const refused = await d.finish({ body: withPasskey({ ...challenge, passkey: { rpId: RP_ID, challenge: 'x', allow: [] } }), bridged: null })
    expect(refused.status).toBe(401)
    expect(admitted.list()).toEqual([])
    // Somebody at the machine runs `cookrew mobile --repin`.
    expect(await d.repin()).toEqual({ added: [], removed: [] })
    const out = await d.finish({ body: withPasskey(await challengeOf(d)), bridged: null })
    expect(out.status).toBe(200)
    passkey = honest
  })

  it('a passkey taken off the account stops opening at once', async () => {
    const d = door()
    await challengeOf(d)
    anchors = { ...(anchors as PairAnchors), passkeys: [] }
    const challenge = await challengeOf(d)
    expect(challenge.passkey).toBeNull()
    expect(challenge.methods).toEqual(['password'])
  })

  it('refuses everything while the account is locked down after "Not me"', async () => {
    anchors = { ...(anchors as PairAnchors), locked: true }
    expect((await begin(door())).status).toBe(423)
    expect((await door().offer()).offered).toBe(false)
  })

  it('the machine’s own id is not a device that may ask', async () => {
    anchors = { ...(anchors as PairAnchors), devices: [...(anchors as PairAnchors).devices, { id: account.deviceId, jwk: mine.jwk }] }
    const out = await door().begin({ body: { deviceId: account.deviceId }, bridged: null })
    expect(out.status).toBe(400)
  })
})
