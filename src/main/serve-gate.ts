import { gateDoorFor, type GateDoor } from '../shared/gate-walk'
import { MKT_PAY } from '../shared/marketplace-copy'
import { isStripeCheckoutUrl } from '../shared/stripe-checkout'
import { withPaidBearer } from './door-bearer'
import type { ServeTarget } from './import-session'
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
  await open(url)
  return checkout
}

/**
 * ARE THESE THE SAME TERMS, in every field a signature covers?
 *
 * `buildX402Payment` signs a transfer of `maxAmountRequired` to `payTo`, valid
 * for `maxTimeoutSeconds`, under the EIP-712 domain of `asset` on `network`
 * named by `extra`. Those are compared and nothing else is: a door may reword
 * its description without changing what is paid. Addresses are compared
 * without case — a checksummed address and its lower-case spelling are one
 * account.
 */
export function sameSignedTerms(shown: PaymentRequirements, fresh: PaymentRequirements): boolean {
  const address = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '')
  return (
    shown.scheme === fresh.scheme &&
    shown.network === fresh.network &&
    shown.maxAmountRequired === fresh.maxAmountRequired &&
    shown.maxTimeoutSeconds === fresh.maxTimeoutSeconds &&
    address(shown.payTo) === address(fresh.payTo) &&
    address(shown.asset) === address(fresh.asset) &&
    shown.extra?.name === fresh.extra?.name &&
    shown.extra?.version === fresh.extra?.version
  )
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
  /** The wallet terms the pay step showed, or null when it showed none. */
  shown: PaymentRequirements | null
}

export function createServeGate(deps: ServeGateDeps) {
  const now = (): number => deps.now?.() ?? Date.now()

  /**
   * WHO IS AT THIS MAC, as half of every key below.
   *
   * Everything this gate remembers is a credential or a promise about money,
   * and a Mac changes hands: A signs out, B signs in. Keyed by door alone,
   * B's sheet would pay on A's Bearer and B's card would open as A. So each
   * entry is filed under the account that was signed in when it was stored
   * and looked up under the account signed in NOW — a different person finds
   * nothing, whether or not anybody remembered to call `forget`.
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
   * that matches what was shown in every signed field (`sameSignedTerms`).
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

  /** What a `pay` phase showed for the wallet rail; any other answer shows nothing. */
  const shownBy = (phase: AdmissionPhase): PaymentRequirements | null => {
    if (phase.kind !== 'pay') return null
    const wallet = phase.rails.find((entry) => entry.rail === 'x402')
    return wallet?.rail === 'x402' ? wallet.requirements : null
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

  return {
    /** Ask the door what it wants. `intent: 'buy'` only when the person pressed BUY A SEAT. */
    gate: async (link: string, intent?: 'buy') => {
      const target = deps.parse(link)
      if (!target) return { ok: false as const, reason: 'bad-address' as const }
      const key = fileKey(who(), targetKey(target))
      try {
        const reached = await deps.reachable(target)
        if (!reached) return { ok: false as const, reason: 'sign-in' as const, detail: 'not serving' }
        const at = reached.at
        const door = gateDoorFor(target, reached)
        if (door === 'direct') {
          // No registry seats anybody at an unlisted door, so there is nothing
          // to buy before its 402: the intent is not read on this walk.
          const token = await deps.signInWithKey(at)
          const phase = await openAdmission(at, token)
          held.set(key, { token, walk: door, shown: shownBy(phase) })
          return { ok: true as const, door, phase, wallet: deps.wallet() }
        }
        const team = target.door as string
        const admitted = await admitWithAccount(at, team, deps.accounts, intent === 'buy' ? { intent } : {})
        if (admitted.token !== null) {
          const entry: Held = { token: admitted.token, walk: door, shown: shownBy(admitted.phase) }
          held.set(key, entry)
          // Admitted with no payment on a token that carried no seat: the door
          // itself says this account already paid here (a purchase cookrew.dev
          // has not recorded yet). The card that follows opens the same way.
          if (intent === 'buy') remember(key, entry, admitted.phase)
        }
        return {
          ok: true as const,
          door,
          phase: admitted.phase,
          wallet: deps.wallet(),
          // The facts the sheet's sentences name: the team, who can say yes,
          // and who this Mac is (the usual cause of a no_seat is being signed
          // in as somebody else).
          team,
          owner: doorOwnerOf(team),
          account: admitted.account,
          seat: admitted.seat
        }
      } catch (error) {
        return {
          ok: false as const,
          reason: 'sign-in' as const,
          detail: error instanceof Error ? error.message : String(error)
        }
      }
    },

    checkout: async (link: string) => {
      const target = deps.parse(link)
      const entry = target ? held.get(fileKey(who(), targetKey(target))) : undefined
      if (!target || !entry) return { ok: false as const, reason: 'not-signed-in' as const }
      try {
        const reached = await deps.reachable(target)
        if (!reached) return { ok: false as const, reason: 'unavailable' as const }
        const checkout = await startStripeCheckout(reached.at, entry.token)
        // The URL comes back too: a hand-off that silently failed to raise a
        // browser would otherwise leave the person waiting on a page they never
        // saw, with no way to reach it. It is a capability — the sheet keeps it
        // to re-open, and never prints it.
        return { ok: true as const, session: checkout.session, url: checkout.url }
      } catch (error) {
        return {
          ok: false as const,
          reason: 'unavailable' as const,
          detail: error instanceof Error ? error.message : String(error)
        }
      }
    },

    settle: async (link: string, rail: 'x402' | 'stripe', session?: string) => {
      const target = deps.parse(link)
      const key = target ? fileKey(who(), targetKey(target)) : ''
      const entry = target ? held.get(key) : undefined
      if (!target || !entry) return { ok: false as const, reason: 'not-signed-in' as const }
      const { token } = entry
      try {
        const reached = await deps.reachable(target)
        if (!reached) return { ok: false as const, reason: 'refused' as const }
        const at = reached.at
        let payment: string
        if (rail === 'stripe') {
          if (!session) return { ok: false as const, reason: 'no-session' as const }
          payment = stripePaymentHeader(session)
        } else {
          const quoted = await openAdmission(at, token)
          const terms =
            quoted.kind === 'pay' ? quoted.rails.find((item) => item.rail === 'x402') : undefined
          if (!terms || terms.rail !== 'x402') {
            // Already open, or this door stopped quoting USDC. Either way there
            // is nothing to sign, and signing a stale quote is money gone.
            return { ok: true as const, phase: remember(key, entry, quoted) }
          }
          // SIGN WHAT WAS SHOWN, OR NOTHING. This quote is fresh from the door;
          // the one the person approved is the one the pay step was built from.
          if (entry.shown === null || !sameSignedTerms(entry.shown, terms.requirements)) {
            return {
              ok: false as const,
              reason: 'terms-changed' as const,
              detail: MKT_PAY['mkt.pay.error.changed.body']
            }
          }
          payment = await deps.buildX402Payment(terms.requirements)
        }
        return {
          ok: true as const,
          phase: remember(key, entry, await openAdmission(at, token, payment))
        }
      } catch (error) {
        return {
          ok: false as const,
          reason: 'refused' as const,
          detail: error instanceof Error ? error.message : String(error)
        }
      }
    },

    /**
     * THE CARD'S SIGN-IN at a listed door — and its transcript reads and END,
     * which are the same caller (door-bearer.ts). An ordinary mint, always:
     * the card never says BUY. Only when cookrew.dev's own mint answers
     * no_seat, for a team THIS account paid at in the last ten minutes, does
     * the Bearer the door admitted stand in.
     */
    admitCard: async (target: ServeTargetRef, team: string): Promise<AccountAdmission> => {
      const key = fileKey(who(), team)
      const admitted = await admitWithAccount(target, team, deps.accounts)
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
     */
    accountChanged: (): void => {
      const as = who()
      if (as === seenAs) return
      seenAs = as
      held.clear()
      standIns.clear()
    }
  }
}
