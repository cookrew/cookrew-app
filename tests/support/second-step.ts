import { base32Decode, totpAt } from '../../registry/src/v2-totp'

/**
 * GATE 1 FROM A TEST'S SIDE (auth UX 2026-11-09): a password is the first step
 * only, so a new account sets up an authenticator and saves its recovery codes
 * before its first session. This walks that over HTTP the way a page does.
 */

export interface SetUp {
  username: string
  deviceId: string
  token: string
  exp: number
  secret: string
  codes: string[]
}

const post = async (url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let parsed: Record<string, unknown> = {}
  try {
    parsed = (await res.json()) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return { status: res.status, body: parsed }
}

/** The code the authenticator shows now, for a base32 secret. */
export const codeNow = (secret: string, at: number = Date.now()): string => totpAt(base32Decode(secret) as Buffer, at)

/** Finish a set-up pending with an authenticator: the factor, the codes, the session. */
export async function finishSetupWithTotp(origin: string, pending: string, at: number = Date.now()): Promise<{ token: string; exp: number; deviceId: string; secret: string; codes: string[] }> {
  const started = await post(`${origin}/v2/sessions/${pending}/setup/totp`, {})
  if (started.status !== 201) throw new Error(`setup/totp answered ${started.status}`)
  const secret = String(started.body.secret)
  const confirmed = await post(`${origin}/v2/sessions/${pending}/setup/totp/confirm`, { code: codeNow(secret, at) })
  if (confirmed.status !== 201) throw new Error(`setup/totp/confirm answered ${confirmed.status}`)
  const codes = confirmed.body.codes as string[]
  const finished = await post(`${origin}/v2/sessions/${pending}/setup/finish`, { saved: true })
  if (finished.status !== 201) throw new Error(`setup/finish answered ${finished.status}`)
  return { token: String(finished.body.token), exp: Number(finished.body.exp), deviceId: String(finished.body.deviceId), secret, codes }
}

/** Claim an account and walk its set-up: what a new account now takes to get a session. */
export async function claimThroughSetup(
  origin: string,
  input: { username: string; password: string; device: Record<string, unknown> }
): Promise<SetUp> {
  const claimed = await post(`${origin}/v2/accounts`, input)
  if (claimed.status !== 403 || claimed.body.error !== 'second_step_setup') {
    throw new Error(`claim answered ${claimed.status} ${String(claimed.body.error)}`)
  }
  const done = await finishSetupWithTotp(origin, String(claimed.body.pending))
  return { username: input.username, ...done }
}
