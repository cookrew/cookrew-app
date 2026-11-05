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

/**
 * What the owner typed, as a name an agent can type (`DeepSeek key` →
 * `deepseek-key`), or null when nothing of it is left. A name is a word on a
 * command line, so a name in another script has no spelling here.
 */
export const secretNameFrom = (raw: string): string | null => {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64).replace(/-+$/, '')
  return isSecretName(slug) ? slug : null
}

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

/** The password field's state, as the block holds it. */
export interface SealedField {
  readonly value: string
  readonly error: string | null
}

/**
 * WHAT A SUCCESSFUL SEAL LEAVES BEHIND: an empty field with no error, and
 * the listing with this name's row replaced. Pure, so the one state step
 * that must never keep the value is a function a test can call.
 */
export const afterSeal = (
  sealed: SecretListing,
  listing: ReadonlyMap<string, SecretListing>
): { readonly field: SealedField; readonly listing: ReadonlyMap<string, SecretListing> } => ({
  field: { value: '', error: null },
  listing: new Map(listing).set(sealed.name, sealed)
})

/** A body's words, the slot lines taken out: the vault table draws those (nodes/SecretVault.tsx). */
export const withoutSlotLines = (content: string): string =>
  content
    .split('\n')
    .filter((line) => secretSlotOf(line) === null)
    .join('\n')
    .trim()

/**
 * A secret note's body with new words: the words, then every slot it had. The
 * editor holds only the words, so typing can never run into a slot line and
 * turn it into text, which would lose the row and hide its value from the
 * close dialog. A slot line typed among the words is taken as a slot.
 */
export const withWords = (content: string, words: string): string => {
  const names = [...new Set([...secretSlotsOf(content), ...secretSlotsOf(words)])]
  return `${[withoutSlotLines(words), names.map(secretSlotLine).join('\n')].filter((part) => part.length > 0).join('\n\n')}\n`
}

/** A body with one more slot, on a line of its own. */
export const withSlotLine = (content: string, name: string): string =>
  `${content.length === 0 || content.endsWith('\n') ? content : `${content}\n`}${secretSlotLine(name)}\n`

/**
 * WHAT THE VAULT'S NEW ROW WOULD DO. `sealed` is every name the store holds and
 * `held` the slots of this note. A name already sealed may be used, never
 * overwritten: replacing a value is that row's own act, where the owner can see
 * it is sealed, and a typed name must not do it by accident.
 */
export const vaultAdd = (input: {
  raw: string
  value: string
  sealed: readonly string[]
  held: readonly string[]
}): { readonly name: string | null; readonly ok: boolean; readonly hint: string } => {
  const name = secretNameFrom(input.raw)
  if (name === null) return { name: null, ok: false, hint: 'letters, digits and dashes' }
  if (input.held.includes(name)) return { name, ok: false, hint: `${name} is already in this note` }
  if (input.sealed.includes(name)) {
    return input.value.length > 0
      ? { name, ok: false, hint: `${name} is already sealed: leave the value empty to use it` }
      : { name, ok: true, hint: `uses the sealed ${name}` }
  }
  return { name, ok: true, hint: input.value.length > 0 ? `agents read it as ${name}` : `agents read it as ${name} · fill it in later` }
}
