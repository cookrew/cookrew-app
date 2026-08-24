/**
 * THE CALLER'S HALF OF THE GATE — the client nobody had written.
 *
 * Everything in this codebase about remote calls was the SERVING side. There
 * was no client, and the cost of that is measured: Magpie's journey audit spent
 * ~140 lines of hand-written crypto to make one call, and ranked the missing
 * author/caller journey above a 1.4-second lag as the reason to give up. The
 * remote teammate card cannot exist without this, and neither can anybody
 * evaluating the product from the outside.
 *
 * WHAT A CALLER ACTUALLY NEEDS, and why this type exists. The ceremony signs
 *
 *     cookrew-call/1\n{workspaceId}\n{sub}\n{challenge}
 *
 * and only TWO of those are obtainable from the wire. The challenge arrives in
 * the 401; the slug is the realm. `workspaceId` is resolved server-side from
 * the slug and is never sent — so a caller that has been given only a URL
 * cannot complete the ceremony, no matter how correct its crypto is. It has to
 * arrive out of band, alongside the enrolment that the owner performs by hand
 * anyway.
 *
 * That is not a defect to route around here, it is a fact to name: a remote
 * teammate is placed from an INVITE, and this type is that invite's payload.
 * Anything less than these five fields is not enough to call, and a chip that
 * carries four of them is a chip that fails at the ceremony with a 401 nobody
 * can debug.
 */

import { remoteRefusalBucket, type RemoteRefusal } from './marketplace-copy'

/** Everything an owner must hand a caller for the ceremony to be completable. */
export interface RemoteCrew {
  /** Origin of the owner's listener, e.g. https://box.tail1234.ts.net:8643 */
  host: string
  /** The workspace slug — the realm, and the first path segment. */
  slug: string
  /**
   * The workspace id the credential is minted against.
   *
   * NOT DISCOVERABLE FROM THE WIRE — see the header. Signed over, so a wrong
   * value fails the ceremony with the same opaque 401 as a forged signature,
   * which is correct for a stranger and miserable for a legitimate caller.
   */
  workspaceId: string
  /** The subject the owner enrolled. Becomes `sub` in every credential. */
  sub: string
}

/** Sign the assertion payload with the caller's ed25519 private key. */
export type CallSigner = (payload: string) => Promise<string> | string

/** Injected so this module needs no network of its own to be tested. */
export type CallFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>

/**
 * What a caller can DO about an answer. VELVET'S FOUR BUCKETS, not my three.
 *
 * I proposed three and she returned four, correcting me in both directions and
 * the corrections are load-bearing:
 *
 *   401 IS ITS OWN BUCKET. It is retryable, but not by pressing the same
 *   button — it needs a ceremony first. Folded into "busy, try again" it makes
 *   the user hammer a control that cannot work; folded into "you cannot" it
 *   hides a door that is open. I had it in 'denied', which was the second of
 *   those mistakes.
 *
 *   TRANSPORT FAILURE IS A BUCKET. It is not among the five wire answers, so I
 *   did not have it at all — my client THREW on a network error. The card will
 *   meet it more often than some of the real refusals, and "unreachable" is
 *   emphatically not "refused": one is our problem, the other is a decision
 *   about the caller.
 *
 * And 402, which is neither. Under R28 a payment step lights in the same gate
 * sheet, so it is surfaced distinctly rather than bucketed — see the note on
 * `outcomeOf`.
 */
export type CallOutcomeKind = 'ok' | 'payment' | RemoteRefusal

export interface CallOutcome {
  kind: CallOutcomeKind
  /** The agent's reply. Present only on 'ok'. */
  text?: string
  /** Conversation id, so the next ask continues rather than forking again. */
  conversation?: string
  /** The version this conversation was cut at. */
  version?: number
  /** Machine-readable reason from the wire, for the card's wording. */
  reason?: string
  /** The wire status, kept for diagnosis — never shown raw to a person. */
  status?: number
  /**
   * A FRESH credential was minted and the answer was still 401.
   *
   * The bucket stays 'identity' because that is what Velvet's function says
   * about a 401 and her vocabulary is authoritative — but the card must not
   * offer USE PASSKEY a third time. Two completed ceremonies have already been
   * refused, so the door her split exists to keep visible is demonstrably not
   * open, and a passkey button here is the loop the split was meant to prevent.
   *
   * Reported to her as a gap: a 401 that survives a fresh ceremony has no
   * string. Until it does the card shows her identity line without the action.
   */
  retried?: boolean
}

/**
 * Map a wire answer onto what the caller can do about it.
 *
 * DELEGATES TO VELVET'S remoteRefusalBucket rather than restating it. Her
 * mechanism argument is the whole point and a second copy would defeat it:
 * 403 scope, 403 entitlement, 403 revoked and 404 all render ONE string, word
 * for word, and that shared string is what makes an unexported agent and a
 * nonexistent one indistinguishable. "Vagueness achieved by bucketing survives
 * a refactor; vagueness achieved by two similar sentences does not." A private
 * mapping here would be exactly the second similar sentence.
 *
 * 402 IS HANDLED BEFORE HER FUNCTION, and reported to her as a gap. Her
 * bucketing falls 402 through to 'unreachable' — "couldn't reach it, your
 * access is fine, the connection isn't" — which is wrong in a way that matters:
 * payment required is a decision about the caller and the connection is
 * perfect. Under R28 it lights a step in the same gate sheet, so the client
 * surfaces it distinctly and lets the sheet decide.
 */
export function outcomeOf(status: number, reason?: string): CallOutcomeKind {
  if (status === 200) return 'ok'
  if (status === 402) return 'payment'
  return remoteRefusalBucket(status, reason)
}

const json = async (
  response: Awaited<ReturnType<CallFetch>>
): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await response.text()) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Pull the nonce out of `Cookrew realm="slug", challenge=abc`. */
export function challengeFromHeader(header: string | null): string | null {
  if (!header) return null
  const match = header.match(/challenge=([A-Za-z0-9_-]+)/)
  return match ? match[1] : null
}

/** The payload the owner's ceremony verifies. Must match call-ceremony.ts. */
export function assertionPayload(workspaceId: string, sub: string, challenge: string): string {
  return `cookrew-call/1\n${workspaceId}\n${sub}\n${challenge}`
}

export interface CallClientDeps {
  fetch: CallFetch
  sign: CallSigner
}

/**
 * A caller that holds one credential and knows how to get another.
 *
 * THE TOKEN IS CACHED AND RE-MINTED ON 401, ONCE. Tokens live an hour, so a
 * long conversation will outlive one, and a client that re-ceremonied on every
 * ask would spend a signature per turn. Once, not in a loop: if a fresh token
 * is also refused, the problem is not staleness — it is that this caller may
 * not call — and retrying would be the 403 loop the gate's own vocabulary
 * exists to prevent.
 */
export class CallClient {
  private token: string | null = null

  constructor(
    private readonly crew: RemoteCrew,
    private readonly deps: CallClientDeps
  ) {}

  /** Drop the held credential — e.g. after the owner revoked us. */
  forget(): void {
    this.token = null
  }

  /**
   * One fetch that cannot throw. `null` means the gate never answered.
   *
   * Shared by the ceremony and the ask deliberately: a tunnel that drops during
   * the ceremony and one that drops during the call are the same fact to the
   * user, and a client that caught only one of them would report the other as a
   * refusal — telling somebody their access was taken away when the network
   * simply blinked.
   */
  private async reach(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ): Promise<Awaited<ReturnType<CallFetch>> | null> {
    try {
      return await this.deps.fetch(url, init)
    } catch {
      return null
    }
  }

  /**
   * Complete the ceremony and hold the credential.
   *
   * The challenge comes from the dedicated endpoint rather than by provoking a
   * 401, so obtaining one costs no failed call and leaves no refused request
   * in the owner's log for something that was never an attempt.
   */
  private async ceremony(): Promise<string | null | 'unreachable'> {
    const base = `${this.crew.host.replace(/\/+$/, '')}/${this.crew.slug}`
    const challenged = await this.reach(`${base}/api/call/challenge`, {
      method: 'POST',
      headers: { accept: 'application/json' }
    })
    if (challenged === null) return 'unreachable'
    if (challenged.status !== 200) return null
    const challenge = (await json(challenged)).challenge
    if (typeof challenge !== 'string' || challenge.length === 0) return null

    const signature = await this.deps.sign(
      assertionPayload(this.crew.workspaceId, this.crew.sub, challenge)
    )
    const asserted = await this.reach(`${base}/api/call/assert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: this.crew.sub, challenge, signature })
    })
    if (asserted === null) return 'unreachable'
    if (asserted.status !== 200) return null
    const token = (await json(asserted)).token
    return typeof token === 'string' && token.length > 0 ? token : null
  }

  /**
   * Ask one agent one thing.
   *
   * `conversation` continues an existing thread. Carrying it is what makes a
   * second ask cost no new fork — the reply hands one back, and a client that
   * drops it gets a fresh version cut per turn.
   */
  async ask(
    agent: string,
    text: string,
    conversation?: string
  ): Promise<CallOutcome> {
    const attempt = async (token: string | null): Promise<CallOutcome> => {
      const base = `${this.crew.host.replace(/\/+$/, '')}/${this.crew.slug}`
      const response = await this.reach(`${base}/agents/${encodeURIComponent(agent)}/ask`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ text, ...(conversation ? { conversation } : {}) })
      })
      // THE BUCKET THIS CLIENT DID NOT HAVE. A DNS failure, a dropped tunnel, a
      // listener that is not running: the gate never answered, so this is not a
      // decision about the caller and must not read like one. Left uncaught it
      // threw out of ask() and took the card with it.
      if (response === null) return { kind: 'unreachable' }
      const body = await json(response)
      const kind = outcomeOf(response.status, body.reason as string | undefined)
      if (kind === 'ok') {
        return {
          kind,
          text: typeof body.reply === 'string' ? body.reply : '',
          conversation: typeof body.conversation === 'string' ? body.conversation : undefined,
          version: typeof body.version === 'number' ? body.version : undefined,
          status: response.status
        }
      }
      return {
        kind,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        status: response.status
      }
    }

    if (this.token === null) {
      const minted = await this.ceremony()
      if (minted === 'unreachable') return { kind: 'unreachable' }
      this.token = minted
      // A ceremony that could not complete is a call that will not be served.
      // Making it anyway costs the owner a refused request in their log for
      // something that was never an attempt — the same reason the challenge
      // comes from its own endpoint rather than by provoking a 401.
      // 'identity', not a flat refusal: a ceremony that did not complete is a
      // door that may well be open, and telling the user they cannot call is
      // the mistake Velvet split this bucket out to prevent.
      if (this.token === null) return { kind: 'identity', status: 401 }
    }
    let outcome = await attempt(this.token)

    // ONCE. See the class note: a fresh token that is also refused means this
    // caller may not call, and retrying is the loop 403 exists to prevent.
    if (outcome.status === 401) {
      const reminted = await this.ceremony()
      if (reminted === 'unreachable') return { kind: 'unreachable' }
      this.token = reminted
      // 'identity', not a flat refusal: a ceremony that did not complete is a
      // door that may well be open, and telling the user they cannot call is
      // the mistake Velvet split this bucket out to prevent.
      if (this.token === null) return { kind: 'identity', status: 401, retried: true }
      outcome = await attempt(this.token)
      // A FRESH credential, still refused. Bucket unchanged — hers is
      // authoritative — but the card must not offer the passkey a third time.
      if (outcome.status === 401) return { ...outcome, retried: true }
    }
    return outcome
  }
}
