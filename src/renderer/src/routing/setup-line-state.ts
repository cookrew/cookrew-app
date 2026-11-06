import type { SetupAsking } from '../../../shared/setup-line'

/**
 * WHAT A SCREEN SAYS OF A SETUP LINE WHILE IT RUNS.
 *
 * A button types one line into the Setup card and the card runs it. While it
 * runs, the button that typed it says so and refuses the same line a second
 * time: today the owner clicked ADD → Subscription twice while an OAuth waited
 * in the browser.
 *
 * Main says when the line ended and what the pane shows (main/setup-line.ts);
 * nothing here decides either. tmux's status bar arrives in the PTY's stream, so
 * the stream can neither end a line nor word a button. It is read for one thing:
 * the page a sign-in printed, because a phone has no other way to that page.
 */

export interface LineWatch {
  line: string
  /** The pane's recent text, control sequences stripped. */
  tail: string
}

export interface SetupRunning {
  line: string
  /** The pane's last non-empty line, as main read it, for the button. */
  lastLine: string
  /** The pane asked for a browser sign-in. */
  oauth: boolean
  /**
   * The page that sign-in wants opened, when the pane printed one. The panel
   * shows it as a link, because the browser the CLI opened is the MAC's: on
   * a phone the only way to the page is to be handed its address.
   */
  url: string | null
  /** The pane stopped on a password prompt. */
  asking?: SetupAsking
}

const TAIL_MAX = 4000
// CSI, OSC and lone ESC sequences; carriage returns become newlines.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_]|\r/g
/**
 * A SIGN-IN IS A SIGN-IN WORD AND A PAGE TO OPEN. Words alone were the old
 * test and they misfired on the owner's phone: START types `magpie autostart
 * on`, magpie answers "magpie opens at login, in the tray", and "login"
 * relabelled the button "sign-in open in your browser" for a sign-in that did
 * not exist. Every real browser sign-in prints the page it opened, so the page
 * is the evidence — and it is also the one thing a phone needs.
 */
const SIGN_IN = /sign(?:ing)?[ -]?in|log[ -]?in|oauth|authenticat|authori[sz]e/i
const URL_RE = /https?:\/\/[^\s'"<>`]+/g
/** A callback server on this Mac is where the browser RETURNS, never the page to open. */
const LOCAL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i

export function startedLine(line: string): LineWatch {
  return { line, tail: '' }
}

export function cleanOutput(chunk: string): string {
  return chunk.replace(CONTROL, (m) => (m === '\r' ? '\n' : ''))
}

/** The last page to open in what the pane printed, trailing punctuation dropped; null when none. */
export function signInUrl(text: string): string | null {
  const pages = (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:)\]]+$/, '')).filter((u) => !LOCAL.test(u))
  return pages.length === 0 ? null : pages[pages.length - 1]
}

export function oauthPending(text: string): boolean {
  return SIGN_IN.test(text) && signInUrl(text) !== null
}

/**
 * What the pane said after the line itself: the line's own URL is not an answer.
 * A long line comes back wrapped, so its text may not be found, and its URLs go by name.
 */
function answerOf(watch: LineWatch): string {
  const at = watch.tail.lastIndexOf(watch.line)
  const said = at < 0 ? watch.tail : watch.tail.slice(at + watch.line.length)
  return said.replace(URL_RE, (url) => (watch.line.includes(url) ? '' : url))
}

export function observeOutput(watch: LineWatch, chunk: string): LineWatch {
  return { ...watch, tail: (watch.tail + cleanOutput(chunk)).slice(-TAIL_MAX) }
}

/** What main read of the pane, before its first answer. */
export const NOTHING_READ = { lastLine: '', asking: null } as const

export function runningView(watch: LineWatch, pane: { lastLine: string; asking: SetupAsking } = NOTHING_READ): SetupRunning {
  const answer = answerOf(watch)
  const oauth = oauthPending(answer)
  return { line: watch.line, lastLine: pane.lastLine, oauth, url: oauth ? signInUrl(answer) : null, asking: pane.asking }
}

/** What a button reads while its line runs; null when it is not that line. */
export function runningLabel(running: SetupRunning | null, line: string): string | null {
  if (running === null || running.line !== line) return null
  if (running.oauth) return 'sign in — open the page'
  const last = running.lastLine.length > 60 ? `${running.lastLine.slice(0, 59)}…` : running.lastLine
  return last ? `running… ${last}` : 'running…'
}

export const LINE_RUNNING = 'that line is still running — wait for it to end'
