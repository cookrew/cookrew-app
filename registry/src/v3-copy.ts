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
