import type { LadderFactor, SecondFactorStep } from '../shared/account-v2'

/**
 * THE SECOND-FACTOR LADDER, MAIN'S HALF — and the one thing it has to hold.
 *
 * cookrew.dev answers a password with 401 `second_factor` and a pending id.
 * Every rung after that (six digits, a rescue code, a nod from the phone) is
 * addressed to the pending and carries no password at all. But the moment a
 * rung lands a session, the app has to RE-DERIVE the offline unlock verifier
 * from the password that opened it — otherwise the commonest arrival here (a
 * password changed on the web) leaves the file holding the old one and no
 * password opens both halves of the app.
 *
 * So the password has to survive the ladder. WHERE IT SURVIVES IS THE WHOLE
 * DESIGN DECISION, and it is this: in main, in memory, keyed by the pending id
 * the registry minted, for no longer than the pending itself lives.
 *
 * The alternative was to keep it in the renderer and pass it back down with
 * every rung. That was rejected for three reasons, in order of weight:
 *
 *   1. The approve rung POLLS FOR UP TO TEN MINUTES. A renderer holding the
 *      password would hold it in React state across that whole wait, in the
 *      process that also renders browser cards and pages the owner merely
 *      browsed to.
 *   2. It would put the password on the IPC bridge once per rung instead of
 *      once per sign-in, for no gain.
 *   3. The rule this codebase already keeps (account-ipc.ts) is that secrets
 *      stay in main. A password that goes down and comes back up is a secret
 *      the renderer is now the custodian of.
 *
 * NOTHING HERE IS WRITTEN, LOGGED OR ENUMERATED. The map is swept on every
 * touch, dropped the instant a ladder ends either way, and its values never
 * leave this file except as the argument to the verifier that consumes them.
 */

/**
 * Ten minutes — the registry's own PENDING_TTL_MS (v2-pending.ts).
 *
 * Deliberately not longer: a password held past the life of the pending it
 * belongs to is a secret kept for a conversation that cannot be finished.
 */
export const LADDER_TTL_MS = 10 * 60 * 1000

/** More ladders at once than one Mac's owner can be climbing. */
const LADDERS_MAX = 8

/**
 * The passwords of the sign-ins currently half done on this Mac.
 *
 * A class rather than a module-level map so a test can hold its own, and so
 * two Accounts over two temp homes never share one.
 */
export class LadderPasswords {
  private readonly now: () => number
  private readonly ttlMs: number
  private held = new Map<string, { password: string; at: number }>()

  constructor(now: () => number = Date.now, ttlMs = LADDER_TTL_MS) {
    this.now = now
    this.ttlMs = ttlMs
  }

  /** Pair a password with the pending the registry just opened for it. */
  remember(pending: string, password: string): void {
    const at = this.now()
    this.sweep(at)
    // Bounded as well as timed. A caller that could open pendings faster than
    // they expire would otherwise grow this map without limit; the oldest goes
    // first, which is the one whose ladder is nearest its own expiry anyway.
    while (this.held.size >= LADDERS_MAX) {
      const oldest = [...this.held.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!oldest) break
      this.held.delete(oldest[0])
    }
    this.held.set(pending, { password, at })
  }

  /**
   * The password for this pending, or null — expired reads as gone.
   *
   * Null is not an error to report as a bug: it is a ladder that outlived its
   * ten minutes, and the honest answer to it is the password step again.
   */
  for(pending: string): string | null {
    const at = this.now()
    this.sweep(at)
    return this.held.get(pending)?.password ?? null
  }

  /** This ladder is over, however it ended. */
  forget(pending: string): void {
    this.held.delete(pending)
  }

  /** How many are in flight. For tests and for nothing else. */
  get size(): number {
    this.sweep(this.now())
    return this.held.size
  }

  private sweep(at: number): void {
    for (const [pending, entry] of this.held) {
      if (at - entry.at >= this.ttlMs) this.held.delete(pending)
    }
  }
}

const FACTORS: readonly LadderFactor[] = ['passkey', 'totp', 'approve', 'recovery']

/**
 * The 401 body as a step, or null.
 *
 * IT IS A STRANGER'S JSON until it has been through here — a registry that
 * answered `next: ['sudo']` must not put a rung on the card that nothing can
 * climb. Unknown names are dropped rather than refused, so a registry newer
 * than this app still offers the rungs this app understands.
 */
export function stepFrom(body: unknown): SecondFactorStep | null {
  if (typeof body !== 'object' || body === null) return null
  const held = body as { pending?: unknown; next?: unknown; expiresAt?: unknown }
  if (typeof held.pending !== 'string' || held.pending === '') return null
  const next = Array.isArray(held.next)
    ? held.next.filter((name): name is LadderFactor => FACTORS.includes(name as LadderFactor))
    : []
  if (next.length === 0) return null
  return {
    pending: held.pending,
    next,
    // A registry that sent no expiry still gets a countdown, from the TTL the
    // contract states — a card with no clock on it cannot say "start again".
    expiresAt: typeof held.expiresAt === 'number' ? held.expiresAt : Date.now() + LADDER_TTL_MS,
  }
}

/** Two seconds, the interval the site's own waiting screen polls on. */
export const APPROVAL_POLL_MS = 2_000

/**
 * The 202 an approval request answers with, or null.
 *
 * The sentence is the registry's, carried rather than re-worded: it names the
 * device and the address, and the desktop is not the party that knows those.
 */
export function askedFrom(body: unknown): { approval: string; expiresAt: number; sentence: string } | null {
  if (typeof body !== 'object' || body === null) return null
  const held = body as { approval?: unknown; expiresAt?: unknown; sentence?: unknown }
  if (typeof held.approval !== 'string' || held.approval === '') return null
  return {
    approval: held.approval,
    expiresAt: typeof held.expiresAt === 'number' ? held.expiresAt : Date.now() + LADDER_TTL_MS,
    sentence: typeof held.sentence === 'string' ? held.sentence : '',
  }
}

/** A rung the desktop can actually climb — see `resumeWithCode`. */
export type TypedFactor = 'totp' | 'recovery'

export const isTypedFactor = (value: unknown): value is TypedFactor =>
  value === 'totp' || value === 'recovery'
