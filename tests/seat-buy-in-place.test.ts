import { registerMac } from './support/register-mac'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
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
import { Accounts, loadAccount } from '../src/main/account-v2'
import { CallCredentialService } from '../src/main/call-credential'
import { doorBearer } from '../src/main/door-bearer'
import { DoorCallers, DoorSeats, seatsApiOverAccounts } from '../src/main/door-seats'
import { SeatSettleQueue } from '../src/main/seat-settle'
import { createServeGate, type ServeGate } from '../src/main/serve-gate'
import type { AccountForDoors, AdmissionPhase } from '../src/main/served-admission'
import { ServedCallers } from '../src/main/served-callers'
import { gateCaller, handleServedRoute, type ServedEndpointDeps } from '../src/main/served-endpoints'
import { handleServedPayRoute } from '../src/main/served-pay-route'
import type { ServedTemplate } from '../src/main/session-served'
import { createV2CallTokenVerifier, v2KeysOverHttp } from '../src/main/v2-call-token'

/**
 * A SEAT IS BOUGHT IN THE APP (0.6.0) — the whole chain, for real.
 *
 * The team's page at cookrew.dev was the one surface that could buy a seat at
 * a listed paid team, and 0.6.0 deleted it. What replaces it is the import
 * gate's own walk with `intent: 'buy'`: cookrew.dev mints a token with no seat,
 * the door admits it as far as its 402, and the sheet lands on the pay phase
 * it already had.
 *
 * NOTHING ON THE CHAIN IS STUBBED BUT STRIPE. A real registry refuses and then
 * mints; the real door verifies the token against the registry's published
 * key, runs the real `gateCaller` and the real pay route, remembers the
 * purchase in the real `DoorCallers`, and reports it through the real settle
 * queue to the registry's real seat route. The operations driven here are
 * `createServeGate` — the same three functions the app's IPC and the phone's
 * routes call. Stripe is one function: which session ids count as paid.
 */

const PASSWORD = 'correct horse battery staple'
const OWNER = 'drej'
const TEAM = 'alpha'
const DOOR = `@${OWNER}/${TEAM}`
const SLOW = 60_000

const template: ServedTemplate = Object.freeze({
  serviceId: 'svc-alpha',
  templateId: 'alpha',
  slug: TEAM,
  access: 'paid' as const,
  priceUsd: '1.00'
})

/** What the door quotes at its 402 — one card rail, priced by the owner. */
const TERMS = { x402Version: 1, accepts: [{ scheme: 'stripe-checkout', amountUsd: '1.00' }] }

/** The three Checkout sessions Stripe is asked about, and what it says of each. */
const PAID = 'cs_test_paid0001'
const UNPAID = 'cs_test_unpaid001'
const UNCHECKABLE = 'cs_test_stripedown'

let registryDir = ''
let doorDir = ''
let origin = ''
let site: Server
let plane: Server
let planeOrigin = ''
const bases: string[] = []

let issuer: CallCredentialService
let callers: DoorCallers
/** Subs with a session open at the door — what `hasOpenSession` reads. */
const sessions = new Set<string>()
/** Every sub the door opened a line for, in order. */
let openedBy: string[] = []
/** The Checkout session the door hands out next. */
let nextCheckout = PAID
/** Whether the door's report to cookrew.dev is being held back (a slow registry). */
let holdReport: Promise<void> | null = null
let report: Promise<boolean> = Promise.resolve(false)
let owner: { base: string; accounts: Accounts }

function machine(name: string): { base: string; accounts: Accounts } {
  const base = mkdtempSync(path.join(tmpdir(), `buy-${name}-`))
  bases.push(base)
  return { base, accounts: new Accounts({ base, origin, deviceName: name }) }
}

async function registeredMachine(name: string, username: string): Promise<{ base: string; accounts: Accounts }> {
  const made = machine(name)
  const registered = await registerMac({ origin, base: made.base, username, password: PASSWORD, name })
  return { base: made.base, accounts: registered.accounts }
}

const sessionToken = (base: string): string => {
  const token = loadAccount(base)?.session?.token
  if (typeof token !== 'string' || token === '') throw new Error('that base holds no session')
  return token
}

/** The session id inside a Stripe X-Payment envelope, or null. */
function stripeSessionOf(payment: string): string | null {
  try {
    const value = JSON.parse(Buffer.from(payment, 'base64').toString('utf8')) as { session?: unknown }
    return typeof value.session === 'string' ? value.session : null
  } catch {
    return null
  }
}

/** THE DOOR'S DEPS, as the owner's app assembles them (index.ts servedDeps). */
const doorDeps = (): ServedEndpointDeps => ({
  issuer,
  callers: new ServedCallers(),
  doorName: () => DOOR,
  v2Tokens: createV2CallTokenVerifier({ keys: v2KeysOverHttp(origin) }),
  onV2Seated: (entry) => callers.seated(entry),
  entitled: (serviceId, sub) => callers.entitled(serviceId, sub),
  onPaid: (payment) => {
    callers.bought(payment.serviceId, payment.sub)
    const queue = new SeatSettleQueue({
      seats: new DoorSeats(seatsApiOverAccounts(owner.accounts)),
      base: doorDir,
      sleep: async () => undefined
    })
    const held = holdReport ?? Promise.resolve()
    report = held.then(() =>
      queue.record({
        team: DOOR,
        username: payment.sub.replace(/^acct-/, ''),
        by: payment.by,
        receipt: payment.receipt
      })
    )
  },
  admit: async () => ({ workspaceId: 'w', sessionId: 's', created: false }),
  hasOpenSession: (_serviceId, sub) => sessions.has(sub),
  endSession: () => false,
  grantBudget: { allowsNewSession: () => true },
  conductorFor: () => null,
  ask: async () => '',
  sessionForCaller: () => null,
  turns: { history: () => [] },
  traces: {
    index: async () => [],
    boundaryMarkers: async () => [],
    page: async () => ({ blocks: [], total: 0, source: 'claude' as const })
  },
  // STRIPE, the one stand-in: a session is paid, not paid, or cannot be asked about.
  settle: async (payment) => {
    const session = stripeSessionOf(payment)
    if (session === PAID) return 'ok'
    return session === UNCHECKABLE ? 'unverifiable' : 'refused'
  },
  paymentTerms: () => TERMS,
  crewFace: (t) => ({
    name: 'COOKREW Alpha',
    serviceId: t.serviceId,
    slug: t.slug,
    address: `${planeOrigin}/${t.slug}`,
    version: 1,
    access: t.access,
    door: 'Pilot',
    agents: 2
  })
})

/** The listed door, reached the way the relay proxy reaches it: /@drej/alpha/… */
function startPlane(): Promise<void> {
  const deps = doorDeps()
  plane = createServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://plane.local')
    const segments = url.pathname.split('/').filter((part) => part.length > 0)
    const rest = `/${segments.slice(2).join('/')}`
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (raw += chunk))
    request.on('end', () => {
      void (async () => {
        // A door that is not this one: the relay's answer for a name nobody serves.
        if (`${segments[0]}/${segments[1]}` !== DOOR) {
          response.writeHead(404, { 'content-type': 'application/json' }).end('{}')
          return
        }
        let parsed: unknown = null
        try {
          parsed = raw === '' ? null : JSON.parse(raw)
        } catch {
          parsed = null
        }
        const headers = request.headers as Record<string, string | undefined>
        if (rest === '/line') {
          const gate = await gateCaller(deps, template, headers)
          if (!gate.ok) {
            response.writeHead(gate.response.status, { 'content-type': 'application/json' })
            response.end(JSON.stringify(gate.response.body))
            return
          }
          sessions.add(gate.claims.sub)
          openedBy.push(gate.claims.sub)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write('event: hello\ndata: {"cols":80,"rows":24}\n\n')
          return
        }
        const pay = await handleServedPayRoute(
          {
            issuer,
            createCheckout: async () => `https://checkout.stripe.com/c/pay/${nextCheckout}`,
            successUrl: (t) => `${planeOrigin}/${t.slug}?payment=received`,
            doorName: () => DOOR
          },
          template,
          method,
          rest,
          headers,
          parsed
        )
        const answer = pay ?? (await handleServedRoute(deps, template, method, rest, { headers, body: parsed }))
        if (answer === null) {
          response.writeHead(404).end('{}')
          return
        }
        response.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) })
        response.end(JSON.stringify(answer.body))
      })()
    })
  })
  return new Promise((settle) => {
    plane.listen(0, '127.0.0.1', () => {
      planeOrigin = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`
      settle()
    })
  })
}

/** One Mac's gate operations, with everything it sent cookrew.dev's mint route recorded. */
function appOn(accounts: Accounts | null, door = DOOR): { ops: ServeGate; minted: unknown[] } {
  const minted: unknown[] = []
  const spied: AccountForDoors = {
    account: () => accounts?.account() ?? null,
    authedResponse: async (pathname, init) => {
      if (pathname.endsWith('/call-token')) minted.push(init?.body === undefined ? undefined : JSON.parse(init.body))
      if (accounts === null) return { ok: false, reason: 'no_account' }
      return accounts.authedResponse(pathname, init)
    }
  }
  const ops = createServeGate({
    parse: (link) => (link.startsWith('@') ? { origin, slug: link.split('/')[1] ?? '', door: link } : null),
    // The relay's loopback end, which is where a listed door is always reached.
    reachable: async (target) => ({
      at: { origin: planeOrigin, slug: target.door ?? door, door: target.door ?? door },
      listed: true,
      live: true
    }),
    accounts: spied,
    signInWithKey: () => Promise.reject(new Error('a listed door is never entered with a key')),
    wallet: () => null,
    buildX402Payment: () => Promise.reject(new Error('this door quotes no USDC'))
  })
  return { ops, minted }
}

type Gated = { ok: true; door: string; phase: AdmissionPhase; team?: string; owner?: string; account?: string | null; seat?: string | null }

beforeAll(async () => {
  registryDir = mkdtempSync(path.join(tmpdir(), 'buy-registry-'))
  doorDir = mkdtempSync(path.join(tmpdir(), 'buy-door-'))
  issuer = new CallCredentialService({ base: doorDir })
  callers = new DoorCallers()
  const doors = new DoorStore(registryDir, { allowPrivate: true })
  doors.register(OWNER, {
    handle: OWNER,
    door: 'Pilot',
    name: TEAM,
    title: 'COOKREW Alpha',
    agents: 3,
    transport: 'relay',
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
    address: `https://cookrew.dev/@${OWNER}/${TEAM}`,
    access: 'paid',
    priceUsd: '1',
    rails: ['stripe']
  })
  site = createRegistry({
    store: new RegistryStore(registryDir),
    log: new TransparencyLog(registryDir),
    identity: new IdentityService(registryDir),
    doors,
    stars: new StarStore(registryDir),
    origin: 'https://cookrew.dev',
    v2: createV2(registryDir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  await startPlane()
  owner = await registeredMachine('owner', OWNER)
}, SLOW)

afterAll(async () => {
  await new Promise<void>((resolve) => {
    plane.closeAllConnections()
    plane.close(() => resolve())
  })
  await new Promise<void>((resolve) => {
    site.closeAllConnections()
    site.close(() => resolve())
  })
  rmSync(registryDir, { recursive: true, force: true })
  rmSync(doorDir, { recursive: true, force: true })
  for (const base of bases) rmSync(base, { recursive: true, force: true })
})

describe('buying a seat at a listed paid team, in the app', () => {
  it('walks no_seat → BUY → the door’s 402 → card → settled → open, and the card opens on the seat', async () => {
    const guest = await registeredMachine('guest', 'lin')
    const app = appOn(guest.accounts)

    // ── a plain import: the seat rung, and the mint said nothing about buying ──
    const refused = (await app.ops.gate(DOOR)) as Gated
    expect(refused).toMatchObject({
      ok: true,
      door: 'install',
      phase: { kind: 'denied', reason: 'no_seat', retryable: false },
      team: DOOR,
      owner: OWNER,
      account: 'lin'
    })
    expect(app.minted).toEqual([{}])
    // Nothing was held for a door that admitted nobody: no card payment can start.
    expect(await app.ops.checkout(DOOR)).toMatchObject({ ok: false, reason: 'not-signed-in' })

    // ── BUY A SEAT: the same walk, said out loud, lands on the door's own terms ──
    const quoted = (await app.ops.gate(DOOR, 'buy')) as Gated
    expect(app.minted).toEqual([{}, { intent: 'buy' }])
    expect(quoted.phase).toMatchObject({
      kind: 'pay',
      rails: [{ rail: 'stripe', price: '1.00', asset: 'USD', chain: 'Stripe' }]
    })
    expect(quoted).toMatchObject({ door: 'install', team: DOOR, owner: OWNER, account: 'lin', seat: null })
    // ASK BEFORE MONEY: pressing BUY charged nothing and opened nothing.
    expect(openedBy).toEqual([])
    expect(callers.entitled(template.serviceId, 'acct-lin')).toBe(false)

    // ── the card rail: the door's own Checkout, then the session presented back ──
    nextCheckout = PAID
    const checkout = await app.ops.checkout(DOOR)
    expect(checkout).toEqual({ ok: true, session: PAID, url: `https://checkout.stripe.com/c/pay/${PAID}` })
    // THE REGISTRY IS SLOW TODAY: the door's report is held until the card has opened.
    let release = (): void => undefined
    holdReport = new Promise<void>((resolve) => (release = resolve))
    const settled = await app.ops.settle(DOOR, 'stripe', PAID)
    expect(settled).toEqual({ ok: true, phase: { kind: 'open' } })
    expect(openedBy).toEqual(['acct-lin'])
    // The door knows at once; cookrew.dev does not yet.
    expect(callers.entitled(template.serviceId, 'acct-lin')).toBe(true)

    // ── the placed card signs in while cookrew.dev still says no seat ──
    const card = (): Promise<string> =>
      doorBearer(
        { admit: (target, team) => app.ops.admitCard(target, team), withKey: () => Promise.reject(new Error('no key')) },
        { origin: planeOrigin, slug: DOOR },
        DOOR
      )
    const early = await card()
    // Its sign-in was an ordinary one — the card never says BUY.
    expect(app.minted).toEqual([{}, { intent: 'buy' }, {}])
    const line = await fetch(`${planeOrigin}/${DOOR}/line`, { headers: { authorization: `Bearer ${early}` } })
    expect(line.status).toBe(200)
    await line.body?.cancel()

    // ── the report lands: the seat is the account's, and the next sign-in is plain ──
    release()
    holdReport = null
    expect(await report).toBe(true)
    const mine = await fetch(`${origin}/v2/teams/${DOOR}/seat`, {
      headers: { authorization: `Bearer ${sessionToken(guest.base)}` }
    })
    expect(((await mine.json()) as { seat: { source?: string } | null }).seat).toMatchObject({ source: 'bought' })

    const again = (await app.ops.gate(DOOR)) as Gated
    expect(again.phase).toEqual({ kind: 'open' })
    expect(again.seat).toEqual(expect.any(String))
    await card()
    // Every mint after the purchase is `{}`: BUY was said once, by a press.
    expect(app.minted.slice(3)).toEqual([{}, {}])

    // ── and an app with no memory of the purchase opens on the seat alone ──
    sessions.delete('acct-lin')
    const second = appOn(guest.accounts)
    const elsewhere = (await second.ops.gate(DOOR)) as Gated
    expect(elsewhere.phase).toEqual({ kind: 'open' })
    expect(second.minted).toEqual([{}])
  }, SLOW)

  it('a card that was never paid for is refused: BUY alone opens nothing', async () => {
    const stranger = await registeredMachine('stranger', 'bo')
    const app = appOn(stranger.accounts)
    expect(((await app.ops.gate(DOOR, 'buy')) as Gated).phase.kind).toBe('pay')
    // The gate holds a Bearer for the pay sheet; the card may not borrow it.
    await expect(
      doorBearer(
        { admit: (target, team) => app.ops.admitCard(target, team), withKey: () => Promise.reject(new Error('no key')) },
        { origin: planeOrigin, slug: DOOR },
        DOOR
      )
    ).rejects.toThrow(`${DOOR} did not admit this account (denied)`)
  }, SLOW)
})

describe('a refusal on the buy path is said, not swallowed', () => {
  it('a card session Stripe says is unpaid is payment_invalid, and nothing is seated', async () => {
    const guest = await registeredMachine('unpaid', 'mo')
    const app = appOn(guest.accounts)
    expect(((await app.ops.gate(DOOR, 'buy')) as Gated).phase.kind).toBe('pay')
    nextCheckout = UNPAID
    const checkout = (await app.ops.checkout(DOOR)) as { ok: true; session: string }
    expect(checkout.session).toBe(UNPAID)
    expect(await app.ops.settle(DOOR, 'stripe', UNPAID)).toEqual({
      ok: true,
      phase: { kind: 'denied', reason: 'payment_invalid', retryable: false }
    })
    expect(callers.entitled(template.serviceId, 'acct-mo')).toBe(false)
    expect(((await app.ops.gate(DOOR)) as Gated).phase).toMatchObject({ kind: 'denied', reason: 'no_seat' })
  }, SLOW)

  it('a payment the door cannot check is payment_unverifiable and may be tried again', async () => {
    const guest = await registeredMachine('uncheckable', 'ada')
    const app = appOn(guest.accounts)
    await app.ops.gate(DOOR, 'buy')
    expect(await app.ops.settle(DOOR, 'stripe', UNCHECKABLE)).toEqual({
      ok: true,
      phase: { kind: 'denied', reason: 'payment_unverifiable', retryable: true }
    })
  }, SLOW)

  it('a door that is gone is an error with its status, and holds no Bearer to pay on', async () => {
    const guest = await registeredMachine('gone', 'kai')
    // The registry still lists the team and mints for it; nobody answers at the name.
    const elsewhere = createServeGate({
      parse: () => ({ origin, slug: TEAM, door: DOOR }),
      reachable: async () => ({ at: { origin: planeOrigin, slug: '@drej/closed', door: DOOR }, listed: true, live: true }),
      accounts: guest.accounts,
      signInWithKey: () => Promise.reject(new Error('no key')),
      wallet: () => null,
      buildX402Payment: () => Promise.reject(new Error('no wallet'))
    })
    expect(((await elsewhere.gate(DOOR, 'buy')) as Gated).phase).toEqual({ kind: 'error', status: 404 })
    expect(await elsewhere.checkout(DOOR)).toMatchObject({ ok: false, reason: 'not-signed-in' })
    // And a door nobody can reach at all is said in the gate's own failure shape.
    const dark = createServeGate({
      parse: () => ({ origin, slug: TEAM, door: DOOR }),
      reachable: async () => null,
      accounts: guest.accounts,
      signInWithKey: () => Promise.reject(new Error('no key')),
      wallet: () => null,
      buildX402Payment: () => Promise.reject(new Error('no wallet'))
    })
    expect(await dark.gate(DOOR, 'buy')).toEqual({ ok: false, reason: 'sign-in', detail: 'not serving' })
  }, SLOW)

  it('the registry saying no is its own phase: no account is identify, an unknown team is its status', async () => {
    const nobody = appOn(null)
    expect(((await nobody.ops.gate(DOOR, 'buy')) as Gated).phase).toEqual({ kind: 'identify' })

    const guest = await registeredMachine('lost', 'zed')
    const lost = appOn(guest.accounts, '@drej/nowhere')
    const answer = (await lost.ops.gate('@drej/nowhere', 'buy')) as Gated
    expect(answer.phase).toEqual({ kind: 'error', status: 404 })
    expect(lost.minted).toEqual([{ intent: 'buy' }])
  }, SLOW)

  it('BUY means nothing at an unlisted door: the key walk is taken and nothing is minted', async () => {
    const guest = await registeredMachine('direct', 'ivy')
    const minted: unknown[] = []
    const direct = createServeGate({
      parse: () => ({ origin: planeOrigin, slug: DOOR }),
      reachable: async (target) => ({ at: target, listed: false, live: true }),
      accounts: {
        account: () => guest.accounts.account(),
        authedResponse: (pathname, init) => (minted.push(init?.body), guest.accounts.authedResponse(pathname, init))
      },
      signInWithKey: () => Promise.reject(new Error('this Mac’s key was offered')),
      wallet: () => null,
      buildX402Payment: () => Promise.reject(new Error('no wallet'))
    })
    expect(await direct.gate(DOOR, 'buy')).toEqual({
      ok: false,
      reason: 'sign-in',
      detail: 'this Mac’s key was offered'
    })
    expect(minted).toEqual([])
  }, SLOW)
})
