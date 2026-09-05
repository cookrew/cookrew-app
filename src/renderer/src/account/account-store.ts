import {
  MIN_PASSWORD,
  isValidUsername,
  normaliseUsername,
  passwordStrength,
  type AccountRefusal,
  type AccountStatus,
  type PasswordStrength,
  type UsernameCheck,
} from '../../../shared/account-v2'

/**
 * THE ACCOUNT SURFACE'S VIEW-MODEL — every decision the screens make, and none
 * of the pixels.
 *
 * The sheets ask three questions and nothing else: what does the avatar show,
 * may the primary be pressed, and which sentence goes next to the field. All
 * three are pure functions of state here, so the answers can be asserted
 * without a DOM — and, more to the point, so the SENTENCES live in one place.
 *
 * THE COPY IS THE PRODUCT. Every refusal is a sentence from the UI/UX design's
 * copy table, verbatim. A screen that says "409" or "invalid input" is the
 * failure mode the design exists to prevent, and a sentence retyped in two
 * components is a sentence that drifts.
 */

/**
 * The copy table, word for word.
 *
 * Where D2's mock and the copy table word the same moment differently, the
 * COPY TABLE WINS — it is the later, canonical list, and the brief points at
 * it. (Two cases: TAKEN, whose mock adds "Yours if they release it"; and
 * REGISTRY_DOWN, whose mock ends "Everything local keeps working".) Sentences
 * the table does not carry are taken from the mock they appear in, named after
 * the screen.
 */
export const ACCOUNT_COPY = {
  /** D1 hover, no account. */
  NO_ACCOUNT:
    'Claim a username — serve teams and reach this Mac from anywhere. Everything here works without one.',
  /** D2, under the password field. */
  PASSWORD_RULE:
    'At least 12 characters. It unlocks Cookrew on this Mac and claims your name on another device. It goes only to cookrew.dev.',
  /** D2, a free name. */
  USERNAME_FREE: 'Yours to take. Lowercase letters, digits and dashes, 1–32.',
  /** D2, a name that is not a name. */
  USERNAME_INVALID: 'A username is lowercase letters, digits and dashes.',
  /** D2, weak. */
  PASSWORD_WEAK: 'Too easy to guess. Use 12 characters or more; a sentence works.',
  /** D2, the second field. */
  CONFIRM_MISMATCH: 'These two do not match yet.',
  /** D2, the secondary. */
  NOT_NOW: 'Not now keeps everything local. You can claim later from the avatar.',
  /** D3, under the three factor rows. */
  SECURITY_WHY:
    'Without a second factor, signing in on a new device needs your approval on this Mac. With one, it does not.',
  /** D3, the codes. */
  CODES_EACH: 'each opens the account once',
  /** D4, the Workspaces tab. */
  WORKSPACES_NOTE:
    'Names and ids only leave this Mac. "Reachable" is what cookrew.dev will offer your phone.',
  /** D4, the Seats tab, this phase. */
  NO_SEATS: 'No seats yet.',
  /** D5. */
  LOCKED_WHY: 'Locked while you were away. Your agents kept working.',
  /** The registry is not answering. */
  REGISTRY_DOWN:
    'cookrew.dev did not answer, so this name cannot be checked yet. Nothing local stops.',
} as const

/** "@anvz is someone else's. Try another." — the table, with the name in it. */
export function takenSentence(username: string): string {
  return `@${normaliseUsername(username)} is someone else's. Try another.`
}

/** The revoke confirmation, with the device named. */
export function revokeSentence(deviceName: string): string {
  return `The ${deviceName} stops opening this account within a minute. It keeps working on this Wi-Fi until re-paired.`
}

/** "Not it. 4 tries left before a 1-minute pause." */
export function wrongPasswordSentence(triesLeft: number): string {
  return `Not it. ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left before a 1-minute pause.`
}

/** After the pause has started, the same voice. */
export function pausedSentence(pausedForMs: number): string {
  const seconds = Math.max(1, Math.ceil(pausedForMs / 1000))
  return `Too many tries. Wait ${seconds} seconds and try again.`
}

/**
 * A refusal from main, as a sentence.
 *
 * The registry's own `message` is preferred whenever it sent one — the wire
 * says it is shown verbatim, and it is the only party that knows why THIS
 * request was refused. The fallbacks are the copy table.
 */
export function refusalSentence(reason: AccountRefusal, message?: string, username = ''): string {
  if (message) return message
  switch (reason) {
    case 'taken':
      return takenSentence(username)
    case 'bad_username':
      return ACCOUNT_COPY.USERNAME_INVALID
    case 'weak_password':
      return ACCOUNT_COPY.PASSWORD_WEAK
    case 'rate_limited':
      return 'cookrew.dev is asking us to slow down. Try again in a minute.'
    case 'offline':
      return ACCOUNT_COPY.REGISTRY_DOWN
    case 'session-expired':
    case 'bad_credentials':
      return 'Your session ended. Type your password once and this carries on.'
    case 'last_device':
      return 'This is the last device on the account, so it cannot be revoked.'
    case 'no_account':
      return 'There is no account on this Mac yet.'
    case 'bad_device':
    case 'unknown':
    default:
      return 'Something went wrong on this side. Try again.'
  }
}

/** Two letters on amber. The name is lowercase, the initials are not. */
export function initialsOf(username: string | null, displayName = ''): string {
  const source = (displayName || username || '').trim()
  if (source.length === 0) return '?'
  const words = source.split(/[\s._-]+/).filter((w) => w.length > 0)
  const letters = words.length > 1 ? `${words[0][0]}${words[1][0]}` : source.slice(0, 2)
  return letters.toUpperCase()
}

/** The avatar's three states (D1). */
export interface AvatarView {
  state: 'none' | 'claimed'
  /** Two letters, or '?' — a dashed circle wears the question mark. */
  initials: string
  /** The hover sentence. */
  title: string
  /** The rose badge's count, or null. Phase 4 raises it; the badge is real. */
  badge: number | null
  /** An uploaded picture, when the account has one. */
  avatar: string | null
}

export function avatarView(status: AccountStatus | null): AvatarView {
  if (!status || status.username === null) {
    return {
      state: 'none',
      initials: '?',
      title: ACCOUNT_COPY.NO_ACCOUNT,
      badge: null,
      avatar: null,
    }
  }
  const requests = status.requests > 0 ? status.requests : null
  return {
    state: 'claimed',
    initials: initialsOf(status.username, status.displayName),
    title:
      requests === null
        ? `@${status.username}`
        : `@${status.username} — ${requests} device${requests === 1 ? '' : 's'} waiting`,
    badge: requests,
    avatar: status.avatar,
  }
}

/** How a field's note reads: good news, a refusal, or plain guidance. */
export type Tone = 'good' | 'bad' | 'dim'

export interface FieldView {
  tone: Tone
  /** The short word beside the field: free ✓, taken, strong, matches ✓. */
  tag: string
  note: string
}

export interface ClaimFields {
  username: string
  /** The registry's answer, or 'checking' while the debounce is in flight. */
  check: UsernameCheck | 'checking'
  password: string
  confirm: string
}

export interface ClaimView {
  username: FieldView
  password: FieldView
  confirm: FieldView
  /** The primary's label — the name is in it, so it says what it will do. */
  primary: string
  /** Both lines green, and only then. */
  canClaim: boolean
}

const STRENGTH_TAG: Record<PasswordStrength, string> = {
  weak: 'weak',
  ok: 'ok',
  strong: 'strong',
}

function usernameField(raw: string, check: ClaimFields['check']): FieldView {
  const username = normaliseUsername(raw)
  if (username.length === 0) {
    return { tone: 'dim', tag: '', note: ACCOUNT_COPY.USERNAME_FREE }
  }
  if (!isValidUsername(username)) {
    return { tone: 'bad', tag: 'invalid', note: ACCOUNT_COPY.USERNAME_INVALID }
  }
  switch (check) {
    case 'free':
      return { tone: 'good', tag: 'free ✓', note: ACCOUNT_COPY.USERNAME_FREE }
    case 'taken':
      return { tone: 'bad', tag: 'taken', note: takenSentence(username) }
    case 'unknown':
      // NEVER OPTIMISTIC. The primary stays down, and the reason is the
      // registry's, not the person's.
      return { tone: 'bad', tag: 'unknown', note: ACCOUNT_COPY.REGISTRY_DOWN }
    case 'invalid':
      return { tone: 'bad', tag: 'invalid', note: ACCOUNT_COPY.USERNAME_INVALID }
    case 'checking':
    default:
      return { tone: 'dim', tag: 'checking…', note: ACCOUNT_COPY.USERNAME_FREE }
  }
}

function passwordField(password: string): FieldView {
  if (password.length === 0) {
    return { tone: 'dim', tag: '', note: ACCOUNT_COPY.PASSWORD_RULE }
  }
  const strength = passwordStrength(password)
  if (strength === 'weak') {
    return { tone: 'bad', tag: STRENGTH_TAG.weak, note: ACCOUNT_COPY.PASSWORD_WEAK }
  }
  return { tone: 'good', tag: STRENGTH_TAG[strength], note: ACCOUNT_COPY.PASSWORD_RULE }
}

function confirmField(password: string, confirm: string): FieldView {
  if (confirm.length === 0) return { tone: 'dim', tag: '', note: '' }
  if (confirm !== password) {
    return { tone: 'bad', tag: 'no match', note: ACCOUNT_COPY.CONFIRM_MISMATCH }
  }
  return { tone: 'good', tag: 'matches ✓', note: '' }
}

/**
 * The claim sheet, decided.
 *
 * `canClaim` is deliberately strict: a name the registry has confirmed FREE, a
 * password at or over the floor, and a matching confirmation. 'unknown' does
 * not pass — an enabled primary whose submission is refused is the outcome the
 * whole live-availability line exists to prevent.
 */
export function claimView(fields: ClaimFields): ClaimView {
  const username = usernameField(fields.username, fields.check)
  const password = passwordField(fields.password)
  const confirm = confirmField(fields.password, fields.confirm)
  const name = normaliseUsername(fields.username)
  return {
    username,
    password,
    confirm,
    primary: name.length > 0 ? `CLAIM @${name.toUpperCase()}` : 'CLAIM',
    canClaim:
      fields.check === 'free' &&
      isValidUsername(name) &&
      fields.password.length >= MIN_PASSWORD &&
      fields.confirm === fields.password,
  }
}

/** The lock screen's line under the avatar, whatever just happened. */
export function lockNote(
  outcome:
    | null
    | { ok: true }
    | { ok: false; reason: 'wrong'; triesLeft: number }
    | { ok: false; reason: 'paused'; pausedForMs: number }
    | { ok: false; reason: 'no-account' },
): string {
  if (outcome === null || outcome.ok) return ACCOUNT_COPY.LOCKED_WHY
  if (outcome.reason === 'wrong') return wrongPasswordSentence(outcome.triesLeft)
  if (outcome.reason === 'paused') return pausedSentence(outcome.pausedForMs)
  return 'There is no account on this Mac to unlock.'
}
