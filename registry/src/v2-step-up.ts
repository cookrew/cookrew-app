import { readJsonBody } from './http'
import { refuse, v2Json, type V2Context } from './v2-http'
import { factorError } from './v2-factor-copy'
import { factorsFor } from './v2-factor-routes'
import { asking } from './v2-http'
import { STEP_UP_SENTENCE, type StepUpAct } from '../../src/shared/step-up'

/**
 * PROVE IT IS YOU, AGAIN, BEFORE THIS ONE.
 *
 * The session is thirty days long and renews on the device key, so the
 * password is no longer a monthly heartbeat. That is right for serving and it
 * leaves a gap: a stolen session is a month of quiet access. The step-up list
 * (src/shared/step-up.ts) is the answer — nothing in the ordinary day asks,
 * and everything that widens what the account opens from, or takes something
 * from another device, asks again.
 *
 * TWO PATHS, AND WHICH ONE IS NOT A PREFERENCE.
 *
 *   The account HAS A FACTOR — a passkey, an authenticator, rescue codes. Then
 *   the strongest thing it can prove with is not the password, and asking for
 *   the password instead would be asking for the weaker of the two. It climbs
 *   THE SAME LADDER a new device climbs: same rungs, same wire shape, same
 *   screens on both clients. The only difference is where it ends, and that
 *   difference lives in one place (finishRung).
 *
 *   The account has NO factor. Then the password is all there is, and it is
 *   asked for inline exactly as `removeFactor` has always asked for it.
 *
 * `approve` is deliberately not counted as "has a factor" for choosing the
 * path, though it IS offered as a rung once the ladder starts. Every signed-in
 * caller has at least one device, so counting it would send every account down
 * the ladder and leave the password path dead code — a branch that is never
 * taken is a branch nobody notices breaking.
 */

/** A body already read by the caller, or the caller may let this read it. */
export interface StepUpBody {
  /** The pending whose rung was climbed, when the ladder path is being finished. */
  stepUp?: unknown
  /** The password, on the no-factor path. */
  current?: unknown
}

const SMALL_BODY = 16 * 1024

/** Does this account hold something stronger than its password? */
export function hasStepUpFactor(ctx: V2Context, username: string): boolean {
  const account = ctx.v2.accounts.get(username)
  if (account === null) return false
  return (
    ctx.v2.factors.store.hasPasskey(username) ||
    ctx.v2.factors.store.totpActive(username) ||
    account.recovery.length > 0
  )
}

/**
 * May this act happen? TRUE means yes; FALSE means the response has already
 * been written and the caller must simply return.
 *
 * The body is passed in rather than read here because most callers need it for
 * their own fields too, and reading a request twice is reading it once and
 * getting nothing the second time.
 */
export async function stepUpHeld(
  ctx: V2Context,
  username: string,
  act: StepUpAct,
  body: StepUpBody
): Promise<boolean> {
  const account = ctx.v2.accounts.get(username)
  if (account === null) {
    refuse(ctx.response, 401, 'unauthenticated')
    return false
  }

  if (!hasStepUpFactor(ctx, username)) {
    if (typeof body.current !== 'string' || body.current === '') {
      v2Json(ctx.response, 403, factorError('password_required'))
      return false
    }
    if (!(await ctx.v2.accounts.verifyPassword(username, body.current))) {
      refuse(ctx.response, 401, 'bad_credentials')
      return false
    }
    return true
  }

  // A rung already climbed for THIS act, spent here and never again.
  if (ctx.v2.factors.pending.spendAuthorised(username, act, body.stepUp)) return true

  const next = factorsFor(ctx.v2, account)
  if (next.length === 0) {
    // Cannot happen — hasStepUpFactor said there is one — and it FAILS CLOSED
    // if it ever does. A gate's default branch must not be "let them through".
    v2Json(ctx.response, 403, factorError('no_factor'))
    return false
  }
  /**
   * The pending carries no device, because nothing is being attached. It is a
   * sign-in's shape around a different ending, and the `act` on it is what
   * tells `finishRung` so.
   */
  const pending = ctx.v2.factors.pending.open({
    username,
    device: null,
    deviceName: account.username,
    kind: 'account',
    address: asking(ctx),
    next,
    act
  })
  v2Json(ctx.response, 401, {
    error: 'step_up',
    message: STEP_UP_SENTENCE[act],
    act,
    next,
    pending: pending.id,
    expiresAt: pending.expiresAt,
    // The same two digits a sign-in shows, for the same reason: the approve
    // rung is on this ladder too, and nagging an owner into tapping APPROVE
    // works just as well when the prize is a join code.
    match: pending.match
  })
  return false
}

/** Read a body and step up in one go, for routes that need nothing else. */
export async function readAndStepUp(
  ctx: V2Context,
  username: string,
  act: StepUpAct
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return { ok: false }
  }
  if (!(await stepUpHeld(ctx, username, act, body.value as StepUpBody))) return { ok: false }
  return { ok: true, body: body.value }
}
