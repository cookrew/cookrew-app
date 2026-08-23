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
 * The three things a caller can DO about a refusal (question 3 to Velvet).
 *
 * Five wire answers collapse to three actions, and the collapse is the point:
 * 'wait' is retryable and 'denied' must never be retried — a client that
 * retries a 403 loops forever against a door that will not open. 'broken' is
 * ours to fix, not theirs.
 */
export type CallOutcomeKind = 'ok' | 'wait' | 'denied' | 'broken'

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
}

/**
 * Map a wire answer onto what the caller can do about it.
 *
 * 404 IS DELIBERATELY INDISTINCT and must stay that way. An agent that exists
 * but is not exported and a name that never existed are ONE answer, because
 * telling them apart lets a stranger map the room. So it lands in 'denied'
 * with no elaboration rather than in a "not found, try another name" branch
 * that would invite exactly that probing.
 */
export function outcomeOf(status: number, reason?: string): CallOutcomeKind {
  if (status === 200) return 'ok'
  // 409 is the only retryable refusal: busy, not_ready, not_running all mean
  // NOT NOW. Everything else that refuses means stop.
  if (status === 409) return 'wait'
  if (status === 401 || status === 403 || status === 404) return 'denied'
  if (status === 402) return 'denied'
  return 'broken'
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
   * Complete the ceremony and hold the credential.
   *
   * The challenge comes from the dedicated endpoint rather than by provoking a
   * 401, so obtaining one costs no failed call and leaves no refused request
   * in the owner's log for something that was never an attempt.
   */
  private async ceremony(): Promise<string | null> {
    const base = `${this.crew.host.replace(/\/+$/, '')}/${this.crew.slug}`
    const challenged = await this.deps.fetch(`${base}/api/call/challenge`, {
      method: 'POST',
      headers: { accept: 'application/json' }
    })
    if (challenged.status !== 200) return null
    const challenge = (await json(challenged)).challenge
    if (typeof challenge !== 'string' || challenge.length === 0) return null

    const signature = await this.deps.sign(
      assertionPayload(this.crew.workspaceId, this.crew.sub, challenge)
    )
    const asserted = await this.deps.fetch(`${base}/api/call/assert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: this.crew.sub, challenge, signature })
    })
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
      const response = await this.deps.fetch(
        `${base}/agents/${encodeURIComponent(agent)}/ask`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ text, ...(conversation ? { conversation } : {}) })
        }
      )
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
      this.token = await this.ceremony()
      // A ceremony that could not complete is a call that will not be served.
      // Making it anyway costs the owner a refused request in their log for
      // something that was never an attempt — the same reason the challenge
      // comes from its own endpoint rather than by provoking a 401.
      if (this.token === null) return { kind: 'denied', status: 401 }
    }
    let outcome = await attempt(this.token)

    // ONCE. See the class note: a fresh token that is also refused means this
    // caller may not call, and retrying is the loop 403 exists to prevent.
    if (outcome.status === 401) {
      this.token = await this.ceremony()
      if (this.token === null) return { kind: 'denied', status: 401 }
      outcome = await attempt(this.token)
    }
    return outcome
  }
}
