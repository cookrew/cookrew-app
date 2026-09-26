import { randomInt, randomUUID } from 'node:crypto'
import type { StepUpAct } from '../../src/shared/step-up'

/**
 * IDENTITY v2 — A SIGN-IN THAT IS HALF DONE.
 *
 * The password was right and the account wants more (a passkey, a code, a
 * nod from a device it already trusts). That half-finished state has to live
 * somewhere between two requests, and it lives HERE: in memory, bounded, and
 * ten minutes long.
 *
 * IN MEMORY, DELIBERATELY. A pending sign-in is not a fact about an account;
 * it is a fact about a conversation. A restart ending every conversation in
 * flight is the correct behaviour — the person types their password again —
 * and it means a password-verified record never touches a disk.
 *
 * THE DEVICE IS NOT ATTACHED YET. `device` is the payload the caller sent,
 * held and not acted on: attaching it before the second factor would mean the
 * password alone put a new device on the account, which is the exact thing
 * the ladder exists to prevent.
 */

export type Factor = 'passkey' | 'totp' | 'approve' | 'recovery'

/** The order the sheet shows them in: recommended first, rescue last. */
export const FACTOR_ORDER: readonly Factor[] = ['passkey', 'totp', 'approve', 'recovery']

/** Ten minutes — long enough to find a phone, short enough to be a moment. */
export const PENDING_TTL_MS = 10 * 60 * 1000
/** Five tries on one pending, then it is gone and the password is typed again. */
export const PENDING_ATTEMPTS = 5
/**
 * Three goes at the two digits, and the sign-in is over.
 *
 * Ninety values is a small number on purpose — a person has to read it off one
 * screen and type it on another — and three tries is what keeps ninety honest.
 * It is counted PER PENDING, not per account or per address: the thing being
 * guessed belongs to one sign-in, and a limiter keyed on anything wider would
 * let one stranger's guessing end somebody else's.
 */
export const MATCH_TRIES = 3

/**
 * TWO DIGITS, 10–99, from the system's random source.
 *
 * Not derived from the pending id, the device, the account or the clock. A
 * number that can be computed from what the asker already holds is not a
 * second channel, it is decoration — and the whole point of the rung is that
 * approving requires SEEING the screen of the machine that is signing in.
 *
 * No leading zero, so there is one shape to show and one to compare; nobody
 * reads "07" off a screen as a different number from "7".
 */
const mintMatch = (): string => String(randomInt(10, 100))
/** More pending sign-ins than a busy hour has; a stranger cannot spend it. */
const PENDING_MAX = 1000
/**
 * And a cap PER ACCOUNT. The global one alone meant the oldest pending in the
 * whole registry was evicted whatever it was — so a caller with any valid
 * password could churn a thousand of their own and make a victim's approval
 * vanish as "expired", which is a denial of the approve rung specifically.
 */
const PENDING_PER_ACCOUNT = 5
/** More requests than the owner's prompt can honestly show at once. */
const APPROVALS_SHOWN = 10

export type Decision = 'approve' | 'deny' | 'not-me'

export interface Approval {
  id: string
  pending: string
  username: string
  /** What the asking device calls itself — "Chrome on macOS". */
  deviceName: string
  kind: string
  /** The address it is asking from. Never a city: this registry does no geo. */
  address: string
  at: number
  expiresAt: number
  /** The D6 sentence, written once so every screen says the same thing. */
  sentence: string
  decision: Decision | null
}

export interface Pending {
  id: string
  username: string
  /** The device payload, unattached and unexamined until a factor passes. */
  device: unknown
  deviceName: string
  kind: string
  address: string
  passwordOk: true
  at: number
  expiresAt: number
  next: readonly Factor[]
  attempts: number
  /**
   * The two digits the ASKING device is shown and the approving device must
   * type. It lives on the pending and never on the Approval, which is what
   * makes it structurally impossible for the owner's approvals list to carry
   * it — the list is built from Approvals, and an attacker holding the
   * owner's session is exactly who must not be handed the number.
   */
  match: string
  /** Wrong numbers so far. The third ends the sign-in. */
  matchMisses: number
  approval: Approval | null
  /**
   * THE ACT THIS PENDING AUTHORISES, when it is not a sign-in.
   *
   * A step-up climbs the same ladder a new device climbs — same rungs, same
   * wire shape, same screens — but it must end somewhere else. A sign-in ends
   * in a session; a step-up ends in PERMISSION to do one thing, on a session
   * the caller already holds. Minting a second session for somebody who is
   * already signed in would be a strange prize for proving who they are, and
   * a device attached as a side effect of changing a password would be worse.
   *
   * Absent means a sign-in, which is what every pending was before this.
   */
  act?: StepUpAct
  /** A rung was climbed on an act-pending: the act may now happen, once. */
  authorised: boolean
  /**
   * WHO OPENED THIS, when the opener was already signed in.
   *
   * A SIGN-IN HAS NO OPENER and that is the whole difference. The device at
   * the front door is not attached yet, so it holds no session, so it cannot
   * reach the route that answers approvals — the ceremony is safe there by
   * arrangement rather than by a check. A STEP-UP inverts every part of that:
   * the asker is attached, holds a session, and is handed the two digits. The
   * same ladder that is sound in front of the door is self-answering behind
   * it, so behind it the asker has to be named and refused by name.
   */
  opener?: { jti: string; device: string }
}

/** What answering an approval came to. */
export type DecideResult =
  | { ok: true; approval: Approval }
  | { ok: false; reason: 'no_approval' }
  | { ok: false; reason: 'bad_match'; triesLeft: number }
  /** The session that asked tried to answer itself. See `Pending.opener`. */
  | { ok: false; reason: 'self_approval' }

export interface OpenInput {
  username: string
  device: unknown
  deviceName: string
  kind: string
  address: string
  next: readonly Factor[]
  /** Set for a step-up: the one act this pending will authorise. */
  act?: StepUpAct
  /** Set for a step-up: the session and device asking. It may not answer. */
  opener?: { jti: string; device: string }
}

/**
 * The one sentence D6 shows and the approvals list repeats.
 *
 * THE DEVICE NAME IS IN QUOTES, and it is not the sentence's subject. It is
 * chosen by whoever is asking to sign in — a device calling itself
 * `cookrew.dev security check` would otherwise be reading as our own words
 * in the prompt where the owner decides. Quoted, it is plainly a name the
 * asking device gave itself.
 */
export const approvalSentence = (deviceName: string, address: string, username: string): string =>
  `A device calling itself “${deviceName}”, at ${address}, wants to sign in as @${username}.`

export class PendingSignIns {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly attemptsMax: number
  private pendings = new Map<string, Pending>()

  constructor(now: () => number = Date.now, ttlMs = PENDING_TTL_MS, attemptsMax = PENDING_ATTEMPTS) {
    this.now = now
    this.ttlMs = ttlMs
    this.attemptsMax = attemptsMax
  }

  open(input: OpenInput): Pending {
    const at = this.now()
    this.sweep(at)
    const pending: Pending = {
      id: randomUUID(),
      username: input.username,
      device: input.device,
      deviceName: input.deviceName,
      kind: input.kind,
      address: input.address,
      passwordOk: true,
      at,
      expiresAt: at + this.ttlMs,
      next: input.next,
      attempts: 0,
      match: mintMatch(),
      matchMisses: 0,
      approval: null,
      ...(input.act === undefined ? {} : { act: input.act }),
      ...(input.opener === undefined ? {} : { opener: input.opener }),
      authorised: false
    }
    // Bounded by count as well as by time — this account's own oldest first,
    // so the pressure of a busy account is felt only by that account.
    const mine = [...this.pendings.values()].filter((p) => p.username === input.username).sort((a, b) => a.at - b.at)
    for (const spare of mine.slice(0, Math.max(0, mine.length - (PENDING_PER_ACCOUNT - 1)))) {
      this.pendings.delete(spare.id)
    }
    if (this.pendings.size >= PENDING_MAX) {
      const oldest = [...this.pendings.values()].sort((a, b) => a.at - b.at)[0]
      if (oldest) this.pendings.delete(oldest.id)
    }
    this.pendings.set(pending.id, pending)
    return pending
  }

  /** The live pending with this id, or null — expired reads as gone. */
  get(id: unknown): Pending | null {
    if (typeof id !== 'string' || id === '') return null
    const held = this.pendings.get(id)
    if (held === undefined) return null
    if (this.now() >= held.expiresAt) {
      this.pendings.delete(id)
      return null
    }
    return held
  }

  /**
   * ONE ATTEMPT AGAINST A PENDING. The fifth wrong code is the last: the
   * pending is dropped, and the person starts from the password again. A
   * limiter keyed by the pending rather than by an address, because the thing
   * being guessed is six digits belonging to one sign-in.
   *
   * AND IT SAYS WHICH. "Too many tries" and "this went cold" are the same
   * status and a different thing to do about it; a person told the wrong one
   * goes looking for a clock problem they do not have. Real-UI QA read the
   * timeout sentence after five wrong codes, which is how this came back
   * carrying a reason.
   */
  attempt(id: string): { ok: true; pending: Pending } | { ok: false; reason: 'expired' | 'too_many_attempts' } {
    const held = this.get(id)
    if (held === null) return { ok: false, reason: 'expired' }
    const next: Pending = { ...held, attempts: held.attempts + 1 }
    if (next.attempts > this.attemptsMax) {
      this.pendings.delete(id)
      return { ok: false, reason: 'too_many_attempts' }
    }
    this.pendings.set(id, next)
    return { ok: true, pending: next }
  }

  close(id: string): void {
    this.pendings.delete(id)
  }

  /**
   * A rung was climbed on an act-pending. Nothing is minted; the pending is
   * marked, and the caller repeats the request it was refused.
   */
  authorise(id: string): boolean {
    const held = this.get(id)
    if (held === null || held.act === undefined) return false
    this.pendings.set(id, { ...held, authorised: true })
    return true
  }

  /**
   * Spend an authorisation: is this pending a live, climbed step-up for THIS
   * person and THIS act?
   *
   * ONCE, AND FOR ONE ACT. Spending closes the pending, so a proof cannot be
   * replayed into a second sensitive act — proving who you are to mint a join
   * code must not also, quietly, be permission to revoke somebody's device.
   * The act is compared rather than assumed for the same reason.
   */
  spendAuthorised(username: string, act: StepUpAct, id: unknown): boolean {
    if (typeof id !== 'string' || id === '') return false
    const held = this.get(id)
    if (held === null) return false
    if (!held.authorised || held.act !== act || held.username !== username) return false
    this.pendings.delete(id)
    return true
  }

  /**
   * EVERY SIGN-IN THIS ACCOUNT HAS IN FLIGHT, DROPPED — what "not me" means.
   *
   * The alarm was pressed. A pending that survives it is a password-verified
   * record with four tries left on it, and the ladder's other rungs would
   * have let the same stranger in through the door beside the one just
   * slammed. `keep` is the disowned request itself, kept only so its poll can
   * still answer "denied" rather than "expired".
   */
  closeAllFor(username: string, keep?: string): number {
    let closed = 0
    for (const [id, pending] of this.pendings) {
      if (pending.username !== username || id === keep) continue
      this.pendings.delete(id)
      closed += 1
    }
    return closed
  }

  /** Has this request been answered with anything but an approval? */
  refused(pending: Pending): boolean {
    return pending.approval !== null && pending.approval.decision !== null && pending.approval.decision !== 'approve'
  }

  // ── approvals ──────────────────────────────────────────────────────────

  /**
   * ASK THE ACCOUNT'S OWN DEVICES. Asking twice does not make two requests:
   * the pending holds one, so a sheet that is reopened polls the same one
   * rather than lighting up a second prompt on the Mac.
   */
  ask(id: string): Approval | null {
    const held = this.get(id)
    if (held === null) return null
    if (held.approval !== null) return held.approval
    const approval: Approval = {
      id: randomUUID(),
      pending: held.id,
      username: held.username,
      deviceName: held.deviceName,
      kind: held.kind,
      address: held.address,
      at: this.now(),
      expiresAt: held.expiresAt,
      sentence: approvalSentence(held.deviceName, held.address, held.username),
      decision: null
    }
    this.pendings.set(held.id, { ...held, approval })
    return approval
  }

  /** Every request this account's devices should be showing right now. */
  approvalsFor(username: string): Approval[] {
    const at = this.now()
    this.sweep(at)
    return [...this.pendings.values()]
      .filter((p) => p.username === username && p.approval !== null && p.approval.decision === null)
      .map((p) => p.approval as Approval)
      .sort((a, b) => b.at - a.at)
      .slice(0, APPROVALS_SHOWN)
  }

  /**
   * Answer one, on behalf of the account it belongs to.
   *
   * APPROVE CARRIES THE NUMBER; DENY AND "NOT ME" DO NOT. Whoever holds the
   * password can press "ask my other device" until the owner is tired enough
   * or clumsy enough to tap APPROVE — the shape of the 2022 Uber breach, and
   * why number matching stopped being optional elsewhere in 2023. Requiring
   * the digits makes seeing the asking device's screen a hard condition, so
   * nagging from somewhere else cannot be outlasted.
   *
   * The two safe answers stay one tap. A person reaching for "not me" is
   * already alarmed, and an alarm that is harder to raise than a mistake is
   * an alarm people stop raising — which is how an account ends up quietly
   * denied over and over instead of locked down once.
   *
   * Every refusal that is not a bad number answers `no_approval`, including
   * one that was already decided. Saying "the number was right, but too late"
   * would tell whoever asked something about a request that is not theirs.
   */
  decide(
    username: string,
    approvalId: unknown,
    decision: Decision,
    match?: unknown,
    by?: { jti: string; device: string }
  ): DecideResult {
    if (typeof approvalId !== 'string' || approvalId === '') return { ok: false, reason: 'no_approval' }
    for (const pending of this.pendings.values()) {
      const approval = pending.approval
      if (approval === null || approval.id !== approvalId) continue
      if (approval.username !== username) return { ok: false, reason: 'no_approval' }
      if (this.now() >= pending.expiresAt) return { ok: false, reason: 'no_approval' }
      if (approval.decision !== null) return { ok: false, reason: 'no_approval' }
      /**
       * THE ONE THAT ASKED MAY NOT BE THE ONE THAT SAYS YES.
       *
       * Only APPROVE is refused this way. Approve is the decision that GRANTS,
       * and it is the only one worth stealing; denying your own request costs
       * the asker their own pending and nobody else anything.
       *
       * BOTH HALVES OF "WHO", because a session and a device are not the same
       * thing and either alone leaves a case. The jti is the literal rule —
       * this sitting may not answer itself — and the device is the ceremony's
       * meaning: "ask my OTHER device" is a promise about a second screen, and
       * a second sitting on the same Mac is not one.
       *
       * ANSWERED BEFORE THE NUMBER IS CHECKED, so a client answering from the
       * wrong place does not spend one of the owner's three tries. The honest
       * limit: this stops ONE stolen session, which is the threat the gate was
       * built for. Two sessions on two devices of one account is an account
       * already lost, and no ladder on this ceremony can help there.
       */
      if (decision === 'approve' && pending.opener !== undefined && by !== undefined) {
        if (by.jti === pending.opener.jti || by.device === pending.opener.device) {
          return { ok: false, reason: 'self_approval' }
        }
      }
      if (decision === 'approve' && (typeof match !== 'string' || match !== pending.match)) {
        // A MISSING NUMBER IS A WRONG NUMBER. A client that cannot send one is
        // not a client that may approve without one; letting it through would
        // be the toggle this rule does not have.
        const misses = pending.matchMisses + 1
        const triesLeft = Math.max(0, MATCH_TRIES - misses)
        // The last miss ENDS the sign-in rather than merely refusing it. The
        // person at the keyboard can always type their password again; the
        // stranger who was nagging cannot start the count over.
        if (triesLeft === 0) this.pendings.delete(pending.id)
        else this.pendings.set(pending.id, { ...pending, matchMisses: misses })
        return { ok: false, reason: 'bad_match', triesLeft }
      }
      const answered: Approval = { ...approval, decision }
      this.pendings.set(pending.id, { ...pending, approval: answered })
      return { ok: true, approval: answered }
    }
    return { ok: false, reason: 'no_approval' }
  }

  private sweep(at: number): void {
    for (const [id, pending] of this.pendings) {
      if (at >= pending.expiresAt) this.pendings.delete(id)
    }
  }
}
