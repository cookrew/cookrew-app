import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { IpcMain } from 'electron'
import { PRIVATE_DIR_MODE, writeFileAtomic } from './atomic-file'
import { shellQuote } from './shell-quote'
import { SETUP_LINE_COPY } from '../shared/first-run-copy'
import { setupLineAllowed } from '../shared/route-lines'
import { askingPassword, type SetupAsking, type SetupLineAsk, type SetupLineNow, type SetupLineRun, type SetupStart } from '../shared/setup-line'

/**
 * A SETUP LINE RUNS IN ITS OWN PROCESS, AND ONLY FROM A PANE AT ITS PROMPT.
 *
 * Box round 3 found two faults with one root, both from reading the screen:
 *
 *   N1  tmux draws its status bar last, so a prompt was never the pane's last
 *       line: a good install looked as if it never ended, and the bar reached
 *       the button. herdr and direct draw no bar, and neither may a check rely
 *       on what each one draws.
 *   N2  one shared pane took a line whatever was listening: Pi's install went to
 *       an open sudo prompt as a password.
 *
 * So the screen decides nothing here. WHAT IS LISTENING is the kernel's answer: a
 * shell at its prompt holds the terminal's foreground group, and anything it runs
 * takes that away (measured on tmux and herdr, 2026-11-06). HOW A LINE ENDED is its
 * exit status, written by a small sh runner to a file beside it: an escape-code
 * sentinel would not do, since tmux and herdr redraw the pane and drop what they do
 * not know. The person still sees the line: the runner prints it, and it runs in
 * the Setup pane where its questions can be answered.
 */

/** A new pane's rc file runs children of its own, and the shell comes up in its own time. */
const FRESH_WAIT_MS = 10_000
/** A pane in use: long enough to see past a flicker, short enough to answer a press. */
const BUSY_WAIT_MS = 600
const STEP_MS = 150
/** Typed, and the runner never said a word: something else took the keys. */
const NEVER_RAN_MS = 20_000
const PS_BUDGET_MS = 3_000
/** How often main itself looks at a run: a screen that went away must not leave it open. */
const WATCH_MS = 5_000

const RUNNING = 'running'

export interface SetupLineDeps {
  /** Where runners and their statuses sit. Made private here. */
  dir: string
  /** The one card a line may be typed into: an agent's pane reads as its own foreground too. */
  isSetupCard: (terminalId: string) => boolean
  /**
   * Holds the pane up for a line, returning how to let go; null when it cannot be.
   * A pane nobody views is dropped from the app, and keys for it go nowhere.
   */
  view: (terminalId: string) => (() => void) | null
  /** The process the pane runs; null when it cannot be read yet. */
  shellPid: (terminalId: string) => number | null
  /** Does this process hold its terminal's foreground? Null when it cannot be told. */
  holds: (pid: number) => Promise<boolean | null>
  type: (terminalId: string, bytes: string) => void
  /** The pane's text with nothing of the multiplexer's in it; null with no view of it. */
  screen: (terminalId: string) => Promise<string | null>
  alive: (terminalId: string) => boolean
  wait?: (ms: number) => Promise<void>
  now?: () => number
  /** Calls `tick` until told to stop. */
  every?: (ms: number, tick: () => void) => () => void
  platform?: NodeJS.Platform
}

interface Run {
  readonly runId: string
  readonly line: string
  readonly pid: number
  readonly at: number
  /** Lets go of the pane and stops main's own look at the run. Safe to call twice. */
  readonly close: () => void
  /** The shell was back in front with no status: once may be the moment before it writes. */
  absent: number
  ended: boolean
  code: number | null
}

export interface SetupLines {
  start: (input: unknown) => Promise<SetupStart>
  now: (terminalId: string, runId: string) => Promise<SetupLineNow>
  /** The run on a card, for a screen that came back to it. */
  current: (terminalId: string) => SetupLineRun | null
}

const once = (act: () => void): (() => void) => {
  let done = false
  return () => {
    if (done) return
    done = true
    act()
  }
}

const everyMs = (ms: number, tick: () => void): (() => void) => {
  const timer = setInterval(tick, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** The runner for one line. It reads its own status path; the line is whole and allowlisted. */
export function lineScript(line: string, statusFile: string): string {
  return [
    '#!/bin/sh',
    '# One Setup line, written by Cookrew (src/main/setup-line.ts).',
    `said=${shellQuote(statusFile)}`,
    `printf '%s\\n' ${RUNNING} > "$said"`,
    // Without it a failed download piped into sh is a good empty script. Not every sh has it.
    '(set -o pipefail) 2>/dev/null && set -o pipefail',
    // A handler, not an ignore: an ignored ^C would be ignored by the line as well.
    'trap : INT',
    `printf '%s\\n' ${shellQuote(line)}`,
    line,
    'code=$?',
    'printf \'%s\\n\' "$code" > "$said.tmp" && mv -f "$said.tmp" "$said"',
    'rm -f "$0"',
    'exit "$code"',
    ''
  ].join('\n')
}

/** `ps -o pgid=,tpgid=`: the group a process is in, and the group its terminal gives the keyboard to. */
export function parseForeground(output: string): boolean | null {
  const [group, foreground] = output.trim().split(/\s+/).map(Number)
  return Number.isInteger(group) && Number.isInteger(foreground) && group > 0 && foreground > 0 ? group === foreground : null
}

/** Two `-o`s: on Linux's ps `-o pgid=,tpgid=` is one column with a long header, and every press would be refused. */
export const foregroundArgs = (pid: number): string[] => ['-o', 'pgid=', '-o', 'tpgid=', '-p', String(pid)]

export function shellHoldsTerminal(pid: number): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile('ps', foregroundArgs(pid), { timeout: PS_BUDGET_MS }, (error, stdout) => resolve(error ? null : parseForeground(String(stdout))))
  })
}

/** The last line a pane shows, unless it is the runner or the line being echoed. */
export function paneLastLine(text: string | null, line: string, base: string): string {
  const last = (text ?? '').split('\n').map((row) => row.trim()).filter((row) => row !== '').at(-1) ?? ''
  return last.endsWith(line) || last.includes(`/${base}.sh`) ? '' : last
}

function askOf(input: unknown): SetupLineAsk | null {
  const { terminalId, line, enter, fresh } = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  if (typeof terminalId !== 'string' || terminalId === '' || typeof line !== 'string' || !setupLineAllowed(line)) return null
  return { terminalId, line, enter: enter !== false, fresh: fresh === true }
}

const refused = (reason: string, busy: boolean): SetupStart => ({ ok: false, reason, busy })

export function createSetupLines(deps: SetupLineDeps): SetupLines {
  const wait = deps.wait ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const runs = new Map<string, Run>()
  /** A press being answered: the pane is free now, and will not be in a moment. */
  const starting = new Set<string>()
  // A terminal id is a name here; nothing a sender chose may leave the folder.
  const baseOf = (terminalId: string): string => terminalId.replace(/[^A-Za-z0-9_-]/g, '_')
  const fileOf = (terminalId: string, ext: string): string => path.join(deps.dir, `${baseOf(terminalId)}.${ext}`)

  /** The shell's pid once it is in front; false when the pane is taken, null when it cannot be told. */
  const freeShell = async (ask: SetupLineAsk): Promise<number | false | null> => {
    const deadline = now() + (ask.fresh ? FRESH_WAIT_MS : BUSY_WAIT_MS)
    let answer: boolean | null = null
    for (;;) {
      const pid = deps.shellPid(ask.terminalId)
      answer = pid === null ? null : await deps.holds(pid)
      if (pid !== null && answer === true) return pid
      if (now() >= deadline) return answer === false ? false : null
      await wait(STEP_MS)
    }
  }

  const statusOf = (terminalId: string): string | null => {
    try {
      return readFileSync(fileOf(terminalId, 'status'), 'utf8').trim()
    } catch {
      return null
    }
  }

  const finish = (run: Run, code: number | null): SetupLineNow => {
    // Two asks can be in flight: the first answer stands.
    if (run.ended) return { state: 'ended', code: run.code }
    run.ended = true
    run.code = code
    run.close()
    return { state: 'ended', code }
  }

  /** Types the line. A run keeps the pane's view until it has ended; anything else lets go here. */
  const launch = (ask: SetupLineAsk, pid: number, release: () => void): SetupStart => {
    if (!ask.enter) {
      deps.type(ask.terminalId, `\x15${ask.line}`)
      release()
      return { ok: true, runId: null }
    }
    mkdirSync(deps.dir, { recursive: true, mode: PRIVATE_DIR_MODE })
    chmodSync(deps.dir, PRIVATE_DIR_MODE)
    const script = fileOf(ask.terminalId, 'sh')
    const status = fileOf(ask.terminalId, 'status')
    rmSync(status, { force: true })
    writeFileAtomic(script, lineScript(ask.line, status))
    const stopLooking = (deps.every ?? everyMs)(WATCH_MS, () => {
      const open = runs.get(ask.terminalId)
      if (open) void readNow(ask.terminalId, open).catch(() => undefined)
    })
    const close = once(() => {
      stopLooking()
      release()
    })
    const run: Run = { runId: randomUUID(), line: ask.line, pid, at: now(), close, absent: 0, ended: false, code: null }
    runs.set(ask.terminalId, run)
    try {
      // ^U first: a half-typed line must not become the front of this one.
      deps.type(ask.terminalId, `\x15/bin/sh ${shellQuote(script)}\r`)
    } catch (error) {
      runs.delete(ask.terminalId)
      close()
      throw error
    }
    return { ok: true, runId: run.runId }
  }

  /** The press, with the pane held up: refused here, the hold goes back with it. */
  const answerPress = async (ask: SetupLineAsk, held: () => void): Promise<SetupStart> => {
    const release = once(held)
    const shell = await freeShell(ask)
    if (shell === false || shell === null) {
      release()
      return shell === false ? refused(SETUP_LINE_COPY.BUSY, true) : refused(SETUP_LINE_COPY.UNREADABLE, true)
    }
    try {
      return launch(ask, shell, release)
    } catch (error) {
      release()
      throw error
    }
  }

  const readNow = async (terminalId: string, run: Run): Promise<SetupLineNow> => {
    if (run.ended) return { state: 'ended', code: run.code }
    const status = statusOf(terminalId)
    if (status !== null && /^\d+$/.test(status)) return finish(run, Number(status))
    if (!deps.alive(terminalId)) return finish(run, null)
    // In front with nothing said: killed, or typed into nothing.
    const silent = (await deps.holds(run.pid)) === true && (status === RUNNING || now() - run.at >= NEVER_RAN_MS)
    run.absent = silent ? run.absent + 1 : 0
    if (run.absent >= 2) return finish(run, null)
    const lastLine = paneLastLine(await deps.screen(terminalId).catch(() => null), run.line, baseOf(terminalId))
    const asking: SetupAsking = askingPassword(lastLine) ? 'password' : null
    return { state: 'running', lastLine, asking }
  }

  return {
    start: async (input) => {
      const ask = askOf(input)
      if (ask === null) return refused(SETUP_LINE_COPY.UNEXPECTED, false)
      if (!deps.isSetupCard(ask.terminalId)) return refused(SETUP_LINE_COPY.UNEXPECTED, false)
      if (starting.has(ask.terminalId)) return refused(SETUP_LINE_COPY.BUSY, true)
      starting.add(ask.terminalId)
      try {
        const last = runs.get(ask.terminalId)
        if (last && (await readNow(ask.terminalId, last)).state === 'running') return refused(SETUP_LINE_COPY.BUSY, true)
        const release = deps.view(ask.terminalId)
        if (release === null) return refused(SETUP_LINE_COPY.UNREADABLE, true)
        if ((deps.platform ?? process.platform) === 'win32') {
          deps.type(ask.terminalId, ask.enter ? `${ask.line}\r` : ask.line)
          release()
          return { ok: true, runId: null, unwatched: true }
        }
        return await answerPress(ask, release)
      } catch (error) {
        console.error('[cookrew] setup line:', error)
        return refused(SETUP_LINE_COPY.UNREADABLE, true)
      } finally {
        starting.delete(ask.terminalId)
      }
    },
    now: async (terminalId, runId) => {
      const run = runs.get(terminalId)
      return run?.runId === runId ? readNow(terminalId, run) : { state: 'none' }
    },
    current: (terminalId) => {
      const run = runs.get(terminalId)
      return run && !run.ended ? { runId: run.runId, line: run.line } : null
    }
  }
}

/** A table so tests/ipc-channels.test.ts can read what is registered. */
export const SETUP_LINE_CHANNELS = ['setup-line:start', 'setup-line:now', 'setup-line:current'] as const

export function registerSetupLineIpc(ipc: Pick<IpcMain, 'handle'>, lines: SetupLines): void {
  const [start, read, current] = SETUP_LINE_CHANNELS
  ipc.handle(start, (_e, input: unknown) => lines.start(input))
  ipc.handle(read, (_e, terminalId: unknown, runId: unknown) => (typeof terminalId === 'string' && typeof runId === 'string' ? lines.now(terminalId, runId) : { state: 'none' }))
  ipc.handle(current, (_e, terminalId: unknown) => (typeof terminalId === 'string' ? lines.current(terminalId) : null))
}
