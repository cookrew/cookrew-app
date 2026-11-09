import { MIN_PASSCODE, usernameProblem, type AccountRefusal, type AccountStatus, type UsernameCheck } from '../../../shared/account-v2'
import { accountCopy } from '../../../shared/account-copy'
import { hostPlatform, machineCopy, machineTable } from '../../../shared/machine-words'
import { PROVIDER_LABEL, type ProviderId, type ProviderOffer } from '../../../shared/oauth'
import { accountProblemHint, type FieldTone } from './provider-words'

/**
 * THE PROVIDER SURFACE'S WORDS AND VERDICTS.
 *
 * Beside account-store.ts rather than inside it: that file is the longest in
 * the renderer, and everything here is about one new door. Same rule as there:
 * the components decide nothing, so every verdict can be tested without a DOM.
 */

export const PROVIDER_COPY = machineTable({
  WAITING: 'Finish in your browser. This sheet will carry on by itself.',
  ALREADY_HAVE: 'Already have a Cookrew account? Sign in with your password, then link this from Security.',
  HANDLE_WHY: 'This is your name on Cookrew. It does not have to match, and it stays yours if you ever unlink.',
  HANDLE_TITLE: 'Choose your Cookrew name',
  SESSION_ENDED: 'Your session ended. Sign in with your provider once and this carries on.',
  STEP_UP: 'Your browser will open so your provider can confirm it is you.',
  LADDER_OVER: 'That sign-in was dropped. Start it again.',
  /**
   * THE FIRST-RUN CARD FOR AN ACCOUNT WITH NO PASSWORD (owner, 2026-11-09):
   * there is no separate passcode; the account password is the lock, and the
   * key that enters every machine of the account. Touch ID can stand in for it.
   */
  ACCOUNT_PASSWORD_TITLE: 'Set your account password',
  ACCOUNT_PASSWORD_WHY:
    'You signed in with your provider, so your account has no password yet. It will lock Cookrew on this Mac and let your phone into your machines. Touch ID can stand in for typing it.',
  ACCOUNT_PASSWORD_LATER: 'Until you set one, Cookrew will not lock itself on this Mac.',
  LOST_PROVIDER: 'Lost access to your provider?',
  LOST_PROVIDER_WHY: 'A recovery code stands in for it while you link a new one. The code is spent even if you cancel.',
  /**
   * ONLY ON A MAC THAT CHOSE A PASSCODE before there was none: it keeps
   * working there until the account password is typed (the fold), and these
   * are the one place the word is still said.
   */
  CHOSEN_PASSCODE_FORGOT: 'Forgot your passcode?',
  CHOSEN_PASSCODE_RESCUE_WHY:
    'A recovery code opens this Mac once. After that it unlocks with your account password.',
  CHOSEN_PASSCODE_LOCK_WHY: 'Locking hides your canvas behind the passcode you chose. Your agents keep working.',
  /** A machine signed in from a terminal (`cookrew login`): its lock waits for the password typed here once. */
  LOCK_WAITS_TYPE: 'The lock is off on this Mac until your account password is typed here once.',
  LOCK_WAITS_SET: 'The lock is off on this Mac until your account has a password. Set one above.',
} as const, hostPlatform())

const REFUSALS: Partial<Record<AccountRefusal, string>> = {
  wrong_identity: machineCopy('That account is not the one on this Mac. Use the one you signed in with here.', hostPlatform()),
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
  if (check === 'retired') return { canGo: false, note: accountCopy('d9.crossing.retired', { handle: value }), tone: 'bad' }
  if (check === 'free') return { canGo: true, note: `@${value} is free.`, tone: 'good' }
  if (check === 'unknown') return { canGo: true, note: machineCopy('cookrew.dev did not say. It will decide when you press.', hostPlatform()), tone: 'dim' }
  return { canGo: false, note: 'Checking…', tone: 'dim' }
}

/** The account password's own rule: twelve characters, the registry's floor. */
export const MIN_ACCOUNT_PASSWORD = 12

export function firstPasswordView(next: string, confirm: string): { canGo: boolean; note: string } {
  if (next.length < MIN_ACCOUNT_PASSWORD) return { canGo: false, note: `Use ${MIN_ACCOUNT_PASSWORD} characters or more; a sentence works.` }
  if (next !== confirm) return { canGo: false, note: 'Type the same password twice.' }
  return { canGo: true, note: '' }
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
export function tripGuard(cancel: () => void): {
  begin: () => number
  end: (from?: number) => void
  leave: () => void
} {
  let running = 0
  // Which round of trips this is. A trip that ends after a `leave` belongs to the
  // round before, and must not count against one that started since.
  let round = 0
  return {
    begin: () => {
      running += 1
      return round
    },
    end: (from = round) => {
      if (from === round) running = Math.max(0, running - 1)
    },
    leave: () => {
      if (running === 0) return
      running = 0
      round += 1
      cancel()
    },
  }
}

/**
 * Is it time to ask for an account password? Only on an account that has none,
 * only on a machine a person signed in at (never one signed in from a
 * terminal: nobody can type at its screen), and `later` is this run's answer.
 */
export function shouldAskAccountPassword(status: AccountStatus | null, later: boolean): boolean {
  return (
    status !== null &&
    status.username !== null &&
    status.lockWaits === 'set-password' &&
    !status.fromTerminal &&
    !status.locked &&
    !later
  )
}
