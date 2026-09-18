import { readJsonBody } from './http'
import { refuse, v2Json, type Signed, type V2Context } from './v2-http'
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
 *
 * AND THE ASKER IS NOT ONE OF THE DEVICES IT MAY ASK (C1).
 *
 * The gate shipped with a hole that every piece of it pointed at and none of
 * it owned. `factorsFor` offers `approve` whenever the account has ANY device;
 * the refusal hands the asker the two digits; `answerApproval` never asked who
 * answered. All three are right for a SIGN-IN, where the asking device is not
 * attached and therefore cannot hold a session at all. For a step-up the asker
 * IS attached — so a caller holding one stolen session asked for step-up, was
 * told the number in the refusal, approved its own request, and minted a join
 * code that attaches a machine for ever. The threshold was crossable by the
 * exact session it exists to stop.
 *
 * Two rules, and each is a complete answer on its own:
 *
 *   A RUNG NOBODY ELSE CAN ANSWER IS NOT OFFERED. With one device on the
 *   account, "ask my other device" has no other device; offering it is
 *   offering the caller a conversation with itself. So `approve` survives only
 *   when the account holds a device that is not the asker's.
 *
 *   AND THE NUMBER GOES ONLY WHERE IT IS FOR. The two digits exist for the
 *   approve rung and for nothing else; no rung, no number. Where the rung IS
 *   offered the digits still travel, because that is the ceremony — read off
 *   this screen, typed on the other — and the pending now records who asked,
 *   so the asker is refused by name at the answering end.
 *
 * Belt and braces on purpose. Either rule alone closes today's attack; both
 * together mean a future change to `factorsFor` cannot quietly reopen it.
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
  signed: Signed,
  act: StepUpAct,
  body: StepUpBody
): Promise<boolean> {
  // FROM THE SESSION, never from a parameter. A gate that took the name it was
  // to check as an argument could be asked to check the wrong one, and the
  // caller it must answer about is always the caller holding the request.
  const username = signed.account.username
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

  /**
   * The ladder this account can climb, minus the rung the asker would be
   * answering on its own. `hasStepUpFactor` has already said there is a
   * passkey, an authenticator or a rescue code, so what is left is never
   * empty — the fail-closed branch below stays unreachable, and stays.
   */
  const elsewhere = account.devices.some((d) => d.id !== signed.claims.dev)
  const next = factorsFor(ctx.v2, account).filter((factor) => factor !== 'approve' || elsewhere)
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
    act,
    // Who asked, so the answering end can refuse them by name.
    opener: { jti: signed.claims.jti, device: signed.claims.dev }
  })
  v2Json(ctx.response, 401, {
    error: 'step_up',
    message: STEP_UP_SENTENCE[act],
    act,
    next,
    pending: pending.id,
    expiresAt: pending.expiresAt,
    /**
     * ONLY WITH THE RUNG IT BELONGS TO. The digits are the approve rung's
     * whole mechanism — read off this screen, typed on the other one — and
     * they mean nothing to a passkey, an authenticator or a rescue code. Sent
     * unconditionally they were a number handed to a caller that could answer
     * it, which is how the threshold came to be self-crossable.
     */
    ...(next.includes('approve') ? { match: pending.match } : {})
  })
  return false
}

/** Read a body and step up in one go, for routes that need nothing else. */
export async function readAndStepUp(
  ctx: V2Context,
  signed: Signed,
  act: StepUpAct
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return { ok: false }
  }
  if (!(await stepUpHeld(ctx, signed, act, body.value as StepUpBody))) return { ok: false }
  return { ok: true, body: body.value }
}
