import type { AccountRefusal, AccountResult } from '../../../shared/account-v2'
import { refusalSentence } from './account-store'

/**
 * WHY IT DID NOT WORK — in the account surface's own words, never in one word
 * for everything.
 *
 * Real-UI QA found a red box on the SECURITY tab carrying the one apology
 * this surface used for everything — the same eleven-catch sentence, which
 * therefore said nothing about which of eleven things had failed. Worse, it
 * was shown for a THROWN IPC rejection, the one case where the app does know
 * something concrete: the error's own message. Told only that it did not
 * work, a person can do nothing but try again and watch it not work.
 *
 * Two shapes, because a call fails in two ways.
 *
 *   IT ANSWERED NO. The registry sent a sentence; it is shown verbatim
 *   (`refusalSentence` already prefers it) because it is the only party that
 *   knows why THIS request was refused.
 *
 *   IT THREW. The bridge rejected — main is not registered for the channel, a
 *   handler raised, the value could not be cloned. The message goes on screen
 *   with what was being attempted in front of it, and the stack goes to the
 *   console where a developer can read it.
 */

/** What was being attempted, said as the start of a sentence. */
export const DOING = {
  PROFILE: 'Your account could not be read from cookrew.dev',
  DEVICES: 'The devices on your account could not be read',
  REVOKE: 'That device could not be revoked',
  FORGET: 'That phone could not be forgotten',
  DISPLAY_NAME: 'That name could not be saved',
  FACTORS: 'Your security settings could not be read',
  CODES: 'New recovery codes could not be made',
  SAVE_CODES: 'Those codes could not be written to a file',
  LOCK: 'The lock could not be changed on this Mac',
  CLAIM: 'That username could not be claimed',
  PASSKEY: 'That passkey could not be added',
  REMOVE_FACTOR: 'That factor could not be removed',
  TOTP_ENROL: 'The authenticator could not be set up',
  TOTP_CONFIRM: 'That code could not be checked',
  PASSWORD: 'Your password could not be changed',
  RESUME: 'Your session could not be started again',
  DECIDE: 'That answer did not reach cookrew.dev',
  SEATS: 'The seats on your account could not be read',
  SEAT: 'That seat could not be changed',
} as const

export type Doing = (typeof DOING)[keyof typeof DOING]

/** The detail an unknown throwable carries, without pretending to know more. */
function detailOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return 'the app got no reason back'
}

/**
 * A THROWN rejection, as a sentence — and the stack to the console.
 *
 * The message is deliberately not cleaned up: an Electron rejection reads
 * "Error invoking remote method 'account:factors': …", which names the channel
 * and is exactly what makes the difference between a bug report and a shrug.
 */
export function problemSentence(doing: Doing, error: unknown): string {
  console.error(`${doing}:`, error)
  return `${doing}: ${detailOf(error)}`
}

/**
 * An ANSWER that refused, as a sentence — the registry's own where it sent
 * one, and otherwise the copy table's, with what was attempted in front of it
 * so two rows failing for the same reason still read differently.
 */
export function refusedSentence(
  doing: Doing,
  refusal: { reason: AccountRefusal; message?: string },
  username = '',
): string {
  const why = refusalSentence(refusal.reason, refusal.message, username)
  return refusal.message ? why : `${doing}. ${why}`
}

/** The one call site both shapes share: hand it a result, get null or a sentence. */
export function answerProblem<T>(
  doing: Doing,
  result: AccountResult<T>,
  username = '',
): string | null {
  return result.ok ? null : refusedSentence(doing, result, username)
}
