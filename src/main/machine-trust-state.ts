/**
 * DOES THE ACCOUNT TRUST THIS MACHINE, as far as this machine knows.
 *
 * The registry decides, and it decides at the sign-in: a desktop signed in
 * with a password, a passkey or the authenticator made on it is a machine of
 * the account from then (registry · startSession). One signed in by a
 * provider alone, or a code, is not until it makes that proof once.
 *
 * THREE ANSWERS, AND THE THIRD IS "NOT ASKED". This machine used to learn its
 * standing only as a side effect of collecting a key for ANOTHER machine, a
 * round that asks nothing while no other machine is online. So a Mac whose
 * only other machine was off never asked, read "no marker" as "not trusted",
 * and told its owner, three minutes after a password sign-in, to sign in
 * again (owner 2026-11-11). Now:
 *
 *   trusted      the marker is there: the registry said yes
 *   needs-proof  the registry said `proof_required` to THIS sign-in
 *   unknown      it has not answered for this sign-in. Nothing is said.
 *
 * It asks for itself, once per sign-in, whoever else is or is not online. The
 * question is the machine grant with no proof in it: a trusted machine is
 * handed one, an unproved one is told what is missing, and neither costs a
 * try at anything. An answer that is neither leaves it unknown, to be asked
 * again later and not in a loop.
 */

export type MachineTrust = 'trusted' | 'needs-proof' | 'unknown'

export interface MachineTrustDeps {
  /** Present once the registry has taken this machine's proof (~/.cookrew/machine-trusted). */
  readonly marker: { exists(): boolean; write(): void; remove(): void }
  /** The machine grant, asked with no proof: the status and the error word, or null when it could not be asked. */
  ask(): Promise<{ status: number; error?: string } | null>
  /** The sign-in on this machine, as a word that changes when it does; null when signed out. */
  who(): string | null
  now?(): number
}

export interface MachineTrustStore {
  /** The sign-in on this machine now (deps.who): what an ask made elsewhere says it asked about. */
  who(): string | null
  state(): MachineTrust
  /** Ask the registry if this sign-in has not been answered for. `now` skips the wait between asks (the proof was just given). */
  learn(options?: { now?: boolean }): Promise<MachineTrust>
  /**
   * What the registry answered to a grant asked elsewhere (the key round, the password at the lock), and the
   * sign-in it was asked for: an answer that arrives after another person signed in is not theirs.
   */
  heard(status: number, error?: string, askedFor?: string | null): void
}

/** An ask that got no verdict is not repeated sooner than this. */
export const TRUST_ASK_EVERY_MS = 60_000

export function createMachineTrust(deps: MachineTrustDeps): MachineTrustStore {
  const now = deps.now ?? Date.now
  /** The sign-in the registry has answered for, and the one it asked a proof of. */
  let answeredFor: string | null = null
  let refusedFor: string | null = null
  /** When it last asked, and about which sign-in: the wait is between asks about the SAME one. */
  let askedAt = Number.NEGATIVE_INFINITY
  let askedFor: string | null = null
  let asking: Promise<void> | null = null
  let askingFor: string | null = null

  const state = (): MachineTrust => {
    const who = deps.who()
    if (who === null) return 'unknown'
    if (refusedFor === who) return 'needs-proof'
    return deps.marker.exists() ? 'trusted' : 'unknown'
  }

  const heard = (status: number, error?: string, asked?: string | null): void => {
    const who = deps.who()
    if (who === null || (asked !== undefined && asked !== who)) return
    if (status === 201) {
      if (!deps.marker.exists()) deps.marker.write()
      answeredFor = who
      refusedFor = null
    } else if (status === 401 && error === 'proof_required') {
      deps.marker.remove()
      answeredFor = who
      refusedFor = who
    }
  }

  const learn = async (options: { now?: boolean } = {}): Promise<MachineTrust> => {
    const who = deps.who()
    if (who === null) return 'unknown'
    const settled = answeredFor === who && options.now !== true
    const rested = options.now === true || askedFor !== who || now() - askedAt >= TRUST_ASK_EVERY_MS
    if (!settled && (rested || asking !== null)) {
      // An ask still out for ANOTHER sign-in answers nothing about this one: waited out, then asked again.
      if (asking !== null && askingFor !== who) await asking
      if (asking === null) {
        askingFor = who
        asking = (async () => {
          askedAt = now()
          askedFor = who
          const answer = await deps.ask().catch(() => null)
          if (answer !== null) heard(answer.status, answer.error, who)
        })().finally(() => {
          asking = null
          askingFor = null
        })
      }
      await asking
    }
    return state()
  }

  return { who: () => deps.who(), state, learn, heard }
}
