import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccountPairDoor, type PairDoorDeps } from '../src/main/account-pair'
import { createAdmittedDeviceStore, type AdmittedDeviceStore } from '../src/main/admitted-devices'
import { verifyV2Grant } from '../src/main/v2-call-token'
import { V2Tokens, GRANT_TTL_MS } from '../registry/src/v2-tokens'
import { jwkThumbprint } from '../src/shared/jwk-thumbprint'
import { pairTranscript, type PairChallenge } from '../src/shared/account-pair'
import { fakeAccount, tempBase } from './support/idv2'

/**
 * ENTERING A MACHINE WITH THE ACCOUNT'S PASS (owner 2026-11-09): the door, alone.
 *
 * Real grants minted by the registry's own token key, checked by the app's own
 * offline verifier; a P-256 browser key signing r‖s as WebCrypto does.
 */

interface Phone {
  readonly id: string
  readonly jwk: Record<string, string>
  readonly key: KeyObject
}

const phone = (): Phone => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>
  return { id: randomUUID(), jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, key: pair.privateKey }
}

const signAs = (device: Phone, message: string): string =>
  sign('sha256', Buffer.from(message, 'utf8'), { key: device.key, dsaEncoding: 'ieee-p1363' }).toString('base64url')

describe('the account pair door', () => {
  let temp: { base: string; clean: () => void }
  let keyDir: string
  let tokens: V2Tokens
  let admitted: AdmittedDeviceStore
  let clock: number
  let revoked: string[]
  let lines: string[]
  let mine: Phone
  const account = fakeAccount({ username: 'anvztor' })

  const door = (over: Partial<PairDoorDeps> = {}) =>
    createAccountPairDoor({
      account: () => account,
      grants: async (token) => verifyV2Grant(token, { jwk: tokens.publicKeyJwk(), revoked }, clock),
      admitted,
      platform: 'linux',
      now: () => clock,
      log: (line) => lines.push(line),
      ...over
    })

  beforeEach(() => {
    temp = tempBase()
    keyDir = mkdtempSync(path.join(tmpdir(), 'pair-door-keys-'))
    clock = Date.now()
    tokens = new V2Tokens(keyDir, { now: () => clock })
    admitted = createAdmittedDeviceStore({ base: temp.base, now: () => clock })
    revoked = []
    lines = []
    mine = phone()
  })
  afterEach(() => {
    temp.clean()
    rmSync(keyDir, { recursive: true, force: true })
  })

  const grantFor = (device: Phone, username = 'anvztor', key: Record<string, string> = device.jwk): string =>
    tokens.mintGrant(username, device.id, jwkThumbprint(key) as string).token

  const asking = (device: Phone, grant: string) => ({ device: { deviceId: device.id, jwk: device.jwk, name: 'iPhone' }, grant })

  const challengeOf = async (d: ReturnType<typeof door>, device: Phone = mine, grant = grantFor(device)): Promise<PairChallenge> => {
    const out = await d.begin({ body: asking(device, grant), bridged: null })
    expect(out.status).toBe(200)
    return out.body as PairChallenge
  }

  const finishBody = (challenge: PairChallenge, device: Phone = mine, grant = grantFor(device), signer: Phone = device) => ({
    ...asking(device, grant),
    challengeId: challenge.challengeId,
    sig: signAs(signer, pairTranscript({ desktopId: challenge.desktopId, challengeId: challenge.challengeId, nonce: challenge.nonce, deviceId: device.id }))
  })

  it('offers itself to the account, in the machine’s own word', () => {
    expect(door().offer()).toEqual({ offered: true, desktopId: account.deviceId, platform: 'linux' })
    expect(door({ account: () => null }).offer().offered).toBe(false)
  })

  it('admits a device holding a pass, on a fresh signature from the key it names, until the pass runs out', async () => {
    const d = door()
    const grant = grantFor(mine)
    const out = await d.finish({ body: finishBody(await challengeOf(d, mine, grant), mine, grant), bridged: null })
    expect(out.status).toBe(200)
    const answer = out.body as { token: string; until: number; desktopId: string }
    expect(answer.desktopId).toBe(account.deviceId)
    expect(answer.until).toBe(clock + GRANT_TTL_MS)
    expect(admitted.deviceFor(answer.token)).toBe(mine.id)
    expect(admitted.list()[0]).toMatchObject({ deviceId: mine.id, name: 'iPhone', via: 'account', until: clock + GRANT_TTL_MS })
    // Twelve hours on, the token opens nothing.
    clock += GRANT_TTL_MS + 1
    expect(admitted.deviceFor(answer.token)).toBeNull()
  })

  it('one pass opens a second machine with no new proof', async () => {
    const grant = grantFor(mine)
    for (const desk of [fakeAccount({ username: 'anvztor' }), fakeAccount({ username: 'anvztor' })]) {
      const d = door({ account: () => desk })
      const out = await d.finish({ body: finishBody(await challengeOf(d, mine, grant), mine, grant), bridged: null })
      expect(out.status).toBe(200)
    }
  })

  it('a session with no pass gets no challenge at all', async () => {
    const out = await door().begin({ body: asking(mine, 'not-a-grant'), bridged: null })
    expect(out.status).toBe(401)
    expect(out.body).toMatchObject({ outcome: 'regrant' })
  })

  it('a pass for another key, another device or another account opens nothing', async () => {
    const other = phone()
    const d = door()
    expect((await d.begin({ body: asking(mine, grantFor(mine, 'anvztor', other.jwk)), bridged: null })).body).toMatchObject({ outcome: 'regrant' })
    expect((await d.begin({ body: asking(mine, grantFor(other)), bridged: null })).body).toMatchObject({ outcome: 'regrant' })
    const elsewhere = await d.begin({ body: asking(mine, grantFor(mine, 'someoneelse')), bridged: null })
    expect(elsewhere.status).toBe(403)
  })

  it('an expired pass, or one whose device was taken off the account, asks for a new pass', async () => {
    const d = door()
    const grant = grantFor(mine)
    clock += GRANT_TTL_MS + 1
    expect((await d.begin({ body: asking(mine, grant), bridged: null })).body).toMatchObject({ outcome: 'regrant' })
    clock -= GRANT_TTL_MS + 1
    const challenge = await challengeOf(d, mine, grant)
    revoked = [mine.id]
    const out = await d.finish({ body: finishBody(challenge, mine, grant), bridged: null })
    expect(out.body).toMatchObject({ outcome: 'regrant' })
    expect(admitted.list()).toEqual([])
  })

  it('a stolen pass is useless without the key: the signature must be the named key’s', async () => {
    const thief = phone()
    const d = door()
    const grant = grantFor(mine)
    const challenge = await challengeOf(d, mine, grant)
    const out = await d.finish({ body: finishBody(challenge, mine, grant, thief), bridged: null })
    expect(out.status).toBe(401)
    expect(admitted.list()).toEqual([])
  })

  it('spends a challenge once, and only a request from its own key can spend it', async () => {
    const d = door()
    const grant = grantFor(mine)
    const challenge = await challengeOf(d, mine, grant)
    // A stranger presenting another key under this device id reaches nothing.
    const stranger = { ...phone(), id: mine.id }
    const junk = await d.finish({ body: { ...finishBody(challenge, stranger, grant), sig: 'AAAA' }, bridged: null })
    expect(junk.status).toBe(401)
    const body = finishBody(challenge, mine, grant)
    expect((await d.finish({ body, bridged: null })).status).toBe(200)
    expect((await d.finish({ body, bridged: null })).status).toBe(401)
  })

  it('down the relay, the device must be the one cookrew.dev signed in', async () => {
    const d = door()
    const out = await d.begin({ body: asking(mine, grantFor(mine)), bridged: { deviceId: randomUUID() } })
    expect(out.status).toBe(401)
  })

  it('the machine’s own id is not a device that may ask, and a loop of begins is bounded', async () => {
    const d = door()
    const self = { ...mine, id: account.deviceId }
    expect((await d.begin({ body: asking(self, grantFor(self)), bridged: null })).status).toBe(400)
    const grant = grantFor(mine)
    const statuses = []
    for (let i = 0; i < 8; i += 1) statuses.push((await d.begin({ body: asking(mine, grant), bridged: null })).status)
    expect(statuses.filter((s) => s === 429).length).toBe(2)
  })

  it('writes no pass and no token into a log line', async () => {
    const d = door()
    const grant = grantFor(mine)
    const out = await d.finish({ body: finishBody(await challengeOf(d, mine, grant), mine, grant), bridged: null })
    const token = (out.body as { token: string }).token
    const all = lines.join('\n')
    expect(all).toMatch(/admitted/)
    expect(all).not.toContain(grant.slice(0, 40))
    expect(all).not.toContain(token)
  })
})
