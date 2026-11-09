import {
  Accounts,
  DEFAULT_LOCK_AFTER_MS,
  deviceIdFor,
  mintDeviceKey,
  unlockVerifierFor,
  writeAccount,
  type AccountFile
} from '../../src/main/account-v2'
import { codeNow } from './second-step'

/**
 * A MAC REGISTERS AN ACCOUNT THE WAY A PERSON NOW DOES (auth UX 2026-11-09).
 *
 * A password is the first step only. A person creating an account on their Mac
 * is walked through auth.cookrew.dev: the Mac's own key is the device, the
 * account gets an authenticator (the second step), the recovery codes are
 * shown and saved, and only then does the session come back to the Mac, which
 * writes its account file with that key and that session.
 *
 * This does the same over HTTP against the real registry — the set-up routes
 * the page itself calls — and writes the file the landing writes
 * (account-v2.ts · saveClaimed). The registry rule is not loosened anywhere.
 */

export interface RegisteredMac {
  readonly accounts: Accounts
  readonly file: AccountFile
  /** The authenticator's base32 secret, for a later second step. */
  readonly secret: string
  /** The recovery codes the person saved. */
  readonly codes: readonly string[]
}

const post = async (url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let parsed: Record<string, unknown> = {}
  try {
    parsed = (await response.json()) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return { status: response.status, body: parsed }
}

export async function registerMac(input: {
  readonly origin: string
  readonly base: string
  readonly username: string
  readonly password: string
  readonly name: string
  /** The registry's clock, when a test injected one: the six digits are read off it. */
  readonly now?: () => number
  /** Anything else the test's Accounts needs (a clock, a fetch). */
  readonly accounts?: Omit<ConstructorParameters<typeof Accounts>[0], 'base' | 'origin'>
}): Promise<RegisteredMac> {
  const now = input.now ?? Date.now
  const keys = mintDeviceKey()
  const deviceId = deviceIdFor(keys.publicKeyJwk)
  const claimed = await post(`${input.origin}/v2/accounts`, {
    username: input.username,
    password: input.password,
    device: { id: deviceId, kind: 'desktop', name: input.name, jwk: keys.publicKeyJwk }
  })
  if (claimed.status !== 403 || claimed.body.error !== 'second_step_setup') {
    throw new Error(`creating @${input.username} answered ${claimed.status} ${String(claimed.body.error)}`)
  }
  const pending = String(claimed.body.pending)
  const started = await post(`${input.origin}/v2/sessions/${pending}/setup/totp`, {})
  if (started.status !== 201) throw new Error(`setup/totp answered ${started.status}`)
  const secret = String(started.body.secret)
  const confirmed = await post(`${input.origin}/v2/sessions/${pending}/setup/totp/confirm`, { code: codeNow(secret, now()) })
  if (confirmed.status !== 201) throw new Error(`setup/totp/confirm answered ${confirmed.status}`)
  const codes = confirmed.body.codes as string[]
  const finished = await post(`${input.origin}/v2/sessions/${pending}/setup/finish`, { saved: true })
  if (finished.status !== 201) throw new Error(`setup/finish answered ${finished.status}`)
  const file: AccountFile = {
    username: input.username,
    deviceId,
    kind: 'desktop',
    name: input.name,
    privateKeyJwk: keys.privateKeyJwk,
    publicKeyJwk: keys.publicKeyJwk,
    registry: input.origin,
    session: { token: String(finished.body.token), exp: Number(finished.body.exp) },
    unlock: unlockVerifierFor(input.password),
    lockAfterMs: DEFAULT_LOCK_AFTER_MS,
    claimedAt: now(),
    workspacesReachable: true,
    recoveryCodesSavedAt: null
  }
  writeAccount(file, input.base)
  return {
    accounts: new Accounts({ ...(input.accounts ?? {}), base: input.base, origin: input.origin, deviceName: input.name }),
    file,
    secret,
    codes
  }
}
