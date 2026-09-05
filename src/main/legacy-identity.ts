import { existingRegistryAccount, type RegistryAccount } from './registry-account'

/**
 * IDENTITY v2, PHASE 6 — THE MAC THAT WAS ALREADY SOMEBODY.
 *
 * Before accounts, a desktop proved itself with one key per registry
 * (~/.cookrew/registry/<host>.json) under a handle the environment named
 * (COOKREW_HANDLE). Doors are published under that handle right now. This
 * module is how that machine becomes an account without its doors blinking:
 *
 *   · WHICH NAME SERVES is a pure function of three facts, so every state a
 *     real Mac can be in is a row in a table a test can read — including
 *     today's, which must keep answering exactly what it answers now.
 *   · THE CROSSING is the v1 ceremony the app already signs, sent to
 *     /v2/migrate. No new credential is invented: the key that proves the
 *     handle at the door is the key that sets the password on it.
 *
 * THE ENVIRONMENT IS RETIRED, and this is where that happens. COOKREW_HANDLE
 * decides nothing once there is an account or a key — it is a development
 * override for a machine that has neither, and it says so, once.
 */

/** Where the name being served came from. Four answers, in precedence order. */
export type HandleSource = 'account' | 'legacy' | 'env'

export interface ServingHandle {
  /** The handle doors publish under; empty when this Mac serves nothing. */
  handle: string
  source: HandleSource | 'none'
  /** One line for the boot log, said once, or null when there is nothing to say. */
  note: string | null
}

/** `@Drej ` and `drej` are one name; anything else is refused elsewhere. */
const clean = (value: string | null): string =>
  (value ?? '').trim().replace(/^@+/, '').toLowerCase()

/**
 * WHICH NAME THIS MAC SERVES UNDER.
 *
 * The order is the account, then the key, then the environment — and the one
 * surprise in it is deliberate: WHEN THE KEY DISAGREES WITH THE ACCOUNT, THE
 * KEY WINS. A door is listed at cookrew.dev under the handle of whatever
 * signed the registration, and the only thing this Mac can sign a v1
 * registration with is that key. Serving under a name we cannot prove would
 * not rename the door; it would refuse the dial and take the door down, which
 * is the one outcome this phase promises will not happen. After a migration
 * the two agree by construction, so this row is only reachable by claiming a
 * different name on a machine that was already serving — and it is reported.
 *
 * The environment decides only on a machine with neither, which is a fresh
 * developer's, and it is told that this is what it is.
 */
export function relayHandle(input: {
  account: string | null
  legacy: string | null
  env: string | null
}): ServingHandle {
  const account = clean(input.account)
  const legacy = clean(input.legacy)
  const env = clean(input.env)

  if (account !== '' && legacy !== '' && legacy !== account) {
    return {
      handle: legacy,
      source: 'legacy',
      note:
        `[cookrew] this Mac is @${account}, but its cookrew.dev key holds @${legacy} — ` +
        `doors keep publishing as @${legacy}, which is the only name that key can prove.`
    }
  }
  if (account !== '') {
    return {
      handle: account,
      source: 'account',
      note:
        env !== '' && env !== account
          ? `[cookrew] COOKREW_HANDLE @${env} is ignored: this Mac serves as its account, @${account}.`
          : null
    }
  }
  if (legacy !== '') {
    return {
      handle: legacy,
      source: 'legacy',
      note:
        env !== '' && env !== legacy
          ? `[cookrew] COOKREW_HANDLE @${env} is ignored: the key on this Mac holds @${legacy}.`
          : null
    }
  }
  if (env !== '') {
    return {
      handle: env,
      source: 'env',
      note: 'COOKREW_HANDLE is a development override; claim a username instead.'
    }
  }
  return { handle: '', source: 'none', note: null }
}

/**
 * THE HANDLE THIS MAC HELD BEFORE PASSWORDS, or null.
 *
 * Null the moment there is an account: the claim sheet's legacy step exists
 * to offer a crossing, and a Mac that has crossed has nothing to be offered.
 * Null too on a machine that never served — reading this must never be the
 * act that mints a key, which is why it goes through
 * `existingRegistryAccount` rather than `registryAccount`.
 */
export function legacyIdentity(input: {
  account: string | null
  origin: string
  base?: string
}): { handle: string } | null {
  if (input.account !== null && input.account !== '') return null
  const held = existingRegistryAccount(input.origin, input.base)
  const handle = clean(held?.handle ?? null)
  return handle === '' ? null : { handle }
}

/** The key itself, for the one caller that has to sign with it. */
export function legacyKey(origin: string, base?: string): RegistryAccount | null {
  return existingRegistryAccount(origin, base)
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** What the registry answers a migration with — the same 201 as a claim. */
export interface MigratedAccount {
  username: string
  deviceId: string
  session: { token: string; exp: number } | null
}

export type MigrateRefusal =
  | 'offline'
  | 'no_passwords_yet'
  | 'bad_credentials'
  | 'weak_password'
  | 'taken'
  | 'not_found'
  | 'rate_limited'
  | 'unknown'

export type MigrateOutcome =
  | { ok: true; value: MigratedAccount }
  | { ok: false; reason: MigrateRefusal; message?: string }

const REFUSALS: Record<string, MigrateRefusal> = {
  bad_credentials: 'bad_credentials',
  weak_password: 'weak_password',
  taken: 'taken',
  legacy: 'taken',
  not_found: 'not_found',
  rate_limited: 'rate_limited'
}

/**
 * IS THIS REGISTRY OLD, or is it new and refusing?
 *
 * Both answer 404, and the difference decides what a person is told: "nothing
 * changes until cookrew.dev is ready" is a promise, and saying it about a
 * registry that simply does not know this handle would be a lie. Every /v2
 * refusal carries a SENTENCE (`{error, message}`); a registry that predates
 * /v2 answers its own bare `{error:'not_found'}`, and so does a proxy with an
 * HTML page. No sentence, therefore no /v2 — the cautious way round, because
 * the cautious answer is the one that changes nothing.
 */
const notReady = (status: number, body: { message?: unknown }): boolean =>
  status === 404 && typeof body.message !== 'string'

/**
 * THE CROSSING: one v1 ceremony, one POST, and no state of our own.
 *
 * The challenge comes from /v1/identity/challenge — the route the app already
 * uses to publish a door — and the signature comes from the key on disk
 * through `registryAccount().assert`, never from a second copy of the
 * ceremony. Anything but a 201 leaves this Mac exactly as it was.
 */
export async function migrateAtRegistry(input: {
  origin: string
  http: FetchLike
  legacy: RegistryAccount
  password: string
  device: { id: string; kind: 'desktop'; name: string; jwk: Record<string, unknown> }
}): Promise<MigrateOutcome> {
  let challenge: string
  try {
    const asked = await input.http(`${input.origin}/v1/identity/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    if (!asked.ok) return { ok: false, reason: 'offline' }
    const offered = (await asked.json()) as { challenge?: unknown }
    if (typeof offered.challenge !== 'string') return { ok: false, reason: 'offline' }
    challenge = offered.challenge
  } catch {
    return { ok: false, reason: 'offline' }
  }

  let answer: Response
  try {
    answer = await input.http(`${input.origin}/v2/migrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: input.legacy.handle,
        password: input.password,
        device: input.device,
        assertion: input.legacy.assert(challenge)
      })
    })
  } catch {
    return { ok: false, reason: 'offline' }
  }

  let body: Record<string, unknown> = {}
  try {
    body = (await answer.json()) as Record<string, unknown>
  } catch {
    // A refusal with no body is still a refusal; it just has no sentence.
  }
  if (answer.status !== 201) {
    if (notReady(answer.status, body)) return { ok: false, reason: 'no_passwords_yet' }
    const named = typeof body.error === 'string' ? REFUSALS[body.error] : undefined
    const message = typeof body.message === 'string' ? body.message : undefined
    return {
      ok: false,
      reason: named ?? (answer.status === 429 ? 'rate_limited' : 'unknown'),
      ...(message === undefined ? {} : { message })
    }
  }
  const session = body.session as { token?: unknown; exp?: unknown } | undefined
  return {
    ok: true,
    value: {
      username: typeof body.username === 'string' ? body.username : input.legacy.handle,
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : input.device.id,
      session:
        typeof session?.token === 'string' && typeof session.exp === 'number'
          ? { token: session.token, exp: session.exp }
          : null
    }
  }
}
