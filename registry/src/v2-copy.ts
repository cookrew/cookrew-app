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
  | 'bad_reach'
  | 'not_this_device'
  | 'bad_origin'
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
  bad_reach:
    'That address card is not this Mac’s. A desktop signs its own addresses, and they must be on your own network, your tailnet or a .local name.',
  not_this_device: 'Only that desktop can say what is on it.',
  bad_origin: 'That request came from another site, so it was not carried out.',
  malformed: 'That request was not something this registry could read.',
  method_not_allowed: 'That address does not answer to this method.'
}

export function sentenceFor(error: V2Error, subject?: string): string {
  // The one refusal that is worth naming its subject: "taken" is the sentence
  // a person reads while typing, and "that name" is a worse answer than theirs.
  if (error === 'taken' && subject !== undefined) return `@${subject} is someone else’s. Try another.`
  return SENTENCES[error]
}

export const v2Error = (error: V2Error, subject?: string): { error: V2Error; message: string } => ({
  error,
  message: sentenceFor(error, subject)
})
