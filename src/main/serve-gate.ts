import { gateDoorFor, type GateDoor } from '../shared/gate-walk'
import { MKT_PAY } from '../shared/marketplace-copy'
import { CHECKOUT_MAX_LIFE_SECONDS, isStripeCheckoutUrl } from '../shared/stripe-checkout'
import { withPaidBearer } from './door-bearer'
import type { ServeTarget } from './import-session'
import { memoryPendingCheckouts, type PendingCheckout, type PendingCheckoutStore } from './pending-checkout'
import {
  admitWithAccount,
  openAdmission,
  startStripeCheckout,
  stripePaymentHeader,
  type AccountAdmission,
  type AccountForDoors,
  type AdmissionPhase,
  type ServeTargetRef
} from './served-admission'
import { doorOwnerOf } from './served-endpoints'
import type { PaymentRequirements } from './x402-rail'

/**
 * THE GATE'S THREE VERBS — ask the door, start a card payment, present one.
 *
 * These are what the import sheet drives over IPC and the phone drives over
 * the mobile API (`serveOps.gate / checkout / settle`). They lived inline in
 * index.ts, where nothing could run them without Electron; they are here so
 * the walk a person pays on is the walk a test walks.
 *
 * WHICH WALK — one decision, `gateDoorFor`: a LISTED team (a published name
 * the directory answers for) is entered as the ACCOUNT — cookrew.dev mints a
 * call token for this Mac's session and the door seats `acct-<username>`, so a
 * seat follows the person to any device. With no account on this Mac the
 * answer is the `identify` phase and the sheet opens the account sheet in
 * place. The caller key is offered at UNLISTED doors only — the DIRECT walk —
 * because a key-holder sub can never be the person a seat names.
 *
 * BUYING A SEAT IS THE SAME WALK, SAID OUT LOUD (0.6.0). `gate(link, 'buy')`
 * is the sheet's BUY A SEAT button: the mint carries `intent: 'buy'`, the
 * door admits the unseated token as far as its 402, and the answer is the pay
 * phase — the price and the rails, nothing charged. From there `checkout` and
 * `settle` are the ones a dialled paid door has always used. There is one
 * payment implementation and this did not add a second.
 *
 * EVERY BEARER STAYS HERE. The renderer names a door and a rail; it never
 * holds a credential, so a renderer bug cannot leak one.
 */

export interface ServeGateDeps {
  /** A pasted address or a published name → where it says to go, or null. */
  parse(link: string): ServeTarget | null
  /** Where to actually send a request for this target, and whether the directory lists it. */
  reachable(target: ServeTarget): Promise<{ at: ServeTarget; listed: boolean; live: boolean } | null>
  /** This Mac's session on cookrew.dev — the listed walk's only credential. */
  accounts: AccountForDoors
  /** The DIRECT walk's sign-in: this Mac's own key at an unlisted door. */
  signInWithKey(at: ServeTargetRef): Promise<string>
  /** The wallet this device would sign a USDC payment with, or null. */
  wallet(): { address: string } | null
  buildX402Payment(requirements: PaymentRequirements): Promise<string>
  /** This Mac's clock. Injected so a test does not wait ten minutes for a stand-in to end. */
  now?(): number
  /** Card payments in flight, on disk (pending-checkout.ts). In memory when none is given. */
  pending?: PendingCheckoutStore
}

export type ServeGate = ReturnType<typeof createServeGate>

/**
 * THE DESKTOP'S OPENER, with the check made again where the page is opened.
 *
 * `startStripeCheckout` already refuses anything that is not Stripe's hosted
 * Checkout. This is the same rule a second time, at the one call that hands an
 * address to the operating system — `shell.openExternal` launches whatever
 * handles the scheme — so no other path to this line can carry a different
 * one. A refusal is the card rail's ordinary "unavailable"; the address that
 * was refused is not repeated to the sheet.
 */
export async function handOffCheckout<T extends { ok: boolean }>(
  checkout: T,
  open: (url: string) => Promise<void>
): Promise<T | { ok: false; reason: 'unavailable'; detail: string }> {
  if (!checkout.ok) return checkout
  const url: unknown = (checkout as { url?: unknown }).url
  if (!isStripeCheckoutUrl(url)) {
    return { ok: false, reason: 'unavailable', detail: 'the door returned an unusable checkout link' }
  }
  // THE CANONICAL FORM, not the door's spelling: what was checked is the
  // parsed address, so the parsed address written back out is what is opened.
  await open(new URL(url).href)
  return checkout
}

/**
 * One key per door, and NOT its wire address.
 *
 * A relayed door is reached through a loopback port that changes with every
 * restart, so keying a token by where it was reached would lose it the moment
 * the app came back. A published name is the durable identity; a dialled
 * door's address is its own.
 */
function targetKey(target: ServeTarget): string {
  return target.door ?? `${target.origin}/${target.slug}`
}

/**
 * How long the Bearer a seat was bought on may stand in for the card: the
 * life of a call token. A seat's owner can END it, and the registry stops
 * minting from that moment; a stand-in must not outlive what an ordinary
 * sign-in would have been good for.
 */
export const STAND_IN_TTL_MS = 10 * 60 * 1000

/** What the gate holds for one person at one door, while an import is decided. */
interface Held {
  /** The door's Bearer for this person. */
  token: string
  /** Which walk it was got on — a seat can only follow the INSTALL walk. */
  walk: GateDoor
  /** The wallet terms the pay step showed, as their key (x402TermsKey), or null when it showed none. */
  shown: string | null
  /** What the pay step quoted for the card — the receipt a card payment is remembered with. */
  cardPrice: string
  /** Set when the walk was a purchase: a renewed sign-in must be the same walk. */
  intent?: 'buy'
}

export function createServeGate(deps: ServeGateDeps) {
  const now = (): number => deps.now?.() ?? Date.now()
  const pending: PendingCheckoutStore = deps.pending ?? memoryPendingCheckouts()

  /**
   * WHO IS AT THIS MAC, as half of every key below.
   *
   * Everything this gate remembers is a credential or a promise about money,
   * and a Mac changes hands: A signs out, B signs in. Keyed by door alone,
   * B's sheet would pay on A's Bearer and B's card would open as A. So each
   * entry is filed under the account it was MADE FOR and looked up under the
   * account signed in NOW — a different person finds nothing, whether or not
   * anybody remembered to call `accountChanged`.
   */
  const who = (): string => deps.accounts.account()?.username ?? ''
  /** Who was here the last time anybody looked — what `accountChanged` compares with. */
  let seenAs = who()
  const fileKey = (account: string, door: string): string => `${account}\n${door}`

  /**
   * Bearers held for doors this app has signed in to, with the walk they were
   * got on and the terms that walk showed. An entry outlives the sheet only
   * until the app quits or the account changes (the Bearer expires on its own
   * at the door).
   *
   * THE WALLET TERMS ARE HERE BECAUSE THE PRESS RE-ASKS. The x402 rail has to
   * ask for a quote again when PAY is pressed (a quote expires), and what
   * comes back is the DOOR's word a second time: 1 USDC on the sheet and 1000
   * at the press is one hostile line of code. The press signs only a quote
   * whose key — every signed field, shared/x402-terms.ts — is the one shown.
   */
  const held = new Map<string, Held>()

  /**
   * THE BEARER A SEAT WAS BOUGHT ON, by account and listed team, until
   * cookrew.dev knows — and for ten minutes at most.
   *
   * The door takes the money and admits the buyer at once; its report to
   * cookrew.dev is a queue that runs AFTER (seat-settle.ts — a slow registry
   * must not hold a door shut). The card placed a moment later signs in with
   * an ordinary mint, and until that report lands the registry still answers
   * no_seat: a person who just paid would be handed a card that says it was
   * refused. So the Bearer the door itself admitted is kept for exactly that
   * gap — offered only when the registry's mint says no_seat, to the same
   * account at the same team, and dropped the first time an ordinary sign-in
   * succeeds. It is the door's own credential for this account; nothing here
   * mints, extends or widens one.
   */
  const standIns = new Map<string, { token: string; at: number }>()

  /** What a `pay` phase showed for one rail. */
  const railOf = <R extends 'x402' | 'stripe'>(phase: AdmissionPhase, rail: R) =>
    phase.kind === 'pay' ? phase.rails.find((entry) => entry.rail === rail) : undefined

  const heldFrom = (token: string, walk: GateDoor, phase: AdmissionPhase, intent?: 'buy'): Held => {
    const wallet = railOf(phase, 'x402')
    return {
      token,
      walk,
      shown: wallet?.rail === 'x402' ? wallet.shown : null,
      cardPrice: railOf(phase, 'stripe')?.price ?? '',
      ...(intent === 'buy' ? { intent } : {})
    }
  }

  /**
   * The door opened a line on this Bearer. On the install walk — a listed
   * team, where a seat exists to be reported — the card may need it for the
   * moment before cookrew.dev records the seat. An unlisted door seats nobody:
   * the Bearer there belongs to this Mac's key, never to an account.
   */
  const remember = (key: string, entry: Held, phase: AdmissionPhase): AdmissionPhase => {
    if (phase.kind === 'open' && entry.walk === 'install') {
      standIns.set(key, { token: entry.token, at: now() })
    }
    return phase
  }

  /**
   * SIGN IN AGAIN, as the same caller on the same walk.
   *
   * A door's Bearer lives an hour from the moment it was issued, and a card
   * page can be paid for an hour from the moment IT was — which is later. So
   * the Bearer can run out while the payment it is for is still in flight,
   * and then every question about that payment is a 401. This is the same
   * sign-in `gate` made: the key at an unlisted door; at a listed one a fresh
   * mint — with the buy intent when the walk was a purchase, because the
   * purchase is the one the person already asked for.
   */
  const renew = async (target: ServeTarget, at: ServeTarget, entry: Held): Promise<string | null> => {
    if (entry.walk === 'direct') return deps.signInWithKey(at)
    const again = await admitWithAccount(
      at,
      target.door as string,
      deps.accounts,
      entry.intent === 'buy' ? { intent: 'buy' } : {}
    )
    return again.token
  }

  /**
   * Open the line as the held caller — and if the door no longer knows the
   * Bearer, renew it ONCE and ask the same thing again. Only a second 401 is
   * an answer; the first is a clock.
   */
  const ask = async (
    key: string,
    target: ServeTarget,
    at: ServeTarget,
    entry: Held,
    payment?: string
  ): Promise<{ phase: AdmissionPhase; entry: Held }> => {
    const first = await openAdmission(at, entry.token, payment)
    if (first.kind !== 'error' || first.status !== 401) return { phase: first, entry }
    const token = await renew(target, at, entry).catch(() => null)
    if (token === null) return { phase: first, entry }
    const renewed: Held = { ...entry, token }
    held.set(key, renewed)
    return { phase: await openAdmission(at, token, payment), entry: renewed }
  }

  const lifeOver = (waiting: PendingCheckout): boolean =>
    now() - waiting.startedAt >= CHECKOUT_MAX_LIFE_SECONDS * 1000

  /**
   * THE DOOR HAS ANSWERED FOR A REMEMBERED CARD SESSION. Two answers end it:
   * `open` — it was paid, the purchase is done — and "not paid" once the
   * session can no longer be paid at all. Anything else (not paid YET, a door
   * that could not check, a refusal about something other than the payment)
   * leaves it standing: while it can still take a card, it must still be the
   * only one.
   */
  const afterCardAnswer = (waiting: PendingCheckout, phase: AdmissionPhase): 'done' | 'gone' | 'standing' => {
    const unpaid = phase.kind === 'denied' && phase.reason === 'payment_invalid'
    const verdict = phase.kind === 'open' ? 'done' : unpaid && lifeOver(waiting) ? 'gone' : 'standing'
    if (verdict !== 'standing') pending.drop(waiting.account, waiting.door, waiting.session)
    return verdict
  }

  const cardOf = (waiting: PendingCheckout) => ({
    session: waiting.session,
    url: waiting.url,
    startedAt: waiting.startedAt,
    price: waiting.price
  })

  const gate = async (link: string, intent?: 'buy') => {
    const target = deps.parse(link)
    if (!target) return { ok: false as const, reason: 'bad-address' as const }
    const door = targetKey(target)
    try {
      const reached = await deps.reachable(target)
      if (!reached) return { ok: false as const, reason: 'sign-in' as const, detail: 'not serving' }
      const at = reached.at
      const walk = gateDoorFor(target, reached)

      if (walk === 'direct') {
        // No registry seats anybody at an unlisted door, so there is nothing
        // to buy before its 402: the intent is not read on this walk.
        const token = await deps.signInWithKey(at)
        // Filed under whoever is here NOW, after the wait — not whoever was
        // here when the ask began.
        const key = fileKey(who(), door)
        const phase = await openAdmission(at, token)
        let entry = heldFrom(token, walk, phase)
        held.set(key, entry)
        const waiting = pending.get(who(), door)
        if (waiting && phase.kind !== 'open') {
          const presented = await ask(key, target, at, entry, stripePaymentHeader(waiting.session))
          entry = presented.entry
          const verdict = afterCardAnswer(waiting, presented.phase)
          if (verdict === 'done') {
            return {
              ok: true as const,
              door: walk,
              phase: presented.phase,
              wallet: deps.wallet(),
              settled: { price: waiting.price, asset: 'USD' as const, rail: 'stripe' as const }
            }
          }
          if (verdict === 'standing') {
            return { ok: true as const, door: walk, phase, wallet: deps.wallet(), card: cardOf(waiting) }
          }
        } else if (waiting) {
          pending.drop(waiting.account, waiting.door, waiting.session)
        }
        return { ok: true as const, door: walk, phase, wallet: deps.wallet() }
      }

      const team = target.door as string
      let asked: 'buy' | undefined = intent === 'buy' ? 'buy' : undefined
      let admitted = await admitWithAccount(at, team, deps.accounts, asked ? { intent: asked } : {})
      // FILED UNDER THE ACCOUNT THE MINT WAS MADE FOR. The person at this Mac
      // can change while the registry and the door are being asked; whatever
      // came back belongs to the account it names, not to whoever was here
      // when the question was put.
      const account = admitted.account ?? who()
      const key = fileKey(account, door)
      const plain = admitted
      const waiting = pending.get(account, door)

      // A CARD PAYMENT IS IN FLIGHT HERE and the plain ask got no Bearer (the
      // registry has no seat for this account yet — which is exactly what a
      // payment in flight looks like). The door must be asked about that
      // payment before anything else is shown, and asking takes a Bearer: the
      // same buy walk the person already took to start it. Nothing new is
      // bought by this — it presents a session that already exists.
      if (waiting && admitted.token === null && admitted.minted === 'no_seat' && asked === undefined) {
        asked = 'buy'
        admitted = await admitWithAccount(at, team, deps.accounts, { intent: 'buy' })
      }

      const facts = {
        ok: true as const,
        door: walk,
        wallet: deps.wallet(),
        // The facts the sheet's sentences name: the team, who can say yes,
        // and who this Mac is (the usual cause of a no_seat is being signed
        // in as somebody else).
        team,
        owner: doorOwnerOf(team),
        account: admitted.account,
        seat: admitted.seat
      }

      if (admitted.token === null) return { ...facts, phase: admitted.phase }

      let entry = heldFrom(admitted.token, walk, admitted.phase, asked)
      held.set(key, entry)
      // Admitted with no payment on a token that carried no seat: the door
      // itself says this account already paid here (a purchase cookrew.dev
      // has not recorded yet). The card that follows opens the same way.
      if (asked === 'buy') remember(key, entry, admitted.phase)

      if (waiting && admitted.phase.kind === 'open') {
        // Seated already — granted, or the payment was recorded elsewhere.
        pending.drop(waiting.account, waiting.door, waiting.session)
      } else if (waiting) {
        // PRESENTED FIRST, before any pay step is shown.
        const presented = await ask(key, target, at, entry, stripePaymentHeader(waiting.session))
        entry = presented.entry
        const verdict = afterCardAnswer(waiting, presented.phase)
        if (verdict === 'done') {
          return {
            ...facts,
            phase: remember(key, entry, presented.phase),
            settled: { price: waiting.price, asset: 'USD' as const, rail: 'stripe' as const }
          }
        }
        if (verdict === 'standing') return { ...facts, phase: admitted.phase, card: cardOf(waiting) }
        // Gone: the answer is the one the person actually asked for.
        if (intent !== 'buy') {
          held.delete(key)
          return { ...facts, account: plain.account, seat: plain.seat, phase: plain.phase }
        }
      }
      return { ...facts, phase: admitted.phase }
    } catch (error) {
      return {
        ok: false as const,
        reason: 'sign-in' as const,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  return {
    /**
     * Ask the door what it wants. `intent: 'buy'` only when the person pressed
     * BUY A SEAT.
     *
     * A CARD PAYMENT ALREADY IN FLIGHT at this door for this account is
     * presented to the door first (pending-checkout.ts): `settled` in the
     * answer means it had landed and the purchase is complete; `card` means it
     * is still unpaid and still payable, and the sheet waits on THAT session.
     */
    gate,

    /**
     * Start a card payment — or hand back the one already started.
     *
     * NEVER A SECOND CHECKOUT WHILE ONE STANDS. A remembered session for this
     * account at this door is returned as it is (`resumed`), whichever surface
     * asks and however long ago it was made: across the door's quote window a
     * fresh request would mint a new session while the first can still be
     * paid, and two payable pages are two charges.
     */
    checkout: async (link: string) => {
      const target = deps.parse(link)
      const account = who()
      const door = target ? targetKey(target) : ''
      const key = fileKey(account, door)
      const found = target ? held.get(key) : undefined
      if (!target || !found) return { ok: false as const, reason: 'not-signed-in' as const }
      let entry = found
      try {
        const reached = await deps.reachable(target)
        if (!reached) return { ok: false as const, reason: 'unavailable' as const }
        const waiting = pending.get(account, door)
        if (waiting) {
          const standing = {
            ok: true as const,
            session: waiting.session,
            url: waiting.url,
            startedAt: waiting.startedAt,
            resumed: true as const
          }
          if (!lifeOver(waiting)) return standing
          // It can no longer be paid. One question to the door settles what
          // it was: paid (hand it back; the wait opens on it), or unpaid for
          // good (forgotten here, and only then is a new one made).
          const presented = await ask(key, target, reached.at, entry, stripePaymentHeader(waiting.session))
          entry = presented.entry
          if (afterCardAnswer(waiting, presented.phase) !== 'gone') return standing
        }
        const checkout = await startStripeCheckout(reached.at, entry.token)
        const startedAt = now()
        pending.put({
          account,
          door,
          link,
          session: checkout.session,
          url: checkout.url,
          price: entry.cardPrice,
          startedAt
        })
        // The URL comes back too: a hand-off that silently failed to raise a
        // browser would otherwise leave the person waiting on a page they never
        // saw, with no way to reach it. It is a capability — the sheet keeps it
        // to re-open, and never prints it.
        return { ok: true as const, session: checkout.session, url: checkout.url, startedAt }
      } catch (error) {
        return {
          ok: false as const,
          reason: 'unavailable' as const,
          detail: error instanceof Error ? error.message : String(error)
        }
      }
    },

    /**
     * Present a payment. `shown` is the wallet rail's: the key of the terms
     * the SURFACE THAT WAS PRESSED displayed (AdmissionRail.shown, sent back
     * with the press). Main remembers what the last gate answer showed, but
     * the phone and the desktop share this gate and either can re-ask — so
     * what main remembers is not necessarily what this person is looking at.
     */
    settle: async (link: string, rail: 'x402' | 'stripe', session?: string, shown?: string) => {
      const target = deps.parse(link)
      const account = who()
      const door = target ? targetKey(target) : ''
      const key = fileKey(account, door)
      const found = target ? held.get(key) : undefined
      if (!target || !found) return { ok: false as const, reason: 'not-signed-in' as const }
      let entry = found
      try {
        const reached = await deps.reachable(target)
        if (!reached) return { ok: false as const, reason: 'refused' as const }
        const at = reached.at
        if (rail === 'stripe') {
          if (!session) return { ok: false as const, reason: 'no-session' as const }
          const presented = await ask(key, target, at, entry, stripePaymentHeader(session))
          const waiting = pending.get(account, door)
          if (waiting && waiting.session === session) afterCardAnswer(waiting, presented.phase)
          return {
            ok: true as const,
            phase: remember(key, presented.entry, presented.phase),
            // Whether a card payment is STILL held in flight here after this
            // answer. A surface offers a new PAY only once this is false: main
            // lets go on the door's word and its own clock, never a surface's.
            standing: pending.get(account, door) !== null
          }
        }

        const quote = await ask(key, target, at, entry)
        entry = quote.entry
        const quoted = quote.phase
        const terms = railOf(quoted, 'x402')
        const changed = {
          ok: false as const,
          reason: 'terms-changed' as const,
          detail: MKT_PAY['mkt.pay.error.changed.body']
        }
        if (!terms || terms.rail !== 'x402') {
          // Still asking for money, but with no wallet quote this app can
          // read: whatever was on screen is not what the door asks now.
          if (quoted.kind === 'pay') return changed
          // Already open, or refused for another reason. Nothing to sign.
          return { ok: true as const, phase: remember(key, entry, quoted) }
        }
        // SIGN WHAT WAS SHOWN, OR NOTHING. Three things must be the same
        // terms: what the pressed surface displayed, what main last showed,
        // and what the door quotes now. A press that carries nothing, or
        // carries a screen that has since been replaced, is refused.
        if (typeof shown !== 'string' || shown.length === 0) return changed
        if (entry.shown === null || shown !== entry.shown || terms.shown !== shown) return changed
        const payment = await deps.buildX402Payment(terms.requirements)
        const presented = await ask(key, target, at, entry, payment)
        return { ok: true as const, phase: remember(key, presented.entry, presented.phase) }
      } catch (error) {
        return {
          ok: false as const,
          reason: 'refused' as const,
          detail: error instanceof Error ? error.message : String(error)
        }
      }
    },

    /**
     * EVERY CARD PAYMENT THIS ACCOUNT LEFT IN FLIGHT, asked about now — at
     * app start, before anybody opens a sheet. A session paid after the app
     * was closed has charged a card and seated nobody: the door only learns of
     * it when it is presented. Returns how many turned out to be paid.
     */
    resumePending: async (): Promise<number> => {
      let landed = 0
      for (const waiting of pending.all(who())) {
        const answer = await gate(waiting.link)
        if (answer.ok && 'settled' in answer && answer.settled !== undefined) landed += 1
      }
      return landed
    },

    /**
     * THE CARD'S SIGN-IN at a listed door — and its transcript reads and END,
     * which are the same caller (door-bearer.ts). An ordinary mint, always:
     * the card never says BUY. Only when cookrew.dev's own mint answers
     * no_seat, for a team THIS account paid at in the last ten minutes, does
     * the Bearer the door admitted stand in.
     */
    admitCard: async (target: ServeTargetRef, team: string): Promise<AccountAdmission> => {
      const admitted = await admitWithAccount(target, team, deps.accounts)
      const key = fileKey(admitted.account ?? who(), team)
      const standIn = standIns.get(key)
      if (admitted.token !== null || (standIn !== undefined && now() - standIn.at >= STAND_IN_TTL_MS)) {
        // cookrew.dev has the seat now, or the stand-in has run out its time:
        // either way it is finished, and gone rather than merely unused.
        standIns.delete(key)
        return admitted
      }
      return withPaidBearer(admitted, standIn?.token ?? null)
    },

    /**
     * SOMETHING ABOUT THE ACCOUNT CHANGED. When it is the PERSON that changed
     * — signed out, switched — every Bearer, every shown quote and every
     * stand-in goes: they were one person's, and the keys above only stop the
     * next person FINDING them.
     *
     * When the person is the same, nothing goes. The account announces many
     * things that are not a change of hands (a device revoked elsewhere, a
     * session renewed), and a card payment may be in flight: forgetting the
     * Bearer then would leave a paid Checkout session nobody can present.
     *
     * The card payments in flight are NOT forgotten either way. They are on
     * disk under the account that started them, and that person coming back
     * is how a payment made in between gets presented.
     *
     * Answers whether it WAS a change of person, so a caller holding other
     * things of theirs (index.ts: the door transcripts) can let go of them too.
     */
    accountChanged: (): boolean => {
      const as = who()
      if (as === seenAs) return false
      seenAs = as
      held.clear()
      standIns.clear()
      return true
    }
  }
}
