import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { connectPage, findChrome, launchChrome, serveBuild, type CdpPage, type Served } from '../scripts/perf-dom-probe.mjs'
import { doorBearer } from '../src/main/door-bearer'
import { handleMobileApi, type MobileApiDeps, type ServeOps } from '../src/main/mobile-api'
import { createServeGate } from '../src/main/serve-gate'
import { MKT_GATE, MKT_PAY } from '../src/shared/marketplace-copy'
import {
  BAD_USDC,
  DOOR,
  PAID,
  TEAM,
  startPaidDoorWorld,
  template,
  type AppOn,
  type PaidDoorWorld
} from './support/paid-door-world'

/**
 * BUY A SEAT, PRESSED.
 *
 * The real ImportGate on a page (tests/perf/fixtures/buy-preview), driven in a
 * headless Chrome with real pointer presses, and behind its bridge the real
 * thing all the way down: the desktop's own route handler (`handleMobileApi`),
 * the gate verbs (`createServeGate`), a real registry and the real door ladder
 * (tests/support/paid-door-world.ts). There is no DOM test environment in this
 * project, so the presses are a browser's.
 *
 * What it holds: pressing BUY A SEAT on the no-seat step lands on the pay step
 * with the door's own price and rails — nothing charged, no card added to the
 * canvas, no window opened; paying ends where a paid import ends; and a
 * refusal on the way is the sheet's own sentence.
 *
 * Needs a Chrome (scripts/perf-dom-probe.mjs findChrome; COOKREW_CHROME to
 * name one). Without it the file reports why and skips.
 */

const FIXTURE = path.join(__dirname, 'perf', 'fixtures', 'buy-preview')
const TOKEN = 'pairing-token-for-the-click-test'
const PRIMARY = '.tf-foot .cr-btn.primary'
const chrome = findChrome()
if (!chrome) process.stdout.write('seat-buy-click: no Chrome found — skipped (set COOKREW_CHROME)\n')
const describeWithChrome = chrome ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** What the fixture recorded leaving the sheet. */
interface Left {
  nodes: unknown[]
  windows: string[]
  placed: unknown
  dismissed: boolean
}

describeWithChrome('BUY A SEAT, pressed', () => {
  let world: PaidDoorWorld
  let out = ''
  let served: Served | null = null
  let api: http.Server
  let browser: Awaited<ReturnType<typeof launchChrome>> | null = null
  /** The gate verbs the page's presses reach — swapped per case, one Mac each. */
  let serve: Pick<ServeOps, 'gate' | 'checkout' | 'settle'> | null = null

  beforeAll(async () => {
    world = await startPaidDoorWorld()
    // THE DESKTOP'S OWN ROUTES, behind the page. Only the gate's three verbs
    // are wired; the sheet under test has no business calling the others.
    const never = (verb: string) => async (): Promise<never> => {
      throw new Error(`the gate sheet called ${verb}`)
    }
    const deps = {
      pairingToken: TOKEN,
      serve: {
        inspect: never('inspect'),
        browse: never('browse'),
        import: never('import'),
        gate: (link, intent) => serve!.gate(link, intent),
        checkout: (link) => serve!.checkout(link),
        settle: (link, rail, session) => serve!.settle(link, rail, session)
      } satisfies ServeOps
    } as unknown as MobileApiDeps
    api = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    out = mkdtempSync(path.join(tmpdir(), 'cookrew-buy-click-'))
    await build({ root: FIXTURE, configFile: false, logLevel: 'silent', base: './', plugins: [react()], build: { outDir: out, emptyOutDir: true, minify: false } })
    served = await serveBuild(out, (api.address() as AddressInfo).port, { remote: false })
    browser = await launchChrome({ width: 1100, height: 900, chrome })
  }, 240_000)

  afterAll(async () => {
    await browser?.kill()
    served?.close()
    api?.closeAllConnections()
    api?.close()
    if (out) rmSync(out, { recursive: true, force: true })
    await world?.close()
  })

  /** A REAL press: the pointer moves to the element's centre and clicks, through CDP. */
  async function click(page: CdpPage, selector: string): Promise<void> {
    const box = await page.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
    )
    expect(box, selector).not.toBeNull()
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box!.x, y: box!.y })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box!.x, y: box!.y, button: 'left', clickCount: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box!.x, y: box!.y, button: 'left', clickCount: 1 })
  }

  const text = (page: CdpPage, selector: string): Promise<string> =>
    page.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`)

  /** Wait until the footer primary reads `label` and can be pressed. */
  async function primaryReads(page: CdpPage, label: string, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms
    let seen = ''
    while (Date.now() < deadline) {
      seen = await text(page, PRIMARY)
      const disabled = await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(PRIMARY)})?.disabled === true`)
      if (seen === label && !disabled) return
      await sleep(100)
    }
    throw new Error(`the primary never read "${label}" — it reads "${seen}"; the sheet says: ${await text(page, '.gk-panel')}`)
  }

  /** Wait for some words to be on the sheet. */
  async function sheetSays(page: CdpPage, words: string, ms = 20_000): Promise<string> {
    const deadline = Date.now() + ms
    let seen = ''
    while (Date.now() < deadline) {
      seen = await text(page, '.gk-panel')
      if (seen.includes(words)) return seen
      await sleep(100)
    }
    throw new Error(`the sheet never said "${words}" — it says: ${seen}`)
  }

  /** A fresh page on the gate for this door, and every exception it throws. */
  async function openGate(): Promise<{ page: CdpPage; errors: string[] }> {
    const page: CdpPage = await connectPage(browser!.port)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    const errors: string[] = []
    page.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
      errors.push(details?.exception?.description ?? details?.text ?? 'exception')
    })
    const query = `link=${encodeURIComponent(DOOR)}&token=${encodeURIComponent(TOKEN)}`
    await page.send('Page.navigate', { url: `http://127.0.0.1:${served!.port}/index.html?${query}` })
    return { page, errors }
  }

  const left = (page: CdpPage): Promise<Left> => page.evaluate<Left>('window.__left()')

  const cardSignIn = (app: AppOn): Promise<string> =>
    doorBearer(
      { admit: (target, team) => app.ops.admitCard(target, team), withKey: () => Promise.reject(new Error('no key')) },
      { origin: world.planeOrigin, slug: DOOR },
      DOOR
    )

  it('lands on the pay step with the door’s terms, opens no page, and after the card is paid ends as a paid import', async () => {
    const guest = await world.registeredMachine('click-card', 'pia')
    const app = world.appOn(guest.accounts)
    serve = app.ops
    world.checkoutNext(PAID)
    const { page, errors } = await openGate()
    try {
      // ── the seat step, as an account with no seat meets it ──
      await primaryReads(page, 'BUY A SEAT · $1.00')
      const refused = await text(page, '.gk-panel')
      expect(refused).toContain('@pia has no seat at @drej/alpha.')
      expect(refused).toContain('Ask @drej for one, or buy one')
      expect(app.minted).toEqual([{}])

      // ── THE PRESS ──
      await click(page, PRIMARY)
      await primaryReads(page, 'PAY 1.00 USD')
      const quoted = await text(page, '.gk-panel')
      // The door's own terms: its price, its rail, and the OWNER as who is paid —
      // never the team's slug wearing an @.
      expect(quoted).toContain('1.00 USD')
      expect(quoted).toContain('Stripe')
      expect(quoted).toContain('Paid directly to @drej')
      expect(quoted).not.toContain('@alpha')
      // And it does not say the seat is theirs before they have paid for it.
      expect(quoted).not.toContain(MKT_GATE['mkt.gate.seat.done'])
      expect(await page.evaluate<string>(`(document.querySelector('.gk-chips button[aria-pressed="true"]')?.textContent ?? '').trim()`)).toContain(MKT_PAY['mkt.pay.rail.card'])
      // BUY was said once, by this press — and it asked; it did not charge.
      expect(app.minted).toEqual([{}, { intent: 'buy' }])
      expect(world.openedBy).not.toContain('acct-pia')
      expect(world.callers.entitled(template.serviceId, 'acct-pia')).toBe(false)
      // NO WEB PAGE: no card on the canvas, no window, no link followed, and the page never left.
      expect(await left(page)).toEqual({ nodes: [], windows: [], placed: null, dismissed: false })
      expect(await page.evaluate<number>("document.querySelectorAll('a[href], iframe, webview').length")).toBe(0)
      expect(await page.evaluate<string>('location.pathname')).toBe('/index.html')

      // ── paying: the sheet waits on the card, then opens by itself ──
      await click(page, PRIMARY)
      await primaryReads(page, MKT_GATE['mkt.gate.open.action'], 30_000)
      expect(world.openedBy).toContain('acct-pia')
      // Paid: now the seat is theirs, and the sheet says so.
      expect(await text(page, '.gk-panel')).toContain(MKT_GATE['mkt.gate.seat.done'])
      expect((await left(page)).placed).toBeNull()

      // ── DONE hands the import what was paid: the card is placed with its receipt ──
      await click(page, PRIMARY)
      await sleep(200)
      expect(await left(page)).toEqual({
        nodes: [],
        windows: [],
        placed: { price: '1.00', asset: 'USD', rail: 'stripe' },
        dismissed: false
      })
      // And the card that import places is admitted, as this account.
      const bearer = await cardSignIn(app)
      const line = await fetch(`${world.planeOrigin}/${DOOR}/line`, { headers: { authorization: `Bearer ${bearer}` } })
      expect(line.status).toBe(200)
      await line.body?.cancel()
      expect(errors).toEqual([])
    } finally {
      page.close()
    }
  }, 120_000)

  it('a payment the door will not take is said on the pay step, in the accusing voice, and nothing is placed', async () => {
    const guest = await world.registeredMachine('click-usdc', 'quin')
    const app = world.appOn(guest.accounts, { usdc: BAD_USDC })
    serve = app.ops
    world.quote(['stripe', 'x402'])
    const { page, errors } = await openGate()
    try {
      await primaryReads(page, 'BUY A SEAT · $1.00')
      await click(page, PRIMARY)
      await primaryReads(page, 'PAY 1.00 USD')
      // Both rails the door quoted are offered; the wallet one names the wallet.
      expect(await page.evaluate<number>("document.querySelectorAll('.gk-chips button').length")).toBe(2)
      await click(page, '.gk-chips button:nth-of-type(2)')
      await primaryReads(page, 'PAY 1 USDC')
      expect(await text(page, '.gk-panel')).toContain('base-sepolia')
      await click(page, PRIMARY)
      const said = await sheetSays(page, MKT_PAY['mkt.pay.error.invalid.title'])
      expect(said).toContain(MKT_PAY['mkt.pay.error.invalid.body'])
      expect(await page.evaluate<number>("document.querySelectorAll('.gk-err.accuse[role=alert]').length")).toBe(1)
      // Still the pay step — the refusal is said where the money was asked for, not on a sheet of its own.
      expect(said).toContain('Terms — what the gate quoted')
      expect(said).not.toContain(MKT_GATE['mkt.gate.seat.done'])
      expect(await left(page)).toEqual({ nodes: [], windows: [], placed: null, dismissed: false })
      expect(world.callers.entitled(template.serviceId, 'acct-quin')).toBe(false)
      expect(errors).toEqual([])
    } finally {
      world.quote(['stripe'])
      page.close()
    }
  }, 120_000)

  it('a door that went away between the refusal and the press is the gate’s own sentence, not a silent sheet', async () => {
    const guest = await world.registeredMachine('click-gone', 'rio')
    const app = world.appOn(guest.accounts)
    // The same Mac, asking a name nobody answers at any more.
    const closed = createServeGate({
      parse: () => ({ origin: world.origin, slug: TEAM, door: DOOR }),
      reachable: async () => ({ at: { origin: world.planeOrigin, slug: '@drej/closed', door: DOOR }, listed: true, live: true }),
      accounts: guest.accounts,
      signInWithKey: () => Promise.reject(new Error('no key')),
      wallet: () => null,
      buildX402Payment: () => Promise.reject(new Error('no wallet'))
    })
    serve = {
      gate: (link, intent) => (intent === 'buy' ? closed.gate(link, intent) : app.ops.gate(link)),
      checkout: (link) => closed.checkout(link),
      settle: (link, rail, session) => closed.settle(link, rail, session)
    }
    const { page, errors } = await openGate()
    try {
      await primaryReads(page, 'BUY A SEAT · $1.00')
      await click(page, PRIMARY)
      const said = await sheetSays(page, MKT_GATE['mkt.gate.error.title'])
      expect(said).toContain(MKT_GATE['mkt.gate.error.why'])
      expect(await left(page)).toEqual({ nodes: [], windows: [], placed: null, dismissed: false })
      expect(errors).toEqual([])
    } finally {
      page.close()
    }
  }, 120_000)
})
