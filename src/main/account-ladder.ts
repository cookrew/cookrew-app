import {
  ladderIsOver,
  type AccountResult,
  type ApprovalAsked,
  type LadderFactor,
  type SecondFactorStep,
  type SignInAnswer,
} from '../shared/account-v2'
import { bodyOf, classify, plainRefusal, wireError } from './account-wire'
import type { AccountSession } from './account-v2'

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

// ── climbing, over the wire ────────────────────────────────────────────────

/**
 * WHAT A RUNG NEEDS FROM THE ACCOUNT, and nothing else.
 *
 * The rungs are here rather than as four more methods on `Accounts` because
 * that class is already the longest file in main and because none of this
 * touches the account FILE except through `land` — which is the one thing a
 * rung must not do twice or differently. Handing over a port rather than the
 * class also states the surface exactly: a rung reads no token, lists no
 * device and writes nothing.
 */
export interface LadderPort {
  http: (input: string, init?: RequestInit) => Promise<Response>
  origin: string
  now: () => number
  /** The passwords of the sign-ins half done on this Mac. */
  passwords: LadderPasswords
  /** Write the session and re-derive the unlock verifier. One place, always. */
  land: (password: string, body: Record<string, unknown>) => SignInAnswer<AccountSession>
}

/**
 * A rung that is typed: the authenticator's six digits, or a rescue code.
 *
 * ONE FUNCTION FOR BOTH because the wire is the same shape — `POST
 * /v2/sessions/:pending/{totp|recovery}` with `{code}` — and the difference is
 * entirely copy, which belongs to the card. A wrong code comes back `bad_code`
 * or `bad_recovery` and the ladder STAYS OPEN: the registry allows five tries
 * on a pending, and a card that closed on the first fat-fingered digit would
 * spend the other four on nothing.
 */
export async function climbTyped(
  port: LadderPort,
  pending: string,
  factor: TypedFactor,
  code: string,
): Promise<SignInAnswer<AccountSession>> {
  const password = port.passwords.for(pending)
  // No password for this pending means the ladder outlived its ten minutes (or
  // main restarted under it). Either way the honest answer is the password
  // step — NOT a rung that could land a session this app would then be unable
  // to unlock itself with.
  if (password === null) return { ok: false, reason: 'expired' }
  const answer = await climbOne(port, pending, password, () =>
    port.http(`${port.origin}/v2/sessions/${encodeURIComponent(pending)}/${factor}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    }),
  )
  // 'waiting' is the POLL's 202 and a typed rung never sends one; this narrows
  // the shared return rather than branching on something no request from here
  // can produce.
  return answer === 'waiting' ? { ok: false, reason: 'unknown' } : answer
}

/**
 * Ask the account's other devices to approve this sign-in (the D6 prompt).
 *
 * Answers the registry's own sentence, unchanged: it names the asking device
 * and the address it is asking from, and this Mac is not the party that knows
 * those. Asking twice does not raise two prompts — the registry holds one
 * approval per pending.
 */
export async function askForApproval(
  port: LadderPort,
  pending: string,
): Promise<AccountResult<ApprovalAsked>> {
  if (port.passwords.for(pending) === null) return { ok: false, reason: 'expired' }
  let response: Response
  try {
    response = await port.http(
      `${port.origin}/v2/sessions/${encodeURIComponent(pending)}/approve`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
  } catch {
    return { ok: false, reason: 'offline' }
  }
  if (response.status !== 202) {
    const refused = await wireError(response)
    if (ladderIsOver(refused.reason)) port.passwords.forget(pending)
    return { ok: false, ...refused }
  }
  const asked = askedFrom(await bodyOf(response))
  return asked === null ? { ok: false, reason: 'unknown' } : { ok: true, value: asked }
}

/**
 * WAIT FOR THE NOD — poll until the other device answers, or time runs out.
 *
 * Two seconds, the same interval cookrew.dev's own waiting screen uses, and
 * BOUNDED: it stops at the pending's own expiry, so a card somebody walked
 * away from cannot leave a request looping in main forever. Polling is not
 * guessing and the registry does not count it against the five tries.
 *
 * A single long-running call rather than "ask me again in two seconds" because
 * the thing being waited on is one event with one answer; a renderer that
 * unmounts simply drops the promise, and the poll ends at the deadline.
 */
export async function waitForApproval(
  port: LadderPort,
  pending: string,
  options: { everyMs?: number; forMs?: number } = {},
): Promise<SignInAnswer<AccountSession>> {
  const password = port.passwords.for(pending)
  if (password === null) return { ok: false, reason: 'expired' }
  const everyMs = options.everyMs ?? APPROVAL_POLL_MS
  const until = port.now() + Math.min(options.forMs ?? LADDER_TTL_MS, LADDER_TTL_MS)
  for (;;) {
    const answer = await climbOne(
      port,
      pending,
      password,
      () => port.http(`${port.origin}/v2/sessions/${encodeURIComponent(pending)}`, { method: 'GET' }),
      // 202 is "still waiting", which is neither a session nor a refusal.
      202,
    )
    if (answer !== 'waiting') return answer
    if (port.now() + everyMs >= until) return { ok: false, reason: 'expired' }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

/**
 * One rung, sent and read: a session, a refusal, or (polling only) waiting.
 *
 * THE PASSWORD IS FORGOTTEN ON EVERY ENDING, success or otherwise, and that is
 * the point of routing all three rungs through here. A ladder that ended while
 * its password stayed in the map would be a secret kept for a conversation
 * nobody can finish.
 */
async function climbOne(
  port: LadderPort,
  pending: string,
  password: string,
  send: () => Promise<Response>,
  waitingStatus = -1,
): Promise<SignInAnswer<AccountSession> | 'waiting'> {
  let response: Response
  try {
    response = await send()
  } catch {
    // Not the end of the ladder: a Wi-Fi that dropped for one request is a
    // retry, and the pending is still standing at the registry.
    return { ok: false, reason: 'offline' }
  }
  if (response.status === waitingStatus) return 'waiting'
  if (response.status === 429) return { ok: false, reason: 'rate_limited' }
  const body = await bodyOf(response)
  if (response.status === 201) {
    port.passwords.forget(pending)
    return port.land(password, body)
  }
  const refused = classify(response.status, body)
  if (ladderIsOver(refused.reason)) port.passwords.forget(pending)
  return plainRefusal(refused)
}
