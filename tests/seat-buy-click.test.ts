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
import type { Accounts } from '../src/main/account-v2'
import { CARD_POLL_MS, CARD_SESSION_LIFE_MS } from '../src/renderer/src/card-wait'
import { MKT_DENIED_REASONS, MKT_GATE, MKT_PAY } from '../src/shared/marketplace-copy'
import {
  BAD_USDC,
  DOOR,
  GOOD_USDC,
  PAID,
  TEAM,
  UNPAID,
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
        settle: (link, rail, session, shown) => serve!.settle(link, rail, session, shown)
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

  it('a payment the door will not take is said on the pay step, and the step stays alive: the card is paid instead', async () => {
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
      // AND THE STEP IS NOT DEAD (M2): both rails are still there, the same
      // one is still selected with its button live, and the card can be chosen instead.
      expect(await page.evaluate<number>("document.querySelectorAll('.gk-chips button').length")).toBe(2)
      await primaryReads(page, 'PAY 1 USDC')
      expect(said).toContain('base-sepolia')
      await click(page, '.gk-chips button:nth-of-type(1)')
      await primaryReads(page, 'PAY 1.00 USD')
      // Choosing another way to pay clears the accusation about the last one.
      expect(await page.evaluate<number>("document.querySelectorAll('.gk-err').length")).toBe(0)
      world.checkoutNext(PAID)
      await click(page, PRIMARY)
      await primaryReads(page, MKT_GATE['mkt.gate.open.action'], 30_000)
      expect(await left(page)).toEqual({ nodes: [], windows: [], placed: null, dismissed: false })
      // Seated by the card, after the wallet was refused: one payment, the one that verified.
      expect(world.callers.entitled(template.serviceId, 'acct-quin')).toBe(true)
      expect(app.signed).toHaveLength(1)
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
      settle: (link, rail, session, shown) => closed.settle(link, rail, session, shown)
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

  /** The gate verbs of one Mac, with every card page it asked for and every session it presented. */
  function counted(app: AppOn): { checkouts: number; presented: Array<string | undefined> } {
    const seen = { checkouts: 0, presented: [] as Array<string | undefined> }
    serve = {
      gate: (link, intent) => app.ops.gate(link, intent),
      checkout: (link) => {
        seen.checkouts += 1
        return app.ops.checkout(link)
      },
      settle: (link, rail, session, shown) => {
        seen.presented.push(session)
        return app.ops.settle(link, rail, session, shown)
      }
    }
    return seen
  }

  it('M3 — the wait ends out loud, CHECK AGAIN asks about the SAME session, and a new payment waits for the door’s word', async () => {
    const guest = await world.registeredMachine('click-wait', 'tia')
    // Main's clock moves with the page's: main, not the sheet, decides when a
    // card session is over and a new one may be made.
    let hourLater = 0
    const app = world.appOn(guest.accounts, { now: () => Date.now() + hourLater })
    const seen = counted(app)
    world.checkoutNext(UNPAID)
    const { page, errors } = await openGate()
    try {
      await primaryReads(page, 'BUY A SEAT · $1.00')
      await click(page, PRIMARY)
      await primaryReads(page, 'PAY 1.00 USD')
      await click(page, PRIMARY)
      // The sheet is waiting: one look at the door, at least, and no live button.
      await sleep(CARD_POLL_MS + 1000)
      expect(seen.checkouts).toBe(1)
      expect(seen.presented.length).toBeGreaterThanOrEqual(1)
      expect(await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(PRIMARY)})?.disabled === true`)).toBe(true)

      // ── an hour passes, on the page and in main: the session can no longer be paid ──
      hourLater = CARD_SESSION_LIFE_MS
      await page.evaluate(`window.__skip(${CARD_SESSION_LIFE_MS})`)
      const ended = await sheetSays(page, MKT_PAY['mkt.pay.card.ended.title'])
      expect(ended).toContain(MKT_PAY['mkt.pay.card.ended.body'])
      // NOT a live PAY: the one thing offered asks about the payment already made.
      await primaryReads(page, MKT_PAY['mkt.pay.card.check'])
      expect(ended).not.toContain('PAY 1.00 USD')
      // And the wait really has stopped asking.
      const asked = seen.presented.length
      await sleep(CARD_POLL_MS + 1000)
      expect(seen.presented.length).toBe(asked)

      // ── CHECK AGAIN: the same session, once, and no new card page ──
      await click(page, PRIMARY)
      const expired = await sheetSays(page, MKT_PAY['mkt.pay.card.expired.title'])
      expect(expired).toContain(MKT_PAY['mkt.pay.card.expired.body'])
      expect(expired).not.toMatch(/nothing was charged/i)
      expect(seen.presented.length).toBe(asked + 1)
      expect(new Set(seen.presented)).toEqual(new Set([UNPAID]))
      expect(seen.checkouts).toBe(1)

      // ── only now, the door having said that session went unpaid, is PAY offered again ──
      await primaryReads(page, 'PAY 1.00 USD')
      world.checkoutNext(PAID)
      await click(page, PRIMARY)
      await primaryReads(page, MKT_GATE['mkt.gate.open.action'], 30_000)
      expect(seen.checkouts).toBe(2)
      expect(seen.presented.at(-1)).toBe(PAID)
      expect(errors).toEqual([])
    } finally {
      page.close()
    }
  }, 120_000)

  it('M3 — a refusal that arrives while waiting is spoken, and CHECK AGAIN settles the session already paid', async () => {
    const guest = await world.registeredMachine('click-budget', 'una')
    const app = world.appOn(guest.accounts)
    const seen = counted(app)
    world.checkoutNext(PAID)
    const { page, errors } = await openGate()
    try {
      await primaryReads(page, 'BUY A SEAT · $1.00')
      await click(page, PRIMARY)
      await primaryReads(page, 'PAY 1.00 USD')
      // The owner's lending budget runs out while the buyer is at Stripe.
      world.budget(false)
      await click(page, PRIMARY)
      const said = await sheetSays(page, MKT_DENIED_REASONS['mkt.denied.budget.title'])
      // A card page is open for this purchase: the sheet does not claim the card was not charged.
      expect(said).toContain(MKT_PAY['mkt.pay.card.unconfirmed.body'])
      expect(said).not.toMatch(/Nothing was charged/i)
      await primaryReads(page, MKT_PAY['mkt.pay.card.check'])
      expect(world.openedBy).not.toContain('acct-una')

      // The owner raises it. The buyer does NOT pay again: the paid session is presented once more.
      world.budget(true)
      await click(page, PRIMARY)
      await primaryReads(page, MKT_GATE['mkt.gate.open.action'], 30_000)
      expect(seen.checkouts).toBe(1)
      expect(new Set(seen.presented)).toEqual(new Set([PAID]))
      await click(page, PRIMARY)
      await sleep(200)
      expect((await left(page)).placed).toEqual({ price: '1.00', asset: 'USD', rail: 'stripe' })
      expect(errors).toEqual([])
    } finally {
      world.budget(true)
      page.close()
    }
  }, 120_000)

  it('M1 — another person signs in while a card is awaited: the wait stops, and the sheet is theirs', async () => {
    const a = await world.registeredMachine('click-a', 'vera')
    const b = await world.registeredMachine('click-b', 'wim')
    let signedIn: Accounts | null = a.accounts
    const app = world.appOn(() => signedIn)
    const seen = counted(app)
    world.checkoutNext(UNPAID)
    const { page, errors } = await openGate()
    try {
      await primaryReads(page, 'BUY A SEAT · $1.00')
      await click(page, PRIMARY)
      await primaryReads(page, 'PAY 1.00 USD')
      await click(page, PRIMARY)
      await sleep(CARD_POLL_MS + 1000)
      expect(seen.presented.length).toBeGreaterThanOrEqual(1)

      // ── the Mac changes hands ──
      signedIn = b.accounts
      app.ops.accountChanged()
      await page.evaluate('window.__accountChanged()')
      await primaryReads(page, 'BUY A SEAT · $1.00')
      expect(await text(page, '.gk-panel')).toContain('@wim has no seat at @drej/alpha.')
      // Nothing more is presented on @vera's session, by anybody.
      const asked = seen.presented.length
      await sleep(CARD_POLL_MS * 2 + 500)
      expect(seen.presented.length).toBe(asked)
      expect(errors).toEqual([])
    } finally {
      page.close()
    }
  }, 120_000)

  it('H2 — a door that raises its price at the press is named in the sheet, and the wallet is never asked', async () => {
    const guest = await world.registeredMachine('click-h2', 'xan')
    const app = world.appOn(guest.accounts, { usdc: GOOD_USDC })
    serve = app.ops
    world.quote(['x402'])
    const { page, errors } = await openGate()
    try {
      await primaryReads(page, 'BUY A SEAT · $1.00')
      await click(page, PRIMARY)
      await primaryReads(page, 'PAY 1 USDC')
      world.usdcTerms({ maxAmountRequired: '1000000000' })
      await click(page, PRIMARY)
      const said = await sheetSays(page, MKT_PAY['mkt.pay.error.changed.title'])
      expect(said).toContain(MKT_PAY['mkt.pay.error.changed.body'])
      // Said in the apology voice: the price may have gone stale on this side.
      expect(await page.evaluate<number>("document.querySelectorAll('.gk-err.apolog[role=alert]').length")).toBe(1)
      expect(app.signed).toEqual([])
      expect(world.openedBy).not.toContain('acct-xan')
      expect(errors).toEqual([])
    } finally {
      world.usdcTerms({})
      world.quote(['stripe'])
      page.close()
    }
  }, 120_000)

  it('M2 — BUY AGAIN on a refunded seat sends the buy intent and lands on the pay step', async () => {
    const guest = await world.registeredMachine('click-refund', 'yun')
    const app = world.appOn(guest.accounts)
    // A door whose seat for this account was refunded: that is what it says to a plain import.
    serve = {
      gate: async (link, intent) =>
        intent === 'buy'
          ? app.ops.gate(link, intent)
          : {
              ok: true,
              door: 'install',
              phase: { kind: 'denied', reason: 'refunded', retryable: false },
              wallet: null,
              team: DOOR,
              owner: 'drej',
              account: 'yun',
              seat: null
            },
      checkout: (link) => app.ops.checkout(link),
      settle: (link, rail, session, shown) => app.ops.settle(link, rail, session, shown)
    }
    const { page, errors } = await openGate()
    try {
      await sheetSays(page, MKT_DENIED_REASONS['mkt.denied.refunded.title'])
      // The refusal's own button, in the refusal's footer.
      const BUY_AGAIN = '.tf-foot .cr-btn:not(.ghost)'
      expect(await text(page, BUY_AGAIN)).toBe(MKT_DENIED_REASONS['mkt.denied.refunded.action'])
      expect(app.minted).toEqual([])
      await click(page, BUY_AGAIN)
      await primaryReads(page, 'PAY 1.00 USD')
      expect(app.minted).toEqual([{ intent: 'buy' }])
      expect(await left(page)).toEqual({ nodes: [], windows: [], placed: null, dismissed: false })
      expect(errors).toEqual([])
    } finally {
      page.close()
    }
  }, 120_000)

  it('D — the sheet is closed with a card page still open and opened again: it resumes THAT payment, reopens the same page, and never makes a second', async () => {
    const guest = await world.registeredMachine('click-reopen', 'zed')
    const app = world.appOn(guest.accounts)
    const seen = counted(app)
    const made = world.checkoutsMade()
    const session = 'cs_test_reopened1'
    world.checkoutNext(session)
    const first = await openGate()
    try {
      await primaryReads(first.page, 'BUY A SEAT · $1.00')
      await click(first.page, PRIMARY)
      await primaryReads(first.page, 'PAY 1.00 USD')
      await click(first.page, PRIMARY)
      await sleep(CARD_POLL_MS + 1000)
      expect(world.checkoutsMade()).toBe(made + 1)
    } finally {
      // THE SHEET IS CLOSED. Everything it held in memory is gone.
      first.page.close()
    }

    world.checkoutNext('cs_test_would_be_second')
    const { page, errors } = await openGate()
    try {
      // No seat step and no fresh pay step: the payment in flight comes first.
      const said = await sheetSays(page, MKT_PAY['mkt.pay.card.resume.title'])
      expect(said).toContain(MKT_PAY['mkt.pay.card.resume.body'])
      await primaryReads(page, MKT_PAY['mkt.pay.card.reopen'])
      expect(said).not.toContain('BUY A SEAT')
      expect(world.checkoutsMade()).toBe(made + 1)

      // REOPEN asks main for the card page: the same session comes back, and the door makes nothing.
      const asked = seen.checkouts
      await click(page, PRIMARY)
      await sleep(600)
      expect(seen.checkouts).toBe(asked + 1)
      expect(world.checkoutsMade()).toBe(made + 1)
      expect(await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(PRIMARY)})?.disabled === true`)).toBe(true)

      // The buyer pays on that page. The sheet opens by itself, on the one session there ever was.
      world.pays(session)
      await primaryReads(page, MKT_GATE['mkt.gate.open.action'], 30_000)
      expect(new Set(seen.presented)).toEqual(new Set([session]))
      await click(page, PRIMARY)
      await sleep(200)
      expect((await left(page)).placed).toEqual({ price: '1.00', asset: 'USD', rail: 'stripe' })
      expect(errors).toEqual([])
    } finally {
      page.close()
    }
  }, 120_000)

  it('D — paid after the sheet was closed: opening it again finds the seat, with its receipt and no pay step', async () => {
    const guest = await world.registeredMachine('click-landed', 'abe')
    const app = world.appOn(guest.accounts)
    const seen = counted(app)
    const session = 'cs_test_landed001'
    world.checkoutNext(session)
    const first = await openGate()
    try {
      await primaryReads(first.page, 'BUY A SEAT · $1.00')
      await click(first.page, PRIMARY)
      await primaryReads(first.page, 'PAY 1.00 USD')
      await click(first.page, PRIMARY)
      await sleep(500)
    } finally {
      first.page.close()
    }
    // Paid in the browser while no sheet was listening.
    world.pays(session)
    const { page, errors } = await openGate()
    try {
      await primaryReads(page, MKT_GATE['mkt.gate.open.action'], 30_000)
      expect(seen.checkouts).toBe(1)
      await click(page, PRIMARY)
      await sleep(200)
      expect((await left(page)).placed).toEqual({ price: '1.00', asset: 'USD', rail: 'stripe' })
      expect(errors).toEqual([])
    } finally {
      page.close()
    }
  }, 120_000)
})
