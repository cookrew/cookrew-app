/**
 * A TURN THE PROVIDER REFUSED IS NOT A DONE TURN (Part C, C-3). The harness goes
 * quiet exactly as it does after a good reply, so the phase alone reads "done".
 * What differs is its last words, in a fixed shape.
 * Anchored, cased and colon-bound on purpose: "API error handling is fixed" and
 * "## Error 404 page added" are good replies, and an old line on the screen means
 * nothing once a reply is known.
 */

const FAILED_RE = /^[\s■•⏺●✗×!*⎿-]*(?:API Error(?::|\s*\(\d{3})|stream error:|unexpected status \d{3}\b|Error:\s+[45]\d\d\b)/
const MAX = 200

export function turnFailure(turn: { readonly reply?: string | null; readonly lines?: readonly string[] | null }): string | null {
  const text = turn.reply ?? [...(turn.lines ?? [])].reverse().find((line) => line.trim() !== '') ?? ''
  const first = text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
  return FAILED_RE.test(first) ? first.slice(0, MAX) : null
}
