/**
 * A TURN THE PROVIDER REFUSED IS NOT A DONE TURN (Part C, C-3). The harness goes
 * quiet exactly as it does after a good reply, so the phase alone reads "done".
 * What differs is its last words. Anchored to the start of the line: an agent
 * talking ABOUT an API error is not one, and neither is an old line on the
 * screen once a reply is known.
 */

const FAILED_RE = /^\W*(?:API Error\b|stream error\b|unexpected status \d{3}\b|Error:?\s+[45]\d\d\b)/i
const MAX = 200

export function turnFailure(turn: { readonly reply?: string | null; readonly lines?: readonly string[] | null }): string | null {
  const text = turn.reply ?? [...(turn.lines ?? [])].reverse().find((line) => line.trim() !== '') ?? ''
  const first = text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
  return FAILED_RE.test(first) ? first.slice(0, MAX) : null
}
