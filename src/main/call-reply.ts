/**
 * WHAT COMES BACK OUT (§9 · ④ · S4) — the reply is untrusted in both directions.
 *
 * TWO DIFFERENT DANGERS, and it is easy to only see the first.
 *
 * OUTWARD (the owner's risk): a reply must carry the caller's OWN turn and
 * nothing else. askTerminal already returns a diff — what appeared after the
 * prompt was submitted, not the pane's scrollback — so the containment is
 * structural rather than a filter applied here. What this file adds is a
 * ceiling: an agent that dumps a file, a diff, or a whole session into its
 * answer would otherwise hand it to an internet caller in one response, and
 * "the agent decided to print it" is not a decision the caller should be able
 * to provoke without limit.
 *
 * INWARD (the caller's risk): §9's promise is that "the caller's terminal sees
 * an ordinary teammate" — which means this text is going to be RENDERED IN
 * SOMEONE ELSE'S TERMINAL. Terminal output is a command language: escape
 * sequences move the cursor, rewrite lines already printed, set the window
 * title, switch the screen buffer, and on some terminals can be made to echo
 * text back as though the user typed it. Handing an agent's raw pty bytes to a
 * remote terminal is the same injection as the inbound one, pointed the other
 * way — and this end is the one that got the bytes from a machine it does not
 * control.
 *
 * So a reply leaves as text: no escapes, no controls, nothing that can act.
 */

/**
 * The most reply we will hand back in one response.
 *
 * Generous enough for a real answer including code, small enough that a caller
 * cannot use an exported agent as a pipe for whatever the agent can be talked
 * into printing.
 */
export const MAX_REPLY_BYTES = 64 * 1024

/**
 * ANSI/VT control sequences: CSI, OSC, DCS/SOS/PM/APC, single-character escapes.
 *
 * Removed rather than escaped, because the caller asked a question and wants an
 * answer — a reply full of visible `ESC[0m` is not more honest than one without
 * it, and this is the same treatment the app's own transcript readers apply
 * before showing agent output anywhere that is not a terminal emulator.
 */
const ANSI =
  // ORDER IS LOAD-BEARING. `]` (0x5D) falls inside the single-character escape
  // class `[@-Z\\-_]`, so putting that branch first matched `ESC]` alone and
  // left `0;pwned` as visible text with its BEL stripped separately — the
  // title-set survived as junk instead of being removed. The string-terminated
  // forms are matched BEFORE the catch-all for the same reason.
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -\/]*[@-~]|[P^_X][^\x1B]*\x1B\\|[@-Z\\-_])/g

/** Anything left that can still act on a terminal: C0 except tab/newline, DEL, C1. */
// eslint-disable-next-line no-control-regex
const RESIDUAL_CONTROLS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g

export interface SafeReply {
  text: string
  /** True when the reply was cut to fit. The caller is TOLD, never silently trimmed. */
  truncated: boolean
}

/**
 * Make an agent's pty output safe to hand to a machine that will render it.
 *
 * Order matters: sequences first, then whatever residue is left. Doing it the
 * other way would strip the ESC out of `ESC[31m` and leave `[31m` as visible
 * junk in the answer.
 */
export function safeCallReply(raw: string): SafeReply {
  const stripped = raw
    .replace(ANSI, '')
    // Carriage returns are how a pty overwrites a line in place; as plain text
    // they make an answer look like it has holes. Collapsed to newlines, then
    // de-duplicated with whatever newline was already there.
    .replace(/\r\n?/g, '\n')
    .replace(RESIDUAL_CONTROLS, '')
    .trim()

  const bytes = Buffer.from(stripped, 'utf8')
  if (bytes.byteLength <= MAX_REPLY_BYTES) return { text: stripped, truncated: false }

  // Cut on a CHARACTER boundary. Slicing a UTF-8 buffer mid-sequence and
  // decoding it yields a replacement character — a corrupted last line handed
  // to a caller with no way to tell it was our doing rather than the agent's.
  const cut = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false })
    .decode(bytes.subarray(0, MAX_REPLY_BYTES))
    .replace(/�$/, '')
  return { text: cut, truncated: true }
}
