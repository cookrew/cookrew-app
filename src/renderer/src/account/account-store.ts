import { V3_COPY, accountCopy } from '../../../shared/account-copy'
import {
  LOCK_CHOICES,
  MIN_PASSWORD,
  isValidUsername,
  normaliseUsername,
  passwordStrength,
  usernameProblem,
  type AccountRefusal,
  type AccountStatus,
  type PasswordStrength,
  type UsernameCheck,
} from '../../../shared/account-v2'
import {
  APPROVAL_COPY,
  type FactorsView,
} from '../../../shared/account-approvals'

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
  /**
   * D1 hover, no account — now from the one source (V3-07).
   *
   * v2 said "Claim a username", which described our database. v3 says the two
   * things a person is deciding between, and that neither is required.
   */
  NO_ACCOUNT: V3_COPY['avatar.no-account'],
  /** D2, under the password field. */
  PASSWORD_RULE:
    'At least 12 characters. It unlocks Cookrew on this Mac and claims your name on another device. It goes only to cookrew.dev.',
  /** D2, a free name. */
  USERNAME_FREE: 'Yours to take. Lowercase letters, digits and dashes, 1–32.',
  /** D2, a name that is not a name. */
  USERNAME_INVALID: 'A username is lowercase letters, digits and dashes.',
  /**
   * D2, a name whose SHAPE is fine and whose prefix is not ours to give.
   *
   * The lowercase-and-dashes sentence was being shown for this, about a name
   * that was already lowercase — so the person retyped it, was refused again,
   * and had no way to learn the real rule.
   */
  USERNAME_RESERVED: 'acct- is reserved for the doors — pick another name.',
  /** D2, weak. */
  PASSWORD_WEAK: 'Too easy to guess. Use 12 characters or more; a sentence works.',
  /** D2, the second field. */
  CONFIRM_MISMATCH: 'These two do not match yet.',
  /**
   * D9, the secondary. v2 said "claim later"; the avatar's door is SIGN IN
   * first now, so the sentence names the door a person will actually find.
   */
  NOT_NOW: 'Not now keeps everything local. You can sign in later from the avatar.',
  /** D9, the sign-in side, under the name. No check runs here, so no verdict. */
  SIGNIN_USERNAME_HINT: 'Your username at cookrew.dev.',
  /** D9, the sign-in side, under the password. No rule: it is an existing password. */
  SIGNIN_PASSWORD_HINT: 'It goes only to cookrew.dev.',
  /** D8, the card's caption. */
  FIRST_RUN_TITLE: 'Use this Mac with your Cookrew account',
  /** D8, what an account is for — and that nothing here waits on one. */
  FIRST_RUN_LEDE:
    'Serve teams, reach this Mac from your phone, take your seats with you. Nothing local needs it.',
  /** D8, the join half. Drawn by nobody until cut 2 ships JOIN. */
  FIRST_RUN_JOIN_ASK: 'Have Cookrew on another device?',
  FIRST_RUN_JOIN_HOW: 'On your phone or other Mac: avatar → Devices → ADD A MAC.',
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
  /** The LOCK NOW row, under the delay. */
  LOCK_NOW_WHY: 'Locking hides your canvas behind your password. Your agents keep working.',
  /** The session ended — said only beside the field that ends it. */
  SESSION_ENDED: 'Your session ended. Type your password once and this carries on.',
  /**
   * The registry wants one more step — and this card is where it is taken.
   *
   * THE OLD SENTENCE SENT THE OWNER SOMEWHERE ELSE ("use a recovery code on
   * cookrew.dev"), which on a Mac with no session is a place they cannot get
   * to and, worse, is not where the step needs to happen: the pending is this
   * app's, and only this app can finish it. The sentence now describes the
   * rungs that are on screen underneath it.
   */
  SESSION_SECOND_FACTOR: 'One more step. Prove it is you, and this carries on.',
  /** Over the six-digit field. */
  LADDER_TOTP_LABEL: 'Authenticator code',
  LADDER_TOTP_HINT: 'The six digits your authenticator app is showing now.',
  /** Over the rescue field, once the owner has asked for it. */
  LADDER_RECOVERY_LABEL: 'Recovery code',
  LADDER_RECOVERY_HINT: 'One of the codes you saved. Each opens the account exactly once.',
  /** The approve rung, before and after it is pressed. */
  LADDER_ASK: 'Ask my other device',
  /**
   * D10, AFTER ASKING — HONEST ABOUT THE PHONE.
   *
   * "Approve it on your phone" promised a push that does not exist: nothing
   * rings, nothing lights up, and the owner stood there waiting for a phone
   * that had not been told. The sentence now says where the request can be
   * FOUND, which is the only thing that is true.
   */
  LADDER_ASKED_HONEST: 'Asked. Open cookrew.dev on your phone, or look at your other Mac.',
  /**
   * D10, THE JOIN LEDE — the tail of the sentence; `joinLede` puts the name
   * in front of it. A first join is not an expired session, and a card that
   * said "Your session ended" to a Mac that never had one would be lying
   * about what happened. The ladder takes this from its caller, never from
   * its own body, so the two doors can say two different true things.
   */
  LADDER_JOIN_LEDE: 'is already on another device. Prove it is you and this Mac joins.',
  /**
   * The ladder is over and the password step is the way back.
   *
   * Said as an instruction, not as an apology: the person is looking at a card
   * that is about to change under them, and the next thing to do is the whole
   * message.
   */
  LADDER_OVER: 'That sign-in was dropped. Type your password again.',
  /** D5. */
  LOCKED_WHY: 'Locked while you were away. Your agents kept working.',
  /**
   * D13, THE LOCK KNOWS WHO IS WAITING — the tail; `lockWaitingSentence`
   * puts the device, or the count, in front of it. The idle lock is the
   * moment a request is most likely to arrive, because the owner is at the
   * other machine; a lock that hid the request would be the one screen that
   * could not say the most useful thing it knows.
   */
  LOCK_WAITING: 'is waiting to join — unlock to answer.',
  /** The registry is not answering. */
  REGISTRY_DOWN:
    'cookrew.dev did not answer, so this name cannot be checked yet. Nothing local stops.',
  /**
   * D2, PHASE 6 — a cookrew.dev that predates passwords.
   *
   * The sentence has to be a promise, not an error: this Mac is serving under
   * this name right now and nothing about that changes because the crossing
   * is not available yet.
   */
  REGISTRY_NO_V2: 'cookrew.dev is not ready for passwords yet — nothing changes until it is.',
  /** D2, phase 6: NOT NOW, said for a Mac that is already serving. */
  LEGACY_KEEP_SERVING:
    'Not now keeps this Mac serving under the name it has. You can set the password later from the avatar.',
  /** D2, phase 6: the name is already this person's, on another device's key. */
  LEGACY_ELSEWHERE:
    'This name belongs to a key on another device — set the password there, or use that device to link this one.',
} as const

/**
 * "You are @drej here already — set a password to keep it." (phase 6)
 *
 * The whole legacy step in one line: nothing is being claimed, nothing is at
 * risk, and the only thing missing is the password.
 */
export function legacySentence(handle: string): string {
  return `You are @${normaliseUsername(handle)} here already — set a password to keep it.`
}

/**
 * D4, phase 6 — the environment still names something, and it is ignored.
 *
 * The old sentence said serving kept the environment's handle "until a later
 * phase". This is that phase: the account decides, and a person reading two
 * names on one screen is owed the one that is true.
 */
export function envIgnoredSentence(env: string, username: string): string {
  return (
    `COOKREW_HANDLE names @${normaliseUsername(env)}; this Mac serves as @${normaliseUsername(username)}. ` +
    'The environment is a development override now, not a name.'
  )
}

/** The 409 a stranger gets for a name that is waiting for its password. */
export function legacyTakenSentence(username: string): string {
  return `@${normaliseUsername(username)} already exists from before passwords — sign in with the key that holds it and set a password.`
}

/**
 * A name that exists, said on the CREATE side.
 *
 * v2 answered "@anvz is someone else's. Try another." — which is true, useless,
 * and wrong about what the person wants: on their own name they are one field
 * away from being signed in, not in need of a different name. v3 hands them the
 * other door (D9 crossing).
 */
export function takenSentence(username: string): string {
  return accountCopy('d9.crossing.taken', { handle: normaliseUsername(username) })
}

/**
 * The revoke confirmation — the sentence IS the security contract.
 *
 * v2 promised less than the system does: it said the device keeps working on
 * this Wi-Fi until re-paired, while revoking actually drops LAN admission on
 * every Mac within a minute. Under-promising is the worse direction for a
 * security control, because someone revoking a lost phone was being told it
 * still held their keyboard.
 */
export function revokeSentence(deviceName: string): string {
  return accountCopy('d12.revoke', { device: deviceName })
}

/**
 * D12: what SIGN OUT ON THIS MAC does, said before it is done — what leaves
 * (this Mac), what stays (the canvas), what goes quiet (the doors).
 */
export function signOutSentence(username: string): string {
  return accountCopy('d12.sign-out', { handle: normaliseUsername(username) })
}

/**
 * The two verbs cut 2 adds to the Devices tab (V3-10, V3-12). Rendered now,
 * disabled, so the tab already has the shape it will keep — a button that
 * appears later is a feature nobody can find; one that says when it comes is
 * a promise.
 */
export const COMING_IN_CUT_2 = 'Coming in cut 2'

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
    case 'no_passwords_yet':
      return ACCOUNT_COPY.REGISTRY_NO_V2
    case 'legacy':
      return legacyTakenSentence(username)
    case 'session-expired':
    case 'bad_credentials':
      // THE SENTENCE AND THE FIELD TRAVEL TOGETHER. It is a constant so that
      // ResumeSession — the one component that offers somewhere to type the
      // password — is the only thing that can say it.
      return ACCOUNT_COPY.SESSION_ENDED
    case 'second_factor':
      return ACCOUNT_COPY.SESSION_SECOND_FACTOR
    // THE LADDER'S OWN REFUSALS. cookrew.dev sends a sentence for every one of
    // these and it wins above; these are the fallbacks for a registry that
    // answered a bare error, and they keep the same split the reasons do —
    // "type it again" versus "start again".
    case 'bad_code':
      return 'That is not the code showing right now. Wait for the next one and type it as it appears.'
    case 'bad_recovery':
      return 'That is not one of your recovery codes. Each one opens the account exactly once.'
    case 'passkey_refused':
      return 'That passkey did not answer for this account. Try another way in.'
    case 'expired':
    case 'not_offered':
      return ACCOUNT_COPY.LADDER_OVER
    case 'too_many_attempts':
      return 'Too many tries on this sign-in. Type your password again.'
    case 'denied':
      return 'That sign-in was denied on your other device. Nothing was attached.'
    case 'password_change_required':
      return 'Somebody said a sign-in was not them, so this password is locked out until you change it. Change it on a device you are still signed in on.'
    case 'last_device':
      // Not "the button is disabled" but what would be lost, and the step
      // that makes the button work. The named sentence when this refusal
      // carries a username, the unnamed one when it was raised before the
      // account was known.
      return username
        ? accountCopy('d12.last-device', { handle: normaliseUsername(username) })
        : accountCopy('d12.last-device.unnamed')
    case 'no_account':
      return 'There is no account on this Mac yet.'
    case 'bad_device':
      return 'cookrew.dev does not know this Mac as a device on the account. Sign in again here.'
    case 'unknown':
    default:
      // NOT "something went wrong": that sentence was on screen for eleven
      // different failures and told a person nothing about any of them. This
      // one at least says who answered and what it cost them — nothing.
      return 'cookrew.dev answered something this app could not read. Nothing was changed.'
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
  const problem = usernameProblem(username)
  if (problem === 'shape') {
    return { tone: 'bad', tag: 'invalid', note: ACCOUNT_COPY.USERNAME_INVALID }
  }
  if (problem === 'reserved') {
    // Judged locally and named, rather than waiting for the registry to answer
    // `bad_username` and rendering it as a sentence about lowercase.
    return { tone: 'bad', tag: 'reserved', note: ACCOUNT_COPY.USERNAME_RESERVED }
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
    case 'reserved':
      return { tone: 'bad', tag: 'reserved', note: ACCOUNT_COPY.USERNAME_RESERVED }
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
    // D9's word. "Claim" described our database; "create" is what the tab says.
    primary: name.length > 0 ? `CREATE @${name.toUpperCase()}` : 'CREATE',
    canClaim:
      fields.check === 'free' &&
      isValidUsername(name) &&
      fields.password.length >= MIN_PASSWORD &&
      fields.confirm === fields.password,
  }
}

/**
 * THE SAME SHEET, FOR A NAME THAT IS ALREADY YOURS (phase 6).
 *
 * No username field and no availability check: the name is whatever key this
 * Mac holds, and offering to type one would offer a choice the registry will
 * not honour. So the view is the password half of D2 and one sentence saying
 * why there is nothing above it.
 */
export interface MigrateView {
  lead: string
  password: FieldView
  confirm: FieldView
  primary: string
  canClaim: boolean
}

export function migrateView(
  fields: { password: string; confirm: string },
  handle: string,
): MigrateView {
  return {
    lead: legacySentence(handle),
    password: passwordField(fields.password),
    confirm: confirmField(fields.password, fields.confirm),
    primary: 'SET A PASSWORD',
    canClaim: fields.password.length >= MIN_PASSWORD && fields.confirm === fields.password,
  }
}

/**
 * THE ONE SHEET'S THREE STATES (D9).
 *
 * SIGN IN is the default: a person registers once and installs many times.
 * 'legacy' is the phase-6 migration exactly as it was — a Mac holding a v1
 * key has no choice to make, only a password to set — and it is decided by
 * the status, never by a tab.
 */
export type SheetState = 'signin' | 'register' | 'legacy'

export interface SignInFields {
  username: string
  password: string
}

export interface SignInView {
  lede: string
  username: FieldView
  password: FieldView
  primary: string
  /** A well-formed name and any password at all: the registry is the judge. */
  canGo: boolean
  footNote: string
}

/**
 * The sign-in side, decided.
 *
 * NO AVAILABILITY CHECK AND NO LENGTH GATE. The check would leak, one HEAD
 * per keystroke, whether every name a person tries exists — and the twelve-
 * character floor is a rule for NEW passwords, not for the one somebody set
 * last year. The name is judged for shape only, locally, with the same rule
 * the create side uses, so a name that cannot exist is refused before the
 * wire and a name that might is left to cookrew.dev.
 *
 * `crossed` is the sentence a crossing from CREATE left behind ("@drej
 * already exists — sign in with your password."). It wears the "yours?" tag
 * because that is the claim being made: the name is probably this person's.
 */
export function signInView(fields: SignInFields, crossed: string | null = null): SignInView {
  const name = normaliseUsername(fields.username)
  const problem = name.length === 0 ? 'ok' : usernameProblem(name)
  const username: FieldView =
    problem === 'shape'
      ? { tone: 'bad', tag: 'invalid', note: ACCOUNT_COPY.USERNAME_INVALID }
      : problem === 'reserved'
        ? { tone: 'bad', tag: 'reserved', note: ACCOUNT_COPY.USERNAME_RESERVED }
        : crossed !== null && name.length > 0
          ? { tone: 'good', tag: 'yours?', note: crossed }
          : { tone: 'dim', tag: '', note: ACCOUNT_COPY.SIGNIN_USERNAME_HINT }
  return {
    lede: V3_COPY['d9.signin.lede'],
    username,
    password: { tone: 'dim', tag: '', note: ACCOUNT_COPY.SIGNIN_PASSWORD_HINT },
    primary: 'CONTINUE',
    canGo: isValidUsername(name) && fields.password.length > 0,
    footNote: ACCOUNT_COPY.NOT_NOW,
  }
}

export interface RegisterView extends ClaimView {
  lede: string
}

/**
 * The create side: D2's fields under a tab, with the create lede.
 *
 * `crossed` is the sentence a crossing from SIGN IN left behind ("There is
 * no @foo yet — take it now."). It is shown ONLY while the live check agrees
 * the name is free: the crossing was decided on one HEAD, and if the next
 * one says otherwise the check's own sentence is the true one.
 */
export function registerView(fields: ClaimFields, crossed: string | null = null): RegisterView {
  const view = claimView(fields)
  const username: FieldView =
    crossed !== null && fields.check === 'free' ? { ...view.username, note: crossed } : view.username
  return { ...view, username, lede: V3_COPY['d9.create.lede'] }
}

/**
 * THE REGISTRY'S OWN BUDGET FOR A PASSWORD, mirrored so the sentence can
 * count. cookrew.dev allows this many POST /v2/sessions per name per minute
 * (registry/src/v2-http.ts, `sessionsPerMinute`) and answers 429 after; the
 * sheet counts its own wrong answers against the same number so "4 tries
 * left" is a true statement and not a decoration.
 */
export const SIGNIN_TRIES_PER_MINUTE = 5
export const SIGNIN_PAUSE_MS = 60_000

/** Wrong passwords spent so far, and the name they were spent on. */
export interface TriesSpent {
  name: string
  count: number
}

/**
 * The count that applies after an answer — WHICH IS PER NAME.
 *
 * The registry's budget belongs to the account, not to the sheet, so a tally
 * carried across a change of name makes the sentence lie in the mean
 * direction: mistype once on @foo, cross to @bar, and the sheet would say "3
 * tries left" where cookrew.dev still allows four. A number offered to
 * someone as a fact has to be one, so a new name starts at zero.
 *
 * `refused` is whether THIS answer was a refused password; anything else (a
 * pause, a ladder, a network problem) leaves the tally where it was.
 */
export function triesFor(held: TriesSpent, name: string, refused: boolean): TriesSpent {
  const spent = held.name === name ? held.count : 0
  return { name, count: refused ? spent + 1 : spent }
}

/**
 * Where a refusal lands the sheet.
 *
 * Three shapes and not a flag on one: a crossing changes the state and keeps
 * the name; a stay keeps the state and says why; a ladder leaves this sheet
 * for D10. Typing them apart is what stops a component from printing the
 * crossing sentence without also changing the tab under it.
 */
export type Landing =
  | { kind: 'cross'; to: 'signin' | 'register'; sentence: string }
  | { kind: 'stay'; sentence: string }
  | { kind: 'ladder'; lede: string }

export interface CrossingInput {
  state: 'signin' | 'register'
  username: string
  refusal: { reason: AccountRefusal; message?: string }
  /**
   * HEAD /v2/accounts/:name, asked ONCE after a refused password — the only
   * time the sign-in side ever asks. Null when there was nothing to ask, or
   * no way to. 'unknown' and null are both "do not guess".
   */
  check?: UsernameCheck | null
  /** Wrong passwords so far on this name, this one included. */
  wrongTries?: number
}

/**
 * THE CROSSINGS (D9) — a wrong tab is never a dead end.
 *
 *   CREATE, and the name exists      → SIGN IN, the name kept, the table's sentence.
 *   SIGN IN, refused, and HEAD says 404 → CREATE, the name kept, "take it now".
 *   SIGN IN, refused, and the name exists → stays; the tries left, counted.
 *
 * The password refusal arrives as 'session-expired': main folds a wrong
 * password into the reason the resume field already keeps open (v3-01), and
 * this sheet reads both spellings as the same fact. The registry's own
 * sentence for it ("…or use a recovery code") is NOT shown here — it names a
 * field this sheet does not have, and the count is the useful thing to say.
 * Every other refusal keeps the registry's sentence, as everywhere else.
 */
export function crossingFor(input: CrossingInput): Landing {
  const name = normaliseUsername(input.username)
  const { reason, message } = input.refusal
  if (reason === 'second_factor') return { kind: 'ladder', lede: joinLede(name) }
  if (input.state === 'register' && reason === 'taken') {
    return { kind: 'cross', to: 'signin', sentence: takenSentence(name) }
  }
  if (input.state === 'signin') {
    if (reason === 'rate_limited') return { kind: 'stay', sentence: pausedSentence(SIGNIN_PAUSE_MS) }
    if (reason === 'bad_credentials' || reason === 'session-expired') {
      if (input.check === 'free') {
        return { kind: 'cross', to: 'register', sentence: accountCopy('d9.crossing.unknown', { handle: name }) }
      }
      const left = SIGNIN_TRIES_PER_MINUTE - (input.wrongTries ?? 1)
      return {
        kind: 'stay',
        sentence: left > 0 ? wrongPasswordSentence(left) : pausedSentence(SIGNIN_PAUSE_MS),
      }
    }
  }
  return { kind: 'stay', sentence: refusalSentence(reason, message, name) }
}

/** What one of the first-run card's buttons does. */
export type FirstRunAction = 'signin' | 'register' | 'dismiss'

export interface FirstRunView {
  title: string
  lede: string
  /** The join half — null until the cut that ships JOIN. */
  join: { ask: string; how: string } | null
  buttons: readonly { action: FirstRunAction; label: string }[]
}

/**
 * JOIN ships in cut 2 (V3-10). Until then the whole join half of the card is
 * absent rather than disabled: a greyed button with no way to make it work
 * is a card asking a question it cannot answer.
 */
const FIRST_RUN_JOIN_SHIPS = false

export interface FirstRunInput {
  status: AccountStatus | null
  /**
   * How many workspaces this Mac has. A fresh install seeds ONE, with a
   * Conductor on it, so "no workspaces" in the design's words is "none the
   * person made": one is fresh, two is a Mac somebody has been using.
   */
  workspaceCount: number | null
  /** Closed once, closed for good. */
  dismissed: boolean
}

/**
 * THE FIRST-RUN CARD (D8), or null — which is the answer on every Mac but a
 * fresh one. No account file, no v1 key, no workspace of the person's own, and
 * never closed. Both facts must be KNOWN: a card drawn while the status is
 * still loading would flash at every owner on every launch.
 */
export function firstRunView(input: FirstRunInput): FirstRunView | null {
  const { status, workspaceCount } = input
  if (input.dismissed || status === null || workspaceCount === null) return null
  if (status.username !== null || status.legacy !== null || workspaceCount > 1) return null
  return {
    title: ACCOUNT_COPY.FIRST_RUN_TITLE,
    lede: ACCOUNT_COPY.FIRST_RUN_LEDE,
    join: FIRST_RUN_JOIN_SHIPS
      ? { ask: ACCOUNT_COPY.FIRST_RUN_JOIN_ASK, how: ACCOUNT_COPY.FIRST_RUN_JOIN_HOW }
      : null,
    buttons: [
      { action: 'signin', label: 'SIGN IN WITH PASSWORD' },
      { action: 'register', label: 'CREATE AN ACCOUNT' },
      { action: 'dismiss', label: 'NOT NOW' },
    ],
  }
}

/** D10: the sentence over a first join's ladder, with the name in front. */
export function joinLede(username: string): string {
  return `@${username} ${ACCOUNT_COPY.LADDER_JOIN_LEDE}`
}

/**
 * WHO IS WAITING UNDER THE LOCK (D13).
 *
 * `count` is `AccountStatus.requests` and is always known; `names` are the
 * device names of those requests IF the lock screen has been able to read the
 * list, else empty. The two are separate on purpose: the count arrives with
 * the status push, the names take a second call, and a lock that said nothing
 * until the names came would be quiet exactly when it was first asked.
 */
export interface LockWaiting {
  count: number
  names: readonly string[]
}

export const NOBODY_WAITING: LockWaiting = { count: 0, names: [] }

/** The D13 toast line, or null when there is nothing to answer. */
export function lockWaitingSentence(waiting: LockWaiting): string | null {
  if (waiting.count <= 0) return null
  if (waiting.count === 1) {
    const who = waiting.names[0] ?? 'A device'
    return `${who} ${ACCOUNT_COPY.LOCK_WAITING}`
  }
  // Several: the count is the news, and a list of names on a locked screen
  // would be a longer sentence about something nobody can act on from here.
  return `${waiting.count} devices are waiting to join — unlock to answer.`
}

/** What the lock screen says: the line under the avatar, and who is waiting. */
export interface LockNote {
  line: string
  /** D13: the request toast, or null. Beside the line, never instead of it. */
  waiting: string | null
}

/** The lock screen's lines, whatever just happened and whoever is waiting. */
export function lockNote(
  outcome:
    | null
    | { ok: true }
    | { ok: false; reason: 'wrong'; triesLeft: number }
    | { ok: false; reason: 'paused'; pausedForMs: number }
    | { ok: false; reason: 'no-account' },
  waiting: LockWaiting = NOBODY_WAITING,
): LockNote {
  return { line: lockLine(outcome), waiting: lockWaitingSentence(waiting) }
}

function lockLine(outcome: Parameters<typeof lockNote>[0]): string {
  if (outcome === null || outcome.ok) return ACCOUNT_COPY.LOCKED_WHY
  if (outcome.reason === 'wrong') return wrongPasswordSentence(outcome.triesLeft)
  if (outcome.reason === 'paused') return pausedSentence(outcome.pausedForMs)
  return 'There is no account on this Mac to unlock.'
}

/** One row of the security card's factor ladder (D3). */
export interface FactorRow {
  /** A stable key, and what the row acts on when it is a REMOVE. */
  id: string
  label: string
  /** The small word on the right: RECOMMENDED, ACTIVE, or nothing. */
  state: string
  action: 'add' | 'remove'
  /** Which factor this row belongs to, so the card knows what to call. */
  factor: 'passkey' | 'totp'
}

/**
 * The two factor rows, in the order the ruling fixed: PASSKEY FIRST.
 *
 * A passkey is recommended only while there is none — an account that already
 * has one does not need to be nagged towards a second, and RECOMMENDED next
 * to a row that is already done is how a card stops being read at all. Each
 * enrolled passkey gets its OWN row so it can be removed by name; the
 * authenticator is one row because an account has one secret.
 */
export function factorRows(
  factors: FactorsView | null,
  format: (at: number) => string = (at) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
): readonly FactorRow[] {
  const passkeys = factors?.passkeys ?? []
  // EVERY ENROLLED PASSKEY IS A ROW, and the ADD row stays underneath them.
  // The card listed either the keys or the invitation, never both, so a
  // passkey enrolled in a browser was invisible on the Mac while the card
  // went on recommending the thing the account already had.
  const enrolled: readonly FactorRow[] = passkeys.map((passkey) => ({
    id: passkey.id,
    label: passkey.name,
    state: `Added ${format(passkey.addedAt)}`,
    action: 'remove' as const,
    factor: 'passkey' as const,
  }))
  const addPasskey: FactorRow = {
    id: 'passkey',
    label: 'Add a passkey (Touch ID)',
    // RECOMMENDED only while there is none: a card that keeps recommending
    // something already done stops being read.
    state: enrolled.length === 0 ? 'RECOMMENDED' : '',
    action: 'add',
    factor: 'passkey',
  }
  const totp: FactorRow = factors?.totp
    ? {
        id: 'totp',
        label: 'Authenticator app',
        state: 'ACTIVE',
        action: 'remove',
        factor: 'totp',
      }
    : {
        id: 'totp',
        label: 'Add an authenticator app',
        state: '',
        action: 'add',
        factor: 'totp',
      }
  return [...enrolled, addPasskey, totp]
}

/**
 * The banner after "not me" — or null, which is the normal state.
 *
 * It is a SENTENCE ABOUT WHAT HAPPENED, not an instruction: the person is
 * being told that every other device was signed out, which is the fact that
 * explains why they are being asked for a new password at all.
 */
export function mustChangeBanner(factors: FactorsView | null): string | null {
  return factors?.mustChangePassword === true ? APPROVAL_COPY.MUST_CHANGE : null
}

/**
 * "Your password, to remove the authenticator."
 *
 * The prompt names WHAT is being taken off, because a password field that
 * appears with no subject reads as a session having expired — and the two
 * call for opposite reactions from the person looking at it.
 */
export function removeFactorPrompt(row: FactorRow): string {
  return row.factor === 'totp'
    ? 'Your password, to remove the authenticator'
    : 'Your password, to remove this passkey'
}

/**
 * WHAT MAKES THE DEVICES TAB RE-READ ITSELF.
 *
 * The username, and the number of devices still waiting. An approval attaches
 * a device at the registry, so the moment that count drops is the moment the
 * list on screen is out of date — and a tab that only refreshes when the
 * sheet is closed and reopened tells an owner their approval did nothing.
 */
export function profileKey(status: { username: string | null; requests: number }): string {
  return `${status.username ?? ''}#${status.requests}`
}

/**
 * What the passkey row says when THIS Electron cannot make one.
 *
 * Not an apology and not a dead end: a passkey added in a browser is a
 * passkey on the account, so the row hands over the one place it does work.
 * The alternative — a button that throws a WebAuthn error into a console the
 * owner will never open — is the same row lying about what it does.
 */
export function passkeyElsewhere(registry: string): { note: string; url: string } {
  return { note: APPROVAL_COPY.PASSKEY_ELSEWHERE, url: `${registry}/me#security` }
}

/**
 * The idle delay, said the way the card says it.
 *
 * A delay nobody set is not 'off' — an unrecognised number means the setting
 * came from somewhere this build does not know about, and calling it off would
 * be the one wrong answer a security card can give.
 */
export function lockLabel(ms: number): string {
  if (ms <= 0) return 'off'
  return LOCK_CHOICES.find((choice) => choice.ms === ms)?.label ?? `${Math.round(ms / 60_000)} min`
}

/** The LOCK row's label, which names the delay it will actually wait. */
export function lockRowLabel(ms: number): string {
  return ms > 0 ? `Lock Cookrew after ${lockLabel(ms)} idle` : 'Lock Cookrew when idle'
}

/**
 * The RESCUE row's state.
 *
 * Saved wins over a count: the owner told us they wrote the codes down, and a
 * row that keeps saying NOT SAVED afterwards is wrong about the only thing it
 * tracks. The registry's remaining count is shown beside it when it sent one —
 * it is the fact the local flag cannot know (a code that has been spent).
 */
export function rescueState(
  savedAt: number | null | undefined,
  codesLeft: number | null | undefined,
  format: (at: number) => string = (at) =>
    new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
): { saved: boolean; label: string } {
  // Nullish, not `=== null`: a status from an older main has the field absent,
  // and "undefined" taking the saved branch is how a card ends up announcing
  // "Saved Invalid Date".
  const saved = savedAt ?? null
  const left = codesLeft ?? null
  if (saved === null && (left === null || left === 0)) {
    return { saved: false, label: 'NOT SAVED' }
  }
  if (saved === null) return { saved: true, label: `${left} LEFT` }
  const note = `Saved ${format(saved)}`
  return { saved: true, label: left === null ? note : `${note} · ${left} left` }
}

/**
 * A device name as a person calls it.
 *
 * macOS hands out "Drej's MacBook Pro.local"; the ".local" is mDNS plumbing
 * and reads, in a list of devices, as part of the name someone chose. Only the
 * suffix goes — the rest is theirs.
 */
export function deviceName(raw: string): string {
  return raw.replace(/\.local$/i, '').trim() || raw
}
