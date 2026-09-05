/**
 * IDENTITY v2 — WHAT A PERSON READS WHEN THEY ARE REFUSED.
 *
 * Every /v2 error is `{error, message}`: the error is for a client, the
 * message is a sentence for whoever is looking at the screen. They live here
 * rather than beside the routes because the sheet, the /me page and the app
 * all show the same refusal, and three copies of a sentence become three
 * different sentences. The wording is the UI/UX note's copy table.
 *
 * R14 still holds for /v1: no code and no token reaches a rendered sheet.
 * What changed is that a v2 refusal now CARRIES its sentence instead of
 * leaving each client to invent one from a machine value.
 */

export type V2Error =
  | 'taken'
  | 'bad_username'
  | 'weak_password'
  | 'bad_device'
  | 'bad_credentials'
  | 'rate_limited'
  | 'unauthenticated'
  | 'not_found'
  | 'last_device'
  | 'bad_profile'
  | 'bad_desktop'
  | 'not_this_device'
  | 'bad_origin'
  | 'no_seat'
  | 'not_owner'
  | 'already_seated'
  | 'bad_seat'
  | 'malformed'
  | 'method_not_allowed'

const SENTENCES: Record<V2Error, string> = {
  taken: 'That name is someone else’s. Try another.',
  bad_username: 'A username is lowercase letters, digits and dashes, up to 32 of them.',
  weak_password: 'Too easy to guess. Use 12 characters or more; a sentence works.',
  bad_device: 'This device did not say what it is, so it cannot be attached to an account.',
  bad_credentials: 'That name and password do not go together. Try again, or use a recovery code.',
  rate_limited: 'Too many tries from here. Wait a minute, then try again.',
  unauthenticated: 'Sign in to see this.',
  not_found: 'There is nothing at that address.',
  last_device: 'This is the last device on the account. Add another before you revoke this one.',
  bad_profile: 'A display name is up to 40 characters, and a picture is a PNG, JPEG or WebP under 64 KB.',
  bad_desktop: 'A desktop registers its own name and up to 64 workspaces, each by name and id.',
  not_this_device: 'Only that desktop can say what is on it.',
  bad_origin: 'That request came from another site, so it was not carried out.',
  no_seat: 'No seat here yet. Buy one, or ask the owner for one.',
  not_owner: 'Only the owner of this team can seat people at it.',
  already_seated: 'That account already has a seat here.',
  bad_seat: 'A seat names a username, and a receipt is one short line of text.',
  malformed: 'That request was not something this registry could read.',
  method_not_allowed: 'That address does not answer to this method.'
}

/**
 * The subject is who or what the refusal is ABOUT — a username being typed, a
 * team being knocked on, the owner who could seat you. A sentence that can
 * name it says something a person can act on; the same sentence without it is
 * a shrug, so these four are written twice rather than once.
 */
export function sentenceFor(error: V2Error, subject?: string): string {
  if (subject === undefined) return SENTENCES[error]
  // The one refusal that is worth naming its subject: "taken" is the sentence
  // a person reads while typing, and "that name" is a worse answer than theirs.
  if (error === 'taken') return `@${subject} is someone else’s. Try another.`
  // At a door the 401 is not "sign in to see this" — it is the reason a seat
  // is worth signing in for at all (the copy table's own sentence).
  if (error === 'unauthenticated') return 'A seat is yours, not a browser’s. Sign in so it follows you.'
  if (error === 'no_seat') return `No seat here yet. Buy one, or ask @${subject} for one.`
  if (error === 'not_owner') return `Only @${subject} can seat people at this team.`
  if (error === 'already_seated') return `@${subject} already has a seat here.`
  return SENTENCES[error]
}

export const v2Error = (error: V2Error, subject?: string): { error: V2Error; message: string } => ({
  error,
  message: sentenceFor(error, subject)
})
