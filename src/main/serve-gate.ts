import { gateDoorFor } from '../shared/gate-walk'
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
}

export type ServeGate = ReturnType<typeof createServeGate>

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

export function createServeGate(deps: ServeGateDeps) {
  /**
   * Bearers held for doors this app has signed in to, while an import is being
   * decided. Keyed by `targetKey`; a token outlives the sheet only until the
   * app quits (they expire on their own at the door).
   */
  const callerTokens = new Map<string, string>()

  /**
   * THE BEARER A SEAT WAS BOUGHT ON, by listed team, until cookrew.dev knows.
   *
   * The door takes the money and admits the buyer at once; its report to
   * cookrew.dev is a queue that runs AFTER (seat-settle.ts — a slow registry
   * must not hold a door shut). The card placed a moment later signs in with
   * an ordinary mint, and until that report lands the registry still answers
   * no_seat: a person who just paid would be handed a card that says it was
   * refused. So the Bearer the door itself admitted is kept for exactly that
   * gap — offered only when the registry says no_seat, and dropped the first
   * time an ordinary sign-in succeeds. It is the door's own credential for
   * this account; nothing here mints, extends or widens one.
   */
  const boughtBearers = new Map<string, string>()

  /** The door opened a line on this Bearer: at a listed team, the card may need it. */
  const remember = (target: ServeTarget, token: string, phase: AdmissionPhase): AdmissionPhase => {
    if (phase.kind === 'open' && typeof target.door === 'string') boughtBearers.set(target.door, token)
    return phase
  }

  return {
    /** Ask the door what it wants. `intent: 'buy'` only when the person pressed BUY A SEAT. */
    gate: async (link: string, intent?: 'buy') => {
      const target = deps.parse(link)
      if (!target) return { ok: false as const, reason: 'bad-address' as const }
      try {
        const reached = await deps.reachable(target)
        if (!reached) return { ok: false as const, reason: 'sign-in' as const, detail: 'not serving' }
        const at = reached.at
        const door = gateDoorFor(target, reached)
        if (door === 'direct') {
          // No registry seats anybody at an unlisted door, so there is nothing
          // to buy before its 402: the intent is not read on this walk.
          const token = await deps.signInWithKey(at)
          callerTokens.set(targetKey(target), token)
          const phase = await openAdmission(at, token)
          return { ok: true as const, door, phase, wallet: deps.wallet() }
        }
        const team = target.door as string
        const admitted = await admitWithAccount(at, team, deps.accounts, intent === 'buy' ? { intent } : {})
        if (admitted.token !== null) {
          callerTokens.set(targetKey(target), admitted.token)
          // Admitted with no payment on a token that carried no seat: the door
          // itself says this account already paid here (a purchase cookrew.dev
          // has not recorded yet). The card that follows opens the same way.
          if (intent === 'buy') remember(target, admitted.token, admitted.phase)
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
      const token = target ? callerTokens.get(targetKey(target)) : undefined
      if (!target || !token) return { ok: false as const, reason: 'not-signed-in' as const }
      try {
        const reached = await deps.reachable(target)
        if (!reached) return { ok: false as const, reason: 'unavailable' as const }
        const checkout = await startStripeCheckout(reached.at, token)
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
      const token = target ? callerTokens.get(targetKey(target)) : undefined
      if (!target || !token) return { ok: false as const, reason: 'not-signed-in' as const }
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
            quoted.kind === 'pay' ? quoted.rails.find((entry) => entry.rail === 'x402') : undefined
          if (!terms || terms.rail !== 'x402') {
            // Already open, or this door stopped quoting USDC. Either way there
            // is nothing to sign, and signing a stale quote is money gone.
            return { ok: true as const, phase: remember(target, token, quoted) }
          }
          payment = await deps.buildX402Payment(terms.requirements)
        }
        return {
          ok: true as const,
          phase: remember(target, token, await openAdmission(at, token, payment))
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
     * the card never says BUY. Only when cookrew.dev answers no_seat for a
     * team this Mac just paid at does the Bearer the door admitted stand in.
     */
    admitCard: async (target: ServeTargetRef, team: string): Promise<AccountAdmission> => {
      const admitted = await admitWithAccount(target, team, deps.accounts)
      if (admitted.token !== null) {
        // cookrew.dev has the seat now; the stand-in has done its job.
        boughtBearers.delete(team)
        return admitted
      }
      return withPaidBearer(admitted, boughtBearers.get(team) ?? null)
    }
  }
}
