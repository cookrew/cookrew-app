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
}

const TAIL_MAX = 4000
// CSI, OSC and lone ESC sequences; carriage returns become newlines.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g
const PROMPT_END = /(?:^|\s)[$%❯›>#]\s*$/
const OAUTH = /browser|sign(?:ing)?[ -]?in|log[ -]?in|oauth|authenticat/i

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

export function oauthPending(tail: string): boolean {
  return OAUTH.test(tail)
}

export function observeOutput(watch: LineWatch, chunk: string): LineWatch {
  if (watch.done) return watch
  const tail = (watch.tail + cleanOutput(chunk)).slice(-TAIL_MAX)
  const echoed = watch.echoed || tail.includes(watch.line)
  const last = lastLine(tail)
  // The echo line itself ends in the command, never in a prompt character.
  const done = echoed && !last.endsWith(watch.line) && promptReturned(last)
  return { ...watch, tail, echoed, done }
}

export function runningView(watch: LineWatch): SetupRunning {
  const last = lastLine(watch.tail)
  return { line: watch.line, lastLine: last.endsWith(watch.line) ? '' : last, oauth: oauthPending(watch.tail) }
}

/** What a button reads while its line runs; null when it is not that line. */
export function runningLabel(running: SetupRunning | null, line: string): string | null {
  if (running === null || running.line !== line) return null
  if (running.oauth) return 'sign-in open in your browser'
  const last = running.lastLine.length > 60 ? `${running.lastLine.slice(0, 59)}…` : running.lastLine
  return last ? `running… ${last}` : 'running…'
}

export const LINE_RUNNING = 'that line is still running — wait for the prompt'
