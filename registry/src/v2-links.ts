import type { LinkedProvider, ProviderId, VerifiedEmail } from '../../src/shared/oauth'
import type { V2Account, V2Accounts, V2Link } from './v2-accounts'
import type { ProviderProof } from './v2-oauth-providers'

/**
 * WHICH PROVIDER IDENTITIES OPEN WHICH ACCOUNT.
 *
 * Apart from the account store because that file is the longest in the
 * registry, and because this is one question with one rule: AN IDENTITY BELONGS
 * TO ONE ACCOUNT. Nothing here looks an account up by email, because an email
 * match is how one person's account becomes another person's. Linking is
 * something a signed-in owner does on purpose.
 *
 * `email` is here too since it arrives the same way: only from a proof, so
 * "verified" is true by construction and there is no field a person can type.
 * It changes at link time and never at sign-in. A sign-in that stops on the
 * ladder has proved nothing yet, and the address a recovery could one day use
 * must not move on half a proof.
 */

export type LinkRefusal = 'link_taken' | 'link_exists'

export class V2Links {
  private readonly accounts: V2Accounts
  private readonly now: () => number

  constructor(accounts: V2Accounts, now: () => number = Date.now) {
    this.accounts = accounts
    this.now = now
  }

  /** The account this identity opens, or null. */
  ownerOf(provider: ProviderId, subject: string): string | null {
    return this.accounts.findByLink(provider, subject)?.username ?? null
  }

  linkOf(username: string, provider: ProviderId, subject: string): V2Link | null {
    return this.accounts.get(username)?.links?.find((l) => l.provider === provider && l.subject === subject) ?? null
  }

  /**
   * Link an identity to the account a signed-in session already proved.
   *
   * THE SAME IDENTITY AGAIN IS THE WAY BACK FROM A PAUSE: the owner has proved
   * themselves twice over by the time they reach here, so it clears `pausedAt`.
   */
  add(username: string, proof: ProviderProof): { ok: true } | { ok: false; reason: LinkRefusal } {
    const owner = this.ownerOf(proof.provider, proof.subject)
    if (owner !== null && owner !== username) return { ok: false, reason: 'link_taken' }
    const account = this.accounts.get(username)
    if (account === null) return { ok: false, reason: 'link_taken' }
    const links = account.links ?? []
    const held = links.find((l) => l.provider === proof.provider)
    if (held !== undefined && held.subject !== proof.subject) return { ok: false, reason: 'link_exists' }
    const link: V2Link = {
      provider: proof.provider,
      subject: proof.subject,
      login: proof.login,
      linkedAt: held?.linkedAt ?? this.now()
    }
    this.accounts.amend(username, (current) => ({
      ...current,
      links: [...(current.links ?? []).filter((l) => l.provider !== proof.provider), link],
      email: current.email ?? emailFrom(proof, this.now())
    }))
    return { ok: true }
  }

  /** Taken off the account. The caller has already stepped up. */
  remove(username: string, provider: ProviderId): boolean {
    const account = this.accounts.get(username)
    if (!account?.links?.some((l) => l.provider === provider)) return false
    this.accounts.amend(username, (current) => ({
      ...current,
      links: (current.links ?? []).filter((l) => l.provider !== provider)
    }))
    return true
  }

  /**
   * Would this leave the account with no way to start a sign-in?
   *
   * A passkey counts, since it opens the account on its own. Rescue codes do
   * not: they are a way back after losing everything, and an account running on
   * them alone has a number of sign-ins left rather than a way in.
   */
  isLastWayIn(account: V2Account, provider: ProviderId, hasPasskey: boolean): boolean {
    if (account.passwordless !== true || hasPasskey) return false
    return (account.links ?? []).every((l) => l.provider === provider)
  }

  /** "Not me" on a sign-in through this link: it opens nothing until relinked. */
  pause(username: string, provider: ProviderId, subject: string): void {
    this.accounts.amend(username, (current) => ({
      ...current,
      links: (current.links ?? []).map((l) =>
        l.provider === provider && l.subject === subject ? { ...l, pausedAt: this.now() } : l
      )
    }))
  }

  setEmail(username: string, email: VerifiedEmail): void {
    this.accounts.amend(username, (current) => ({ ...current, email }))
  }

}

/** The owner's view of the links. Subjects stay inside the registry. */
export function linkedView(account: V2Account): readonly LinkedProvider[] {
  return (account.links ?? []).map((l) => ({
    provider: l.provider,
    login: l.login,
    linkedAt: l.linkedAt,
    paused: l.pausedAt !== undefined
  }))
}

/** The address a proof carries, stamped. Null when it carries none. */
export function emailFrom(proof: ProviderProof, at: number): VerifiedEmail | null {
  return proof.email === null ? null : { address: proof.email, via: proof.provider, verifiedAt: at }
}
