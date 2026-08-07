import { multiplexer, type PtySession } from './pty'

export interface AskOptions {
  /** ms of continuous silence that counts as "the agent finished". */
  quiescenceMs?: number
  /** Give up waiting after this long. */
  timeoutMs?: number
  /** Minimum time to wait before quiescence can trigger (agent boot time). */
  graceMs?: number
}

const SUBMIT_DELAY_BASE_MS = 150
const SUBMIT_DELAY_PER_KB_MS = 100
const SUBMIT_DELAY_MAX_MS = 1500

/** Bracketed-paste markers (DECSET 2004): a paste's explicit start/end. */
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

/**
 * Pause between the prompt text and the submitting Enter. Agent TUIs treat a
 * burst of input as a paste; a carriage return inside that burst becomes a
 * literal newline in their input box instead of a submit. The pause scales
 * with prompt size because the TUI ingests large pastes over time — an Enter
 * arriving before ingestion finishes gets swallowed into the paste.
 */
export function submitDelayMs(promptLength: number): number {
  const scaled = SUBMIT_DELAY_BASE_MS + Math.round((promptLength / 1024) * SUBMIT_DELAY_PER_KB_MS)
  return Math.min(scaled, SUBMIT_DELAY_MAX_MS)
}

/**
 * Deliver `body` as one bracketed-paste unit, then submit it with a delayed
 * Enter. The explicit \x1b[200~…\x1b[201~ markers make the TUI finalize the
 * paste at a known boundary, so the trailing Enter is seen as a submit rather
 * than folded into a still-ingesting paste — the "[Pasted text] never sent"
 * bug that a bare raw write hits when the TUI's own paste heuristic collapses
 * the burst. Same mechanism the fork engine uses (injectWhenReady).
 */
async function pasteAndSubmit(session: PtySession, body: string): Promise<void> {
  session.write(`${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`)
  await new Promise((resolve) => setTimeout(resolve, submitDelayMs(body.length)))
  session.write('\r')
}

/**
 * Send a prompt to a terminal and wait until its output goes quiet, then
 * return the new text produced since the prompt was sent. This mirrors how
 * `cookrew ask` blocks until the target agent finishes responding.
 */
export async function askTerminal(
  session: PtySession,
  prompt: string,
  options: AskOptions = {}
): Promise<string> {
  const quiescenceMs = options.quiescenceMs ?? 2500
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const graceMs = options.graceMs ?? 1500

  const before = session.fullText()
  await pasteAndSubmit(session, prompt)

  await waitForReply(session, { quiescenceMs, timeoutMs, graceMs })

  return diffOutput(before, session.fullText())
}

/**
 * Wait until the agent has finished replying.
 *
 * Prefers ASKING the multiplexer over inferring it. Output quiescence — "silent
 * for 2500ms, therefore done" — is wrong in both directions: an agent pausing
 * mid-turn for a long tool call reads as finished, and an agent that answers
 * instantly still costs the full 2500ms. A backend with `agentLifecycle` knows
 * the real answer and reports it in milliseconds.
 *
 * The heuristic stays as the fallback, unchanged, for tmux and the direct
 * backend — and for a herdr pane whose state herdr cannot report, which
 * `waitUntilIdle` signals by resolving false rather than throwing.
 */
async function waitForReply(
  session: PtySession,
  timing: { quiescenceMs: number; timeoutMs: number; graceMs: number }
): Promise<void> {
  const mux = multiplexer()
  if (mux?.capabilities.agentLifecycle && mux.waitUntilIdle) {
    // The grace period still applies: an agent that has not started working
    // yet is idle, and returning on that would report the PREVIOUS turn's
    // output as this turn's reply.
    await new Promise((resolve) => setTimeout(resolve, timing.graceMs))
    if (await mux.waitUntilIdle(session.sessionName, timing.timeoutMs)) return
  }
  await waitForQuiescence(session, timing)
}

/** The original heuristic: silence for `quiescenceMs` means finished. */
function waitForQuiescence(
  session: PtySession,
  timing: { quiescenceMs: number; timeoutMs: number; graceMs: number }
): Promise<void> {
  const startedAt = Date.now()
  return new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt
      const quiet = session.idleFor() >= timing.quiescenceMs
      if ((elapsed >= timing.graceMs && quiet) || elapsed >= timing.timeoutMs) {
        clearInterval(timer)
        resolve()
      }
    }, 200)
  })
}

/** Send raw bytes (with escapes already decoded) and return the viewport. */
export async function askRaw(session: PtySession, rawInput: string): Promise<string> {
  const trailingEnter = /[\r\n]+$/.exec(rawInput)
  const body = trailingEnter ? rawInput.slice(0, trailingEnter.index) : rawInput
  if (trailingEnter && body.length > 0) {
    // Text followed by Enter: the same paste-swallow hazard askTerminal
    // guards against — a TUI mid-ingest folds an immediate Enter into the
    // paste and never submits. Deliver as a bracketed paste, then Enter.
    await pasteAndSubmit(session, body)
  } else {
    session.write(rawInput)
  }
  await new Promise((resolve) => setTimeout(resolve, 800))
  return session.viewportText()
}

/**
 * Return the portion of `after` that was appended past `before`.
 * Terminal buffers only ever append lines (scrollback), but the last lines
 * of `before` may have been redrawn — find the longest prefix overlap.
 */
export function diffOutput(before: string, after: string): string {
  if (after.startsWith(before)) {
    return after.slice(before.length).replace(/^\n+/, '')
  }
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  let common = 0
  while (
    common < beforeLines.length &&
    common < afterLines.length &&
    beforeLines[common] === afterLines[common]
  ) {
    common += 1
  }
  return afterLines.slice(common).join('\n').replace(/^\n+/, '')
}

/** Decode CLI escapes: \n \t \e \\ and \xNN byte sequences. */
export function decodeRawEscapes(input: string): string {
  return input
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/\\n/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\e/g, String.fromCharCode(27))
    .replace(/\\\\/g, '\\')
}
