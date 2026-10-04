import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore plain JS helper shared with the perf probes
import { connectPage, findChrome, launchChrome } from '../scripts/perf-dom-probe.mjs'

/**
 * THE MARKET AS A SHOP, DRIVEN WITH REAL INPUT.
 *
 * A real registry on a real port, a real Chrome, and the market's own
 * buttons pressed the way a person presses them. The walk is the one the
 * owner asked for: a stranger sees prices and one way in; signing in is a
 * username and a password typed into the account sheet — nothing asks for a
 * handle, nothing enrols a key; the page then reads every card by that
 * username; a star takes without a dialog; a seat granted by an owner puts
 * the team on the reader's shelf with OPEN; and a priced team the reader
 * holds no seat at offers BUY, which lands on the team page with ?buy=1.
 *
 * Skipped where there is no Chrome to drive.
 */

const PASSWORD = 'correct horse battery staple'
/**
 * A REAL door key. line.js seals every exchange to it in WebCrypto before the
 * relay is even asked, so a made-up string would fail at the seal — as a
 * DOMException, not as the door's own answer — and the page would read a
 * sign-in problem where there is none.
 */
const SEAL = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
const chrome = findChrome() as string | null

interface Page {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(method: string, cb: (params: Record<string, unknown>) => void): () => void
  evaluate(expression: string): Promise<unknown>
  close(): void
}

let dir = ''
let origin = ''
let close: () => Promise<void> = async () => undefined
let browser: { port: number; kill(): Promise<void> } | null = null
let page: Page

const device = (name: string) => ({
  id: randomUUID(),
  kind: 'browser' as const,
  name,
  jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
})

/** Navigate and wait for the load event. */
async function go(url: string): Promise<void> {
  const loaded = new Promise<void>((resolve) => {
    const off = page.on('Page.loadEventFired', () => {
      off()
      resolve()
    })
  })
  await page.send('Page.navigate', { url })
  await loaded
  await new Promise((r) => setTimeout(r, 300))
}

/** Wait for the next load after something the page does (a reload, a link). */
async function nextLoad(act: () => Promise<unknown>, timeoutMs = 15_000): Promise<void> {
  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => void page.evaluate('location.href').then((at) => reject(new Error(`no navigation; still at ${String(at)}`))),
      timeoutMs
    )
    const off = page.on('Page.loadEventFired', () => {
      clearTimeout(timer)
      off()
      resolve()
    })
  })
  await act()
  await loaded
  await new Promise((r) => setTimeout(r, 300))
}

/**
 * A real click at the element's centre — the pointer, not el.click(). The
 * page is measured after it has settled (two frames, fonts in) and the point
 * is checked to actually land on the element, because a layout that shifts
 * between the measure and the press is a click on whatever moved there.
 */
async function click(selector: string): Promise<void> {
  let box: { x: number; y: number } | null = null
  for (let attempt = 0; attempt < 5 && box === null; attempt += 1) {
    box = (await page.evaluate(`(async () => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      // The site scrolls smoothly (html{scroll-behavior:smooth}); a measure
      // taken mid-glide is a point the element has not reached yet.
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      await document.fonts.ready
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const hit = document.elementFromPoint(x, y)
      return hit && (hit === el || el.contains(hit)) ? { x, y } : null
    })()`)) as { x: number; y: number } | null
    if (box === null) await new Promise((r) => setTimeout(r, 250))
  }
  if (!box) throw new Error(`nothing clickable at ${selector}`)
  // A move first: a press that arrives from nowhere is not a click Chrome
  // delivers to the element under it.
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  // The handlers behind these buttons await a fetch or a device key before
  // they draw; give the page a beat before reading what the click did.
  await new Promise((r) => setTimeout(r, 400))
}

/**
 * Click until the page shows what the click was for. A modal that is still
 * settling can take a press and do nothing with it; the retry is bounded and
 * the predicate is the page's own state, so a pass means the thing happened.
 */
async function clickUntil(selector: string, done: string, tries = 3): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await click(selector)
    for (let poll = 0; poll < 8; poll += 1) {
      if ((await page.evaluate(done)) === true) return
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error(`${selector} never led to: ${done}`)
}

/** Poll the page's own state until it is true, within a bound. */
async function waitFor(done: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if ((await page.evaluate(done)) === true) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`never true: ${done}`)
}

async function type(selector: string, text: string): Promise<void> {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  await page.send('Input.insertText', { text })
}

const text = async (selector: string): Promise<string> =>
  String(await page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`))
const count = async (selector: string): Promise<number> =>
  Number(await page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`))
const html = async (): Promise<string> => String(await page.evaluate('document.documentElement.outerHTML'))

beforeAll(async () => {
  if (chrome === null) return
  dir = mkdtempSync(path.join(tmpdir(), 'market-shop-e2e-'))
  const v2 = createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  const doors = new DoorStore(dir, { allowPrivate: true })
  const face = { door: 'Pilot', agents: 3, transport: 'relay' as const, sealKey: SEAL }
  doors.register('drej', { ...face, handle: 'drej', name: 'alpha', title: 'COOKREW Alpha', address: 'https://cookrew.dev/@drej/alpha', access: 'paid', priceUsd: '1', rails: ['stripe'], summary: 'Builder, reviewer, and the orch that keeps them honest.' })
  doors.register('drej', { ...face, handle: 'drej', name: 'ledger', title: 'Ledger Room', address: 'https://cookrew.dev/@drej/ledger', access: 'paid', priceUsd: '4.50', rails: ['stripe'] })
  doors.register('drej', { ...face, handle: 'drej', name: 'open-house', title: 'Open House', address: 'https://cookrew.dev/@drej/open-house', access: 'account', rails: [] })
  const server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors,
    stars: new StarStore(dir),
    v2
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // localhost, not 127.0.0.1: Chrome accepts a Secure cookie from an http
  // localhost origin, and the session cookie is `__Host-` (Secure by rule).
  origin = `http://localhost:${(server.address() as AddressInfo).port}`
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => {
        rmSync(dir, { recursive: true, force: true })
        resolve()
      })
    })
  // The owner exists already, by the API — the walk is the BUYER's.
  const res = await fetch(`${origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'drej', password: PASSWORD, device: device('owner mac') })
  })
  expect(res.status).toBe(201)
  ownerToken = ((await res.json()) as { session: { token: string } }).session.token

  browser = await launchChrome({ width: 1280, height: 900 })
  page = (await connectPage(browser.port)) as Page
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Network.enable')
  page.on('Network.requestWillBeSent', (p) => {
    const request = p.request as { url: string; postData?: string }
    requests.push({ url: request.url, body: request.postData ?? '' })
  })
}, 60_000)

/** Every request the page made, so the walk can be read off the wire too. */
const requests: { url: string; body: string }[] = []

let ownerToken = ''

afterAll(async () => {
  page?.close()
  await browser?.kill()
  await close()
})

const suite = chrome === null ? describe.skip : describe

suite('the market, driven as a stranger who becomes @lin', () => {
  it('shows a stranger the prices and one way in, with no handle anywhere', async () => {
    await go(`${origin}/market`)
    expect(await count('article.team')).toBe(3)
    expect(await count('article.team [data-signin]')).toBe(3)
    expect(await text('article.team:has(a[href="/drej/alpha"]) .btn.primary')).toContain('Sign in to buy · $1')
    expect(await text('article.team:has(a[href="/drej/open-house"]) .btn.primary')).toContain('Sign in to open')
    expect(await count('#yours')).toBe(0)
    const body = await html()
    expect(body).not.toContain('Enrol')
    expect(body).not.toContain('?buy=1')
  })

  it('registers a username and a password in the account sheet, and the page becomes @lin’s', async () => {
    await clickUntil('article.team:has(a[href="/drej/alpha"]) .btn.primary[data-signin]', "document.getElementById('account-sheet')?.open === true")
    // The sheet asks for a username and a password — the handle field of
    // the old enrolment dialog does not exist on this page.
    expect(await count('#signin-handle')).toBe(0)
    await clickUntil('[data-acct-tab="register"]', "document.getElementById('acct-confirm-row')?.hidden === false")
    await type('#acct-username', 'lin')
    await type('#acct-password', PASSWORD)
    await type('#acct-confirm', PASSWORD)
    // The sheet checks the name as it is typed and writes the answer under
    // the field when it comes back — which moves the buttons. Measure the
    // submit only once the answer is in.
    await waitFor("document.getElementById('acct-username-note')?.textContent === 'free'")
    try {
      await nextLoad(() => click('#acct-submit'))
    } catch (error) {
      throw new Error(`${String(error)} — the sheet says: ${await text('#acct-message')}`)
    }
    expect(await text('#yours .chip.amber')).toBe('@lin · 0 seats · 0 starred')
    expect(await text('#signin')).toBe('@lin')
    expect(await count('article.team [data-signin]')).toBe(0)
    expect(await text('article.team[data-standing="unseated"] .btn.primary')).toContain('Buy a seat · $')
    expect(await text('article.team[data-standing="admitted"] .btn.primary')).toBe('Open')
  }, 20_000)

  it('stars a team with one click and no dialog — on its page, where the star lives now', async () => {
    const star = 'button[data-star="drej/alpha"]'
    await go(`${origin}/drej/alpha`)
    await click(star)
    await new Promise((r) => setTimeout(r, 600))
    expect(await text(`${star} span`)).toBe('1')
    expect(await page.evaluate(`document.querySelector('${star}').classList.contains('on')`)).toBe(true)
    expect(await count('dialog[open]')).toBe(0)
    expect(await count('#signin-sheet')).toBe(0)
  })

  it('puts a team on the shelf with OPEN the moment the owner grants a seat', async () => {
    const granted = await fetch(`${origin}/v2/teams/@drej/alpha/seats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ username: 'lin' })
    })
    expect(granted.status).toBe(201)
    await go(`${origin}/market`)
    expect(await text('#yours .chip.amber')).toBe('@lin · 1 seat · 1 starred')
    expect(await text('#yours .ttl')).toBe('COOKREW Alpha')
    expect(await text('#yours .stand')).toBe('Seated · granted by @drej')
    expect(await text('#yours .btn.primary')).toBe('Open')
    // The strip's row and the catalogue list it once: two cards remain below.
    expect(await count('article.team .ttl')).toBe(2)
  })

  it('BUY on a priced team lands on its page and goes to buy as @lin — no handle, no second sign-in', async () => {
    requests.length = 0
    await nextLoad(() => click('article.team[data-standing="unseated"] .btn.primary'))
    await new Promise((r) => setTimeout(r, 800))
    // line.js spent ?buy=1 off the URL and, since the reader is signed in,
    // asked cookrew.dev for the buy token at once — the username's own word
    // for this door, minted from the session, with nothing typed.
    expect(await page.evaluate('location.pathname + location.search')).toBe('/drej/ledger')
    const minted = requests.find((r) => r.url.endsWith('/v2/teams/@drej/ledger/call-token'))
    expect(minted?.body).toContain('"intent":"buy"')
    expect(await text('#seat-buy')).toContain('Buy a seat · $4.50')
    // Nobody is serving the door in this harness, so the line reports that
    // rather than a sign-in: the door was reached as @lin.
    expect(await text('#phase')).toBe('OFFLINE')
    expect(await count('#signin-handle')).toBe(0)
  }, 20_000)

  it('OPEN on the shelf lands on the line, already seated', async () => {
    await go(`${origin}/market`)
    await nextLoad(() => click('#yours .btn.primary'))
    expect(await page.evaluate('location.pathname')).toBe('/drej/alpha')
    // The door's own condition comes first (nobody serves it in this
    // harness); the seat bar still says who is reading and that they hold a seat.
    expect(await text('#phase')).toBe('OFFLINE')
    expect(await text('#seatbar')).toContain('@lin')
    expect(await text('#seatbar')).toContain('Seat since')
    expect(await count('#seatbar [data-seat-buy]')).toBe(0)
  }, 20_000)
})
