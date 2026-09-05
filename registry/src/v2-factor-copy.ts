/**
 * IDENTITY v2, PHASE 4 — THE SENTENCES OF THE LADDER.
 *
 * Beside v2-copy.ts rather than inside it, because phase 4 lands next to two
 * other phases in the same file tree and a shared list is a shared merge. The
 * rule is the same one v2-copy states: a refusal carries a sentence a person
 * can act on, and the sentence lives in one place so the sheet, the phone and
 * the desktop cannot drift into three versions of it.
 *
 * The wording follows the UI/UX note's copy table — "one more step", the D6
 * approval prompt, and the rescue codes' "each opens the account once".
 */

export type FactorError =
  | 'second_factor'
  | 'password_change_required'
  | 'bad_code'
  | 'bad_recovery'
  | 'passkey_refused'
  | 'not_offered'
  | 'expired'
  | 'denied'
  | 'too_many_attempts'
  | 'no_approval'
  | 'bad_decision'
  | 'totp_not_started'
  | 'totp_active'
  | 'passkey_limit'
  | 'passkey_known'
  | 'bad_name'

const SENTENCES: Record<FactorError, string> = {
  second_factor: 'One more step. Prove it is you.',
  password_change_required:
    'Somebody said a sign-in was not them, so this password is locked out until you change it. Change it on a device you are still signed in on.',
  bad_code: 'That is not the code showing right now. Wait for the next one and type it as it appears.',
  bad_recovery: 'That is not one of your recovery codes. Each one opens the account exactly once.',
  passkey_refused: 'That passkey did not answer for this account. Try another way in.',
  not_offered: 'This account cannot be opened that way. Choose one of the ways it offers.',
  expired: 'That sign-in took too long, so it was dropped. Start again with your password.',
  denied: 'That sign-in was denied on your other device. Nothing was attached.',
  too_many_attempts: 'Too many tries on this sign-in. Start again with your password.',
  no_approval: 'There is no such request — it may already have been answered.',
  bad_decision: 'A request is approved, denied, or “not me”.',
  totp_not_started: 'Ask for a secret first, then confirm it with a code from the app.',
  totp_active: 'This account already has an authenticator. Remove it before adding another.',
  passkey_limit: 'That is as many passkeys as one account holds. Remove one before adding another.',
  passkey_known: 'That passkey is already enrolled.',
  bad_name: 'Give the passkey a name you will recognise — up to 64 characters.'
}

export const factorError = (error: FactorError): { error: FactorError; message: string } => ({
  error,
  message: SENTENCES[error]
})

export const factorSentence = (error: FactorError): string => SENTENCES[error]
