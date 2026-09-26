
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
export const V3_COPY = {
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
    'COOKREW_HANDLE names @{env}. Your account is @{handle}, and the account is the name — the environment is a development override.',
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
  /** D11, a phone asking for this Mac's keyboard. Says what ALLOW hands over. */
  'd11.wifi-row':
    '{device} wants to reach this Mac on Wi-Fi. ALLOW gives it the keyboard until you revoke.',
  /** D11, someone asking for a seat. Replaces "Copy link to ask @owner". */
  'd11.seat-row': '@{handle} asks for a seat at {team}.',
  /**
   * D11, the join row's own lead, above the number field. The device names
   * ITSELF here — the sentence quotes what a stranger's machine calls itself,
   * so it reads as a claim being made rather than as our description of it.
   */
  'd11.join-lead': '{device} wants to join @{handle}',
  /** D11 over-state, a device that is on the account now. */
  'd11.join-done': '{device} joined @{handle}',
  /** D11 over-state, a phone that has this Mac's keyboard until it is revoked. */
  'd11.wifi-done': '{device} can reach this Mac on Wi-Fi',
  /** D11 over-state, a guest who is in the room. */
  'd11.seat-done': '@{handle} is seated at {team}',
  /**
   * D11, a sign-in somebody disowned. It names WHERE it was answered, because
   * the owner reading this a day later needs to know which of their devices
   * they were holding when they said no.
   */
  'd11.denied': 'A sign-in as @{handle} was denied on {device}',
  /** D11, an empty queue. The ordinary state, and it says what would land here. */
  'd11.empty': 'Nothing is waiting. Devices asking to join, phones asking for Wi-Fi and guests asking for a seat all land here.',
  /** D11, what each button in the queue actually does — including NOT ME. */
  'd11.footer':
    "APPROVE needs the number. ALLOW gives the phone this Mac's keyboard until you revoke it. SEAT THEM grants by username. NOT ME signs every other device out and locks the password until you change it.",

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

  /** M5, the phone asked for LAN. The fallback that already works is named. */
  'm5.asked':
    'Tap ALLOW on that Mac. Until then this phone reaches it through cookrew.dev, which already works.',
  /** M5, allowed. */
  'm5.allowed': '{device} let this phone in on Wi-Fi. No prompt next time.',
  /**
   * M5, the Mac said no. A decline is not an error and not a dead end: OPEN
   * still works, because the relay was never the fallback — it is the path
   * this page was already using.
   */
  'm5.declined': '{device} said no. OPEN still reaches it through cookrew.dev.',
  /**
   * M5, the door that has nothing to do with accounts.
   *
   * A Mac nobody has signed in on cannot be asked for anything — there is no
   * account to carry the request. That Mac keeps the ceremony it always had,
   * and the sentence names BOTH ways in rather than only the camera: a phone
   * standing in front of the screen it would scan is the one case where a
   * scan is impossible.
   */
  'm5.no-account':
    'A Mac with no account keeps today’s door: scan its QR, or paste what `cookrew mobile` printed.',
  /**
   * M5, a browser whose device key cannot receive a sealed token.
   *
   * Sealing is a Diffie-Hellman against this device's own key, and a key minted
   * before M5 is an Ed25519 signing key a browser cannot derive from. Rather
   * than a silent failure the row says which door is still open.
   */
  /**
   * M5, the companion's Not paired card — all the ways in, best first.
   *
   * The card used to name two doors, both of them the old one: scan the Mac's
   * QR, or paste what the terminal printed. Both still work and both are still
   * here, because a Mac nobody has signed in on has no other way to let a
   * phone in. But a Mac that IS on an account now has a better door — one tap
   * on /me, answered on the Mac — and a card that did not mention it would
   * send every reader to the ceremony they were trying to escape.
   */
  'm5.unpaired':
    'If this Mac is on your account, open cookrew.dev/me and tap USE WI-FI on its row — you answer on the Mac, with no scan. Otherwise scan the QR on the Mac’s avatar → Pair a phone, or paste what `cookrew mobile` printed.',
  'm5.no-seal':
    'This browser joined before Wi-Fi sharing and cannot receive the token. OPEN works; to use Wi-Fi, add this browser again.',

  /**
   * G1 identify — replaces the passkey sentence.
   *
   * "@username" is literal here, not a placeholder: it is the shape of the
   * thing the person types, shown to them at the moment they type it.
   */
  'g1.identify':
    'Sign in with your Cookrew account — @username and your password, or a code from your phone. Seats and sessions follow the account.',
  /** G1, a paid team. Both doors, and what happens on the asking one. */
  'g1.seat':
    '@{handle}’s team charges {price} a seat. Buy one here, or ask — @{handle} sees the request on every device and you are seated the moment they say yes.',

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
   * NOT `d11.wifi-row`, which says "ALLOW gives it the keyboard until you
   * revoke" — that sentence describes a button, and this view has none.
   * Allowing carries the pairing URL already sealed to the asking device and
   * only the Mac being asked for holds that token, so the one useful thing to
   * say here is where the answer lives.
   */
  'w5.reach-elsewhere': '{device} asked to reach that Mac on Wi-Fi. Answer it on the Mac itself.',
  /** W5, the two ADD buttons. Where the code is typed, and how long it lives. */
  'w5.add-lede':
    'On the new device open cookrew.dev, choose “Join with a code”, and type this. It works once, for ten minutes.',
  /**
   * W5, under the Requests heading — the web's queue while it is still only
   * sign-ins.
   *
   * NOT `d11.footer`, and that is the point. D11 names ALLOW and SEAT THEM,
   * which the unified queue (V3-11) will put on this page and which are not
   * on it yet. A footer describing buttons a reader cannot see teaches them
   * to stop reading footers. This one swaps for d11.footer the day the other
   * two kinds arrive here.
   */
  'w5.requests-footer':
    'A device asking to sign in as @{handle}, or somebody asking for a seat. APPROVE needs the number showing on that device; SEAT THEM grants by username; NOT ME signs every other device out and locks the password until you change it.',

  /**
   * W6, the team page with no seat yet — and the reason to prefer asking.
   *
   * It names WHERE the ask lands ("on every device") because the old button
   * copied a link: the reader's model was "I now have to go and find them".
   * The request finds them instead, and the sentence has to say so or the
   * button looks like the same errand with fewer steps.
   */
  'w6.no-seat':
    'Buy one, or ask @{handle} — they see the request on every device, and you are seated the moment they say yes.',
  /** W6, the ask was filed and the bar is waiting. */
  'w6.asked-head': 'Asked @{handle}',
  /** W6, the same ask arriving twice. Not an error: the first one still stands. */
  'w6.already-asked': '@{handle} already has your request. It is still waiting.',
  /** W6, the web team page after asking. The seat outlives the tab. */
  'w6.asked':
    "This page seats you the moment they say yes. You can close it; the seat is yours, not this tab's."
} as const

export type V3CopyId = keyof typeof V3_COPY

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
