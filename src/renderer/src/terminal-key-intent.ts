/**
 * What the terminal overlay wants done with one key event, decided without
 * touching xterm, the clipboard or the PTY. Pure — unit-tested.
 *
 * This runs inside xterm's own key dispatch, which means a throw here does not
 * surface as an error the user can see: it aborts the dispatch and the
 * keystroke is silently lost. That is exactly what an unguarded
 * `event.key.toLowerCase()` did on a phone. A soft keyboard driving an IME can
 * deliver key events with no `key` at all (and WebKit reports the placeholder
 * "Unidentified" for others), so the characters that travel as key events —
 * the digits and punctuation on a CJK keyboard's secondary layer — died here,
 * while hanzi survived because they arrive by `compositionend` and never reach
 * this handler. Everything this function does not claim must fall through to
 * xterm, so `pass` is the default for anything unrecognised.
 */
export type TerminalKeyIntent = 'agent-newline' | 'copy' | 'swallow-paste' | 'pass'

export interface TerminalKeyEvent {
  /** Absent on some IME-generated events — the reason this module exists. */
  key: string | undefined
  type: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

export interface TerminalKeyContext {
  /** An agent TUI (Claude Code and friends) rather than a plain shell. */
  agent: boolean
  hasSelection: boolean
}

export function terminalKeyIntent(
  event: TerminalKeyEvent,
  context: TerminalKeyContext
): TerminalKeyIntent {
  // Shift+Enter inserts a newline in agent TUIs instead of submitting the
  // prompt. Plain shells keep the default Enter behavior.
  if (event.key === 'Enter' && event.shiftKey && context.agent) return 'agent-newline'

  // Nothing below is reachable without a key, and `??` is what keeps a missing
  // one from throwing the keystroke away.
  const key = (event.key ?? '').toLowerCase()

  // ⌘C (mac) / Ctrl+Shift+C: copy the xterm selection ourselves — the menu's
  // copy role only sees DOM selections, not xterm's internal one. Ctrl+C alone
  // stays SIGINT.
  const wantsCopy =
    (event.metaKey && !event.ctrlKey && key === 'c') || (event.ctrlKey && event.shiftKey && key === 'c')
  if (wantsCopy && context.hasSelection) return 'copy'

  // ⌘V / Ctrl+Shift+V: swallow the accelerator so it isn't sent to the PTY as
  // raw bytes. The paste itself belongs to the container's one 'paste'
  // listener — doing it here too is what inserted the text twice.
  const wantsPaste =
    (event.metaKey && !event.ctrlKey && key === 'v') || (event.ctrlKey && event.shiftKey && key === 'v')
  if (wantsPaste) return 'swallow-paste'

  return 'pass'
}
