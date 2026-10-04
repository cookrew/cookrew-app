import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { CallCredentialService } from '../src/main/call-credential'
import { ServedCallers } from '../src/main/served-callers'
import { ServedTemplates } from '../src/main/session-served'
import { handleServedRoute, type ServedEndpointDeps } from '../src/main/served-endpoints'
import { handleServedPayRoute } from '../src/main/served-pay-route'
import { DoorCallers } from '../src/main/door-seats'
import { SeatSettleQueue } from '../src/main/seat-settle'
import { loadStripeSecret } from '../src/main/stripe-config'
import { stripeSecretMode } from '../src/shared/served-payment-config'
import {
  createStripeRedemptionStore,
  stripeCreateCheckout,
  stripeGet,
  stripePaymentTerms,
  stripePost,
  stripeSettle,
  type StripeConfig
} from '../src/main/stripe-rail'
import { combinePaymentTerms, railSettle } from '../src/main/payment-rails'
import { stripePaymentHeader } from '../src/main/served-admission'
import { createV2CallTokenVerifier, v2KeysOverHttp } from '../src/main/v2-call-token'
import { SERVED_SESSION_END_PATH } from '../src/shared/served-transcript'
import type { TurnRecord } from '../src/shared/turn'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain JS helper shared with the perf probes
import { launchChrome, connectPage } from '../scripts/perf-dom-probe.mjs'

/**
 * THE SEAT PURCHASE, END TO END, ON STRIPE'S OWN TEST MODE.
 *
 * A real registry on a loopback port, a real owner's door mounting the real
 * Stripe rail with the owner's test key, and a real browser filling Stripe's
 * hosted Checkout with the 4242 card. Every assertion is the previous ring's
 * output consumed by the next: the registry mints a buying token, the door
 * quotes, Stripe takes the card and sends the browser back to the team page
 * with the session id, the door settles that id, the seat lands at the
 * registry, and the next token carries it.
 *
 * GATED. This talks to api.stripe.com and drives a browser, so it runs only
 * when asked (COOKREW_STRIPE_E2E=1) and only on a TEST key read the one way
 * the app reads it — ~/.cookrew/stripe.env, 0600. The key is never printed.
 */
const secret = process.env.COOKREW_STRIPE_E2E === '1' ? loadStripeSecret({ log: () => undefined }) : null
const armed = secret !== null && stripeSecretMode(secret) === 'test'
const suite = armed ? describe : describe.skip

const PASSWORD = 'correct horse battery staple'
const OWNER = 'ana'
const TEAM = 'crew'
const DOOR = `@${OWNER}/${TEAM}`
const PRICE = '1'
const SEAL = 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab'

const device = (name: string) => ({
  id: randomUUID(),
  kind: 'browser' as const,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

interface Who {
  username: string
  token: string
}

let dirs: string[] = []
let registry = ''
let registryServer: http.Server | null = null
let door = ''
let doorServer: http.Server | null = null
const people: Record<string, Who> = {}
/** What the door reported to cookrew.dev as bought, in order. */
const reported: Array<{ team: string; username: string; by: string; receipt: string }> = []
/** The door's own record of open sessions, so the test can watch them. */
const sessions = new Map<string, string>()

const reg = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${registry}${p}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  })
const as = (who: Who): Record<string, string> => ({ authorization: `Bearer ${who.token}` })

const atDoor = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${door}/${TEAM}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })

async function claim(username: string): Promise<Who> {
  const res = await reg('POST', '/v2/accounts', { username, password: PASSWORD, device: device(username) })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { session: { token: string } }
  return { username, token: body.session.token }
}

/** The owner's app, serving one paid crew on the real Stripe rail. */
async function ownerApp(config: StripeConfig): Promise<string> {
  const base = mkdtempSync(path.join(tmpdir(), 'stripe-e2e-owner-'))
  dirs.push(base)
  const issuer = new CallCredentialService({ base })
  const callers = new ServedCallers()
  const doorCallers = new DoorCallers()
  const served = new ServedTemplates({ orchOf: () => 'Conductor' })
  served.serve({ serviceId: 'svc-crew', templateId: 'crew-team', slug: TEAM, access: 'paid', priceUsd: PRICE })
  const histories = new Map<string, TurnRecord[]>()
  const redemptions = createStripeRedemptionStore(path.join(base, 'stripe-redemptions.json'))
  const verifier = createV2CallTokenVerifier({ keys: v2KeysOverHttp(registry) })
  const settles = new SeatSettleQueue({
    base,
    sleep: async () => undefined,
    seats: {
      settle: async (team, input) => {
        reported.push({ team, ...input })
        const res = await reg('POST', `/v2/teams/${team}/seats/settle`, input, as(people.owner))
        const body = (await res.json()) as { seat?: unknown; error?: string }
        return res.status === 201
          ? { ok: true, value: body.seat as never }
          : { ok: false, reason: (body.error ?? 'offline') as never }
      }
    }
  })

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const slug = url.pathname.split('/').filter(Boolean)[0] ?? ''
      const template = served.bySlug(slug)
      if (!template) {
        res.writeHead(404).end('{}')
        return
      }
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      let body: unknown = null
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      } catch {
        body = null
      }
      const headers: Record<string, string | undefined> = {}
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
      const method = (req.method ?? 'GET').toUpperCase()
      const pathname = url.pathname.slice(`/${slug}`.length) || '/'
      const issuerDeps = {
        challenge: (b: string) => issuer.challenge(b),
        consumeChallenge: (v: string, b?: string) => issuer.consumeChallenge(v, b),
        mint: (sub: string, scope: string) => issuer.mint(sub, scope),
        verifyToken: (t: string) => issuer.verifyToken(t)
      }
      const checkout = await handleServedPayRoute(
        {
          issuer: issuerDeps,
          createCheckout: async (input) => {
            const result = await stripeCreateCheckout(
              { config, post: stripePost },
              {
                priceUsd: input.amountUsd,
                serviceId: input.serviceId,
                sub: input.sub,
                slug: input.slug,
                successUrl: input.successUrl,
                ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }),
                ...(input.team === undefined ? {} : { team: input.team })
              }
            )
            return result.ok ? result.url : null
          },
          successUrl: (t) => `${door}/${t.slug}?payment=received`,
          doorName: () => DOOR,
          registryOrigin: () => registry
        },
        template,
        method,
        pathname,
        headers,
        body
      )
      if (checkout !== null) {
        res.writeHead(checkout.status, { 'content-type': 'application/json', ...(checkout.headers ?? {}) })
        res.end(JSON.stringify(checkout.body))
        return
      }
      const authorization = headers.authorization ?? ''
      const claims = authorization.startsWith('Bearer ') ? issuer.verifyToken(authorization.slice(7)) : null
      const deps: ServedEndpointDeps = {
        issuer: issuerDeps,
        callers,
        doorName: () => DOOR,
        v2Tokens: verifier,
        onV2Seated: (entry) => doorCallers.seated(entry),
        entitled: (serviceId, sub) => doorCallers.entitled(serviceId, sub),
        onPaid: (payment) => {
          doorCallers.bought(payment.serviceId, payment.sub)
          const username = payment.sub.replace(/^acct-/, '')
          void settles.record({ team: DOOR, username, by: payment.by, receipt: payment.receipt }).catch(() => undefined)
        },
        grantBudget: { allowsNewSession: () => true },
        admit: async (serviceId, sub) => {
          const key = `${serviceId}/${sub}`
          const open = sessions.get(key)
          if (open) return { workspaceId: `ws-${open}`, sessionId: open, created: false }
          const sessionId = `${sub}-${sessions.size + 1}`
          sessions.set(key, sessionId)
          return { workspaceId: `ws-${sessionId}`, sessionId, created: true }
        },
        hasOpenSession: (serviceId, sub) => sessions.has(`${serviceId}/${sub}`),
        endSession: (serviceId, sub) => sessions.delete(`${serviceId}/${sub}`),
        conductorFor: (sessionId) => `orch-${sessionId}`,
        ask: async (orch, prompt) => {
          const history = histories.get(orch) ?? []
          const index = history.length + 1
          histories.set(orch, [
            ...history,
            { index, uuid: `${orch}-${index}`, prompt, reply: `heard: ${prompt}`, startedAt: index, endedAt: index + 1, final: true }
          ])
          return `heard: ${prompt}`
        },
        sessionForCaller: (serviceId, sub) => {
          const sessionId = sessions.get(`${serviceId}/${sub}`)
          return sessionId ? { conductorId: `orch-${sessionId}` } : null
        },
        turns: { history: (terminalId) => histories.get(terminalId) ?? [] },
        traces: {
          index: async () => [],
          boundaryMarkers: async () => [],
          page: async () => ({ blocks: [], total: 0, source: 'claude' as const })
        },
        paymentTerms: (t) =>
          combinePaymentTerms(null, stripePaymentTerms(config, t.priceUsd ?? '', `/${t.slug}/api/call/pay`)),
        settle: (payment, amountUsd) =>
          railSettle(
            {
              x402: async () => 'refused',
              stripe: async (stripePayment) => {
                if (claims === null || claims.workspace !== template.serviceId) return 'refused'
                return stripeSettle(
                  { config, get: stripeGet, redemptions },
                  stripePayment,
                  { amountUsd, serviceId: template.serviceId, sub: claims.sub }
                )
              }
            },
            payment
          ),
        crewFace: (t) => ({
          name: 'The Crew',
          serviceId: t.serviceId,
          slug: t.slug,
          address: `${door}/${t.slug}`,
          version: 1,
          access: t.access,
          ...(t.priceUsd !== undefined ? { priceUsd: t.priceUsd } : {}),
          door: 'Conductor',
          agents: 2
        })
      }
      const answer = await handleServedRoute(deps, template, method, pathname, {
        headers,
        body,
        query: Object.fromEntries(url.searchParams.entries())
      })
      if (answer === null) {
        res.writeHead(404).end('{}')
        return
      }
      res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) })
      res.end(JSON.stringify(answer.body))
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  doorServer = server
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** The buyer's walk to the door: a registry token with the given intent, presented at the door. */
async function signInAtDoor(who: Who, intent: 'open' | 'buy'): Promise<{ status: number; doorToken: string | null; purpose?: string; seat: string | null }> {
  const minted = await reg('POST', `/v2/teams/${DOOR}/call-token`, intent === 'buy' ? { intent: 'buy' } : {}, as(who))
  if (minted.status !== 201) return { status: minted.status, doorToken: null, seat: null }
  const body = (await minted.json()) as { token: string; purpose?: string; seat: string | null }
  const asserted = await atDoor('POST', '/api/call/assert', { v2Token: body.token })
  expect(asserted.status).toBe(200)
  const at = (await asserted.json()) as { token: string }
  return { status: 201, doorToken: at.token, purpose: body.purpose, seat: body.seat }
}

/** Fill one field on Stripe's hosted page by id: focus, select all, type. */
type Page = Awaited<ReturnType<typeof connectPage>>
async function fill(page: Page, id: string, value: string): Promise<void> {
  const found = await page.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return false; el.focus(); el.select?.(); return true })()`)
  if (found !== true) throw new Error(`Stripe Checkout has no #${id}`)
  await page.send('Input.insertText', { text: value })
}

/** Pick an option in one of Stripe's (React-controlled) selects: the native setter, then the event React listens for. */
async function choose(page: Page, id: string, value: string): Promise<void> {
  const ok = await page.evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)})
    if (!el) return 'missing'
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`)
  if (ok !== value) throw new Error(`Stripe Checkout #${id} would not take ${value} (${String(ok)})`)
}

const press = async (page: Page, at: { x: number; y: number }): Promise<void> => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  }
}

const suggestionsOpen = async (page: Page): Promise<boolean> =>
  (await page.evaluate(`document.body.textContent.includes('Suggestions powered by Google')`)) === true

/**
 * The address field opens Google's suggestions over the rest of the form,
 * and a PAY pressed while they are up is swallowed. Close them the way a
 * person does — the × in their corner — and fall back to Escape.
 */
async function closeSuggestions(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3 && (await suggestionsOpen(page)); attempt += 1) {
    const cross = (await page.evaluate(`(() => {
      const head = Array.from(document.querySelectorAll('*')).find((e) => e.children.length === 0 && e.textContent.trim() === 'Suggestions powered by Google')
      if (!head) return null
      let box = head
      for (let i = 0; i < 4 && box.parentElement; i += 1) {
        box = box.parentElement
        const cross = box.querySelector('button, [role="button"], svg')
        if (cross && cross !== head) {
          const r = cross.getBoundingClientRect()
          if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        }
      }
      return null
    })()`)) as { x: number; y: number } | null
    if (cross !== null) await press(page, cross)
    else {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    }
    await sleep(500)
  }
}

/** Every field on Stripe's form and what it holds — the diagnosis when the way back never comes. */
const formState = (page: Page): Promise<unknown> =>
  page.evaluate(`Array.from(document.querySelectorAll('input,select')).map((e) => e.id + '=' + JSON.stringify(e.type === 'checkbox' ? e.checked : e.value) + (e.getAttribute('aria-invalid') === 'true' ? '!' : '')).join(' ')`)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

suite('a seat is bought on Stripe test mode, from the team page, and admits the buyer', () => {
  let chrome: { port: number; kill: () => Promise<void> } | null = null
  let checkoutUrl = ''
  let session = ''
  let buyerDoorToken = ''

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stripe-e2e-registry-'))
    dirs.push(dir)
    const v2 = createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
    const doors = new DoorStore(dir, { allowPrivate: true })
    const server = createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      identity: new IdentityService(dir),
      doors,
      stars: new StarStore(dir),
      origin: 'http://127.0.0.1',
      v2
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    registryServer = server
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    people.owner = await claim(OWNER)
    people.buyer = await claim('lin')
    people.other = await claim('mira')
    const registered = doors.register(OWNER, {
      handle: OWNER,
      name: TEAM,
      title: 'The Crew',
      door: 'Conductor',
      agents: 2,
      transport: 'relay',
      sealKey: SEAL,
      address: `https://cookrew.dev/${DOOR}`,
      access: 'paid',
      priceUsd: PRICE,
      rails: ['stripe']
    })
    expect(registered.ok).toBe(true)
    door = await ownerApp({ secretKey: secret ?? '' })
  }, 60_000)

  afterAll(async () => {
    await chrome?.kill()
    for (const server of [doorServer, registryServer]) {
      if (!server) continue
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
    dirs = []
  })

  it('refuses a plain open to somebody with no seat, and mints a buying token on the word', async () => {
    const plain = await signInAtDoor(people.buyer, 'open')
    expect(plain.status).toBe(403)
    const buying = await signInAtDoor(people.buyer, 'buy')
    expect(buying.status).toBe(201)
    expect(buying.purpose).toBe('buy')
    expect(buying.seat).toBeNull()
    buyerDoorToken = buying.doorToken ?? ''
    expect(buyerDoorToken).not.toBe('')
  })

  it('quotes the seat at the door, on the card rail', async () => {
    const asked = await atDoor('POST', '/ask', { prompt: 'hello' }, { authorization: `Bearer ${buyerDoorToken}` })
    expect(asked.status).toBe(402)
    const body = (await asked.json()) as { terms: { accepts: Array<{ scheme: string; amountUsd?: string }> } }
    expect(body.terms.accepts.map((a) => a.scheme)).toContain('stripe-checkout')
    expect(body.terms.accepts.find((a) => a.scheme === 'stripe-checkout')?.amountUsd).toBe(PRICE)
  })

  it('starts a Checkout that returns to the team page — and only to that page', async () => {
    const wrong = await atDoor('POST', '/api/call/pay', { returnUrl: `${registry}/${OWNER}/other` }, { authorization: `Bearer ${buyerDoorToken}` })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ error: 'bad_return' })

    const res = await atDoor('POST', '/api/call/pay', { returnUrl: `${registry}/${OWNER}/${TEAM}` }, { authorization: `Bearer ${buyerDoorToken}` })
    const body = (await res.json()) as { url?: string; error?: string }
    expect(res.status, JSON.stringify(body)).toBe(200)
    checkoutUrl = body.url ?? ''
    expect(checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//)
    session = /\/(cs_test_[A-Za-z0-9_]+)/.exec(checkoutUrl)?.[1] ?? ''
    expect(session).toMatch(/^cs_test_/)

    // The receipt names the seat at the published door, and the return carries the placeholder.
    const items = await stripeGet(`https://api.stripe.com/v1/checkout/sessions/${session}/line_items`, {
      headers: { authorization: `Bearer ${secret}`, 'stripe-version': '2025-08-27.basil' }
    })
    expect(items.ok).toBe(true)
    const names = ((items.json as { data: Array<{ description: string }> }).data ?? []).map((d) => d.description)
    expect(names).toEqual([`A seat at ${DOOR}`])
    const detail = await stripeGet(`https://api.stripe.com/v1/checkout/sessions/${session}`, {
      headers: { authorization: `Bearer ${secret}`, 'stripe-version': '2025-08-27.basil' }
    })
    expect((detail.json as { success_url: string }).success_url).toBe(`${registry}/${OWNER}/${TEAM}?paid={CHECKOUT_SESSION_ID}`)
    expect((detail.json as { cancel_url: string }).cancel_url).toBe(`${registry}/${OWNER}/${TEAM}`)
  }, 30_000)

  it('is paid with the 4242 card in a real browser, which lands back on the team page with the session', async () => {
    chrome = await launchChrome({ width: 1280, height: 1000 })
    const page = await connectPage(chrome.port)
    await page.send('Page.enable')
    // Tall enough that Stripe's whole form, PAY button included, is on
    // screen: the form lives in its own scroll box, and a press below the
    // viewport's edge is a press on nothing.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1700, deviceScaleFactor: 1, mobile: false })
    await page.send('Network.enable')
    await page.send('Runtime.enable')
    // The buyer is signed in at cookrew.dev in this browser, and this tab is
    // the one that left for the card page — which is what makes the ?paid=
    // on the way back count (line.js PAYING_KEY).
    await page.send('Network.setCookie', { name: 'cr_session', value: people.buyer.token, url: registry })
    const navigations: string[] = []
    const wire: string[] = []
    const logs: string[] = []
    await page.send('Log.enable')
    page.on('Network.responseReceived', (params: Record<string, unknown>) => {
      const r = params.response as { url: string; status: number }
      if (/stripe\.com\/v1\/|\/confirm|payment_pages|payment_intents/.test(r.url)) wire.push(`${r.status} ${r.url.replace(/\?.*$/, '').slice(0, 110)}`)
    })
    page.on('Runtime.consoleAPICalled', (params: Record<string, unknown>) => {
      const args = params.args as Array<{ value?: unknown; description?: string }>
      logs.push(`${String(params.type)}: ${args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 200)}`)
    })
    page.on('Log.entryAdded', (params: Record<string, unknown>) => {
      const e = params.entry as { level: string; text: string; url?: string }
      logs.push(`${e.level}: ${e.text.slice(0, 200)} ${(e.url ?? '').slice(0, 80)}`)
    })
    page.on('Page.frameNavigated', (params: Record<string, unknown>) => {
      const frame = params.frame as { url: string; parentId?: string }
      if (!frame.parentId) navigations.push(frame.url)
    })
    const goTo = async (url: string): Promise<void> => {
      const loaded = new Promise<void>((resolve) => {
        const off = page.on('Page.loadEventFired', () => {
          off()
          resolve()
        })
      })
      await page.send('Page.navigate', { url })
      await loaded
    }
    await goTo(`${registry}/${OWNER}/${TEAM}`)
    expect(await page.evaluate('document.querySelector("#team") !== null')).toBe(true)
    await page.evaluate(`sessionStorage.setItem(${JSON.stringify(`cr_paying:${DOOR}`)}, JSON.stringify({ team: ${JSON.stringify(DOOR)}, at: Date.now() }))`)

    await goTo(checkoutUrl)
    // Only what happens AFTER the card page counts as the way back.
    navigations.length = 0
    // Stripe's page renders its form after load; wait for the card field.
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if ((await page.evaluate('document.getElementById("cardNumber") !== null')) === true) break
      await sleep(500)
    }
    const ids = (await page.evaluate('Array.from(document.querySelectorAll("input,select")).map((e) => e.id || e.name).filter(Boolean)')) as string[]
    expect(ids, `Stripe form fields: ${ids.join(' ')}`).toContain('cardNumber')

    if (ids.includes('email')) await fill(page, 'email', 'lin@example.test')
    await fill(page, 'cardNumber', '4242424242424242')
    await fill(page, 'cardExpiry', '1234')
    await fill(page, 'cardCvc', '123')
    if (ids.includes('billingName')) await fill(page, 'billingName', 'Lin Buyer')
    if (ids.includes('billingCountry')) {
      await choose(page, 'billingCountry', 'US')
      await sleep(600)
    }
    if (ids.includes('billingAddressLine1')) {
      await fill(page, 'billingAddressLine1', '1 Market St')
      await sleep(800)
      await closeSuggestions(page)
    }
    const blank = async (id: string): Promise<boolean> =>
      (await page.evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return e !== null && e.value === '' })()`)) === true
    if (await blank('billingLocality')) await fill(page, 'billingLocality', 'San Francisco')
    if (await blank('billingPostalCode')) await fill(page, 'billingPostalCode', '94103')
    if (await blank('billingAdministrativeArea')) await choose(page, 'billingAdministrativeArea', 'CA')
    // Link's "save my info" is on by default and then wants a phone number;
    // this buyer is not enrolling in Link.
    await page.evaluate(`(() => { const c = document.getElementById('enableStripePass'); if (c && c.checked) c.click() })()`)
    await sleep(500)
    // Nothing may be floating over the button when it is pressed.
    await closeSuggestions(page)
    expect(await suggestionsOpen(page), 'the address suggestions are still over the form').toBe(false)
    // A REAL press: the button is found, scrolled into view, and the mouse
    // is put on it — Stripe's form is entitled to ignore a synthetic click.
    const box = (await page.evaluate(`(() => {
      const b = document.querySelector('.SubmitButton, button[type="submit"]')
      if (!b) return null
      b.scrollIntoView({ block: 'center' })
      const r = b.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: b.textContent.trim(), disabled: b.disabled }
    })()`)) as { x: number; y: number; text: string; disabled: boolean } | null
    expect(box, 'no submit button on the Stripe page').not.toBeNull()
    const viewport = (await page.evaluate('({ w: innerWidth, h: innerHeight })')) as { w: number; h: number }
    expect(box!.y, `the PAY button sits at y=${box!.y} in a ${viewport.h}px viewport`).toBeLessThan(viewport.h - 10)
    expect(box!.disabled, 'the PAY button is disabled').toBe(false)
    wire.length = 0
    logs.length = 0
    await press(page, box!)
    // A press that only reopened the suggestions is pressed again once they are closed.
    await sleep(1500)
    if (await suggestionsOpen(page)) {
      await closeSuggestions(page)
      await press(page, box!)
      await sleep(1500)
    }
    // THREE WAYS TO PRESS ONE BUTTON. Stripe's form has been seen to take a
    // real mouse click as focus only; Enter on the focused button is the
    // keyboard's press, and a form submit is the form's own. Each is tried
    // only while nothing has left for Stripe's confirm yet.
    const confirmed = (): boolean => wire.some((w) => /confirm|payment_intents/.test(w))
    const pressedBy = confirmed() ? 'mouse' : 'later'
    if (!confirmed()) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await sleep(2500)
    }
    if (!confirmed()) {
      await page.evaluate(`(() => { const b = document.querySelector('.SubmitButton, button[type="submit"]'); const f = b && b.form; if (f) f.requestSubmit(b) })()`)
      await sleep(2500)
    }
    if (process.env.COOKREW_STRIPE_E2E_TRACE === '1') process.stderr.write(`pressed by: ${pressedBy}; wire: ${wire.join(' ; ')}\n`)
    const afterPress = (await page.evaluate(`(() => { const b = document.querySelector('.SubmitButton, button[type="submit"]'); return b ? { disabled: b.disabled, busy: b.getAttribute('aria-busy'), cls: b.className.slice(0, 120), active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) } : null })()`)) as unknown
    const shotAfter = (await page.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    const fs = await import('node:fs')
    fs.writeFileSync('/tmp/stripe-e2e-after-press.png', Buffer.from(shotAfter.data, 'base64'))
    const clicked = box!.text
    // Whatever Stripe's form has to say after the press — a field it wants
    // filled — is the diagnosis when the way back never comes.
    const said = async (): Promise<string> =>
      String(await page.evaluate(`Array.from(document.querySelectorAll('[role="alert"], .FieldError, [class*="Error"]')).map((e) => e.textContent.trim()).filter(Boolean).join(' | ')`))

    // Stripe confirms the card, then sends this tab back to the team page.
    const back = Date.now() + 45_000
    let landed = ''
    const seen: string[] = []
    while (Date.now() < back) {
      landed = navigations.find((u) => u.startsWith(`${registry}/${OWNER}/${TEAM}`)) ?? ''
      if (landed) break
      await sleep(500)
      // What Stripe thinks of the session while we wait — the diagnosis
      // when the browser never comes back.
      if (seen.length < 6 && (Date.now() - (back - 45_000)) % 15_000 < 500) {
        const detail = await stripeGet(`https://api.stripe.com/v1/checkout/sessions/${session}`, {
          headers: { authorization: `Bearer ${secret}`, 'stripe-version': '2025-08-27.basil' }
        })
        const d = detail.json as { status?: string; payment_status?: string }
        seen.push(`${d.status}/${d.payment_status}@${String(await page.evaluate('location.href')).slice(0, 60)}`)
      }
    }
    if (!landed) {
      const shot = (await page.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
      const { writeFileSync } = await import('node:fs')
      writeFileSync('/tmp/stripe-e2e-stuck.png', Buffer.from(shot.data, 'base64'))
    }
    expect(landed, `navigations: ${navigations.join(' | ')} · pressed: ${clicked} · after: ${JSON.stringify(afterPress)} · wire: ${wire.join(' ; ')} · console: ${logs.slice(0, 12).join(' ; ')} · stripe: ${seen.slice(0, 2).join(', ')} · said: ${landed ? '' : await said()}`).toBe(`${registry}/${OWNER}/${TEAM}?paid=${session}`)

    // The page spends the return: the URL is scrubbed, the session is held
    // for the line, the gate says so, and the buying token is asked for.
    await sleep(2500)
    expect(await page.evaluate('location.search')).toBe('')
    expect(await page.evaluate(`sessionStorage.getItem(${JSON.stringify(`cr_paid:${DOOR}`)})`)).toBe(session)
    expect(await page.evaluate('document.getElementById("gate-h").textContent')).toBe('Payment received')
    page.close()
  }, 200_000)

  it('admits the buyer on the paid session, once, and never quotes them again', async () => {
    const paid = { authorization: `Bearer ${buyerDoorToken}`, 'x-payment': stripePaymentHeader(session) }
    const first = await atDoor('POST', '/ask', { prompt: 'first' }, paid)
    expect(first.status, await first.text()).toBe(200)
    // The open session, asked again without any payment: no 402.
    const second = await atDoor('POST', '/ask', { prompt: 'second' }, { authorization: `Bearer ${buyerDoorToken}` })
    expect(second.status).toBe(200)
    // Ended, and started again on the same token: the purchase admits, no card.
    const ended = await atDoor('POST', SERVED_SESSION_END_PATH, undefined, { authorization: `Bearer ${buyerDoorToken}` })
    expect(ended.status).toBe(200)
    const again = await atDoor('POST', '/ask', { prompt: 'third' }, { authorization: `Bearer ${buyerDoorToken}` })
    expect(again.status).toBe(200)
    // The same session id presented a second time is spent — refused, nothing charged.
    await atDoor('POST', SERVED_SESSION_END_PATH, undefined, { authorization: `Bearer ${buyerDoorToken}` })
    const replay = await signInAtDoor(people.other, 'buy')
    const stolen = await atDoor('POST', '/ask', { prompt: 'mine?' }, { authorization: `Bearer ${replay.doorToken}`, 'x-payment': stripePaymentHeader(session) })
    expect(stolen.status).toBe(402)
    expect(await stolen.json()).toEqual({ reason: 'invalid', retryable: false })
  }, 30_000)

  it('is a seat at cookrew.dev, bought by card, that the next token carries', async () => {
    const deadline = Date.now() + 10_000
    let seat: { source?: string; by?: string } | null = null
    while (Date.now() < deadline && seat === null) {
      const res = await reg('GET', `/v2/teams/${DOOR}/seat`, undefined, as(people.buyer))
      seat = ((await res.json()) as { seat: typeof seat }).seat
      if (seat === null) await sleep(300)
    }
    expect(seat).toMatchObject({ source: 'bought', by: 'stripe' })
    expect(reported).toEqual([{ team: DOOR, username: 'lin', by: 'stripe', receipt: session }])
    const opened = await signInAtDoor(people.buyer, 'open')
    expect(opened.status).toBe(201)
    expect(opened.seat).not.toBeNull()
    expect(opened.purpose).toBeUndefined()
  }, 30_000)
})
