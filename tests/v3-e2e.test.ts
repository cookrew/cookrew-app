import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { Accounts, accountFilePath, deviceIdFor, loadAccount } from '../src/main/account-v2'
import {
  createAdmittedDeviceStore,
  hashToken,
  writeAdmittedDevices
} from '../src/main/admitted-devices'
import { createV2CallTokenVerifier, v2KeysOverHttp } from '../src/main/v2-call-token'

/**
 * IDENTITY v3 — THE ONE CHAIN, END TO END.
 *
 * One script, built once for all three cuts: a REAL registry on a real port,
 * two account bases standing in for two Macs, and further bases standing in
 * for a phone and for guests. Every assertion is the previous ring's output
 * being consumed by the next — that is what makes this an acceptance script
 * and not a pile of unit tests sharing a file.
 *
 * NOTHING IS STUBBED ON EITHER SIDE. The app's own `Accounts` talks HTTP to
 * the registry's own routes; the revoked list the door verifier fetches is the
 * one the registry publishes. The only thing missing is Electron, and nothing
 * in this chain needs a window.
 *
 * The registry is started IN PROCESS (createRegistry on port 0) rather than by
 * spawning the built /tmp/registry.mjs. It is the same server code on the same
 * kind of port, it needs no build step to be current with the branch under
 * test, and it cannot leak a child process into a suite that fails. The
 * decision is recorded here because the issue named the bundle.
 *
 * Cut 1 covers steps 1, 8, 10 and 11 of the acceptance table (section 09 of
 * account-e2e-2026-09-17). Steps 8 and 10's APP half wait on the desktop gate
 * that spends a v2 call token (V3-04); what can stand without it — the seat
 * spine those steps ride on — is asserted here so the harness is known-good
 * rather than merely written.
 */

const PASSWORD = 'correct horse battery staple'
const OWNER = 'drej'

/** A team the owner charges for — what a seat is a seat AT. */
const PAID_TEAM = { name: 'alpha', title: 'COOKREW Alpha' }

let registryDir = ''
let origin = ''
let close: () => Promise<void>
const bases: string[] = []

/**
 * ONE CHAIN, so the steps run in the spec's order and feed each other: the
 * Mac that registers in step 1 is the Mac that revokes in step 11 and the one
 * that owns the paid team the guest buys a seat at. A per-step account would
 * make each assertion true in a world of its own.
 */
let ownerMac: { base: string; accounts: Accounts }
/** Minted once in step 1; the ladder in step 11 climbs one of them. */
let recoveryCodes: readonly string[] = []

/** Real scrypt at the registry's real cost — a claim and a ladder are slow. */
const SLOW = 60_000

/** A fresh, empty base dir — one stands for one Mac, one phone, one guest. */
function emptyBase(what: string): string {
  const base = mkdtempSync(path.join(tmpdir(), `v3-e2e-${what}-`))
  bases.push(base)
  return base
}

/** The app, as it runs on one machine, pointed at the test registry. */
function machine(name: string): { base: string; accounts: Accounts } {
  const base = emptyBase(name.toLowerCase().replace(/\W+/g, '-'))
  return { base, accounts: new Accounts({ base, origin, deviceName: name }) }
}

/** Raw HTTP, for the routes the app has no method for yet. */
async function call(
  method: string,
  route: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {}
  }
}

/** The session token an Accounts instance is holding, for raw calls. */
function sessionToken(base: string): string {
  const account = loadAccount(base)
  const token = account?.session?.token
  if (typeof token !== 'string' || token === '') {
    throw new Error('that base holds no session token')
  }
  return token
}

const teamRoute = (tail: string): string => `/v2/teams/@${OWNER}/${PAID_TEAM.name}/${tail}`

beforeAll(async () => {
  registryDir = mkdtempSync(path.join(tmpdir(), 'v3-e2e-registry-'))
  const doors = new DoorStore(registryDir, { allowPrivate: true })
  doors.register(OWNER, {
    handle: OWNER,
    door: 'Pilot',
    name: PAID_TEAM.name,
    title: PAID_TEAM.title,
    agents: 3,
    transport: 'relay',
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
    address: `https://cookrew.dev/@${OWNER}/${PAID_TEAM.name}`,
    access: 'paid',
    priceUsd: '1',
    rails: ['stripe', 'x402']
  })
  const server = createRegistry({
    store: new RegistryStore(registryDir),
    log: new TransparencyLog(registryDir),
    identity: new IdentityService(registryDir),
    doors,
    stars: new StarStore(registryDir),
    origin: 'https://cookrew.dev',
    v2: createV2(registryDir, {
      limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
})

afterAll(async () => {
  await close()
  rmSync(registryDir, { recursive: true, force: true })
  for (const base of bases) rmSync(base, { recursive: true, force: true })
})

describe('step 1 — Mac A registers @drej', () => {
  it('writes an id that is a function of the key, and stands alone on /v2/me', async () => {
    ownerMac = machine('Mac A')
    const macA = ownerMac
    const claimed = await macA.accounts.claim({ username: OWNER, password: PASSWORD })
    expect(claimed.ok).toBe(true)

    // f(jwk), recomputed here from the PUBLIC key the file kept: the id is
    // derived, never issued, so the same key on a restored backup is the same
    // device rather than a second one.
    const file = loadAccount(macA.base)
    expect(file?.username).toBe(OWNER)
    expect(file?.deviceId).toBe(deviceIdFor(file?.publicKeyJwk as Record<string, unknown>))
    expect(accountFilePath(macA.base)).toBe(path.join(macA.base, 'account.json'))

    // devices=[A]: the registry knows this Mac and nothing else yet.
    const me = await call('GET', '/v2/me', undefined, sessionToken(macA.base))
    expect(me.status).toBe(200)
    const devices = me.body.devices as { id: string; name: string }[]
    expect(devices.map((device) => device.name)).toEqual(['Mac A'])
    expect(devices.map((device) => device.id)).toEqual([file?.deviceId])

    // The recovery card is a once: the codes come back on the mint, and the
    // file carries no "saved" stamp until the owner says they wrote them down.
    const codes = await macA.accounts.recoveryCodes()
    expect(codes.ok).toBe(true)
    if (!codes.ok) return
    expect(codes.value.length).toBeGreaterThan(0)
    expect(loadAccount(macA.base)?.recoveryCodesSavedAt).toBeNull()
    recoveryCodes = codes.value
  }, SLOW)
})

describe('step 11 — Mac A revokes the phone', () => {
  it('withdraws the phone from this Mac at the registry, and from its Wi-Fi', async () => {
    // The Mac from step 1, and a phone attached to the same account by the
    // ladder — step 1's recovery codes being spent is the chain's next link.
    const macA = ownerMac
    expect(recoveryCodes.length).toBeGreaterThan(0)

    const phone = machine('Phone')
    const step = await phone.accounts.signIn({ username: OWNER, password: PASSWORD })
    expect(step.ok).toBe(false)
    if (step.ok || step.reason !== 'second_factor') {
      throw new Error(`expected the ladder, got ${JSON.stringify(step)}`)
    }
    const landed = await phone.accounts.resumeWithCode(
      step.step.pending,
      'recovery',
      recoveryCodes[0]
    )
    expect(landed).toMatchObject({ ok: true })
    const phoneId = loadAccount(phone.base)?.deviceId
    expect(typeof phoneId).toBe('string')

    // THE LAN HALF. This Mac has opened for that phone: a row in the admitted
    // ledger, and the phone holding the token whose hash is in it. `accepts`
    // is the check the companion's second door makes on every request, so a
    // true here is the data plane open and a false is the 401.
    const admitted = createAdmittedDeviceStore({ base: macA.base })
    const companionToken = 'a-companion-token-the-phone-holds'
    // Written straight to the ledger rather than through record(), which no
    // longer mints a per-device token: reach v2.1 has one credential, and the
    // hashes already on disk are honoured rather than re-minted. A phone that
    // paired the old way is the harder case, so it is the one under test.
    writeAdmittedDevices(
      [
        {
          deviceId: phoneId as string,
          name: 'Phone',
          admittedAt: Date.now(),
          lastSeenAt: Date.now(),
          tokenHash: hashToken(companionToken)
        }
      ],
      macA.base
    )
    expect(admitted.has(phoneId as string)).toBe(true)
    expect(admitted.accepts(companionToken)).toBe(true)

    // The door verifier is the ONE fetch of /v2/keys, read twice: once for the
    // key that checks call tokens, once for the revoked list that prunes this
    // ledger. The sweep that drives it in the app is a timer; here it is
    // driven directly, which is the same call the timer makes.
    const withdrawn: string[] = []
    const verifier = createV2CallTokenVerifier({
      keys: v2KeysOverHttp(origin),
      onRevoked: (revoked) => {
        for (const device of admitted.prune(revoked)) withdrawn.push(device.deviceId)
      }
    })
    // Nothing is revoked yet, so a sweep now must take nothing away — the
    // pruning has to be caused by the revoke, not by the sweep running at all.
    expect(await verifier.refresh()).toBe(true)
    expect(admitted.has(phoneId as string)).toBe(true)

    const revoked = await macA.accounts.revokeDevice(phoneId as string)
    expect(revoked.ok).toBe(true)

    const startedAt = Date.now()
    expect(await verifier.refresh()).toBe(true)
    // Within the minute the security model promises. The sweep's own period is
    // the budget; this asserts the withdrawal itself costs nothing like it.
    expect(Date.now() - startedAt).toBeLessThan(60_000)
    expect(withdrawn).toEqual([phoneId])
    expect(admitted.has(phoneId as string)).toBe(false)
    // The LAN data plane, closed: the token the phone is still holding no
    // longer matches any row, so the companion's door refuses it.
    expect(admitted.accepts(companionToken)).toBe(false)

    // And the registry says the same thing to anyone who asks.
    const me = await call('GET', '/v2/me', undefined, sessionToken(macA.base))
    expect((me.body.devices as { id: string }[]).map((device) => device.id)).not.toContain(phoneId)
  }, SLOW)
})

describe('the seat spine steps 8 and 10 ride on', () => {
  /**
   * Steps 8 and 10 are about what the DESKTOP does with a seat: a gate that
   * meets 401, opens the account sheet, spends a v2 call token, and opens the
   * door without asking for a second payment (8); and the same gate meeting
   * 403 no_seat once the owner ends the seat, in the gate's own words (10).
   * That consumer is V3-04 and it is not on a branch yet.
   *
   * What CAN be proved without it is the half the desktop will consume, and
   * proving it is what makes "the harness is ready" a fact: a guest with a
   * seat is handed a call token naming that seat, and the moment the owner
   * ends it the next call token is refused 403 no_seat.
   */
  it('hands a seated guest a call token, and refuses the next one once the seat ends', async () => {
    const owner = ownerMac
    const guest = machine('Guest Mac')
    expect(await guest.accounts.claim({ username: 'lin', password: PASSWORD })).toMatchObject({
      ok: true
    })
    const ownerToken = sessionToken(owner.base)
    const guestToken = sessionToken(guest.base)

    // No seat, no token — the paid door's answer to a stranger who has paid
    // nobody, and the exact refusal step 10 will read at the end.
    const before = await call('POST', teamRoute('call-token'), {}, guestToken)
    expect(before.status).toBe(403)
    expect(before.body.error).toBe('no_seat')

    // The web purchase, as the door reports it (step 7's output).
    const settled = await call(
      'POST',
      teamRoute('seats/settle'),
      { username: 'lin', by: 'stripe', receipt: 'stripe test receipt' },
      ownerToken
    )
    expect({ status: settled.status, error: settled.body.error }).toMatchObject({ status: 201 })

    // Step 8's input: a call token that NAMES the seat, so the door can be
    // opened on a purchase that already happened.
    const seated = await call('POST', teamRoute('call-token'), {}, guestToken)
    expect(seated.status).toBe(201)
    expect(typeof seated.body.token).toBe('string')
    expect(seated.body.seat).not.toBeNull()
    expect(seated.body.aud).toBe(`@${OWNER}/${PAID_TEAM.name}`)
    expect(seated.body.account).toBe('lin')
    const seatId = seated.body.seat as string

    // Step 10: the owner ends it, and the very next token is refused.
    const ended = await call('DELETE', teamRoute(`seats/${seatId}`), undefined, ownerToken)
    // 204: the seat is gone and there is nothing to say about it.
    expect(ended.status).toBe(204)
    const after = await call('POST', teamRoute('call-token'), {}, guestToken)
    expect(after.status).toBe(403)
    expect(after.body.error).toBe('no_seat')
  }, SLOW)

  it.todo(
    'step 8 — the desktop gate meets 401, spends the seated call token, and the door opens with no second payment (V3-04)'
  )
  it.todo(
    'step 10 — the desktop gate shows the gate.no_seat band when the ended seat is refused (V3-04)'
  )
})
