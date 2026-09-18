import { randomInt } from 'node:crypto'
import { RECOVERY_ALPHABET, normaliseRecoveryCode } from './v2-secrets'

/**
 * JOINING FROM A DEVICE YOU ALREADY HOLD.
 *
 * A password alone must never attach a device — that is the security model's
 * third line, and it is the whole reason this file exists. Before it, a second
 * Mac could only arrive by typing the password on the NEW machine, which is
 * the one place a phished password is worth the most: whoever has it can walk
 * a machine of their own onto the account.
 *
 * So the authority moves to the side that is already trusted. A signed-in
 * device mints an eight-character code under step-up; the new machine types
 * that code and nothing else. The password is never typed on a machine the
 * account has not met, and a phished password attaches nothing.
 *
 * IN MEMORY, LIKE A PENDING AND UNLIKE A RECOVERY CODE. A recovery code is a
 * fact about an account and lives on disk for months. A join code is a fact
 * about the next ten minutes — somebody is walking to another machine — and a
 * restart ending it is correct: the owner mints another and nothing was lost
 * but a walk. Keeping it on disk would mean a code outliving the moment it was
 * read out, which is the one property it must not have.
 *
 * THE SAME ALPHABET AS A RECOVERY CODE, for the same reason: it is read off
 * one screen and typed on another, so no 0/O and no 1/I/L, and it is compared
 * case-insensitively without its dash because people retype what they see.
 */

/** Ten minutes — a walk to the other machine, not an afternoon. */
export const JOIN_CODE_TTL_MS = 10 * 60 * 1000
/**
 * More codes than a registry has accounts walking between machines at once.
 * A bound on a map a signed-in caller can grow, for the same reason the
 * pendings have one; the per-account limiter is the real ceiling.
 */
const JOIN_CODES_MAX = 1000

export interface JoinCode {
  /** The code as it is shown: two blocks of four, dashed. */
  code: string
  username: string
  at: number
  expiresAt: number
}

/**
 * The live codes, keyed by their normalised form.
 *
 * ONE LIVE PER ACCOUNT. Minting replaces rather than adds, so an owner who
 * pressed ADD A MAC twice has one code and not two — the second screen is the
 * only one that works, which is the one they are looking at. Two live codes
 * would also be two chances for a shoulder-surfed screen to still be good.
 */
export class JoinCodes {
  private readonly now: () => number
  private readonly ttlMs: number
  private codes = new Map<string, JoinCode>()

  constructor(now: () => number = Date.now, ttlMs = JOIN_CODE_TTL_MS) {
    this.now = now
    this.ttlMs = ttlMs
  }

  /** Mint one for this account, retiring whatever it had. */
  mint(username: string): JoinCode {
    const at = this.now()
    this.sweep(at)
    for (const [key, held] of this.codes) {
      if (held.username === username) this.codes.delete(key)
    }
    if (this.codes.size >= JOIN_CODES_MAX) {
      const oldest = [...this.codes.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) this.codes.delete(oldest[0])
    }
    const block = (): string =>
      Array.from({ length: 4 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('')
    const code = `${block()}-${block()}`
    const minted: JoinCode = { code, username, at, expiresAt: at + this.ttlMs }
    this.codes.set(normaliseRecoveryCode(code), minted)
    return minted
  }

  /**
   * Spend one: the account it belongs to, or null.
   *
   * THE CODE IS DEAD WHATEVER HAPPENS NEXT. It is removed here, before the
   * caller has looked at the device on the request, so a code that was read
   * out cannot be tried again with a better-formed body. That is the same
   * order `useRecoveryCode` is spent in, and for the same reason.
   */
  redeem(code: unknown): string | null {
    if (typeof code !== 'string') return null
    const at = this.now()
    this.sweep(at)
    const key = normaliseRecoveryCode(code)
    if (key === '') return null
    const held = this.codes.get(key)
    if (held === undefined) return null
    this.codes.delete(key)
    return held.username
  }

  /** The live code for this account, or null — for a sheet that reopened. */
  liveFor(username: string): JoinCode | null {
    this.sweep(this.now())
    return [...this.codes.values()].find((held) => held.username === username) ?? null
  }

  private sweep(at: number): void {
    for (const [key, held] of this.codes) {
      if (at >= held.expiresAt) this.codes.delete(key)
    }
  }
}


/**
 * A LEAF MODULE, imported by the assembly in v2-http and by the routes in
 * v2-join. It knows nothing about HTTP, which is what keeps the store out of
 * the import cycle those two would otherwise form.
 */
