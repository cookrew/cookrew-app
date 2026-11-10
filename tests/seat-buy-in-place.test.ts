import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { doorBearer } from '../src/main/door-bearer'
import { createServeGate } from '../src/main/serve-gate'
import type { AdmissionPhase } from '../src/main/served-admission'
import {
  BAD_USDC,
  DOOR,
  GOOD_USDC,
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
const cardSignIn = (app: AppOn): Promise<string> =>
  doorBearer(
    { admit: (target, team) => app.ops.admitCard(target, team), withKey: () => Promise.reject(new Error('no key')) },
    { origin: world.planeOrigin, slug: DOOR },
    DOOR
  )

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
    expect(checkout).toEqual({ ok: true, session: PAID, url: `https://checkout.stripe.com/c/pay/${PAID}` })
    // THE REGISTRY IS SLOW TODAY: the door's report is held until the card has opened.
    const release = world.holdReports()
    const settled = await app.ops.settle(DOOR, 'stripe', PAID)
    expect(settled).toEqual({ ok: true, phase: { kind: 'open' } })
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
      expect(await app.ops.settle(DOOR, 'x402')).toEqual({ ok: true, phase: { kind: 'open' } })
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
      phase: { kind: 'denied', reason: 'payment_invalid', retryable: false }
    })
    expect(world.callers.entitled(template.serviceId, 'acct-mo')).toBe(false)
    expect(((await app.ops.gate(DOOR)) as Gated).phase).toMatchObject({ kind: 'denied', reason: 'no_seat' })
    await expect(cardSignIn(app)).rejects.toThrow('did not admit this account (denied)')
  }, SLOW)

  it('a USDC payment the door will not take is payment_invalid too', async () => {
    const guest = await world.registeredMachine('badusdc', 'noa')
    world.quote(['x402'])
    try {
      const app = world.appOn(guest.accounts, { usdc: BAD_USDC })
      await app.ops.gate(DOOR, 'buy')
      expect(await app.ops.settle(DOOR, 'x402')).toEqual({
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
      phase: { kind: 'denied', reason: 'payment_unverifiable', retryable: true }
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
