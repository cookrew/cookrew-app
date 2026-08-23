/**
 * A STRANGER'S BYTES, ON THEIR WAY INTO A REAL PTY (§9 · ④ · S4).
 *
 * THE ESCAPE THAT MAKES THIS NOT OPTIONAL. ownerSubmit delivers a prompt as one
 * bracketed-paste unit: ESC[200~ , the text, ESC[201~ , then a carriage return.
 * A terminal treats everything between those markers as PASTED CONTENT rather
 * than typed keys — which is exactly what stops a newline in a prompt from
 * submitting early.
 *
 * So a caller who puts the literal end marker INSIDE its prompt closes the
 * paste early, and every byte after it is read as keystrokes by the agent's
 * TUI. That is not a formatting problem. It is arbitrary input to the owner's
 * agent — Enter, an interrupt, a slash-command, whatever the harness binds —
 * from an internet caller who was only ever entitled to ask a question.
 *
 * The same is true of a bare ESC. At the live tail of every agent TUI this
 * codebase hosts, ESC is an interrupt; ask.ts says so where it explains why the
 * contaminated flag can never be auto-cleared. A prompt is text, and text does
 * not contain an interrupt.
 *
 * REFUSED, NOT STRIPPED. Silently removing bytes would answer a question the
 * caller did not ask and give it no way to know. The caller gets a refusal that
 * names the problem class, and its own remedy is obvious: send text.
 */

/**
 * The most prompt we will carry into a pty.
 *
 * Not a formatting preference: pasteAndSubmit scales its submit delay with
 * prompt size, so length is time the producer lease is held on the owner's
 * machine, by a stranger. 16 KB is far past any real question and far short of
 * anything worth stalling a terminal for.
 */
export const MAX_PROMPT_BYTES = 16 * 1024

export type PromptRefusal = 'empty' | 'too_long' | 'control_bytes'

export type PromptVerdict =
  | { ok: true; text: string }
  | { ok: false; reason: PromptRefusal }

/**
 * Everything a prompt may not contain.
 *
 * C0 controls, DEL, and the C1 range — with TAB and LINE FEED allowed, because
 * those are the two a person genuinely types into a question. Carriage return
 * is NOT allowed: it is the submit key, and a prompt that carries one is asking
 * for a second submission the caller did not pay for. \r\n from a well-meaning
 * client is normalised to \n before this runs, so refusing it here costs an
 * honest caller nothing.
 */
const FORBIDDEN = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/

export function validateCallPrompt(raw: unknown): PromptVerdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' }

  // Normalised first, so a CRLF client is not refused for a line ending.
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (text.length === 0) return { ok: false, reason: 'empty' }

  // Measured in BYTES, not characters: the pty carries bytes, and a prompt of
  // emoji is four times the length a character count would report.
  if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
    return { ok: false, reason: 'too_long' }
  }

  // One test for every control byte, so a marker cannot be assembled out of
  // pieces that were each individually allowed. ESC is in this range, which is
  // what makes both the bracketed-paste escape and a bare interrupt
  // unreachable — there is no ESC[201~ without an ESC.
  if (FORBIDDEN.test(text)) return { ok: false, reason: 'control_bytes' }

  return { ok: true, text }
}
