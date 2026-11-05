import { MIN_PASSCODE, usernameProblem, type AccountRefusal, type AccountStatus, type UsernameCheck } from '../../../shared/account-v2'
import { PROVIDER_LABEL, type ProviderId, type ProviderOffer } from '../../../shared/oauth'
import { accountProblemHint, type FieldTone } from './provider-words'

/**
 * THE PROVIDER SURFACE'S WORDS AND VERDICTS.
 *
 * Beside account-store.ts rather than inside it: that file is the longest in
 * the renderer, and everything here is about one new door. Same rule as there:
 * the components decide nothing, so every verdict can be tested without a DOM.
 */

export const PROVIDER_COPY = {
  WAITING: 'Finish in your browser. This sheet will carry on by itself.',
  ALREADY_HAVE: 'Already have a Cookrew account? Sign in with your password, then link this from Security.',
  HANDLE_WHY: 'This is your name on Cookrew. It does not have to match, and it stays yours if you ever unlink.',
  HANDLE_TITLE: 'Choose your Cookrew name',
  SESSION_ENDED: 'Your session ended. Sign in with your provider once and this carries on.',
  STEP_UP: 'Your browser will open so your provider can confirm it is you.',
  LADDER_OVER: 'That sign-in was dropped. Start it again.',
  PASSCODE_TITLE: 'Choose a passcode',
  PASSCODE_LOCAL: 'It unlocks Cookrew on this Mac and never leaves it. Your agents keep working while it is locked.',
  PASSCODE_LATER: 'Until you choose one, Cookrew will not lock itself on this Mac.',
  PASSCODE_CODES: 'Save your recovery codes next. They are the way back if you forget this.',
  LOST_PROVIDER: 'Lost access to your provider?',
  LOST_PROVIDER_WHY: 'A recovery code stands in for it while you link a new one. The code is spent even if you cancel.',
  FORGOT_PASSCODE: 'Forgot your passcode?',
  RESCUE_WHY: 'A recovery code opens this Mac once. You will choose a new passcode straight after.',
  LOCK_NOW_WHY: 'Locking hides your canvas behind your passcode. Your agents keep working.',
} as const

const REFUSALS: Partial<Record<AccountRefusal, string>> = {
  wrong_identity: 'That account is not the one on this Mac. Use the one you signed in with here.',
  link_taken: 'That account is already linked to another Cookrew account.',
  link_exists: 'A different account from this provider is linked here. Remove it first.',
  link_paused: 'This sign-in was reported as “not me”, so it is paused. Link it again from a signed-in device.',
  last_sign_in: 'This is the only way into the account. Add another before removing it.',
  ticket_gone: 'That took too long, so it was dropped. Sign in again.',
  provider_down: 'The provider did not answer. Try again in a moment.',
  provider_required: 'Sign in with your provider again to do this.',
  expired: 'That took too long, so it was dropped. Start it again.',
  locked: 'Unlock Cookrew first.',
  weak_passcode: `Use ${MIN_PASSCODE} characters or more.`,
  bad_credentials: 'That is not it.',
}

/**
 * What to say about a refused provider step. Null is "say nothing": changing
 * your mind in a browser is not a failure, and an apology for it reads as one.
 */
export function providerRefusal(reason: AccountRefusal, message?: string): string | null {
  if (reason === 'cancelled') return null
  return message ?? REFUSALS[reason] ?? accountProblemHint(reason)
}

export const continueLabel = (offer: ProviderOffer): string => `CONTINUE WITH ${offer.label.toUpperCase()}`

export const waitingLabel = (provider: ProviderId): string => `Waiting for ${PROVIDER_LABEL[provider]}…`

/** What the handle field says and whether the primary may be pressed. */
export function handleView(
  value: string,
  check: UsernameCheck | 'checking',
): { canGo: boolean; note: string; tone: FieldTone } {
  if (usernameProblem(value) === 'reserved') return { canGo: false, note: 'That prefix is reserved. Pick another name.', tone: 'bad' }
  if (usernameProblem(value) === 'shape' || check === 'invalid') {
    return { canGo: false, note: 'Lowercase letters, digits and dashes, up to 32 of them.', tone: 'bad' }
  }
  if (check === 'taken') return { canGo: false, note: `@${value} is taken. Pick another name.`, tone: 'bad' }
  if (check === 'free') return { canGo: true, note: `@${value} is free.`, tone: 'good' }
  if (check === 'unknown') return { canGo: true, note: 'cookrew.dev did not say. It will decide when you press.', tone: 'dim' }
  return { canGo: false, note: 'Checking…', tone: 'dim' }
}

export function passcodeView(next: string, confirm: string): { canGo: boolean; note: string } {
  if (next.length < MIN_PASSCODE) return { canGo: false, note: `Use ${MIN_PASSCODE} characters or more.` }
  if (next !== confirm) return { canGo: false, note: 'Type the same passcode twice.' }
  return { canGo: true, note: '' }
}

/**
 * WHO OWNS A BROWSER TRIP: the surface that started it.
 *
 * A sheet that closes mid-trip must take the trip with it, or the browser
 * finishes into a surface that is gone and an act the person dismissed still
 * happens. `leave` is the only thing that cancels, and only a running trip.
 */
export function tripGuard(cancel: () => void): { begin: () => void; end: () => void; leave: () => void } {
  let running = 0
  return {
    begin: () => {
      running += 1
    },
    end: () => {
      running = Math.max(0, running - 1)
    },
    leave: () => {
      if (running === 0) return
      running = 0
      cancel()
    },
  }
}

/** Is it time to ask? `later` is this run's answer, and a relaunch asks again. */
export function shouldAskPasscode(status: AccountStatus | null, later: boolean): boolean {
  return status !== null && status.passcodePending && !status.locked && !later
}
