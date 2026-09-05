import { randomUUID } from 'node:crypto'

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
/** More pending sign-ins than a busy hour has; a stranger cannot spend it. */
const PENDING_MAX = 1000

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
  approval: Approval | null
}

export interface OpenInput {
  username: string
  device: unknown
  deviceName: string
  kind: string
  address: string
  next: readonly Factor[]
}

/** The one sentence D6 shows and the approvals list repeats. */
export const approvalSentence = (deviceName: string, address: string, username: string): string =>
  `${deviceName} at ${address} wants to sign in as @${username}.`

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
      approval: null
    }
    // Bounded by count as well as by time: the oldest goes rather than the
    // process growing a map a stranger decides the size of.
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
   */
  attempt(id: string): Pending | null {
    const held = this.get(id)
    if (held === null) return null
    const next: Pending = { ...held, attempts: held.attempts + 1 }
    if (next.attempts > this.attemptsMax) {
      this.pendings.delete(id)
      return null
    }
    this.pendings.set(id, next)
    return next
  }

  close(id: string): void {
    this.pendings.delete(id)
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
  }

  /** Answer one, on behalf of the account it belongs to. */
  decide(username: string, approvalId: unknown, decision: Decision): Approval | null {
    if (typeof approvalId !== 'string' || approvalId === '') return null
    for (const pending of this.pendings.values()) {
      const approval = pending.approval
      if (approval === null || approval.id !== approvalId) continue
      if (approval.username !== username) return null
      if (this.now() >= pending.expiresAt) return null
      if (approval.decision !== null) return null
      const answered: Approval = { ...approval, decision }
      this.pendings.set(pending.id, { ...pending, approval: answered })
      return answered
    }
    return null
  }

  private sweep(at: number): void {
    for (const [id, pending] of this.pendings) {
      if (at >= pending.expiresAt) this.pendings.delete(id)
    }
  }
}
