import { hostPlatform, machineCopy, machineTable, registryCopy } from './machine-words'

/**
 * THE ACCOUNT'S SENTENCES — one source for desktop and web (V3-07).
 *
 * Identity v3 gave the account a password, a join code, a request queue and a
 * device list, and the sentences for all of it were being written three times:
 * once in account-store.ts for the desktop cards, once in auth-gate.ts for the
 * companion, and once by hand inside the registry's HTML. Three copies of a
 * sentence is three chances for a refusal to say something the other two do
 * not, and a person who reads the same refusal differently on their Mac and on
 * their phone learns that one of them is lying.
 *
 * So every sentence from the design's copy table lives here, keyed by the
 * table's own Moment column in lower-kebab. Surfaces borrow; none carries.
 *
 * THREE RULES THE TABLE IS WRITTEN UNDER, kept here so an addition keeps them:
 *
 *   No sentence says "error", "invalid", or a status number. Those are our
 *   words for our machinery. A refusal is a sentence with a next step in it —
 *   if there is no next step, the sentence is not finished.
 *
 *   A device, a door and a person are named, never described. "The iPhone",
 *   "@drej", "alpha" — the placeholders below exist so the sentence reads as
 *   being about the thing in front of the person, not about a category.
 *
 *   What survives is said in the same breath as what stopped. Revoking says
 *   the canvas stays; signing out says the doors go offline; the last device
 *   says what would be lost, not that the button is disabled.
 *
 * NOTHING HERE RENDERS UNTIL A SURFACE IMPORTS IT. The table covers moments
 * across all three cuts; V3_COPY is the v3 namespace the issue asks for, so a
 * sentence whose feature lands in cut 2 or 3 sits here, typed and tested, and
 * is drawn by nobody until its lane wires it.
 */
export const V3_COPY = machineTable({
  /** D1 hover with no account. Replaces "Claim a username — …". */
  'avatar.no-account':
    'Sign in — or create an account. Serve teams and reach this Mac from anywhere. Everything here works without one.',

  /** D9, the sign-in side of the one door. */
  'd9.signin.lede': 'A username and a password. This Mac becomes a device on your account.',
  /** D9, the create side. The site never asks for an email, so the lede says so. */
  'd9.create.lede':
    'This Mac becomes your first device. A username and a password — nothing else is asked for.',
  /**
   * D9, typing a name that exists while on CREATE. It is not a refusal: the
   * person is one field away from the thing they wanted, so the sentence hands
   * them the other door instead of telling them to think of another name.
   */
  'd9.crossing.taken': '@{handle} already exists — sign in with your password.',
  /**
   * D9, a deleted name on CREATE. Unlike a taken one there is nobody to sign in
   * as, so it hands over no door: it only asks for another name.
   */
  'd9.crossing.retired': '@{handle} cannot be used. Choose another name.',
  /**
   * D9, the label on the way out of a taken name (V3-UI1 · F2).
   *
   * A real-interface pass found CREATE showing "@magpie already exists — sign
   * in with your password." beside a DISABLED primary, with nothing anywhere
   * to press: the sentence named the way out and the sheet offered no way to
   * take it. The button becomes the crossing, and says so — a primary that
   * still read CREATE and then signed somebody in would be worse than the
   * dead end it replaced.
   */
  'd9.crossing.taken-primary': 'SIGN IN AS @{handle}',
  /**
   * D4 · THE ENVIRONMENT STILL NAMES SOMETHING, AND THE ACCOUNT WINS
   * (V3-UI1 · F5).
   *
   * The old sentence read "COOKREW_HANDLE names @drej; this Mac serves as
   * @magpie." A real-interface pass read that on a profile showing @magpie and
   * called it a contradiction — and the second clause is in fact the untrue
   * one, for a reason the screen could not see: the serving handle is resolved
   * ONCE at boot (relayHandle, main), so a Mac that started local-only and
   * signed in afterwards is still serving under whatever the environment or
   * its old key said. The sheet cannot know that, so it no longer claims it.
   *
   * What is left is what this surface does know and the phase-6 ruling it is
   * here to state: the account is the name, and COOKREW_HANDLE is a
   * development override.
   */
  'd4.env-override':
    'This launch names @{env}. Your account is @{handle}, and the account is the name — the launch setting is a development override.',
  /** D9, typing a free name while on SIGN IN. The mirror of the above. */
  'd9.crossing.unknown': 'There is no @{handle} yet — take it now.',

  /** D10, the lede. Replaces "Your session ended…", which is kept for resume. */
  'd10.join.lede': '@{handle} is already on another device. Prove it is you and this Mac joins.',
  /** D10 after asking. The number is on THIS Mac and typed on the other one. */
  'd10.asked': 'Asked. On your phone or other Mac, type the number below to let this Mac in.',
  /** D10, the honest half: where to look. Nobody is pushed a notification. */
  'd10.asked.honest': 'Open cookrew.dev on your phone, or look at your other Mac.',
  /** D10, a wrong number. Spent, not "invalid" — and the next step is to ask again. */
  'd10.mismatch':
    'The number typed on your other device did not match. Ask again — this one is spent.',

  /** D11, the join request, as the approver reads it. */
  'd11.join-row': 'What number is on that Mac?',
  /**
   * D11, someone asking for a seat.
   *
   * NO SUCH ROW ARRIVES ANY MORE (0.6.0): the registry has no route to ask on
   * and the app has no row for it. The sentence stays because the account
   * page still hands it to its script (registry/src/site-account.ts,
   * `data-seat-row`), which keeps a branch for a row of that kind.
   */
  'd11.seat-row': '@{handle} asks for a seat at {team}.',
  /**
   * D11, the join row's own lead, above the number field. The device names
   * ITSELF here — the sentence quotes what a stranger's machine calls itself,
   * so it reads as a claim being made rather than as our description of it.
   */
  'd11.join-lead': '{device} wants to join @{handle}',
  /** D11 over-state, a device that is on the account now. */
  'd11.join-done': '{device} joined @{handle}',
  /**
   * D11, a sign-in somebody disowned. It names WHERE it was answered, because
   * the owner reading this a day later needs to know which of their devices
   * they were holding when they said no.
   */
  'd11.denied': 'A sign-in as @{handle} was denied on {device}',
  /** D11, an empty queue. The ordinary state, and it says what would land here. */
  'd11.empty': 'Nothing is waiting. Devices asking to join land here.',
  /** D11, what each button in the queue actually does — including NOT ME. */
  'd11.footer':
    'APPROVE needs the number. NOT ME signs every other device out and locks the password until you change it.',

  /** The event every device is told about, with the way to disown it. */
  'joined.event': '{device} joined @{handle} from {place} · {ago} — NOT YOU?',

  /**
   * D12 revoke — THE SENTENCE IS THE SECURITY CONTRACT.
   *
   * The architecture's own line: revoking kills the session now, the door
   * tokens within their TTL, and the LAN admission on every Mac within a
   * minute. The v2 sentence promised less than the system does ("it keeps
   * working on this Wi-Fi until re-paired"), which is the worse direction for
   * a security control to be wrong in: someone revoking a lost phone was told
   * it still had their keyboard. This says all three places at once.
   */
  'd12.revoke':
    "The {device} stops opening this account within a minute — here, at every door, and on every Mac's Wi-Fi. Anything it asked for is dropped.",
  /**
   * THE SAME MOMENT, WHILE THE MECHANISM IS NOT THERE YET (H2).
   *
   * The sentence above is the contract, and it was being said in builds that
   * did not keep it: the root pairing token still opened every route, so a
   * revoked phone still had this Mac's keyboard on this Wi-Fi. Which of the
   * two is shown is decided by the one fact both the gate and the copy read
   * (shared/lan-token-mode.ts), so the promise cannot outrun the mechanism a
   * second time.
   *
   * It names ROTATION rather than FORGET deliberately. Forgetting removes the
   * admitted row, and while the root opens everything the row is not the
   * credential the phone is using — so FORGET here would be a second sentence
   * that does not do what it says. `cookrew mobile --rotate` ends it, at the
   * cost the pairing sheet already names: every phone re-pairs.
   */
  'd12.revoke.lan-pending':
    'The {device} stops opening this account within a minute — here and at every door. On this Mac it keeps working on this Wi-Fi until you run `cookrew mobile --rotate`, which re-pairs every phone.',
  /** D12 sign out. What leaves, what stays, and what goes quiet. */
  'd12.sign-out':
    'This Mac leaves @{handle}. Everything on the canvas stays. The doors it serves go offline until it signs in again.',
  /**
   * D12, the last device. The v2 sentence said the button could not be used;
   * this says what would be lost, which is the only version that helps — the
   * next step is to add a device, not to accept a disabled control.
   */
  'd12.last-device':
    'This is the last device on @{handle} — add another first, or the account has no way back in.',
  /**
   * NOT FROM THE TABLE, and the only key here that is not.
   *
   * refusalSentence() maps a reason to a sentence and is sometimes called
   * before the account's name is known. The table's sentence opens with
   * "@{handle}", and "@" with nothing after it is a worse thing to ship than
   * one extra key — so this is the same sentence with the subject unnamed.
   * Any surface that HAS the handle must use the table key above.
   */
  'd12.last-device.unnamed':
    'This is the last device on the account — add another first, or there is no way back in.',
  /** D12, minting a join code for a second Mac. Life and blast radius, up front. */
  'd12.add-a-mac':
    'Open Cookrew on the new Mac and type this. It works once, for ten minutes. Every device will be told when the Mac joins.',

  /** D13, on the lock screen: the lock knows who is waiting behind it. */
  'd13.lock': '{device} is waiting to join — unlock to answer.',

  /** D14, a serving device whose session is running out. */
  'd14.expiring':
    "@{handle}'s doors go offline on {day} unless {device} renews — open Cookrew there once.",
  /** D14, a door another Mac already holds. Replaces a silent name-taken. */
  'd14.held': '{door} is served by {device} since {day}. A door has one holder.',
  /** D14, the door moved away from here. */
  'd14.moved': '{door} moved to {device}. This Mac stopped serving it.',

  /**
   * M5, the companion's Not paired card, when the account cannot be used here.
   *
   * Owner 2026-11-09: the account's password or a passkey enters a machine of
   * the account, with nobody at it (account-pair.ts). This sentence is what is
   * left for a machine with no account — or a page that cannot ask it — and it
   * names only doors that work there: the QR, and the token `cookrew mobile
   * --token` prints. USE WI-FI is gone from it: it was answered at the machine.
   */
  'm5.unpaired':
    'Scan the QR on the Mac’s avatar → Pair a phone, or paste the link `cookrew mobile --token` printed.',
  /**
   * M5, the card on a machine of the account: the way in that needs nobody
   * there. Owner 2026-11-09: one verification opens every machine of the
   * account for twelve hours.
   */
  'm5.enter.lede':
    'Enter this Mac with your account — a passkey, or the account password. Every machine of your account then lets this browser in for twelve hours.',
  'm5.enter.entering': 'Entering with your account…',
  'm5.enter.passkey': 'Use a passkey',
  'm5.enter.password': 'Account password',
  'm5.enter.go': 'Enter',
  /** M5, a browser with no cookrew.dev device key: the account cannot vouch for it yet. */
  'm5.enter.signin':
    'This browser is not signed in to your account. Open this Mac from console.cookrew.dev: you sign in there.',
  /** M5, a machine of the account reached on a page that cannot use the account (a direct address). */
  'm5.enter.elsewhere':
    'Open this Mac from console.cookrew.dev: you sign in there and prove it’s you once, with a passkey or the account password.',
  /** M5, ruling 3: a provider-only account with no passkey sets an account password first. */
  'm5.enter.setpassword':
    'Set an account password first: this account signs in with Google or GitHub and has no password or passkey yet. Set one at auth.cookrew.dev/account, then come back.',
  /** M5, cookrew.dev could not be asked for the pass. */
  'm5.enter.unreachable':
    'cookrew.dev cannot be reached just now. Try again in a minute, or pair with a token instead.',
  /** M5, a token was minted and then refused: rare, and said rather than silent. */
  'm5.enter.kept': 'This Mac let this browser in but then refused it. Try again.',
  /** M5, the token, kept for a machine with no account, folded away below the account. */
  'm5.enter.token': 'Pair with a token instead',

  /**
   * G1 identify — replaces the passkey sentence.
   *
   * "@username" is literal here, not a placeholder: it is the shape of the
   * thing the person types, shown to them at the moment they type it.
   */
  'g1.identify':
    'Sign in with your Cookrew account — @username and your password, or a code from your phone. Seats and sessions follow the account.',

  /** G2, no seat. Two next steps, and the reason to prefer neither. */
  'g2.no-seat':
    '@{handle} has no seat at @{owner}/{team}. Ask @{owner} for one, or buy one — either way it follows you.',
  /**
   * G2, the owner's lending cap. The sheet retries itself, so the sentence
   * says so — otherwise the person sits refreshing something that is already
   * waiting for them.
   */
  'g2.budget':
    '@{owner} is lending as much as they allow right now. Try again in a while — this sheet will, on its own, in 15 minutes.',

  /**
   * G3, the direct door — the one place a caller key remains. Replaces the
   * six-word ceremony's instruction: v3 identifies this Mac by its own key, so
   * there is nothing for two people to read to each other.
   */
  'g3.direct':
    "Direct connection · no account needed. This door is not listed at cookrew.dev. This Mac's own key identifies you to it; nothing follows you elsewhere.",

  /**
   * W4 · W5 — THE WEB SAYS "BROWSER" WHERE THE DESKTOP SAYS "MAC".
   *
   * These four are the D10/D11 sentences rewritten for the side that is a tab
   * and not an application. They are separate keys rather than placeholders in
   * the desktop ones because the difference is not a noun to substitute: on
   * the Mac the asking device IS the thing the person is standing at, and on
   * the web it is one of many tabs they may close. A sentence that hedged
   * ("this device") to serve both would be vaguer on both.
   */
  /**
   * M4, the page a join QR lands on. It says what is about to happen and what
   * is NOT being asked for, because the whole promise of a code is that the
   * password is never typed on a machine the account has not met.
   */
  'm4.join-lede':
    'A code from one of your devices. Joining makes this one a device on the same account — no password is typed here.',
  /** M4, the other door, for somebody who has a password and no code. */
  'm4.join-instead': 'Sign in with your password instead',
  /** M4, arrived with no code in the fragment — a bare /join, or a stripped link. */
  'm4.no-code':
    'This link carries no code. Open Devices on a Mac you already use, choose ADD A PHONE, and scan the picture it shows.',
  /** W4, the line under the tabs. The other half of "sign in or create". */
  'w4.join-offer': 'Have a code from another device?',
  /** W4, the join panel. Says what is NOT asked for, which is the whole point. */
  'w4.join-lede':
    'Type the code from a device already on your account. No password is asked for here — the code is the permission.',
  /** W4 after asking, the number rung. The number is HERE and typed THERE. */
  'w4.asked': 'Asked. On your other device, type the number below to let this browser in.',
  /**
   * W4, a code that did not work.
   *
   * NOT the registry's own 401 sentence. /v2/join answers `bad_credentials`
   * on purpose — a wrong code and a code for an account nobody has must be
   * one answer — but that sentence reads "That name and password do not go
   * together", and this sheet has asked for neither. Passing it through named
   * two fields that were not on screen. The refusal a person can act on is
   * the one about the thing they typed.
   */
  'w4.join-refused':
    'That code did not work. Ask the device you minted it on for a fresh one — a code works once, for ten minutes.',
  /** W5, the question over the approver's number field (D11's, for any device). */
  'w5.join-row': 'What number is on that device?',
  /**
   * M6, a reach row seen somewhere that cannot answer it.
   *
   * NO SUCH ROW ARRIVES ANY MORE (0.6.0): the registry opens none. The
   * sentence stays because the account page still hands it to its script
   * (registry/src/site-account.ts, `data-wifi-row`), which keeps a branch for
   * a row of that kind.
   */
  'w5.reach-elsewhere': '{device} asked to reach that Mac on Wi-Fi. Answer it on the Mac itself.',
  /** W5, the two ADD buttons. Where the code is typed, and how long it lives. */
  'w5.add-lede':
    'On the new device open cookrew.dev, choose “Join with a code”, and type this. It works once, for ten minutes.',
  /**
   * W5, under the Requests heading: the web's queue, which is sign-ins.
   *
   * NOT `d11.footer`: this one says who is asking, because the page is read
   * by somebody who may not be at a Mac. It names the buttons a reader of the
   * page can see and no other: a footer describing buttons that are not there
   * teaches people to stop reading footers.
   */
  'w5.requests-footer':
    'A device asking to sign in as @{handle}. APPROVE needs the number showing on that device; NOT ME signs every other device out and locks the password until you change it.',

} as const, hostPlatform())

export type V3CopyId = keyof typeof V3_COPY

/**
 * THE SAME ACCOUNT, AT A TERMINAL (`cookrew login`, `logout`, `whoami`).
 *
 * Its own table because main speaks these, not a window: there is no preload
 * to name the platform, so `cliCopy` is told it. The three rules above hold
 * here too, and a sentence names a command wherever it can, because a terminal
 * has no button to point at.
 */
export const CLI_COPY = {
  'gate.no-door': "refused: signing in is the owner's — this app has no account to sign in to",
  'gate.no-keyboard':
    'refused: signing in needs a person at a terminal, typing at a hidden prompt, and this command has no keyboard. Run cookrew login yourself in a Shell card (cookrew recruit --preset Shell).',
  'gate.agent-caller':
    'refused: this was run by an agent. Signing in is for the owner: run cookrew login yourself in a Shell card (cookrew recruit --preset Shell).',
  'gate.agent-busy':
    'refused: the agent in this pane is working, and signing in is for the owner. Run cookrew login yourself in a Shell card (cookrew recruit --preset Shell).',
  'gate.driven':
    'refused: the last keys in this pane came from an agent, not a keyboard. Type cookrew login yourself in a Shell card (cookrew recruit --preset Shell).',
  'gate.held': 'refused: a sign-in is already open on this Mac. Finish it, or press Ctrl-C there.',
  'gate.not-open': 'refused: this connection has no sign-in open. Run cookrew login.',

  'ask.username': 'Username: ',
  'ask.password': 'Password for @{handle}: ',
  'ask.password-logout': 'Password for @{handle}, to sign this Mac out: ',
  'ask.choose': 'Which one? [1]: ',
  'ask.choose-again': 'Pick a number from the list.',
  'ask.totp': 'Six digits from your authenticator: ',
  'ask.recovery': 'Recovery code: ',
  'ask.handle': 'Choose your Cookrew name [{suggest}]: ',
  'ask.handle-blank': 'Choose your Cookrew name: ',

  'rung.approve': 'Approve on another device',
  'rung.totp': 'Authenticator code',
  'rung.recovery': 'Recovery code',
  'rung.no-passkey': 'A passkey needs a window, and this terminal has none. Use another way in:',
  'rung.passkey-only':
    'A passkey needs a window, and this terminal has none, and this account offers nothing else. Add an authenticator on a device you are signed in on, then run cookrew login again.',
  'rung.no-match': 'cookrew.dev sent no number for this sign-in, so it cannot be approved from here.',
  'rung.none': 'This account offers no way in that a terminal can use. Nothing was attached.',

  'approve.match': 'On your phone or another signed-in device, type this number: {match}',
  'approve.waiting': 'Waiting for your answer there. The sign-in stays open for ten minutes.',
  'approve.hint': 'Press c to use another way in. Ctrl-C stops.',
  'approve.hint-alone': 'Ctrl-C stops.',
  'approve.offline': 'cookrew.dev stopped answering. Still waiting; the sign-in is open at the other end.',

  'device.code': 'Open {url} and type this code: {code}',
  'device.waiting': 'Waiting for GitHub. Ctrl-C stops.',

  'browser.code': 'Open {url} and enter {code}',
  'browser.direct': 'Or open {url}, which has the code in it already.',
  'browser.waiting': 'Waiting for you to finish in the browser. Ctrl-C stops.',
  'browser.cancelled': 'Stopped before the browser finished. Nothing was attached.',
  'browser.denied': 'That sign-in was refused in the browser. Nothing was attached.',
  'browser.expired': 'That code went cold before the browser finished. Run cookrew login to start again.',
  'browser.wrong_identity': 'The browser signed in to another account, not the one on this Mac. Nothing changed.',

  'said.new-identity':
    'Nobody on Cookrew has this GitHub account yet. Already have an account? Press Ctrl-C, run cookrew login with your password, then link GitHub in Security.',
  'said.lock-off':
    'No password was typed here, so Cookrew will not lock itself on this Mac until the account password is typed on it once (Security → Lock).',
  'said.lock-off-no-password':
    '@{handle} has no password yet, so Cookrew will not lock itself on this Mac. Set one at auth.cookrew.dev/account, then type it here once (Security → Lock).',
  'said.no-password': '@{handle} has no password. Run cookrew login --github, or sign in from the app.',
  'said.logout-no-password':
    '@{handle} has no password, so leaving needs a browser. Sign this Mac out from the app, or revoke it from another device.',
  'said.signed-in': 'Signed in as @{handle}. cookrew.dev shows this Mac as {device}.',
  'said.already': 'Already signed in as @{handle}. cookrew.dev shows this Mac as {device}.',
  'said.other-account': 'This Mac is @{handle}. Run cookrew logout first, then cookrew login {wanted}.',
  'said.not-signed-in': 'Not signed in on this Mac. Run cookrew login.',
  'said.session-ended': '@{handle} on {device}: the session ended. Run cookrew login to renew it.',
  'said.whoami': '@{handle} on {device} ({registry})',
  'said.signed-out': 'Signed out. This Mac left @{handle}. Everything on the canvas stays.',
  'said.start-again': 'Nothing was attached. Run cookrew login to start again.',
  'said.too-many-passwords': 'Three wrong passwords, so this stops here. Nothing changed on this Mac.',

  'refused.cancelled': 'Stopped before GitHub finished. Nothing was attached.',
  'refused.wrong_identity': 'That GitHub account is not the one on this Mac.',
  'refused.locked': 'Cookrew is locked on this Mac. Unlock it, then run this again.',
  'refused.handle-taken': '@{handle} is taken. Pick another name.',
  'refused.rate_limited': 'cookrew.dev is asking us to slow down. Try again in a minute.',
  'refused.offline': 'cookrew.dev did not answer. Nothing changed. Try again in a moment.',
  'refused.wrong-password': 'That is not the password for this account.',
  'refused.bad_code': 'That is not the code showing right now. Wait for the next one and type it as it appears.',
  'refused.bad_recovery': 'That is not one of your recovery codes. Each one opens the account exactly once.',
  'refused.expired': 'This sign-in went cold after ten minutes.',
  'refused.too_many_attempts': 'Too many tries on this sign-in.',
  'refused.denied': 'That sign-in was denied on your other device.',
  'refused.bad_username': 'A username is lowercase letters, digits and dashes.',
  'refused.password_change_required':
    'Somebody said a sign-in was not them, so this password is locked out until you change it. Change it on a device you are still signed in on.',
  'refused.last_device':
    'This is the last device on @{handle}, and an account with no device cannot be proved. Add another device first, then run cookrew logout.',
  'refused.unknown': 'cookrew.dev answered something this app could not read. Nothing was changed. Try again in a moment.'
} as const

export type CliCopyId = keyof typeof CLI_COPY

/** A terminal sentence, in the word for the machine it is running on. */
export function cliCopy(
  id: CliCopyId,
  platform: string,
  vars: Readonly<Record<string, string | number>> = {},
  registry?: string
): string {
  return fillCopy(registryCopy(machineCopy(CLI_COPY[id], platform), registry), vars)
}

/**
 * Fill a sentence's {placeholders}. Throws on one nobody supplied, because a
 * brace on screen is a programming mistake and not a state a person is in.
 *
 * It lives HERE rather than in marketplace-copy.ts so the dependency runs one
 * way only: marketplace-copy borrows the account's sentences, and a module
 * that is borrowed from must not borrow back. A cycle between two `const`
 * tables is not a lint complaint — whichever one initialises second reads
 * `undefined` out of the first, and the sentence ships blank.
 */
export function fillCopy(
  template: string,
  vars: Readonly<Record<string, string | number>> = {}
): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`copy: no value for {${name}}`)
    return String(value)
  })
}

export function accountCopy(
  id: V3CopyId,
  vars: Readonly<Record<string, string | number>> = {}
): string {
  return fillCopy(V3_COPY[id], vars)
}

/** A handle, as the sentences write it: exactly one @. */
export function handleLabel(handle: string): string {
  return handle.startsWith('@') ? handle.slice(1) : handle
}
