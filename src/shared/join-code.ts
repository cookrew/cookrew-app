/**
 * THE EIGHT CHARACTERS A MACHINE JOINS WITH (v3, D8 · D12).
 *
 * A join code is read off one screen and typed on another, or carried in a
 * `cookrew://join#<code>` fragment that a person may have retyped. So the
 * spelling is forgiven in exactly the ways a person gets it wrong — the case,
 * the dash, the spaces — and nothing else: the alphabet is the registry's own
 * (registry/src/v2-secrets.ts · RECOVERY_ALPHABET), which has no 0/O and no
 * 1/I/L precisely because those are the characters that are two characters.
 *
 * SHARED, because three surfaces spell it: the deep-link parser in main, the
 * first-run field in the renderer, and the registry that compares it. Two
 * normalisers is how a code that works when scanned stops working when typed.
 * The registry does its own normalising — this one exists so a code that
 * cannot be a code is refused HERE, before it is sent anywhere.
 */

/** Two blocks of four, dashed. The dash is optional on the way in. */
const JOIN_CODE = /^([2-9A-HJ-NP-Z]{4})-?([2-9A-HJ-NP-Z]{4})$/

/** What the registry prints and what a person reads back: `XXXX-XXXX`. */
export const JOIN_CODE_EXAMPLE = '7KQ4-M2XB'

/** `XXXX-XXXX` from whatever was typed or scanned, or null. */
export function normaliseJoinCode(raw: string): string | null {
  const match = JOIN_CODE.exec(raw.trim().toUpperCase().replace(/[\s·]+/g, ''))
  return match === null ? null : `${match[1]}-${match[2]}`
}

/** Is this a code at all? The field's own answer, before anything is sent. */
export const isJoinCode = (raw: string): boolean => normaliseJoinCode(raw) !== null
