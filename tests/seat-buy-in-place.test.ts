import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Accounts } from '../src/main/account-v2'
import { doorBearer } from '../src/main/door-bearer'
import { PendingCheckouts, memoryPendingCheckouts } from '../src/main/pending-checkout'
import { CHECKOUT_MAX_LIFE_SECONDS, CHECKOUT_TTL_SECONDS } from '../src/shared/stripe-checkout'
import { STAND_IN_TTL_MS, createServeGate } from '../src/main/serve-gate'
import { signInToDoor, type AdmissionPhase } from '../src/main/served-admission'
import {
  BAD_USDC,
  DOOR,
  GOOD_USDC,
  OTHER_DOOR,
  OWNER,
  PAID,
  TEAM,
  UNCHECKABLE,
  UNPAID,
  WALLET,
  startPaidDoorWorld,
  template,
  type AppOn,
  type PaidDoorWorld
} from './support/paid-door-world'

/**
 * A SEAT IS BOUGHT IN THE APP (0.6.0) — the whole chain, for real.
 *
 * The team's page at cookrew.dev was the one surface that could buy a seat at
 * a listed paid team, and 0.6.0 deleted it. What replaces it is the import
 * gate's own walk with `intent: 'buy'`: cookrew.dev mints a token with no seat,
 * the door admits it as far as its 402, and the sheet lands on the pay phase
 * it already had.
 *
 * The world is tests/support/paid-door-world.ts: a real registry, the real
 * door ladder and pay route, the real settle queue, and the app's own gate
 * verbs (`createServeGate`) on real accounts. Only the rails are stand-ins.
 */

const SLOW = 60_000

let world: PaidDoorWorld

type Gated = {
  ok: true
  door: string
  phase: AdmissionPhase
  wallet: { address: string } | null
  team?: string
  owner?: string
  account?: string | null
  seat?: string | null
}

/** The placed card's sign-in — and its transcript reads and END, which are the same caller. */
const cardSignIn = (app: AppOn, door = DOOR): Promise<string> =>
  doorBearer(
    { admit: (target, team) => app.ops.admitCard(target, team), withKey: () => Promise.reject(new Error('no key')) },
    { origin: world.planeOrigin, slug: door },
    door
  )

/** The wallet terms a pay step displayed, as the key the surface sends back with the press. */
const walletKey = (gated: unknown): string | undefined => {
  const phase = (gated as Gated).phase
  const wallet = phase.kind === 'pay' ? phase.rails.find((rail) => rail.rail === 'x402') : undefined
  return wallet?.rail === 'x402' ? wallet.shown : undefined
}

/** Buy a seat by card as whoever `app` is, with the door's report to cookrew.dev held back. */
async function buyWithReportHeld(app: AppOn): Promise<() => void> {
  expect(((await app.ops.gate(DOOR, 'buy')) as Gated).phase.kind).toBe('pay')
  world.checkoutNext(PAID)
  await app.ops.checkout(DOOR)
  const release = world.holdReports()
  expect(await app.ops.settle(DOOR, 'stripe', PAID)).toEqual({ ok: true, phase: { kind: 'open' }, standing: false })
  return release
}

beforeAll(async () => {
  world = await startPaidDoorWorld()
}, SLOW)

afterAll(() => world.close())

describe('buying a seat at a listed paid team, in the app', () => {
  it('walks no_seat → BUY → the door’s 402 → card → settled → open, and the card opens on the seat', async () => {
    const guest = await world.registeredMachine('guest', 'lin')
    const app = world.appOn(guest.accounts)

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
    expect(world.openedBy).toEqual([])
    expect(world.callers.entitled(template.serviceId, 'acct-lin')).toBe(false)

    // ── the card rail: the door's own Checkout, then the session presented back ──
    world.checkoutNext(PAID)
    const checkout = await app.ops.checkout(DOOR)
    expect(checkout).toEqual({
      ok: true,
      session: PAID,
      url: `https://checkout.stripe.com/c/pay/${PAID}`,
      startedAt: expect.any(Number)
    })
    // THE REGISTRY IS SLOW TODAY: the door's report is held until the card has opened.
    const release = world.holdReports()
    const settled = await app.ops.settle(DOOR, 'stripe', PAID)
    expect(settled).toEqual({ ok: true, phase: { kind: 'open' }, standing: false })
    expect(world.openedBy).toEqual(['acct-lin'])
    // The door knows at once; cookrew.dev does not yet.
    expect(world.callers.entitled(template.serviceId, 'acct-lin')).toBe(true)

    // ── the placed card signs in while cookrew.dev still says no seat ──
    const early = await cardSignIn(app)
    // Its sign-in was an ordinary one — the card never says BUY.
    expect(app.minted).toEqual([{}, { intent: 'buy' }, {}])
    const line = await fetch(`${world.planeOrigin}/${DOOR}/line`, { headers: { authorization: `Bearer ${early}` } })
    expect(line.status).toBe(200)
    await line.body?.cancel()

    // ── the report lands: the seat is the account's, and the next sign-in is plain ──
    release()
    expect(await world.lastReport()).toBe(true)
    const mine = await fetch(`${world.origin}/v2/teams/${DOOR}/seat`, {
      headers: { authorization: `Bearer ${world.sessionToken(guest.base)}` }
    })
    expect(((await mine.json()) as { seat: { source?: string } | null }).seat).toMatchObject({ source: 'bought' })

    const again = (await app.ops.gate(DOOR)) as Gated
    expect(again.phase).toEqual({ kind: 'open' })
    expect(again.seat).toEqual(expect.any(String))
    await cardSignIn(app)
    // Every mint after the purchase is `{}`: BUY was said once, by a press.
    expect(app.minted.slice(3)).toEqual([{}, {}])

    // ── and an app with no memory of the purchase opens on the seat alone ──
    world.sessions.delete('acct-lin')
    const second = world.appOn(guest.accounts)
    const elsewhere = (await second.ops.gate(DOOR)) as Gated
    expect(elsewhere.phase).toEqual({ kind: 'open' })
    expect(second.minted).toEqual([{}])
  }, SLOW)

  it('the wallet rail is the same walk: quoted with both rails, signed here, admitted, seated', async () => {
    const guest = await world.registeredMachine('wallet', 'uma')
    world.quote(['stripe', 'x402'])
    try {
      const app = world.appOn(guest.accounts, { usdc: GOOD_USDC })
      const quoted = (await app.ops.gate(DOOR, 'buy')) as Gated
      expect(quoted.wallet).toEqual({ address: WALLET })
      expect(quoted.phase).toMatchObject({
        kind: 'pay',
        rails: [
          { rail: 'stripe', price: '1.00', asset: 'USD' },
          { rail: 'x402', price: '1', asset: 'USDC', chain: 'base-sepolia' }
        ]
      })
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toEqual({ ok: true, phase: { kind: 'open' } })
      // One signature, over exactly what the pay step showed.
      expect(app.signed).toHaveLength(1)
      expect(app.signed[0]).toMatchObject({ maxAmountRequired: '1000000', network: 'base-sepolia' })
      expect(await world.lastReport()).toBe(true)
      expect(((await app.ops.gate(DOOR)) as Gated).seat).toEqual(expect.any(String))
    } finally {
      world.quote(['stripe'])
    }
  }, SLOW)

  it('a card that was never paid for is refused: BUY alone opens nothing', async () => {
    const stranger = await world.registeredMachine('stranger', 'bo')
    const app = world.appOn(stranger.accounts)
    expect(((await app.ops.gate(DOOR, 'buy')) as Gated).phase.kind).toBe('pay')
    // The gate holds a Bearer for the pay sheet; the card may not borrow it.
    await expect(cardSignIn(app)).rejects.toThrow(`${DOOR} did not admit this account (denied)`)
  }, SLOW)
})

describe('what a purchase leaves in memory belongs to one account at one team (M1, L1–L3)', () => {
  /**
   * The gate keeps three things per purchase: the Bearer it pays on, the
   * wallet terms it showed, and — for the gap before cookrew.dev records the
   * seat — the Bearer the door admitted the purchase on. Each is a credential
   * or a promise about money, and a Mac changes hands: A signs out, B signs
   * in. None of them may follow the Mac instead of the person.
   */
  it('A buys, B signs in on the same Mac: B’s card is refused and never handed A’s Bearer', async () => {
    const a = await world.registeredMachine('m1-a', 'm1a')
    const b = await world.registeredMachine('m1-b', 'm1b')
    let signedIn: Accounts | null = a.accounts
    const app = world.appOn(() => signedIn)
    const release = await buyWithReportHeld(app)
    try {
      const mine = await cardSignIn(app)

      // ── the Mac changes hands, and nothing told the gate (the key alone must hold) ──
      signedIn = b.accounts
      await expect(cardSignIn(app)).rejects.toThrow(`${DOOR} did not admit this account (denied)`)
      // B cannot pay on A's Bearer or present on it either.
      expect(await app.ops.checkout(DOOR)).toMatchObject({ ok: false, reason: 'not-signed-in' })
      expect(await app.ops.settle(DOOR, 'stripe', PAID)).toMatchObject({ ok: false, reason: 'not-signed-in' })
      expect(world.openedBy.filter((sub) => sub === 'acct-m1b')).toEqual([])

      // ── A is back: the purchase is still A's ──
      signedIn = a.accounts
      expect(await cardSignIn(app)).toBe(mine)

      // ── an account EVENT that is not a change of person forgets nothing: a
      //    payment in flight must not be stranded by a password prompt ──
      app.ops.accountChanged()
      expect(await cardSignIn(app)).toBe(mine)
      expect(await app.ops.checkout(DOOR)).toMatchObject({ ok: true, session: PAID })

      // ── a change of person that IS announced forgets everything at once,
      //    and coming back does not bring it home ──
      signedIn = b.accounts
      app.ops.accountChanged()
      signedIn = a.accounts
      app.ops.accountChanged()
      await expect(cardSignIn(app)).rejects.toThrow('did not admit this account (denied)')
      expect(await app.ops.checkout(DOOR)).toMatchObject({ ok: false, reason: 'not-signed-in' })
    } finally {
      release()
      await world.lastReport()
    }
  }, SLOW)

  it('a Bearer is filed under the account the mint was MADE FOR, not whoever was here when the ask began', async () => {
    const a = await world.registeredMachine('h-switch-a', 'hswa')
    const b = await world.registeredMachine('h-switch-b', 'hswb')
    let signedIn: Accounts = a.accounts
    const gate = createServeGate({
      parse: () => ({ origin: world.origin, slug: TEAM, door: DOOR }),
      // The Mac changes hands WHILE the door is being looked up: A asked, B is here when the mint is made.
      reachable: async () => {
        signedIn = b.accounts
        return { at: { origin: world.planeOrigin, slug: DOOR, door: DOOR }, listed: true, live: true }
      },
      accounts: {
        account: () => signedIn.account(),
        authedResponse: (pathname, init) => signedIn.authedResponse(pathname, init)
      },
      signInWithKey: () => Promise.reject(new Error('no key')),
      wallet: () => null,
      buildX402Payment: () => Promise.reject(new Error('no wallet'))
    })
    const answer = (await gate.gate(DOOR, 'buy')) as Gated
    // The token is B's — that is who cookrew.dev minted for.
    expect(answer).toMatchObject({ account: 'hswb', phase: { kind: 'pay' } })
    // A, back at the Mac, holds nothing: B's Bearer was not filed under A.
    signedIn = a.accounts
    expect(await gate.settle(DOOR, 'stripe', PAID)).toMatchObject({ ok: false, reason: 'not-signed-in' })
    expect(world.openedBy).not.toContain('acct-hswb')
    expect(world.openedBy).not.toContain('acct-hswa')
  }, SLOW)

  it('a purchase at one team stands in at that team only', async () => {
    const guest = await world.registeredMachine('m1-team', 'm1team')
    const app = world.appOn(guest.accounts)
    const release = await buyWithReportHeld(app)
    try {
      await expect(cardSignIn(app, OTHER_DOOR)).rejects.toThrow(`${OTHER_DOOR} did not admit this account (denied)`)
      await expect(cardSignIn(app)).resolves.toEqual(expect.any(String))
    } finally {
      release()
      await world.lastReport()
    }
  }, SLOW)

  it('the stand-in lasts as long as a call token and no longer (L1)', async () => {
    const guest = await world.registeredMachine('m1-ttl', 'm1ttl')
    let clock = 1_700_000_000_000
    const app = world.appOn(guest.accounts, { now: () => clock })
    const release = await buyWithReportHeld(app)
    try {
      expect(STAND_IN_TTL_MS).toBe(10 * 60 * 1000)
      clock += STAND_IN_TTL_MS - 1
      await expect(cardSignIn(app)).resolves.toEqual(expect.any(String))
      clock += 1
      await expect(cardSignIn(app)).rejects.toThrow('did not admit this account (denied)')
      // Gone for good, not merely hidden: winding the clock back does not bring it home.
      clock -= STAND_IN_TTL_MS
      await expect(cardSignIn(app)).rejects.toThrow('did not admit this account (denied)')
    } finally {
      release()
      await world.lastReport()
    }
  }, SLOW)

  it('an UNLISTED door is never remembered: a purchase with this Mac’s key stands in for no account (L3)', async () => {
    const guest = await world.registeredMachine('m1-direct', 'm1direct')
    const keys = mkdtempSync(path.join(tmpdir(), 'buy-direct-key-'))
    try {
      // The same door, DIALLED: the directory does not list what was typed, so
      // the walk is the key's. Its name is carried only to prove it is not used.
      const direct = createServeGate({
        parse: () => ({ origin: world.planeOrigin, slug: DOOR, door: DOOR }),
        reachable: async (target) => ({ at: target, listed: false, live: true }),
        accounts: guest.accounts,
        signInWithKey: (at) =>
          signInToDoor(at, { sub: 'm1keyholder', candidates: () => [path.join(keys, 'k.json')], canonical: () => path.join(keys, 'k.json') }),
        wallet: () => null,
        buildX402Payment: () => Promise.reject(new Error('no wallet'))
      })
      expect(await direct.gate(DOOR)).toMatchObject({ ok: true, door: 'direct', phase: { kind: 'pay' } })
      world.checkoutNext(PAID)
      await direct.checkout(DOOR)
      expect(await direct.settle(DOOR, 'stripe', PAID)).toEqual({ ok: true, phase: { kind: 'open' }, standing: false })
      // The key-holder paid. The ACCOUNT on this Mac holds no seat, and gets no Bearer.
      await expect(
        doorBearer(
          { admit: (target, team) => direct.admitCard(target, team), withKey: () => Promise.reject(new Error('no key')) },
          { origin: world.planeOrigin, slug: DOOR },
          DOOR
        )
      ).rejects.toThrow('did not admit this account (denied)')
    } finally {
      rmSync(keys, { recursive: true, force: true })
    }
  }, SLOW)
})

describe('the wallet signs what the person was shown, or nothing (H2)', () => {
  /**
   * The x402 rail asks the door for a quote again at the press — a quote can
   * expire — and signs THAT one. So a door could show 1 USDC on the pay step
   * and quote 1000 when PAY is pressed. Every field the signature covers is
   * compared with what the pay step was built from; one difference and the
   * wallet is never asked.
   */
  const CHANGES: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['a higher amount', { maxAmountRequired: '1000000000' }],
    ['a lower amount, even', { maxAmountRequired: '1' }],
    ['a different payee', { payTo: '0x000000000000000000000000000000000000dEaD' }],
    ['a different asset', { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
    ['a different network', { network: 'base' }],
    ['a longer validity', { maxTimeoutSeconds: 86_400 }],
    ['a different signing domain name', { extra: { name: 'USD Coin', version: '2' } }],
    ['a different signing domain version', { extra: { name: 'USDC', version: '1' } }]
  ]

  it.each(CHANGES)('%s at the press is refused, and nothing is signed', async (_what, patch) => {
    const guest = await world.registeredMachine('h2', `h2${CHANGES.findIndex(([, p]) => p === patch)}`)
    world.quote(['x402'])
    try {
      const app = world.appOn(guest.accounts, { usdc: GOOD_USDC })
      expect(((await app.ops.gate(DOOR, 'buy')) as Gated).phase.kind).toBe('pay')
      const before = world.openedBy.length
      world.usdcTerms(patch)
      const answer = await app.ops.settle(DOOR, 'x402', undefined, app.shown())
      expect(answer).toMatchObject({ ok: false, reason: 'terms-changed' })
      expect(app.signed).toEqual([])
      expect(world.openedBy).toHaveLength(before)
      // The door going back to what it showed is payable again: the shown terms were kept.
      world.usdcTerms({})
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toEqual({ ok: true, phase: { kind: 'open' } })
      expect(app.signed).toHaveLength(1)
    } finally {
      world.usdcTerms({})
      world.quote(['stripe'])
    }
  }, SLOW)

  it.each([
    ['an amount BigInt would read as a thousand dollars', { maxAmountRequired: '0x3B9ACA00' }],
    ['an amount with a leading space', { maxAmountRequired: ' 1000000000' }],
    ['an amount with a plus sign', { maxAmountRequired: '+1000000000' }],
    ['a token that is not USDC', { asset: '0x4200000000000000000000000000000000000006' }],
    ['a network this app cannot name', { network: 'ethereum' }]
  ])('%s is not offered at the pay step, and a settle pressed anyway signs nothing', async (what, patch) => {
    const guest = await world.registeredMachine('ab', `ab${what.length}${Object.keys(patch)[0].length}${String(Object.values(patch)[0]).length}`)
    world.quote(['stripe', 'x402'])
    world.usdcTerms(patch)
    try {
      const app = world.appOn(guest.accounts, { usdc: GOOD_USDC })
      const quoted = (await app.ops.gate(DOOR, 'buy')) as Gated
      // The card is there; the wallet quote the app will not read is not a rail at all.
      expect(quoted.phase).toMatchObject({ kind: 'pay', rails: [{ rail: 'stripe' }] })
      expect((quoted.phase as { rails: unknown[] }).rails).toHaveLength(1)
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toMatchObject({ ok: false, reason: 'terms-changed' })
      expect(app.signed).toEqual([])
    } finally {
      world.usdcTerms({})
      world.quote(['stripe'])
    }
  }, SLOW)

  it('a rail the pay step never showed is not signed: no remembered terms, no signature', async () => {
    const guest = await world.registeredMachine('h2-none', 'h2none')
    const app = world.appOn(guest.accounts, { usdc: GOOD_USDC })
    // The pay step showed a card and nothing else.
    expect(((await app.ops.gate(DOOR, 'buy')) as Gated).phase).toMatchObject({ kind: 'pay', rails: [{ rail: 'stripe' }] })
    world.quote(['stripe', 'x402'])
    try {
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toMatchObject({ ok: false, reason: 'terms-changed' })
      expect(app.signed).toEqual([])
    } finally {
      world.quote(['stripe'])
    }
  }, SLOW)

  it('what is not signed may differ: a reworded description is the same quote', async () => {
    const guest = await world.registeredMachine('h2-words', 'h2words')
    world.quote(['x402'])
    try {
      const app = world.appOn(guest.accounts, { usdc: GOOD_USDC })
      await app.ops.gate(DOOR, 'buy')
      world.usdcTerms({ description: 'a seat, described another way', payTo: '0xc8ee69bb8da2804b860be6e4afa9acccdb2053a5' })
      // Same payee, written in lower case: an address is the same address.
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toEqual({ ok: true, phase: { kind: 'open' } })
    } finally {
      world.usdcTerms({})
      world.quote(['stripe'])
    }
  }, SLOW)
})

describe('the press signs what THAT surface displayed (C)', () => {
  /**
   * Main remembers the terms the last gate answer showed — but the phone and
   * the desktop share one gate, and so do a sheet and its own re-ask. The
   * second ask replaces what main remembers while the first sheet is still
   * showing the old price. So the press carries what its own surface
   * displayed, and three things must agree before a wallet is asked: what the
   * surface showed, what main remembers, and what the door quotes now.
   */
  it('the desktop shows 1 USDC, a phone’s gate replaces it with 1000, the desktop presses PAY: refused, nothing signed', async () => {
    const guest = await world.registeredMachine('c-two', 'ctwo')
    world.quote(['x402'])
    try {
      const app = world.appOn(guest.accounts, { usdc: GOOD_USDC })
      const desktop = walletKey(await app.ops.gate(DOOR, 'buy'))
      expect(desktop).toEqual(expect.stringContaining('|1000000|'))

      // The door raises its price, and another surface on this Mac asks it.
      world.usdcTerms({ maxAmountRequired: '1000000000' })
      const phone = walletKey(await app.ops.gate(DOOR, 'buy'))
      expect(phone).toEqual(expect.stringContaining('|1000000000|'))
      expect(phone).not.toBe(desktop)

      // The desktop still shows 1 USDC and is pressed. Main remembers 1000 and
      // the door quotes 1000 — they agree with each other, and not with the screen.
      expect(await app.ops.settle(DOOR, 'x402', undefined, desktop)).toMatchObject({ ok: false, reason: 'terms-changed' })
      expect(app.signed).toEqual([])
      expect(world.openedBy).not.toContain('acct-ctwo')

      // A press that says nothing about what it showed is refused too.
      expect(await app.ops.settle(DOOR, 'x402')).toMatchObject({ ok: false, reason: 'terms-changed' })
      expect(await app.ops.settle(DOOR, 'x402', undefined, '')).toMatchObject({ ok: false, reason: 'terms-changed' })
      expect(app.signed).toEqual([])

      // The phone, which displayed 1000 and is pressed, pays 1000: that is what its person saw.
      expect(await app.ops.settle(DOOR, 'x402', undefined, phone)).toEqual({ ok: true, phase: { kind: 'open' } })
      expect(app.signed).toHaveLength(1)
      expect(app.signed[0]).toMatchObject({ maxAmountRequired: '1000000000' })
    } finally {
      world.usdcTerms({})
      world.quote(['stripe'])
    }
  }, SLOW)

  it('a surface cannot talk main into terms the door is not asking: what it says it showed must be what main showed', async () => {
    const guest = await world.registeredMachine('c-lie', 'clie')
    world.quote(['x402'])
    try {
      const app = world.appOn(guest.accounts, { usdc: GOOD_USDC })
      const shown = walletKey(await app.ops.gate(DOOR, 'buy')) as string
      const cheaper = shown.replace('|1000000|', '|1|')
      expect(await app.ops.settle(DOOR, 'x402', undefined, cheaper)).toMatchObject({ ok: false, reason: 'terms-changed' })
      expect(app.signed).toEqual([])
    } finally {
      world.quote(['stripe'])
    }
  }, SLOW)
})

describe('a card payment in flight outlives the sheet that started it (D)', () => {
  /**
   * One Checkout session per purchase, whatever closes and reopens. The disk
   * is real (a temp dir); the clock is the app's own, moved by hand.
   */
  const WINDOW_MS = CHECKOUT_TTL_SECONDS * 1000
  const LIFE_MS = CHECKOUT_MAX_LIFE_SECONDS * 1000
  const dirs: string[] = []
  const disk = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buy-pending-'))
    dirs.push(dir)
    return dir
  }
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
  type Resumed = Gated & {
    card?: { session: string; url: string; startedAt: number; price: string }
    settled?: { price: string; asset: string; rail: string }
  }

  it('pay started, sheet closed, the quote window rolls over, sheet reopened: the SAME session, and one Checkout in total', async () => {
    const guest = await world.registeredMachine('d-reopen', 'dre')
    const base = disk()
    let clock = 1_700_000_000_000
    const app = world.appOn(guest.accounts, { now: () => clock, pending: new PendingCheckouts({ base }) })
    const made = world.checkoutsMade()
    world.checkoutNext(UNPAID)
    await app.ops.gate(DOOR, 'buy')
    const first = (await app.ops.checkout(DOOR)) as { ok: true; session: string; url: string; startedAt: number }
    expect(first).toMatchObject({ ok: true, session: UNPAID, startedAt: clock })
    expect(new PendingCheckouts({ base }).get('dre', DOOR)).toMatchObject({ session: UNPAID, price: '1.00', link: DOOR })

    // The sheet is closed. Thirty-one minutes pass: a NEW quote window at the
    // door, where an identical request would no longer replay the old session.
    clock += WINDOW_MS + 60_000
    world.checkoutNext('cs_test_would_be_second')
    const asked = world.presented.length

    // Reopened — an ordinary import, nobody pressed BUY again.
    const reopened = (await app.ops.gate(DOOR)) as Resumed
    // THE SESSION WAS PRESENTED FIRST, before anything was shown.
    expect(world.presented.slice(asked)).toEqual([UNPAID])
    // Still unpaid and still payable: the sheet is handed THAT session to wait on.
    expect(reopened.phase).toMatchObject({ kind: 'pay', rails: [{ rail: 'stripe' }] })
    expect(reopened.card).toEqual({ session: UNPAID, url: first.url, startedAt: first.startedAt, price: '1.00' })

    // PAY, from whichever surface: the same page, never a new Checkout.
    expect(await app.ops.checkout(DOOR)).toMatchObject({ ok: true, session: UNPAID, url: first.url, startedAt: first.startedAt, resumed: true })
    expect(world.checkoutsMade()).toBe(made + 1)
  }, SLOW)

  it('paid while the app was closed: the next start presents it, and the seat is there with no second payment', async () => {
    const guest = await world.registeredMachine('d-closed', 'dcl')
    const base = disk()
    const made = world.checkoutsMade()
    world.checkoutNext(PAID)
    const before = world.appOn(guest.accounts, { pending: new PendingCheckouts({ base }) })
    await before.ops.gate(DOOR, 'buy')
    await before.ops.checkout(DOOR)
    // The app quits. The buyer pays on Stripe's page, still open in the browser.
    // (PAID is a session Stripe calls paid — nobody has presented it yet.)
    expect(world.openedBy).not.toContain('acct-dcl')

    // A NEW process: nothing in memory, only the file.
    const after = world.appOn(guest.accounts, { pending: new PendingCheckouts({ base }) })
    expect(await after.ops.resumePending()).toBe(1)
    expect(world.openedBy).toContain('acct-dcl')
    expect(await world.lastReport()).toBe(true)
    expect(new PendingCheckouts({ base }).all('dcl')).toEqual([])

    // And the import that follows opens on the seat: plain mint, no pay step.
    const opened = (await after.ops.gate(DOOR)) as Resumed
    expect(opened.phase).toEqual({ kind: 'open' })
    expect(opened.seat).toEqual(expect.any(String))
    expect(world.checkoutsMade()).toBe(made + 1)
  }, SLOW)

  it('a gate that finds the payment landed completes the purchase with its receipt, as after a wait', async () => {
    const guest = await world.registeredMachine('d-landed', 'dla')
    const base = disk()
    world.checkoutNext(PAID)
    const app = world.appOn(guest.accounts, { pending: new PendingCheckouts({ base }) })
    await app.ops.gate(DOOR, 'buy')
    await app.ops.checkout(DOOR)
    const release = world.holdReports()
    try {
      const reopened = (await app.ops.gate(DOOR)) as Resumed
      expect(reopened.phase).toEqual({ kind: 'open' })
      expect(reopened.settled).toEqual({ price: '1.00', asset: 'USD', rail: 'stripe' })
      expect(reopened.card).toBeUndefined()
      expect(new PendingCheckouts({ base }).all('dla')).toEqual([])
      // The card placed next opens, registry report or not.
      await expect(cardSignIn(app)).resolves.toEqual(expect.any(String))
    } finally {
      release()
      await world.lastReport()
    }
  }, SLOW)

  it('the phone and the desktop are one purchase: one session between them', async () => {
    const guest = await world.registeredMachine('d-two', 'dtw')
    const base = disk()
    const made = world.checkoutsMade()
    world.checkoutNext(UNPAID)
    // Two surfaces, one main: the same gate verbs, called from each.
    const app = world.appOn(guest.accounts, { pending: new PendingCheckouts({ base }) })
    await app.ops.gate(DOOR, 'buy')
    const desktop = (await app.ops.checkout(DOOR)) as { session: string }
    world.checkoutNext('cs_test_would_be_second')
    const phone = (await app.ops.gate(DOOR, 'buy')) as Resumed
    expect(phone.card?.session).toBe(desktop.session)
    expect(await app.ops.checkout(DOOR)).toMatchObject({ ok: true, session: desktop.session, resumed: true })
    expect(world.checkoutsMade()).toBe(made + 1)
  }, SLOW)

  it('a session the door calls unpaid after its life is over is forgotten, and only then is a new one made', async () => {
    const guest = await world.registeredMachine('d-over', 'dov')
    const base = disk()
    let clock = 1_700_000_000_000
    const app = world.appOn(guest.accounts, { now: () => clock, pending: new PendingCheckouts({ base }) })
    const made = world.checkoutsMade()
    world.checkoutNext(UNPAID)
    await app.ops.gate(DOOR, 'buy')
    await app.ops.checkout(DOOR)

    // One millisecond short of its life: still remembered, still the only one.
    clock += LIFE_MS - 1
    expect(((await app.ops.gate(DOOR)) as Resumed).card?.session).toBe(UNPAID)
    expect(new PendingCheckouts({ base }).all('dov')).toHaveLength(1)

    // Its life is over and the door says unpaid: gone, and the answer is the plain one.
    clock += 1
    const fresh = (await app.ops.gate(DOOR)) as Resumed
    expect(fresh.card).toBeUndefined()
    expect(fresh.phase).toMatchObject({ kind: 'denied', reason: 'no_seat' })
    expect(new PendingCheckouts({ base }).all('dov')).toEqual([])

    world.checkoutNext(PAID)
    await app.ops.gate(DOOR, 'buy')
    expect(await app.ops.checkout(DOOR)).toMatchObject({ ok: true, session: PAID })
    expect(world.checkoutsMade()).toBe(made + 2)
  }, SLOW)

  it('a settle that the door answers "unpaid" before the life is over keeps the session; "open" drops it', async () => {
    const guest = await world.registeredMachine('d-settle', 'dse')
    const base = disk()
    world.checkoutNext(UNPAID)
    const app = world.appOn(guest.accounts, { pending: new PendingCheckouts({ base }) })
    await app.ops.gate(DOOR, 'buy')
    await app.ops.checkout(DOOR)
    // The answer says whether main still holds a payment in flight here:
    // that, not a surface's own clock, is what frees a new PAY.
    expect(await app.ops.settle(DOOR, 'stripe', UNPAID)).toEqual({
      ok: true,
      phase: { kind: 'denied', reason: 'payment_invalid', retryable: false },
      standing: true
    })
    expect(new PendingCheckouts({ base }).all('dse')).toHaveLength(1)
    // Another person on this Mac is not handed it, and cannot start a second for the first.
    const other = await world.registeredMachine('d-other', 'dot')
    const theirs = world.appOn(other.accounts, { pending: new PendingCheckouts({ base }) })
    expect(((await theirs.ops.gate(DOOR, 'buy')) as Resumed).card).toBeUndefined()
  }, SLOW)
})

describe('a Bearer that ran out while the card page was open (E)', () => {
  it('is renewed once and the SAME session presented again; only a second refusal is spoken', async () => {
    const guest = await world.registeredMachine('e-bearer', 'ebe')
    const app = world.appOn(guest.accounts)
    world.checkoutNext(PAID)
    await app.ops.gate(DOOR, 'buy')
    await app.ops.checkout(DOOR)
    expect(app.minted).toEqual([{ intent: 'buy' }])

    // The door's Bearers live an hour by ITS clock; the card page lives as long.
    world.doorClockForward(61 * 60 * 1000)
    const asked = world.presented.length
    expect(await app.ops.settle(DOOR, 'stripe', PAID)).toEqual({ ok: true, phase: { kind: 'open' }, standing: false })
    // Signed in again as the same buyer, and the same session went up.
    expect(app.minted).toEqual([{ intent: 'buy' }, { intent: 'buy' }])
    expect(world.presented.slice(asked)).toEqual([PAID])
    expect(world.openedBy).toContain('acct-ebe')
  }, SLOW)

  it('a door that answers 401 again after the renewal is said — one renewal, never a loop', async () => {
    const guest = await world.registeredMachine('e-loop', 'elo')
    const seen = { asserts: 0, lines: 0 }
    // A door that signs anybody in and then knows none of its own Bearers.
    const amnesiac = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        if (request.url?.endsWith('/api/call/assert')) {
          seen.asserts += 1
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, token: `bearer-${seen.asserts}` }))
          return
        }
        seen.lines += 1
        response.writeHead(401, { 'content-type': 'application/json' }).end('{}')
      })
    })
    await new Promise<void>((resolve) => amnesiac.listen(0, '127.0.0.1', resolve))
    try {
      const at = `http://127.0.0.1:${(amnesiac.address() as AddressInfo).port}`
      const gate = createServeGate({
        parse: () => ({ origin: world.origin, slug: TEAM, door: DOOR }),
        reachable: async () => ({ at: { origin: at, slug: DOOR, door: DOOR }, listed: true, live: true }),
        accounts: guest.accounts,
        signInWithKey: () => Promise.reject(new Error('no key')),
        wallet: () => null,
        buildX402Payment: () => Promise.reject(new Error('no wallet'))
      })
      expect(((await gate.gate(DOOR, 'buy')) as Gated).phase).toEqual({ kind: 'error', status: 401 })
      const before = { ...seen }
      expect(await gate.settle(DOOR, 'stripe', PAID)).toEqual({ ok: true, phase: { kind: 'error', status: 401 }, standing: false })
      // Exactly one new sign-in. The line is asked three times and no more:
      // the session presented, the sign-in's own look at the door, the
      // session presented again on the new Bearer.
      expect(seen.asserts - before.asserts).toBe(1)
      expect(seen.lines - before.lines).toBe(3)
    } finally {
      amnesiac.closeAllConnections()
      await new Promise<void>((resolve) => amnesiac.close(() => resolve()))
    }
  }, SLOW)

  it('a door that refuses the renewed sign-in too is said, once, with its status', async () => {
    const guest = await world.registeredMachine('e-dead', 'ede')
    let tries = 0
    const dead = createServeGate({
      parse: () => ({ origin: world.origin, slug: TEAM, door: DOOR }),
      // The first ask reaches the door; after that every request lands where nobody knows the Bearer.
      reachable: async () => {
        tries += 1
        return { at: { origin: world.planeOrigin, slug: tries === 1 ? DOOR : '@drej/closed', door: DOOR }, listed: true, live: true }
      },
      accounts: guest.accounts,
      signInWithKey: () => Promise.reject(new Error('no key')),
      wallet: () => null,
      buildX402Payment: () => Promise.reject(new Error('no wallet'))
    })
    expect(((await dead.gate(DOOR, 'buy')) as Gated).phase.kind).toBe('pay')
    // Every later request meets a 404 — not a 401 — so nothing is renewed and it is said as it is.
    expect(await dead.settle(DOOR, 'stripe', PAID)).toEqual({ ok: true, phase: { kind: 'gone' }, standing: false })
  }, SLOW)
})

describe('round 3 — one payment per purchase, whatever is pressed', () => {
  type Carded = Gated & { card?: { session: string }; settled?: unknown }
  const HOUR = 60 * 60 * 1000

  it('a wallet press while a card payment stands is refused by MAIN, and nothing is signed (1)', async () => {
    const guest = await world.registeredMachine('r3-wallet', 'rwa')
    world.quote(['stripe', 'x402'])
    try {
      const app = world.appOn(guest.accounts, { usdc: GOOD_USDC })
      // The phone's sheet opened first and shows both rails.
      await app.ops.gate(DOOR, 'buy')
      const phone = app.shown()
      // The desktop starts a Checkout. The phone's sheet knows nothing of it.
      world.checkoutNext(UNPAID)
      await app.ops.checkout(DOOR)
      const answer = await app.ops.settle(DOOR, 'x402', undefined, phone)
      expect(answer).toMatchObject({ ok: false, reason: 'card-in-flight', card: { session: UNPAID } })
      expect(app.signed).toEqual([])
      expect(world.openedBy).not.toContain('acct-rwa')
    } finally {
      world.quote(['stripe'])
    }
  }, SLOW)

  it('a gate that finds the door OPEN while a card session is remembered presents it once, then forgets it (1)', async () => {
    const guest = await world.registeredMachine('r3-seated', 'rse')
    const pending = memoryPendingCheckouts()
    const app = world.appOn(guest.accounts, { pending })
    const session = 'cs_test_seatedmeanwhile'
    world.checkoutNext(session)
    await app.ops.gate(DOOR, 'buy')
    await app.ops.checkout(DOOR)
    // The owner grants a seat while the card page is still open.
    const granted = await fetch(`${world.origin}/v2/teams/${DOOR}/seats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${world.sessionToken(world.owner.base)}` },
      body: JSON.stringify({ username: 'rse' })
    })
    expect(granted.status).toBe(201)
    const handed = world.linePayments.length
    const opened = (await app.ops.gate(DOOR)) as Carded
    expect(opened.phase).toEqual({ kind: 'open' })
    expect(opened.card).toBeUndefined()
    // Presented to the door exactly once, and only then forgotten.
    expect(world.linePayments.slice(handed)).toEqual([session])
    expect(pending.all('rse')).toEqual([])
    // WHAT THE DOOR DOES WITH IT: a seated caller is admitted before the money
    // rung, so the payment is not looked at and the session is not spent.
    expect(world.presented).not.toContain(session)
  }, SLOW)

  it('every gate answer carries the card while one stands: denied, identify, an error, a door that cannot be reached (2)', async () => {
    const guest = await world.registeredMachine('r3-phases', 'rph')
    const waiting = {
      account: 'rph',
      link: DOOR,
      session: 'cs_test_standing1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_standing1',
      price: '1.00',
      startedAt: Date.now()
    }
    const never = {
      signInWithKey: () => Promise.reject(new Error('no key')),
      wallet: () => null,
      buildX402Payment: () => Promise.reject(new Error('no wallet'))
    }
    // A door that refuses the sign-in itself: its own 403 at the assert.
    const refusing = createServer((request, response) => {
      request.resume()
      request.on('end', () => response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ reason: 'workspace' })))
    })
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve))
    try {
      const at = `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`
      const pendingAt = (door: string) => {
        const store = memoryPendingCheckouts()
        store.put({ ...waiting, door })
        return store
      }
      const denied = (await createServeGate({
        ...never,
        parse: () => ({ origin: world.origin, slug: TEAM, door: DOOR }),
        reachable: async () => ({ at: { origin: at, slug: DOOR, door: DOOR }, listed: true, live: true }),
        accounts: guest.accounts,
        pending: pendingAt(DOOR)
      }).gate(DOOR)) as Carded
      expect(denied.phase).toMatchObject({ kind: 'denied', reason: 'workspace' })
      expect(denied.card?.session).toBe(waiting.session)

      // This Mac knows who it is, and cookrew.dev will not take its session any more.
      const identify = (await createServeGate({
        ...never,
        parse: () => ({ origin: world.origin, slug: TEAM, door: DOOR }),
        reachable: async () => ({ at: { origin: world.planeOrigin, slug: DOOR, door: DOOR }, listed: true, live: true }),
        accounts: { account: () => ({ username: 'rph' }), authedResponse: async () => ({ ok: false, reason: 'session-expired' }) },
        pending: pendingAt(DOOR)
      }).gate(DOOR)) as Carded
      expect(identify.phase).toEqual({ kind: 'identify' })
      expect(identify.card?.session).toBe(waiting.session)

      // cookrew.dev does not know the team (any more).
      const nowhere = '@drej/nowhere'
      const error = (await createServeGate({
        ...never,
        parse: () => ({ origin: world.origin, slug: 'nowhere', door: nowhere }),
        reachable: async () => ({ at: { origin: world.planeOrigin, slug: nowhere, door: nowhere }, listed: true, live: true }),
        accounts: guest.accounts,
        pending: pendingAt(nowhere)
      }).gate(nowhere)) as Carded
      expect(error.phase).toEqual({ kind: 'error', status: 404 })
      expect(error.card?.session).toBe(waiting.session)

      // The door cannot be found at all: not even a phase, and still the card.
      const dark = await createServeGate({
        ...never,
        parse: () => ({ origin: world.origin, slug: TEAM, door: DOOR }),
        reachable: async () => null,
        accounts: guest.accounts,
        pending: pendingAt(DOOR)
      }).gate(DOOR)
      expect(dark).toMatchObject({ ok: false, reason: 'sign-in', card: { session: waiting.session } })
    } finally {
      refusing.closeAllConnections()
      await new Promise<void>((resolve) => refusing.close(() => resolve()))
    }
  }, SLOW)

  it('"trying again will not charge you twice" is true: a retried wallet press re-sends the SAME signed payment (3)', async () => {
    const guest = await world.registeredMachine('r3-retry', 'rre')
    world.quote(['x402'])
    world.walletVerdict('unverifiable')
    let clock = 1_700_000_000_000
    try {
      const app = world.appOn(guest.accounts, { usdc: GOOD_USDC, now: () => clock })
      await app.ops.gate(DOOR, 'buy')
      const handed = world.linePayments.length
      const unsure = { ok: true, phase: { kind: 'denied', reason: 'payment_unverifiable', retryable: true } }
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toEqual(unsure)
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toEqual(unsure)
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toEqual(unsure)
      // Three presses, ONE signature — and the door was handed one and the same header each time.
      expect(app.signed).toHaveLength(1)
      const sent = world.linePayments.slice(handed)
      expect(sent).toHaveLength(3)
      expect(new Set(sent).size).toBe(1)

      // A different quote while that authorisation can still be collected: refused, nothing new signed.
      world.usdcTerms({ maxAmountRequired: '2000000' })
      await app.ops.gate(DOOR, 'buy')
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toMatchObject({ ok: false, reason: 'terms-changed' })
      expect(app.signed).toHaveLength(1)
      world.usdcTerms({})
      await app.ops.gate(DOOR, 'buy')

      // One second before it lapses: still the same header.
      clock += 300_000 - 1000
      await app.ops.settle(DOOR, 'x402', undefined, app.shown())
      expect(app.signed).toHaveLength(1)
      // Once it can no longer be collected, a new one may be signed.
      clock += 60_000
      world.walletVerdict('ok')
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toEqual({ ok: true, phase: { kind: 'open' } })
      expect(app.signed).toHaveLength(2)
      expect(world.linePayments.at(-1)).not.toBe(sent[0])
    } finally {
      world.walletVerdict('ok')
      world.usdcTerms({})
      world.quote(['stripe'])
    }
  }, SLOW)

  it('no card page while a signed wallet payment can still be collected: a door cannot be paid both ways', async () => {
    // The other order of rule (1). A door answers a wallet press "could not check" and keeps the
    // signed transfer, which it may still submit; a card page made now would be a second payment.
    const guest = await world.registeredMachine('r3-both', 'rbo')
    world.quote(['x402', 'stripe'])
    world.walletVerdict('unverifiable')
    let clock = 1_700_000_000_000
    try {
      const app = world.appOn(guest.accounts, { usdc: GOOD_USDC, now: () => clock })
      await app.ops.gate(DOOR, 'buy')
      await app.ops.settle(DOOR, 'x402', undefined, app.shown())
      expect(app.signed).toHaveLength(1)
      const made = world.checkoutsMade()
      const refused = await app.ops.checkout(DOOR)
      expect(refused).toMatchObject({ ok: false, reason: 'wallet-in-flight' })
      expect((refused as { detail?: string }).detail).toMatch(/wallet/i)
      expect((refused as { detail?: string }).detail).not.toMatch(/nothing was charged/i)
      expect(world.checkoutsMade()).toBe(made)
      // Once the signed transfer can no longer be collected, the card is offered again.
      clock += 300_000 + 6_000
      world.checkoutNext('cs_test_afterwallet01')
      expect(await app.ops.checkout(DOOR)).toMatchObject({ ok: true, session: 'cs_test_afterwallet01' })
      expect(world.checkoutsMade()).toBe(made + 1)
    } finally {
      world.walletVerdict('ok')
      world.quote(['stripe'])
    }
  }, SLOW)

  it('a signed wallet payment is one person’s: a change of hands forgets it (3)', async () => {
    const a = await world.registeredMachine('r3-hands-a', 'rha')
    const b = await world.registeredMachine('r3-hands-b', 'rhb')
    world.quote(['x402'])
    world.walletVerdict('unverifiable')
    try {
      let signedIn: Accounts = a.accounts
      const app = world.appOn(() => signedIn, { usdc: GOOD_USDC })
      await app.ops.gate(DOOR, 'buy')
      await app.ops.settle(DOOR, 'x402', undefined, app.shown())
      signedIn = b.accounts
      app.ops.accountChanged()
      await app.ops.gate(DOOR, 'buy')
      await app.ops.settle(DOOR, 'x402', undefined, app.shown())
      // B's press was B's own signature, not A's header sent again.
      expect(app.signed).toHaveLength(2)
      expect(new Set(world.linePayments.slice(-2)).size).toBe(2)
    } finally {
      world.walletVerdict('ok')
      world.quote(['stripe'])
    }
  }, SLOW)

  it('a card session older than any Checkout can live is forgotten without asking anybody (4)', async () => {
    const guest = await world.registeredMachine('r3-old', 'rol')
    const pending = memoryPendingCheckouts()
    let clock = 1_700_000_000_000
    const app = world.appOn(guest.accounts, { now: () => clock, pending })
    // A door that never says "not paid": it cannot check, for ever.
    world.checkoutNext(UNCHECKABLE)
    await app.ops.gate(DOOR, 'buy')
    await app.ops.checkout(DOOR)
    clock += 25 * HOUR - 1
    expect(((await app.ops.gate(DOOR)) as Carded).card?.session).toBe(UNCHECKABLE)
    expect(pending.all('rol')).toHaveLength(1)

    clock += 1
    const asked = world.linePayments.length
    expect(await app.ops.resumePending()).toBe(0)
    expect(pending.all('rol')).toEqual([])
    // Nobody was asked about it: its age alone ended it.
    expect(world.linePayments.length).toBe(asked)
    const fresh = (await app.ops.gate(DOOR)) as Carded
    expect(fresh.card).toBeUndefined()
    expect(fresh.phase).toMatchObject({ kind: 'denied', reason: 'no_seat' })
  }, SLOW)

  it('two surfaces asking for a card page at the same moment get one page: the door is asked once (5)', async () => {
    const guest = await world.registeredMachine('r3-twin', 'rtw')
    const app = world.appOn(guest.accounts)
    world.checkoutNext('cs_test_twins0001')
    await app.ops.gate(DOOR, 'buy')
    const made = world.checkoutsMade()
    const [one, two] = await Promise.all([app.ops.checkout(DOOR), app.ops.checkout(DOOR)])
    expect(world.checkoutsMade()).toBe(made + 1)
    expect(one).toMatchObject({ ok: true, session: 'cs_test_twins0001' })
    expect(two).toMatchObject({ ok: true, session: 'cs_test_twins0001' })
  }, SLOW)

  it('a door that forgets every Bearer costs three renewals per wait, not one per tick (6)', async () => {
    const guest = await world.registeredMachine('r3-budget', 'rbu')
    let mints = 0
    const uses = new Map<string, number>()
    let issued = 0
    // Signs anybody in; says "not paid" to a Bearer's first payment and has forgotten that Bearer by the next:
    // every tick of a wait meets a 401, renews, and is told "not paid" on the new one.
    const forgetful = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        const json = (status: number, body: unknown): void =>
          void response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
        if (request.url?.endsWith('/api/call/assert')) return json(200, { ok: true, token: `bearer-${(issued += 1)}` })
        const bearer = String(request.headers.authorization)
        if (request.headers['x-payment'] === undefined) return json(402, { terms: { x402Version: 1, accepts: [{ scheme: 'stripe-checkout', amountUsd: '1.00' }] } })
        const used = (uses.get(bearer) ?? 0) + 1
        uses.set(bearer, used)
        return used === 1 ? json(402, { reason: 'invalid', retryable: false }) : json(401, {})
      })
    })
    await new Promise<void>((resolve) => forgetful.listen(0, '127.0.0.1', resolve))
    try {
      const at = `http://127.0.0.1:${(forgetful.address() as AddressInfo).port}`
      const gate = createServeGate({
        parse: () => ({ origin: world.origin, slug: TEAM, door: DOOR }),
        reachable: async () => ({ at: { origin: at, slug: DOOR, door: DOOR }, listed: true, live: true }),
        accounts: {
          account: () => guest.accounts.account(),
          authedResponse: (pathname, init) => {
            if (pathname.endsWith('/call-token')) mints += 1
            return guest.accounts.authedResponse(pathname, init)
          }
        },
        signInWithKey: () => Promise.reject(new Error('no key')),
        wallet: () => null,
        buildX402Payment: () => Promise.reject(new Error('no wallet'))
      })
      expect(((await gate.gate(DOOR, 'buy')) as Gated).phase.kind).toBe('pay')
      const after = mints
      const answers: unknown[] = []
      for (let tick = 0; tick < 12; tick += 1) answers.push(await gate.settle(DOOR, 'stripe', PAID))
      // Twelve ticks of a card wait: three sign-ins, then the door's refusal is simply said.
      expect(mints - after).toBe(3)
      expect(answers.at(-1)).toMatchObject({ ok: true, phase: { kind: 'error', status: 401 } })
    } finally {
      forgetful.closeAllConnections()
      await new Promise<void>((resolve) => forgetful.close(() => resolve()))
    }
  }, SLOW)
})

describe('a refusal on the buy path is said, not swallowed', () => {
  it('a card session Stripe says is unpaid is payment_invalid, and nothing is seated', async () => {
    const guest = await world.registeredMachine('unpaid', 'mo')
    const app = world.appOn(guest.accounts)
    expect(((await app.ops.gate(DOOR, 'buy')) as Gated).phase.kind).toBe('pay')
    world.checkoutNext(UNPAID)
    const checkout = (await app.ops.checkout(DOOR)) as { ok: true; session: string }
    expect(checkout.session).toBe(UNPAID)
    expect(await app.ops.settle(DOOR, 'stripe', UNPAID)).toEqual({
      ok: true,
      phase: { kind: 'denied', reason: 'payment_invalid', retryable: false },
      // The card page can still be paid: main goes on holding that session.
      standing: true
    })
    expect(world.callers.entitled(template.serviceId, 'acct-mo')).toBe(false)
    // An import again while that card page can still be paid: the door is asked
    // about THAT session first, and the sheet is handed it to wait on — no seat,
    // no second Checkout.
    const again = (await app.ops.gate(DOOR)) as Gated & { card?: { session: string } }
    expect(again.phase.kind).toBe('pay')
    expect(again.card?.session).toBe(UNPAID)
    await expect(cardSignIn(app)).rejects.toThrow('did not admit this account (denied)')
  }, SLOW)

  it('a USDC payment the door will not take is payment_invalid too', async () => {
    const guest = await world.registeredMachine('badusdc', 'noa')
    world.quote(['x402'])
    try {
      const app = world.appOn(guest.accounts, { usdc: BAD_USDC })
      await app.ops.gate(DOOR, 'buy')
      expect(await app.ops.settle(DOOR, 'x402', undefined, app.shown())).toEqual({
        ok: true,
        phase: { kind: 'denied', reason: 'payment_invalid', retryable: false }
      })
      expect(world.callers.entitled(template.serviceId, 'acct-noa')).toBe(false)
    } finally {
      world.quote(['stripe'])
    }
  }, SLOW)

  it('a payment the door cannot check is payment_unverifiable and may be tried again', async () => {
    const guest = await world.registeredMachine('uncheckable', 'ada')
    const app = world.appOn(guest.accounts)
    await app.ops.gate(DOOR, 'buy')
    expect(await app.ops.settle(DOOR, 'stripe', UNCHECKABLE)).toEqual({
      ok: true,
      phase: { kind: 'denied', reason: 'payment_unverifiable', retryable: true },
      standing: false
    })
  }, SLOW)

  it('a door that is gone is an error with its status, and holds no Bearer to pay on', async () => {
    const guest = await world.registeredMachine('gone', 'kai')
    const unreachable = {
      parse: () => ({ origin: world.origin, slug: TEAM, door: DOOR }),
      accounts: guest.accounts,
      signInWithKey: () => Promise.reject(new Error('no key')),
      wallet: () => null,
      buildX402Payment: () => Promise.reject(new Error('no wallet'))
    }
    // The registry still lists the team and mints for it; nobody answers at the name.
    const closed = createServeGate({
      ...unreachable,
      reachable: async () => ({
        at: { origin: world.planeOrigin, slug: '@drej/closed', door: DOOR },
        listed: true,
        live: true
      })
    })
    expect(((await closed.gate(DOOR, 'buy')) as Gated).phase).toEqual({ kind: 'error', status: 404 })
    expect(await closed.checkout(DOOR)).toMatchObject({ ok: false, reason: 'not-signed-in' })
    // And a door nobody can reach at all is said in the gate's own failure shape.
    const dark = createServeGate({ ...unreachable, reachable: async () => null })
    expect(await dark.gate(DOOR, 'buy')).toEqual({ ok: false, reason: 'sign-in', detail: 'not serving' })
  }, SLOW)

  it('the registry saying no is its own phase: no account is identify, an unknown team is its status', async () => {
    const nobody = world.appOn(null)
    expect(((await nobody.ops.gate(DOOR, 'buy')) as Gated).phase).toEqual({ kind: 'identify' })

    const guest = await world.registeredMachine('lost', 'zed')
    const lost = world.appOn(guest.accounts)
    const answer = (await lost.ops.gate('@drej/nowhere', 'buy')) as Gated
    expect(answer.phase).toEqual({ kind: 'error', status: 404 })
    expect(lost.minted).toEqual([{ intent: 'buy' }])
  }, SLOW)

  it('BUY means nothing at an unlisted door: the key walk is taken and nothing is minted', async () => {
    const guest = await world.registeredMachine('direct', 'ivy')
    const minted: unknown[] = []
    const direct = createServeGate({
      parse: () => ({ origin: world.planeOrigin, slug: DOOR }),
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
