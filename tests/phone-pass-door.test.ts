import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccountPairDoor, type PairDoorDeps } from '../src/main/account-pair'
import { createAdmittedDeviceStore, readAdmittedDevices, type AdmittedDeviceStore } from '../src/main/admitted-devices'
import { createRefusedPhones, refusalOnForget } from '../src/main/refused-phones'
import { createV2CallTokenVerifier, verifyV2Grant } from '../src/main/v2-call-token'
import { V2Tokens } from '../registry/src/v2-tokens'
import { jwkThumbprint } from '../src/shared/jwk-thumbprint'
import { pairTranscript, type PairChallenge } from '../src/shared/account-pair'
import { fakeAccount, tempBase } from './support/idv2'
import { expectMode } from './support/file-mode'

/**
 * A TRUSTED PHONE AT A MACHINE'S DOOR (owner 2026-11-16): the native phone app
 * enters every machine of the account with its phone pass and stays until it
 * is revoked. Real passes minted by the registry's own token key, checked by
 * the app's own offline verifier; an Ed25519 key, as the Go client holds it.
 */

interface Phone {
  readonly id: string
  readonly jwk: Record<string, string>
  readonly key: KeyObject
}

const phone = (): Phone => {
  const pair = generateKeyPairSync('ed25519')
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>
  return { id: randomUUID(), jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, key: pair.privateKey }
}

const signAs = (device: Phone, message: string): string => sign(null, Buffer.from(message, 'utf8'), device.key).toString('base64url')

describe('a trusted phone at the door', () => {
  let temp: { base: string; clean: () => void }
  let keyDir: string
  let tokens: V2Tokens
  let admitted: AdmittedDeviceStore
  let clock: number
  let revoked: string[]
  let mine: Phone
  const account = fakeAccount({ username: 'anvztor' })

  const door = (over: Partial<PairDoorDeps> = {}) =>
    createAccountPairDoor({
      account: () => account,
      grants: async (token) => verifyV2Grant(token, { jwk: tokens.publicKeyJwk(), revoked }, clock),
      admitted,
      platform: 'darwin',
      now: () => clock,
      ...over
    })

  beforeEach(() => {
    temp = tempBase()
    keyDir = mkdtempSync(path.join(tmpdir(), 'phone-door-keys-'))
    clock = Date.now()
    tokens = new V2Tokens(keyDir, { now: () => clock })
    admitted = createAdmittedDeviceStore({ base: temp.base, now: () => clock })
    revoked = []
    mine = phone()
  })
  afterEach(() => {
    temp.clean()
    rmSync(keyDir, { recursive: true, force: true })
  })

  const phoneGrant = (device: Phone, since = 1_000): string =>
    tokens.mintPhoneGrant('anvztor', device.id, jwkThumbprint(device.jwk) as string, 'sitting-1', since).token

  const asking = (device: Phone, grant: string) => ({ device: { deviceId: device.id, jwk: device.jwk, name: 'iPhone' }, grant })

  const enter = async (d: ReturnType<typeof door>, grant: string, device: Phone = mine) => {
    const begun = await d.begin({ body: asking(device, grant), bridged: null })
    if (begun.status !== 200) return begun
    const challenge = begun.body as PairChallenge
    const sig = signAs(device, pairTranscript({ desktopId: challenge.desktopId, challengeId: challenge.challengeId, nonce: challenge.nonce, deviceId: device.id }))
    return d.finish({ body: { ...asking(device, grant), challengeId: challenge.challengeId, sig }, bridged: null })
  }

  it('admits the phone as a device of this machine, with no end but its revocation', async () => {
    const out = await enter(door(), phoneGrant(mine))
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, outcome: 'admitted', deviceId: mine.id, until: 0 })
    // A device's token, not a watch's: the phone is the whole app.
    expect((out.body as { scope?: string }).scope).toBeUndefined()
    const row = admitted.list()[0]
    expect(row).toMatchObject({ deviceId: mine.id, via: 'phone', sid: 'sitting-1', since: 1_000 })
    expect(row.until).toBeUndefined()
    // Long after the pass that let it in has run out, its token still opens this Mac.
    clock += 30 * 24 * 60 * 60 * 1000
    expect(admitted.accepts((out.body as { token: string }).token)).toBe(true)
  })

  it('the row is read back from the file as written', async () => {
    await enter(door(), phoneGrant(mine))
    expect(readAdmittedDevices(temp.base)[0]).toMatchObject({ via: 'phone', since: 1_000 })
  })

  it('revoked at cookrew.dev — the phone, or the sign-in it came from — it goes', async () => {
    await enter(door(), phoneGrant(mine))
    expect(admitted.prune([mine.id]).map((x) => x.deviceId)).toEqual([mine.id])
    await enter(door(), phoneGrant(mine))
    expect(admitted.prune(['sitting-1']).map((x) => x.deviceId)).toEqual([mine.id])
    expect(admitted.list()).toEqual([])
  })

  it('a revoked phone, or one whose sign-in ended, is turned away before a challenge', async () => {
    const grant = phoneGrant(mine)
    revoked = [mine.id]
    expect((await door().begin({ body: asking(mine, grant), bridged: null })).body).toMatchObject({ outcome: 'regrant' })
    revoked = ['sitting-1']
    expect((await door().begin({ body: asking(mine, grant), bridged: null })).body).toMatchObject({ outcome: 'regrant' })
  })

  it('a stolen pass is useless without the phone’s key', async () => {
    const thief = phone()
    const d = door()
    const grant = phoneGrant(mine)
    const begun = await d.begin({ body: asking(mine, grant), bridged: null })
    const challenge = begun.body as PairChallenge
    const sig = signAs(thief, pairTranscript({ desktopId: challenge.desktopId, challengeId: challenge.challengeId, nonce: challenge.nonce, deviceId: mine.id }))
    const out = await d.finish({ body: { ...asking(mine, grant), challengeId: challenge.challengeId, sig }, bridged: null })
    expect(out.status).toBe(401)
    expect(admitted.list()).toEqual([])
  })

  describe('a phone forgotten here', () => {
    let refusedFile: string
    beforeEach(() => {
      refusedFile = path.join(temp.base, 'phone-refused.json')
    })

    it('stays out on the pass it was forgotten under, however good that pass is', async () => {
      const refused = createRefusedPhones(refusedFile)
      refused.add(mine.id, 1_000)
      const out = await enter(door({ refusedPhone: refused.refuses }), phoneGrant(mine, 1_000))
      expect(out.status).toBe(403)
      expect(admitted.list()).toEqual([])
    })

    it('comes back once it joined the account again with a new phone’s code', async () => {
      const refused = createRefusedPhones(refusedFile)
      refused.add(mine.id, 1_000)
      const out = await enter(door({ refusedPhone: refused.refuses }), phoneGrant(mine, 2_000))
      expect(out.status).toBe(200)
      expect(admitted.list()[0]).toMatchObject({ via: 'phone', since: 2_000 })
    })

    it('keeps another phone out of nothing', async () => {
      const refused = createRefusedPhones(refusedFile)
      refused.add(randomUUID(), 5_000)
      expect((await enter(door({ refusedPhone: refused.refuses }), phoneGrant(mine))).status).toBe(200)
    })

    it('is remembered across a restart, in a file only this user reads, and bounded', async () => {
      createRefusedPhones(refusedFile).add(mine.id, 1_000)
      expect(createRefusedPhones(refusedFile).refuses(mine.id, 1_000)).toBe(true)
      expect(createRefusedPhones(refusedFile).refuses(mine.id.toUpperCase(), 999)).toBe(true)
      expectMode(refusedFile, 0o600)
      const many = createRefusedPhones(refusedFile)
      for (let i = 0; i < 300; i++) many.add(randomUUID(), i)
      // The newest forgetting is never the one dropped; the oldest (this phone, first in) is.
      const last = randomUUID()
      many.add(last, 7)
      expect(many.refuses(last, 7)).toBe(true)
      expect(many.refuses(mine.id, 1_000)).toBe(false)
      const { readFileSync } = await import('node:fs')
      expect(Object.keys(JSON.parse(readFileSync(refusedFile, 'utf8'))).length).toBeLessThanOrEqual(256)
    })

    it('forgetting any device but a machine keeps its phone passes out: a trusted phone last let in on a proved pass too', () => {
      const at = 50_000
      expect(refusalOnForget({ deviceId: mine.id, admittedAt: 1, lastSeenAt: 1, via: 'phone', since: 1_000 }, at)).toBe(1_000)
      // A row from an ordinary pass names no trusted moment: everything up to now is kept out.
      expect(refusalOnForget({ deviceId: mine.id, admittedAt: 1, lastSeenAt: 1, via: 'account', until: 9 }, at)).toBe(at)
      expect(refusalOnForget({ deviceId: mine.id, admittedAt: 1, lastSeenAt: 1 }, at)).toBe(at)
      // A machine has its own list, kept for good (machine-keys.ts).
      expect(refusalOnForget({ deviceId: mine.id, admittedAt: 1, lastSeenAt: 1, via: 'machine' }, at)).toBeNull()
      expect(refusalOnForget(undefined, at)).toBeNull()
    })

    it('an unreadable file refuses nobody and never throws', async () => {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(refusedFile, '{not json')
      expect(createRefusedPhones(refusedFile).refuses(mine.id, 1)).toBe(false)
    })
  })
})

describe('the offline verifier reads a phone pass', () => {
  it('refetches the revoked list on a cached revoked hit, for a phone pass as for a grant', async () => {
    const keyDir = mkdtempSync(path.join(tmpdir(), 'phone-verify-'))
    try {
      const tokens = new V2Tokens(keyDir)
      const device = phone()
      const grant = tokens.mintPhoneGrant('anvztor', device.id, jwkThumbprint(device.jwk) as string, 'sitting-9', 42).token
      const lists: string[][] = [[device.id], []]
      let fetched = 0
      const verifier = createV2CallTokenVerifier({
        keys: { fetch: async () => ({ jwk: tokens.publicKeyJwk(), revoked: lists[Math.min(fetched++, lists.length - 1)] }) }
      })
      // The cached list says revoked; the fresh one (the owner un-revoked nothing, the cache was simply behind) lets it through.
      const out = await verifier.grant(grant)
      expect(fetched).toBe(2)
      expect(out).toMatchObject({ dev: device.id, phone: true, since: 42 })
    } finally {
      rmSync(keyDir, { recursive: true, force: true })
    }
  })
})
