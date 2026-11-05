import { SETUP_LINE_COPY } from './first-run-copy'

/**
 * ONE SETUP LINE, AS BOTH SIDES OF THE BRIDGE SEE IT. Main types it and reads how
 * it ended (main/setup-line.ts); a screen shows it (renderer/routing).
 */

/** The one card lines are typed into, found by these two. */
export const SETUP_CARD_NAME = 'Setup'
export const SETUP_CARD_PRESET = 'Shell'

export interface SetupLineAsk {
  readonly terminalId: string
  readonly line: string
  /** False for a key line: the person pastes and presses Enter themselves. */
  readonly enter: boolean
  /** The card was made for this press: its shell may still be starting. */
  readonly fresh: boolean
}

/** `runId` is null when the line is typed and not watched: a key line, or `unwatched` on Windows. */
export type SetupStart =
  | { readonly ok: true; readonly runId: string | null; readonly unwatched?: boolean }
  /** `busy`: the pane is taken, and Stop is the way to clear it. */
  | { readonly ok: false; readonly reason: string; readonly busy: boolean }

export type SetupAsking = 'password' | null

/** A run still open on a card. */
export interface SetupLineRun {
  readonly runId: string
  readonly line: string
}

export type SetupLineNow =
  | { readonly state: 'running'; readonly lastLine: string; readonly asking: SetupAsking }
  /** `code` is null when the line never said: it was killed, or its pane went. */
  | { readonly state: 'ended'; readonly code: number | null }
  /** No such run here: an app restarted, or another run has taken its place. */
  | { readonly state: 'none' }

/** A terminal's ^C ends a process with 128 + SIGINT. */
const INTERRUPTED = 130

const PASSWORD_PROMPT = /(?:password|passphrase)\b[^:]*:$/i

/** The pane stops on a password prompt: the last line ends at the colon, nothing after it. */
export function askingPassword(lastLine: string): boolean {
  return PASSWORD_PROMPT.test(lastLine.trim())
}

/** What is said of a line that did not end well; null when it did. */
export function lineEndWords(code: number | null): string | null {
  if (code === 0) return null
  if (code === null) return SETUP_LINE_COPY.LOST
  return code === INTERRUPTED ? SETUP_LINE_COPY.STOPPED : SETUP_LINE_COPY.FAILED(code)
}
