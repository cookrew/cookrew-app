/**
 * THE ACCOUNT'S SENTENCES, MIRRORED FOR THE WEB (V3-07).
 *
 * The registry is built and shipped on its own; it cannot import from
 * src/shared, so the sentences the site renders are written out again here by
 * hand. Two hand-written copies of one sentence is exactly the drift the one
 * source exists to stop — so tests/registry-web-copy-seal.test.ts holds them
 * equal, key for key, the way registry-web-seal.test.ts holds seal.js equal to
 * relay-seal.ts. If this file and src/shared/account-copy.ts disagree, the
 * shared one is right and this is the bug.
 *
 * Only the keys the WEB renders are mirrored. A key the site never draws has
 * no business being duplicated here.
 */
export const WEB_V3_COPY = {
  'avatar.no-account':
    'Sign in — or create an account. Serve teams and reach this Mac from anywhere. Everything here works without one.',
  'd9.signin.lede': 'A username and a password. This Mac becomes a device on your account.',
  'd9.create.lede':
    'This Mac becomes your first device. A username and a password — nothing else is asked for.',
  'd11.seat-row': '@{handle} asks for a seat at {team}.',
  'd12.revoke':
    "The {device} stops opening this account within a minute — here, at every door, and on every Mac's Wi-Fi. Anything it asked for is dropped.",
  'd12.last-device':
    'This is the last device on @{handle} — add another first, or the account has no way back in.',
  'g1.identify':
    'Sign in with your Cookrew account — @username and your password, or a code from your phone. Seats and sessions follow the account.',
  'g2.no-seat':
    '@{handle} has no seat at @{owner}/{team}. Ask @{owner} for one, or buy one — either way it follows you.',
  'w4.join-offer': 'Have a code from another device?',
  'w4.join-lede':
    'Type the code from a device already on your account. No password is asked for here — the code is the permission.',
  'w4.asked': 'Asked. On your other device, type the number below to let this browser in.',
  'w4.join-refused':
    'That code did not work. Ask the device you minted it on for a fresh one — a code works once, for ten minutes.',
  'w5.join-row': 'What number is on that device?',
  'w5.add-lede':
    'On the new device open cookrew.dev, choose “Join with a code”, and type this. It works once, for ten minutes.',
  'w5.requests-footer':
    'A device asking to sign in as @{handle}. APPROVE needs the number showing on it; deny does nothing else; NOT ME signs every other device out and locks the password until you change it.',
  'w6.asked':
    "This page seats you the moment they say yes. You can close it; the seat is yours, not this tab's."
} as const

export type WebV3CopyId = keyof typeof WEB_V3_COPY

/** The web's own filler — same contract as the shared one, no import across. */
export function webCopy(
  id: WebV3CopyId,
  vars: Readonly<Record<string, string | number>> = {}
): string {
  return WEB_V3_COPY[id].replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`web copy: no value for {${name}}`)
    return String(value)
  })
}
