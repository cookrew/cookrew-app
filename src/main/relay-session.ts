import { dialRelay, type RelayDial } from './relay-dial'
import { registryAccount } from './registry-account'

/**
 * JOINING A RELAY — the whole ceremony, in one call.
 *
 * Enrol if this registry has never met us, climb the 401, spend the challenge,
 * take the ticket, hold the line open. Every step here already existed
 * somewhere; what did not exist was one place that does them in order, and
 * without that the app would have grown its own half-version at each call site.
 *
 * The ticket is short-lived and is never returned to the caller — it goes
 * straight into the dial. A ticket that reached a card, a log or a stored
 * command would be a credential for someone else's door.
 */

export interface JoinRelayOptions {
  /** The registry, e.g. https://cookrew.dev */
  origin: string
  /** The owner's handle at that registry. */
  handle: string
  /** The team's url-safe name. Together: @handle/team. */
  team: string
  /**
   * WHICH MAC IS CLAIMING (V3-18) — this device's id on the account, and the
   * name a person would recognise it by.
   *
   * Absent for a Mac that is on no Cookrew account, and then the relay keeps
   * today's behaviour exactly: a name already held is refused rather than
   * taken over. That is the honest default — the rule is "one name, one holder
   * ACROSS AN ACCOUNT", and a machine on no account has no other Mac to take a
   * door from.
   *
   * `session` is the account's own token, and it is WHAT LETS A SECOND MAC
   * SERVE AT ALL. The v1 ceremony below proves the handle with a key each
   * machine mints for itself, so the second Mac of an account enrols a
   * different key under the same credential id and is refused
   * `credential_exists` — for ever, on every attempt. A session proves the
   * same username without a second key existing.
   */
  as?: { deviceId: string; name: string; session?: string }
  log?: (message: string) => void
}

export type JoinRefusal =
  | 'unreachable'
  | 'unidentified'
  | 'not-yours'
  | 'name-taken'
  | 'no-relay'

export async function joinRelay(
  options: JoinRelayOptions
): Promise<{ ok: true; dial: RelayDial; name: string } | { ok: false; reason: JoinRefusal }> {
  const name = `@${options.handle}/${options.team}`
  const account = registryAccount(options.origin, options.handle)
  // The machine's own description rides on every attempt, including the
  // unauthenticated first one: the relay files it with the ticket, and a
  // ticket is only ever minted for an assertion that already proved @handle.
  const who = options.as === undefined ? {} : { as: options.as.name, deviceId: options.as.deviceId }
  const session = options.as?.session
  const ask = async (assertion?: unknown): Promise<Response> =>
    fetch(new URL('/v1/relay/ticket', options.origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The account's own word for who is asking, when this Mac has one. A
        // registry that has not been taught it ignores the header and the
        // ceremony below runs exactly as it always has.
        ...(session === undefined ? {} : { authorization: `Bearer ${session}` })
      },
      body: JSON.stringify(assertion === undefined ? { name, ...who } : { name, assertion, ...who })
    })

  let ticket: string
  try {
    // Round one asks for nothing and expects to be refused: the challenge only
    // exists because we were told to prove something.
    const challenged = await ask()
    if (challenged.status === 404) return { ok: false, reason: 'no-relay' }
    const offered = (await challenged.json().catch(() => ({}))) as {
      challenge?: string
      ticket?: string
    }
    // …unless the session already answered it. A Mac signed in as the handle
    // has nothing left to prove, so it never starts a ceremony it does not
    // need — and the second Mac of an account has no other way through.
    if (challenged.ok && offered.ticket) {
      ticket = offered.ticket
      return await hold(options, name, ticket)
    }
    if (!offered.challenge) return { ok: false, reason: 'no-relay' }

    let answered = await ask(account.assert(offered.challenge))
    if (answered.status === 401) {
      // A registry that has never met this key. Enrol, take a FRESH challenge —
      // the first was spent by the attempt that failed — and go again once.
      const enrolled = await fetch(new URL('/v1/identity/register', options.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(account.enrolment())
      })
      // 409 means the handle is enrolled to a DIFFERENT key — someone else's,
      // or this owner's from a machine whose account file is gone. Retrying
      // would fail forever and read as a broken login, so it is named for what
      // it is: the handle is not this key's to use.
      if (enrolled.status === 409) return { ok: false, reason: 'not-yours' }
      const again = (await (await ask()).json().catch(() => ({}))) as { challenge?: string }
      if (!again.challenge) return { ok: false, reason: 'unidentified' }
      answered = await ask(account.assert(again.challenge))
    }
    if (answered.status === 403) return { ok: false, reason: 'not-yours' }
    if (!answered.ok) return { ok: false, reason: 'unidentified' }
    const body = (await answered.json()) as { ticket?: string }
    if (!body.ticket) return { ok: false, reason: 'unidentified' }
    ticket = body.ticket
  } catch {
    return { ok: false, reason: 'unreachable' }
  }

  return hold(options, name, ticket)
}

/** Dial with a ticket and hold the line. Both proofs above end here. */
async function hold(
  options: JoinRelayOptions,
  name: string,
  ticket: string
): Promise<{ ok: true; dial: RelayDial; name: string } | { ok: false; reason: JoinRefusal }> {
  const dial = dialRelay({ origin: options.origin, ticket, log: options.log })
  try {
    await dial.ready
  } catch {
    dial.close()
    // The one refusal that is not about credentials: somebody else is already
    // holding this name, which for the owner means an older copy of their own
    // app never let go — or, on a Mac that cannot name itself, another of the
    // account's, which is a name it may not take over.
    return { ok: false, reason: 'name-taken' }
  }
  return { ok: true, dial, name }
}
