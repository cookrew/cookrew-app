import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import type { V2Identity } from '../registry/src/v2-http'
import { createCanvasLink, type CanvasLink } from '../src/main/canvas-link'
import { createCanvasBridge, loopbackDialer } from '../src/main/canvas-bridge'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { createAccountPairDoor } from '../src/main/account-pair'
import { handleAccountPairRoutes } from '../src/main/account-pair-routes'
import { createAdmittedDeviceStore } from '../src/main/admitted-devices'
import { createRefusedPhones, refusalOnForget } from '../src/main/refused-phones'
import { takeRelayDevice } from '../src/main/relay-device'
import { createV2CallTokenVerifier, v2KeysOverHttp } from '../src/main/v2-call-token'
import { setPhoneInviter } from '../src/main/phone-invite'
import type { AccountFile } from '../src/main/account-v2'

/**
 * THE PHONE, END TO END, ON THIS MACHINE ONLY.
 *
 * The real Go client (phone/cmd/probe) against a real registry on loopback,
 * its real relay, and the Mac's real door: the owner mints a phone's code on
 * the Mac, the phone joins with it, takes its phone pass, enters the Mac down
 * the relay and reads a route with the token the Mac handed it; the account
 * revokes it and the Mac lets it go. Two languages meet on this wire and
 * nothing else checks that they agree. Nothing here reaches cookrew.dev.
 *
 * Opt in, since it needs the probe built:
 *   (cd phone && go build -o .build/probe ./cmd/probe)
 *   PHONE_PROBE_E2E=1 npx vitest run tests/phone-probe.integration.test.ts
 */

const BINARY = path.join(__dirname, '..', 'phone', '.build', 'probe')
const OPTED_IN = process.env.PHONE_PROBE_E2E === '1'
const run = OPTED_IN ? describe : describe.skip
// Asked for and not built is a failure, never a quiet skip.
if (OPTED_IN && !existsSync(BINARY)) throw new Error(`PHONE_PROBE_E2E=1 but ${BINARY} is not built: (cd phone && go build -o .build/probe ./cmd/probe)`)

const PASSWORD = 'correct horse battery staple'
const PAIRING = 'the-pairing-token-of-this-mac'

vi.mock('../src/main/board-index', async (importActual) => {
  const actual = await importActual<typeof import('../src/main/board-index')>()
  return { ...actual, buildBoard: () => ({ rows: [], summary: {}, activeWorkspaceId: 'ws' }) }
})

interface Up {
  origin: string
  close: () => Promise<void>
}

const listen = async (server: Server): Promise<Up> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

const jwkOf = (): Record<string, string> =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>

/** The probe's lines, or its failure as an error carrying stderr. */
const probe = (registry: string, state: string, ...args: string[]): Promise<string[]> =>
  new Promise((resolve, reject) => {
    execFile(BINARY, ['-registry', registry, '-state', state, ...args], { timeout: 60_000, env: { PATH: process.env.PATH ?? '' } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${stderr.trim() || error.message}`))
      else resolve(stdout.trim().split('\n').filter((line) => line.length > 0))
    })
  })

run('the phone, away from home, on one QR', () => {
  let site: Up
  let mac: Up
  let dir = ''
  let token = ''
  let v2: V2Identity
  let link: CanvasLink | null = null
  const username = 'owner'
  const macId = randomUUID()
  let refusedFile = ''
  const admittedBase = (): string => path.join(dir, 'mac')

  const mintPhoneCode = async (current: string): Promise<{ ok: boolean; code?: string; url?: string; reason?: string }> => {
    const reply = await fetch(`${mac.origin}/api/phone/invite`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PAIRING}`, 'content-type': 'application/json' },
      body: JSON.stringify({ current })
    })
    expect(reply.status).toBe(200)
    return (await reply.json()) as { ok: boolean; code?: string; url?: string; reason?: string }
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'phone-probe-'))
    refusedFile = path.join(dir, 'mac', 'phone-refused.json')
    v2 = createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000, joinPerMinute: 1000 } })
    site = await listen(
      createRegistry({
        store: new RegistryStore(dir),
        log: new TransparencyLog(dir),
        identity: new IdentityService(dir),
        doors: new DoorStore(dir, { allowPrivate: true }),
        stars: new StarStore(dir),
        origin: 'https://cookrew.dev',
        v2
      })
    )
    const claimed = await fetch(`${site.origin}/v2/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD, device: { id: macId, kind: 'desktop', name: 'This Mac', jwk: jwkOf() } })
    })
    expect(claimed.status).toBe(201)
    token = ((await claimed.json()) as { session: { token: string } }).session.token
    await fetch(`${site.origin}/v2/me/desktops/${macId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'This Mac', workspaces: [{ id: 'w1', name: 'Cookrew Dev' }] })
    })

    // THE MAC: its real door, verifier, admitted store and forgotten phones, behind its real gate.
    const admitted = createAdmittedDeviceStore({ base: admittedBase() })
    const refused = createRefusedPhones(refusedFile)
    const verifier = createV2CallTokenVerifier({ keys: v2KeysOverHttp(site.origin), onRevoked: (revoked) => admitted.prune(revoked) })
    const door = createAccountPairDoor({
      account: () => ({ username, deviceId: macId }) as AccountFile,
      grants: (grant) => verifier.grant(grant),
      admitted,
      platform: 'darwin',
      refusedPhone: (id, since) => refused.refuses(id, since)
    })
    // The Mac's own minter, as index.ts lends it: the account's join code for a phone, under the password.
    setPhoneInviter(async (current) => {
      const reply = await fetch(`${site.origin}/v2/me/join-codes`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ current, purpose: 'phone' })
      })
      const body = (await reply.json()) as { code?: string; expiresAt?: number; error?: string }
      return reply.status === 201 && body.code && body.expiresAt
        ? { ok: true, code: body.code, expiresAt: body.expiresAt, url: `https://cookrew.dev/join#${body.code}` }
        : { ok: false, reason: body.error ?? 'unknown' }
    })
    const deps = {
      pairingToken: PAIRING,
      wallToken: 'wall',
      companionGate: (presented: string | null) => presented === PAIRING || (presented !== null && admitted.accepts(presented)),
      store: { focusedState: { nodes: [], connections: [] } },
      ptys: { get: () => undefined },
      turns: { list: () => [], seen: () => undefined },
      agents: { list: () => [] },
      ops: {},
      presets: []
    } as unknown as MobileApiDeps
    mac = await listen(
      createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const bridged = takeRelayDevice(request)
        void (async () => {
          if (await handleAccountPairRoutes(request, response, url, door, bridged)) return
          if (await handleMobileApi(request, response, url, deps)) return
          response.writeHead(404)
          response.end()
        })()
      })
    )
    link = createCanvasLink({ origin: () => site.origin, credential: () => ({ token, deviceId: macId }) })
    const bridge = createCanvasBridge({ send: (line) => link!.send(line), dial: loopbackDialer(Number(new URL(mac.origin).port)) })
    link.onFrame(bridge.frame)
    link.onDrop(bridge.reset)
    link.start()
    const deadline = Date.now() + 4000
    while (!link.held()) {
      if (Date.now() > deadline) throw new Error('the Mac never held its line')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // Forgetting, as index.ts does it: the admitted row goes, and its phone passes stay out.
    ;(globalThis as { forgetPhone?: (id: string) => void }).forgetPhone = (id) => {
      const keptOut = refusalOnForget(admitted.list().find((row) => row.deviceId === id), Date.now())
      if (keptOut !== null) refused.add(id, keptOut)
      admitted.forget(id)
    }
    ;(globalThis as { pruneNow?: () => Promise<boolean> }).pruneNow = () => verifier.refresh()
  }, 20_000)

  afterAll(async () => {
    link?.stop()
    setPhoneInviter(null)
    await site?.close()
    await mac?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to talk to anything but this machine', async () => {
    await expect(probe('https://cookrew.dev', path.join(dir, 'never.json'), 'machines')).rejects.toThrow(/only talks to a registry on this machine/)
  })

  it('a wrong password on the Mac mints nothing; a code nobody minted joins nothing', async () => {
    expect(await mintPhoneCode('not the password')).toMatchObject({ ok: false, reason: 'bad_credentials' })
    await expect(probe(site.origin, path.join(dir, 'wrong.json'), 'join', 'AAAA-BBBB')).rejects.toThrow(/wrong, ran out or was used/)
  })

  it('one QR: the phone joins, takes its pass, enters the Mac down the relay and is let in until revoked', async () => {
    const minted = await mintPhoneCode(PASSWORD)
    expect(minted.ok).toBe(true)
    const state = path.join(dir, 'phone.json')
    const joined = await probe(site.origin, state, 'join', minted.url as string)
    expect(joined[0]).toMatch(/^joined owner [0-9a-f-]{36}$/)
    const phoneId = joined[0].split(' ')[2]
    expect(v2.accounts.get(username)?.devices.find((d) => d.id === phoneId)).toMatchObject({ kind: 'phone', phonePassAt: expect.any(Number) })

    expect(await probe(site.origin, state, 'enter')).toEqual([`entered ${macId} This Mac until 0`])
    // Its own token opens the Mac, down the relay, as a paired device.
    const status = await probe(site.origin, state, 'call', macId, 'api/auth/status')
    expect(status[0]).toMatch(/^200 /)
    expect(JSON.parse(status[0].slice(4))).toMatchObject({ scope: 'pairing', canWrite: true })
    // Entered once: the next run asks no pass and knocks on no door.
    expect(await probe(site.origin, state, 'enter')).toEqual([`held ${macId} This Mac`])
    expect(await probe(site.origin, state, 'renew')).toEqual([expect.stringMatching(/^session held until \d+$/)])
    // The same code does not join twice.
    await expect(probe(site.origin, path.join(dir, 'again.json'), 'join', minted.url as string)).rejects.toThrow(/wrong, ran out or was used/)
  }, 60_000)

  it('forgotten on the Mac it stays out on its pass; the same phone, on a new QR, comes back', async () => {
    const state = path.join(dir, 'forgotten.json')
    const joined = await probe(site.origin, state, 'join', (await mintPhoneCode(PASSWORD)).url as string)
    const phoneId = joined[0].split(' ')[2]
    expect(await probe(site.origin, state, 'enter')).toEqual([`entered ${macId} This Mac until 0`])
    ;(globalThis as unknown as { forgetPhone: (id: string) => void }).forgetPhone(phoneId)
    // Its token opens nothing now: the open status route says so rather than refusing.
    const status = await probe(site.origin, state, 'call', macId, 'api/auth/status')
    expect(JSON.parse(status[0].slice(4))).toMatchObject({ scope: 'none' })
    // It lets go of the dead token and knocks again on the pass it was forgotten under: kept out.
    await probe(site.origin, state, 'drop', macId)
    expect((await probe(site.origin, state, 'enter'))[0]).toMatch(new RegExp(`^refused ${macId} This Mac: .*forget this phone`))
    // The same key on a new code: the trusted moment moves forward, and the Mac takes it back.
    expect(await probe(site.origin, state, 'rejoin', (await mintPhoneCode(PASSWORD)).url as string)).toEqual([`rejoined owner ${phoneId}`])
    expect(await probe(site.origin, state, 'enter')).toEqual([`entered ${macId} This Mac until 0`])
    const back = await probe(site.origin, state, 'call', macId, 'api/auth/status')
    expect(JSON.parse(back[0].slice(4))).toMatchObject({ scope: 'pairing' })
  }, 60_000)

  it('revoked at the account, the Mac lets it go', async () => {
    const state = path.join(dir, 'revoked.json')
    const joined = await probe(site.origin, state, 'join', (await mintPhoneCode(PASSWORD)).url as string)
    const phoneId = joined[0].split(' ')[2]
    await probe(site.origin, state, 'enter')
    expect(v2.accounts.revokeDevice(username, phoneId)).toEqual({ ok: true })
    expect(await (globalThis as unknown as { pruneNow: () => Promise<boolean> }).pruneNow()).toBe(true)
    // The relay itself turns a revoked phone's session away before the Mac is asked.
    await expect(probe(site.origin, state, 'call', macId, 'api/auth/status')).rejects.toThrow(/the account session has ended/)
  }, 60_000)
})
