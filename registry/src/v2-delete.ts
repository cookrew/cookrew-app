import { readJsonBody } from './http'
import { clearedCookie, noContent, refuse, type Signed, type V2Context } from './v2-http'
import { stepUpHeld, type StepUpBody } from './v2-step-up'

/**
 * DELETING AN ACCOUNT. DELETE /v2/me, by its signed-in owner.
 *
 * Proof first, and proof means what every other step-up means: the password,
 * a climbed rung, or a provider round trip on an account with no password. The
 * session alone is what a thief holds, so it is never enough. The body also has
 * to name the account, so that no client can do this by accident.
 *
 * ONE SYNCHRONOUS RUN, with the account itself last. Nothing can interleave, and
 * if a store throws halfway the owner is still signed in and can simply ask
 * again: every step here is safe to repeat. The other order would strand what
 * was left with nobody able to reach it.
 *
 * What stays is listed for people in src/shared/account-delete.ts. Change one
 * and read the other.
 */

const SMALL_BODY = 16 * 1024

export async function deleteAccount(ctx: V2Context, signed: Signed): Promise<void> {
  const { response, v2 } = ctx
  const { username } = signed.account
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok && body.reason === 'too_large') {
    refuse(response, 413, 'malformed')
    return
  }
  const value = (body.ok ? body.value : {}) as StepUpBody & { confirm?: unknown }
  // Before the gate, so a mistyped name does not spend a rung somebody climbed.
  if (value.confirm !== username) {
    refuse(response, 400, 'confirm_mismatch')
    return
  }
  if (!(await stepUpHeld(ctx, signed, 'delete-account', value))) return

  // Read again: a step-up can take a provider round trip, and the account may
  // have gained a device while it ran.
  const account = v2.accounts.get(username)
  if (account === null) {
    refuse(response, 401, 'unauthenticated')
    return
  }
  try {
    // Every id this account ever held: a Mac signed out earlier keeps its
    // certificate record until now, and `revoked` is the only list of those.
    for (const id of [...account.devices.map((d) => d.id), ...(account.revoked ?? []).map((r) => r.id)]) {
      ctx.names?.forget(id)
    }
    v2.requests.emptyFor(username)
    v2.joinCodes.voidFor(username)
    v2.factors.pending.closeAllFor(username)
    v2.factors.store.forget(username)
    v2.seats.closeAccount(username)
    v2.events.forget(username)
    ctx.accountGone?.(account)
    v2.accounts.close(username)
  } catch (error) {
    console.error(`account delete stopped partway: ${error instanceof Error ? error.message : String(error)}`)
    refuse(response, 503, 'busy', undefined, { 'retry-after': '5' })
    return
  }
  noContent(response, { 'set-cookie': clearedCookie() })
}
