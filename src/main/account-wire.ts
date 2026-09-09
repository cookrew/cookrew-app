import type { AccountRefusal } from '../shared/account-v2'

/**
 * WHAT COOKREW.DEV'S "NO" MEANS, in one vocabulary.
 *
 * Every account call and every rung of the sign-in ladder reads a refusal the
 * same way, so the reading lives here rather than in the two modules that do
 * the calling. The rule the wire states is that an error carries `{error,
 * message}` and that the MESSAGE IS SHOWN VERBATIM — it is the only party that
 * knows why THIS request was refused — so nothing here re-words one. What it
 * decides is the REASON, which is what a surface branches on: whether to keep
 * a field open, offer a rung, or send somebody back to their password.
 *
 * Split out of account-v2.ts when the ladder arrived: the ladder has to read a
 * body ITSELF (a 401 saying `second_factor` carries the pending id in the same
 * JSON, and a Response body is consumable once), and two modules sharing a
 * classifier beats two classifiers that agree until one of them is edited.
 */

export interface WireError {
  error?: string
  message?: string
}

export const REFUSALS: Record<string, AccountRefusal> = {
  taken: 'taken',
  legacy: 'legacy',
  no_passwords_yet: 'no_passwords_yet',
  bad_username: 'bad_username',
  weak_password: 'weak_password',
  bad_device: 'bad_device',
  bad_credentials: 'bad_credentials',
  second_factor: 'second_factor',
  last_device: 'last_device',
  not_found: 'not_found',
  already_seated: 'already_seated',
  // The ladder's own vocabulary (v2-factor-copy.ts). Named here so a mistyped
  // code arrives as 'bad_code' rather than as the catch-all — the card keeps
  // its field open for one and sends the owner back to the password for the
  // other, and it cannot tell them apart from 'unknown'.
  bad_code: 'bad_code',
  bad_recovery: 'bad_recovery',
  passkey_refused: 'passkey_refused',
  expired: 'expired',
  too_many_attempts: 'too_many_attempts',
  denied: 'denied',
  not_offered: 'not_offered',
  password_change_required: 'password_change_required',
}

/**
 * A refusal's body, already read, as a reason and a sentence.
 *
 * SPLIT OUT OF `wireError` because the ladder has to read the body ITSELF: a
 * 401 that says `second_factor` carries the pending id in the same JSON, and a
 * Response body can only be consumed once. Both paths classify identically
 * because both call this.
 */
export function classify(status: number, body: WireError): { reason: AccountRefusal; message?: string } {
  if (status === 429) return { reason: 'rate_limited' }
  // A 401 is a dead session ONLY when the registry says so (no error, or
  // `unauthenticated`). A wrong authenticator code or a refused passkey also
  // arrive as 401, with their own error and sentence — telling the owner
  // "your session ended" for a mistyped code sent them to the wrong fix.
  if (status === 401) {
    if (typeof body.error !== 'string' || body.error === 'unauthenticated') {
      return { reason: 'session-expired' }
    }
    const named: AccountRefusal = REFUSALS[body.error] ?? 'unknown'
    return body.message ? { reason: named, message: body.message } : { reason: named }
  }
  const reason: AccountRefusal =
    (typeof body.error === 'string' ? REFUSALS[body.error] : undefined) ?? 'unknown'
  return body.message ? { reason, message: body.message } : { reason }
}

/** A JSON body, or an empty one: a refusal with no body is still a refusal. */
export async function bodyOf(response: Response): Promise<WireError & Record<string, unknown>> {
  try {
    return (await response.json()) as WireError & Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * A refusal as the third arm of a `SignInAnswer` — everything but the step.
 *
 * `second_factor` reaching here is a step this app could not read (no pending
 * id, or no rung it knows). There is nothing a person can do about that, so it
 * is reported as an answer we could not read rather than as a ladder with no
 * rungs on it.
 */
export function plainRefusal(refused: { reason: AccountRefusal; message?: string }): {
  ok: false
  reason: Exclude<AccountRefusal, 'second_factor'>
  message?: string
} {
  const reason = refused.reason === 'second_factor' ? 'unknown' : refused.reason
  return { ok: false, reason, ...(refused.message ? { message: refused.message } : {}) }
}

export async function wireError(
  response: Response,
): Promise<{ reason: AccountRefusal; message?: string }> {
  if (response.status === 429) return { reason: 'rate_limited' }
  return classify(response.status, await bodyOf(response))
}
