import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../../registry/src/server'
import { RegistryStore } from '../../registry/src/store'
import { TransparencyLog } from '../../registry/src/log'
import { IdentityService } from '../../registry/src/identity'
import { DoorStore } from '../../registry/src/doors'
import { StarStore } from '../../registry/src/stars'
import { createV2 } from '../../registry/src/v2-routes'
import { Accounts, loadAccount } from '../../src/main/account-v2'
import { CallCredentialService } from '../../src/main/call-credential'
import { DoorCallers, DoorSeats, seatsApiOverAccounts } from '../../src/main/door-seats'
import { SeatSettleQueue } from '../../src/main/seat-settle'
import { createServeGate, type ServeGate } from '../../src/main/serve-gate'
import type { AccountForDoors } from '../../src/main/served-admission'
import { ServedCallers } from '../../src/main/served-callers'
import { gateCaller, handleServedRoute, type ServedEndpointDeps } from '../../src/main/served-endpoints'
import { handleServedPayRoute } from '../../src/main/served-pay-route'
import type { ServedTemplate } from '../../src/main/session-served'
import { createV2CallTokenVerifier, v2KeysOverHttp } from '../../src/main/v2-call-token'
import { registerMac } from './register-mac'

/**
 * A LISTED PAID TEAM, WHOLE — the world a seat is bought in.
 *
 * NOTHING ON THE CHAIN IS STUBBED BUT THE RAILS. A real registry (in process,
 * on a real port) refuses and mints; the real door verifies the token against
 * the registry's published key, runs the real `gateCaller` and the real pay
 * route, remembers the purchase in the real `DoorCallers`, and reports it
 * through the real settle queue to the registry's real seat route. The app's
 * side is `createServeGate` — the functions its IPC and the phone's routes
 * call — on real `Accounts`.
 *
 * The rails are one function each: which Checkout sessions Stripe calls paid,
 * and which USDC envelope verifies. No key, no network beyond loopback.
 */

const PASSWORD = 'correct horse battery staple'
export const OWNER = 'drej'
export const TEAM = 'alpha'
export const DOOR = `@${OWNER}/${TEAM}`
export const PRICE = '1.00'
/** A second paid team the registry lists and nobody here serves: somewhere else to hold no seat. */
export const OTHER_DOOR = `@${OWNER}/beta`

export const template: ServedTemplate = Object.freeze({
  serviceId: 'svc-alpha',
  templateId: 'alpha',
  slug: TEAM,
  access: 'paid' as const,
  priceUsd: PRICE
})

/** The three Checkout sessions Stripe is asked about, and what it says of each. */
export const PAID = 'cs_test_paid0001'
export const UNPAID = 'cs_test_unpaid001'
export const UNCHECKABLE = 'cs_test_stripedown'
/** The one USDC envelope that verifies; any other is refused. */
export const GOOD_USDC = 'x402-envelope-that-verifies'
export const BAD_USDC = 'x402-envelope-that-does-not'
export const WALLET = '0x1234567890abcdef1234567890abcdef1234cdef'

const CARD_TERMS = { scheme: 'stripe-checkout', amountUsd: PRICE }
const USDC_TERMS = {
  scheme: 'exact',
  network: 'base-sepolia',
  maxAmountRequired: '1000000',
  resource: `https://door.example/${TEAM}`,
  description: 'one seat',
  mimeType: 'application/json',
  payTo: '0xA1b2C3d4E5f6789012345678901234567890aBcD',
  maxTimeoutSeconds: 300,
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  extra: { name: 'USDC', version: '2' }
}

export interface Mac {
  base: string
  accounts: Accounts
}

/** One Mac's gate verbs, with every body it sent cookrew.dev's mint route. */
export interface AppOn {
  ops: ServeGate
  minted: unknown[]
  /** Every quote this Mac's wallet was asked to sign, in order. */
  signed: unknown[]
}

export interface PaidDoorWorld {
  /** The registry. */
  origin: string
  /** The relay's loopback end: where a listed door is always reached. */
  planeOrigin: string
  owner: Mac
  /** What the door remembers about who signed in and who paid. */
  callers: DoorCallers
  /** Every sub the door opened a line for, in order. */
  openedBy: string[]
  /** Subs with a session open at the door. */
  sessions: Set<string>
  /** Which rails the door quotes at its 402. Card only, until told otherwise. */
  quote(rails: readonly ('stripe' | 'x402')[]): void
  /** A door that changes what its USDC quote says from now on. `{}` puts it back. */
  usdcTerms(patch: Record<string, unknown>): void
  /** The Checkout session the door hands out next. */
  checkoutNext(session: string): void
  /** A slow registry: the door's seat report waits until the returned release is called. */
  holdReports(): () => void
  /** The last seat report the door made, settled or not. */
  lastReport(): Promise<boolean>
  registeredMachine(name: string, username: string): Promise<Mac>
  sessionToken(base: string): string
  /**
   * `usdc` is the envelope this Mac's wallet would sign; without one it has no
   * wallet. Pass a FUNCTION for the account to stand for one Mac whose
   * signed-in person changes; `now` is that Mac's clock.
   */
  appOn(
    accounts: Accounts | null | (() => Accounts | null),
    options?: { usdc?: string; now?: () => number }
  ): AppOn
  close(): Promise<void>
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

export async function startPaidDoorWorld(): Promise<PaidDoorWorld> {
  const registryDir = mkdtempSync(path.join(tmpdir(), 'buy-registry-'))
  const doorDir = mkdtempSync(path.join(tmpdir(), 'buy-door-'))
  const bases: string[] = []
  const issuer = new CallCredentialService({ base: doorDir })
  const callers = new DoorCallers()
  const sessions = new Set<string>()
  const openedBy: string[] = []
  let quoted: readonly ('stripe' | 'x402')[] = ['stripe']
  let usdcPatch: Record<string, unknown> = {}
  /** Built at the moment of asking, so a door can change its mind between two asks. */
  const accepts = (): unknown[] =>
    quoted.map((rail) => (rail === 'stripe' ? CARD_TERMS : { ...USDC_TERMS, ...usdcPatch }))
  let nextCheckout = PAID
  let holdReport: Promise<void> | null = null
  let report: Promise<boolean> = Promise.resolve(false)

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
  doors.register(OWNER, {
    handle: OWNER,
    door: 'Pilot',
    name: 'beta',
    title: 'COOKREW Beta',
    agents: 1,
    transport: 'relay',
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
    address: `https://cookrew.dev/@${OWNER}/beta`,
    access: 'paid',
    priceUsd: '1',
    rails: ['stripe']
  })
  const site: Server = createRegistry({
    store: new RegistryStore(registryDir),
    log: new TransparencyLog(registryDir),
    identity: new IdentityService(registryDir),
    doors,
    stars: new StarStore(registryDir),
    origin: 'https://cookrew.dev',
    v2: createV2(registryDir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`

  const registeredMachine = async (name: string, username: string): Promise<Mac> => {
    const base = mkdtempSync(path.join(tmpdir(), `buy-${name}-`))
    bases.push(base)
    const registered = await registerMac({ origin, base, username, password: PASSWORD, name })
    return { base, accounts: registered.accounts }
  }
  const owner = await registeredMachine('owner', OWNER)

  let planeOrigin = ''
  /** THE DOOR'S DEPS, as the owner's app assembles them (index.ts servedDeps). */
  const deps: ServedEndpointDeps = {
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
    // THE RAILS, the one stand-in: a payment is good, bad, or cannot be asked about.
    settle: async (payment) => {
      if (payment === GOOD_USDC) return 'ok'
      const session = stripeSessionOf(payment)
      if (session === PAID) return 'ok'
      return session === UNCHECKABLE ? 'unverifiable' : 'refused'
    },
    paymentTerms: () => ({ x402Version: 1, accepts: accepts() }),
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
  }

  /** The listed door, reached the way the relay proxy reaches it: /@drej/alpha/… */
  const plane: Server = createServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://plane.local')
    const segments = url.pathname.split('/').filter((part) => part.length > 0)
    const rest = `/${segments.slice(2).join('/')}`
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (raw += chunk))
    request.on('end', () => {
      void (async () => {
        // A name nobody serves: the relay's answer for a door that is gone.
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
  await new Promise<void>((resolve) => plane.listen(0, '127.0.0.1', resolve))
  planeOrigin = `http://127.0.0.1:${(plane.address() as AddressInfo).port}`

  const appOn = (
    who: Accounts | null | (() => Accounts | null),
    options: { usdc?: string; now?: () => number } = {}
  ): AppOn => {
    const minted: unknown[] = []
    const signed: unknown[] = []
    const current = (): Accounts | null => (typeof who === 'function' ? who() : who)
    const spied: AccountForDoors = {
      account: () => current()?.account() ?? null,
      authedResponse: async (pathname, init) => {
        if (pathname.endsWith('/call-token')) minted.push(init?.body === undefined ? undefined : JSON.parse(init.body))
        const accounts = current()
        if (accounts === null) return { ok: false, reason: 'no_account' }
        return accounts.authedResponse(pathname, init)
      }
    }
    const usdc = options.usdc
    const ops = createServeGate({
      parse: (link) => (link.startsWith('@') ? { origin, slug: link.split('/')[1] ?? '', door: link } : null),
      reachable: async (target) =>
        target.door ? { at: { origin: planeOrigin, slug: target.door, door: target.door }, listed: true, live: true } : null,
      accounts: spied,
      ...(options.now ? { now: options.now } : {}),
      signInWithKey: () => Promise.reject(new Error('a listed door is never entered with a key')),
      wallet: () => (usdc === undefined ? null : { address: WALLET }),
      buildX402Payment: (requirements) => {
        signed.push(requirements)
        return usdc === undefined ? Promise.reject(new Error('this Mac has no wallet')) : Promise.resolve(usdc)
      }
    })
    return { ops, minted, signed }
  }

  return {
    origin,
    planeOrigin,
    owner,
    callers,
    openedBy,
    sessions,
    quote: (rails) => {
      quoted = rails
    },
    usdcTerms: (patch) => {
      usdcPatch = patch
    },
    checkoutNext: (session) => {
      nextCheckout = session
    },
    holdReports: () => {
      let release = (): void => undefined
      holdReport = new Promise<void>((resolve) => (release = resolve))
      return () => {
        holdReport = null
        release()
      }
    },
    lastReport: () => report,
    registeredMachine,
    sessionToken: (base) => {
      const token = loadAccount(base)?.session?.token
      if (typeof token !== 'string' || token === '') throw new Error('that base holds no session')
      return token
    },
    appOn,
    close: async () => {
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
    }
  }
}
