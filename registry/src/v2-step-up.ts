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
 * WHAT COUNTS AS PROOF — and one revision to V3-16's answer, argued.
 *
 *   A RUNG ALREADY CLIMBED for this act, spent once. The strongest proof, and
 *   the one the refusal offers first: same rungs as the sign-in ladder, same
 *   wire shape, same screens. The only difference is where it ends, and that
 *   difference lives in one place (finishRung).
 *
 *   OR THE CURRENT PASSWORD, whether or not the account holds a factor. V3-16
 *   took the password only from accounts with no factor, on the argument that
 *   "asking for the password would be asking for the weaker of the two". That
 *   argument is about PREFERENCE; a threshold is about SUFFICIENCY, and two
 *   facts decide it:
 *
 *     the threat this gate was built for is a STOLEN SESSION, and the password
 *     is precisely what the holder of a stolen session does not have. The one
 *     case where that stops being true — somebody else knows the password — is
 *     the not-me alarm, and the alarm closes this door above;
 *
 *     rung-only is not reachable today. Neither client can climb a step-up, so
 *     rung-only does not produce a stronger product: it produces an act that
 *     cannot be performed at all by any account holding so much as a sheet of
 *     rescue codes. An act nobody can perform is not a threshold that holds —
 *     it is a threshold somebody deletes.
 *
 *   THE HONEST COST, so that whoever tightens this can weigh it: against an
 *   attacker who has BOTH a phished password AND a stolen session, rung-only
 *   would hold and this does not. That attacker cannot simply sign in — a new
 *   device meets the ladder — so the case is real rather than theoretical.
 *   When a client can climb a step-up (V3-12/13), narrowing this to rungs for
 *   accounts that hold a factor is one condition and one test.
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

  /**
   * "NOT ME" CLOSES THIS DOOR TOO — before either path, so both inherit it.
   *
   * The alarm means one thing: a stranger has this password. Sign-in honours
   * it, the rung honours it, join-redeem honours it and recovery honours it;
   * this gate was built precisely so that seven copies of a boundary could not
   * drift, and it was the copy that drifted — a locked account still minted a
   * live join code to whoever typed the disowned password.
   *
   * INSIDE THE GATE RATHER THAN AT EACH CALL SITE, which is the whole argument
   * for having a gate: an act wired in tomorrow gets the alarm without anybody
   * remembering to add it.
   *
   * IT REFUSES THE LADDER AS WELL AS THE PASSWORD, even though a passkey is
   * something the stranger does not have. A step-up is permission to widen
   * what the account opens from, and an account whose owner has just said it
   * is compromised should not be widening. The owner is not stranded: they
   * still hold the sitting they pressed the alarm from, and POST
   * /v2/me/password is deliberately NOT behind this gate — it is the one act
   * that clears the alarm, and putting it behind the alarm would be a lock
   * with its key inside.
   */
  if (ctx.v2.factors.store.mustChangePassword(username)) {
    v2Json(ctx.response, 403, factorError('password_change_required'))
    return false
  }

  // A rung already climbed for THIS act, spent here and never again.
  if (ctx.v2.factors.pending.spendAuthorised(username, act, body.stepUp)) return true

  /**
   * THE PASSWORD, WHEN ONE WAS BROUGHT. Judged on what the caller offered: a
   * caller that sends a password has asked to be judged on it, so a wrong one
   * is a wrong password rather than an invitation to climb a ladder instead.
   */
  if (typeof body.current === 'string' && body.current !== '') {
    if (!(await ctx.v2.accounts.verifyPassword(username, body.current))) {
      refuse(ctx.response, 401, 'bad_credentials')
      return false
    }
    return true
  }

  if (!hasStepUpFactor(ctx, username)) {
    v2Json(ctx.response, 403, factorError('password_required'))
    return false
  }

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
  /**
   * A BODY THAT IS NOT THERE IS NOT AN ERROR HERE — it is a request with no
   * proof in it, which is exactly what this gate exists to answer.
   *
   * Most of these acts used to be a bare DELETE with no body at all, so the
   * commonest way to meet the gate is to bring nothing; "malformed" would be
   * our word for our machinery in the one place a person most needs a next
   * step. The act does not happen either way — `stepUpHeld` refuses an empty
   * proof — and the refusal says which proof is missing. Only `too_large`
   * keeps its own status, because that one really is about the bytes.
   */
  if (!body.ok && body.reason === 'too_large') {
    refuse(ctx.response, 413, 'malformed')
    return { ok: false }
  }
  const value = body.ok ? body.value : {}
  if (!(await stepUpHeld(ctx, signed, act, value as StepUpBody))) return { ok: false }
  return { ok: true, body: value }
}
