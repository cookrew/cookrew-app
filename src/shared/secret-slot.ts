/**
 * THE SEALED SLOT, AS TEXT.
 *
 * A note's body rides in /api/workspace to the phone, over the relay to
 * cookrew.dev, and sits in workspace.json in clear — 590 KB of the live
 * canvas is note bodies. So a secret is never a note's text. A line that is
 * exactly `🔒 <name>` is a SLOT: the name of a secret the owner sealed into
 * ~/.cookrew/secrets/ (main/secrets-store.ts), read by local agents with
 * `cookrew secret read <name>`, and never anything more than its name here.
 *
 * Pure: the grammar both ends agree on, with no store and no DOM.
 */

/** Lower-case, digits and dashes, 1–64 chars, never a leading dash. */
export const SECRET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export const SECRET_SLOT_MARK = '🔒'

export const isSecretName = (name: string): boolean => SECRET_NAME_RE.test(name)

/** The one spelling of a slot line. */
export const secretSlotLine = (name: string): string => `${SECRET_SLOT_MARK} ${name}`

const SLOT_LINE_RE = /^🔒 ([a-z0-9][a-z0-9-]{0,63})\s*$/

/** The slot a line is, or null. */
export const secretSlotOf = (line: string): string | null => {
  const match = SLOT_LINE_RE.exec(line)
  return match ? match[1] : null
}

/** Every slot in a body, in order, each name once. */
export const secretSlotsOf = (content: string): string[] => {
  const seen = new Set<string>()
  for (const line of content.split('\n')) {
    const name = secretSlotOf(line)
    if (name !== null) seen.add(name)
  }
  return [...seen]
}

/** What anyone but the reader may know about a sealed secret: never the value. */
export interface SecretListing {
  readonly name: string
  readonly served: boolean
  readonly updatedAt: number
}
