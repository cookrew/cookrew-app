/**
 * A TYPED SETUP LINE, WATCHED UNTIL THE PROMPT COMES BACK.
 *
 * A button types one line into the Setup card and the card runs it. While
 * it runs, the button that typed it says so with the pane's last line — "Finish
 * signing in in your browser" — and refuses the same line a second time:
 * today the owner clicked ADD → Subscription twice while an OAuth waited in
 * the browser. Pure over the PTY's bytes; the hook attaches and feeds chunks.
 *
 * The watch waits for the shell to ECHO the line before it believes a
 * prompt: a fresh attach can replay an old prompt first.
 */

export interface LineWatch {
  line: string
  /** The shell has echoed the line; prompts before that are old. */
  echoed: boolean
  /** The pane's recent text, control sequences stripped. */
  tail: string
  done: boolean
}

export interface SetupRunning {
  line: string
  /** The pane's last non-empty line, for the button. */
  lastLine: string
  /** The pane asked for a browser sign-in. */
  oauth: boolean
  /**
   * The page that sign-in wants opened, when the pane printed one. The panel
   * shows it as a link, because the browser the CLI opened is the MAC's: on
   * a phone the only way to the page is to be handed its address.
   */
  url: string | null
}

const TAIL_MAX = 4000
// CSI, OSC and lone ESC sequences; carriage returns become newlines.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g
const PROMPT_END = /(?:^|\s)[$%❯›>#]\s*$/
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
  return { line, echoed: false, tail: '', done: false }
}

export function cleanOutput(chunk: string): string {
  return chunk.replace(CONTROL, (m) => (m === '\r' ? '\n' : ''))
}

export function lastLine(tail: string): string {
  const lines = tail.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  return lines.length === 0 ? '' : lines[lines.length - 1]
}

export function promptReturned(line: string): boolean {
  return PROMPT_END.test(line)
}

/** The last page to open in what the pane printed, trailing punctuation dropped; null when none. */
export function signInUrl(text: string): string | null {
  const pages = (text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:)\]]+$/, '')).filter((u) => !LOCAL.test(u))
  return pages.length === 0 ? null : pages[pages.length - 1]
}

export function oauthPending(text: string): boolean {
  return SIGN_IN.test(text) && signInUrl(text) !== null
}

/** What the pane said AFTER echoing the line: the typed line's own URL is not an answer. */
function answerOf(watch: LineWatch): string {
  const at = watch.tail.indexOf(watch.line)
  return at < 0 ? (watch.echoed ? watch.tail : '') : watch.tail.slice(at + watch.line.length)
}

/** A line wider than the pane comes back wrapped: the shell breaks it where the row ends. */
const unwrapped = (text: string): string => text.replace(/\s+/g, '')

export function observeOutput(watch: LineWatch, chunk: string): LineWatch {
  if (watch.done) return watch
  const tail = (watch.tail + cleanOutput(chunk)).slice(-TAIL_MAX)
  const echoed = watch.echoed || unwrapped(tail).includes(unwrapped(watch.line))
  const last = lastLine(tail)
  // The echo line itself ends in the command, never in a prompt character.
  const done = echoed && !last.endsWith(watch.line) && promptReturned(last)
  return { ...watch, tail, echoed, done }
}

export function runningView(watch: LineWatch): SetupRunning {
  const last = lastLine(watch.tail)
  const answer = answerOf(watch)
  const oauth = oauthPending(answer)
  return { line: watch.line, lastLine: last.endsWith(watch.line) ? '' : last, oauth, url: oauth ? signInUrl(answer) : null }
}

/** What a button reads while its line runs; null when it is not that line. */
export function runningLabel(running: SetupRunning | null, line: string): string | null {
  if (running === null || running.line !== line) return null
  if (running.oauth) return 'sign in — open the page'
  const last = running.lastLine.length > 60 ? `${running.lastLine.slice(0, 59)}…` : running.lastLine
  return last ? `running… ${last}` : 'running…'
}

export const LINE_RUNNING = 'that line is still running — wait for the prompt'
