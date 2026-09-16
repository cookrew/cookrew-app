/**
 * Where a paste request meets the terminal that can serve it.
 *
 * The paste key lives in the dock (VoiceBar) and the long press lives in the
 * overlay, but only the overlay holds the xterm — and the xterm is what must
 * do the pasting. It wraps the text in bracketed-paste markers when the TUI
 * has that mode on, and without them an agent's prompt reads every newline in
 * a pasted block as a submit: one paragraph becomes six prompts. Sending the
 * text straight to the PTY is therefore not an equivalent shortcut.
 *
 * So the overlay registers a sink per terminal and the dock asks by id.
 *
 * SYNCHRONOUS on purpose. The caller is inside a real user gesture
 * (pointerup), and iOS grants a clipboard read only there — an await, a
 * microtask hop or a setTimeout between the tap and readText() loses the
 * activation and the read is refused.
 */
type PasteSink = () => void

const sinks = new Map<string, PasteSink>()

/** Register the terminal's paste sink; returns an unregister. */
export function registerTerminalPaste(terminalId: string, sink: PasteSink): () => void {
  sinks.set(terminalId, sink)
  return () => {
    // Only ever remove OUR sink: a remount registers the new one before the
    // old effect's cleanup runs, and a blind delete would leave the live
    // overlay unreachable.
    if (sinks.get(terminalId) === sink) sinks.delete(terminalId)
  }
}

/** Ask a terminal to paste. False when nothing is listening for that id. */
export function requestTerminalPaste(terminalId: string): boolean {
  const sink = sinks.get(terminalId)
  if (!sink) return false
  sink()
  return true
}
