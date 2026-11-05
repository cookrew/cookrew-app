// CAN THIS CARD START, AND IF IT DIED, WHY.
//
// A pane that cannot start used to be found out by starting it: tmux takes the
// pane with the failed command, the card reads "process exited", and the reason
// is nowhere. Under herdr a `cd` that fails is worse, because the agent starts
// anyway, in whatever folder the pane had. So what can be known beforehand is
// asked beforehand, against the very PATH the pane will export.
//
// False alarms cost more here than silence: a card that would have run and was
// refused is a new bug. So anything this cannot read for certain, shell syntax
// above all, is left to run and report for itself.

import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import type { LaunchFailure } from '../shared/launch-failure'

/** How long after a start an exit counts as the start failing. */
export const LAUNCH_WINDOW_MS = 20_000

const LAST_LINES = 6
const LINE_MAX = 200
/** Anything a shell would read as more than a plain word. */
const SHELL_SYNTAX = /[\s'"`$&|;<>()*?[\]{}\\~#]/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** What the multiplexer says about the pane, never what the pane said. */
const MUX_LINE = /^(\[exited\]|\[detached.*\]|Pane is dead\b.*)$/
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\^_])/g

/** The program a command line starts, or null when it takes a shell to say. */
export function commandWord(command: string): string | null {
  const words = command.trim().split(/\s+/).filter((word) => word.length > 0)
  const first = words.find((word) => !ASSIGNMENT.test(word))
  if (first === undefined) return null
  if (command.includes('&&') || command.includes('||') || command.includes(';') || command.includes('|')) return null
  return SHELL_SYNTAX.test(first) ? null : first
}

/** A stat that failed for a reason other than the path not being there says nothing about it. */
const certainlyAbsent = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Is it a program? Null when this cannot tell. */
function isExecutableFile(file: string): boolean | null {
  try {
    if (!statSync(file).isFile()) return false
  } catch (error) {
    return certainlyAbsent(error) ? false : null
  }
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** False only when it certainly is not there: a folder it may not read could hold it. */
function resolves(word: string, cwd: string, searchPath: string): boolean {
  if (word.includes('/')) return isExecutableFile(path.resolve(cwd, word)) !== false
  return searchPath
    .split(':')
    .some((dir) => dir.length > 0 && isExecutableFile(path.join(path.resolve(cwd, dir), word)) !== false)
}

/**
 * Is the program SEEN here? The other way round from `resolves`, for a card nobody
 * asked for: a dir this user may not read proves nothing, and neither does a
 * command that takes a shell to say.
 */
export function toolSeen(command: string, cwd: string, searchPath: string): boolean {
  const word = commandWord(command)
  if (word === null) return false
  if (word.includes('/')) return isExecutableFile(path.resolve(cwd, word)) === true
  return searchPath
    .split(':')
    .some((dir) => dir.length > 0 && isExecutableFile(path.join(path.resolve(cwd, dir), word)) === true)
}

const failure = (over: Pick<LaunchFailure, 'kind' | 'why' | 'fix'> & Partial<LaunchFailure>): LaunchFailure => ({
  blocked: true,
  exitCode: null,
  lastLines: [],
  at: Date.now(),
  ...over
})

export function folderFailure(cwd: string): LaunchFailure | null {
  try {
    if (statSync(cwd).isDirectory()) return null
    return failure({
      kind: 'folder-not-directory',
      why: `${cwd} is a file, not a folder.`,
      fix: 'Point this workspace at a folder, then send again.'
    })
  } catch (error) {
    if (!certainlyAbsent(error)) return null
    return failure({
      kind: 'folder-missing',
      why: `The folder ${cwd} does not exist.`,
      fix: 'Create or restore it, then send again.'
    })
  }
}

export interface LaunchCheck {
  cwd: string
  command: string
  /** The PATH the pane will export. */
  path: string
  /** False when that PATH is not the one the command will see (the direct backend's login shell). */
  checkCommand: boolean
  /** How to install a harness, when this app knows. */
  installLine: (word: string) => string | null
}

/** What stops this card starting, or null. Only what is certain. */
export function launchBlock(check: LaunchCheck): LaunchFailure | null {
  const folder = folderFailure(check.cwd)
  if (folder) return folder
  if (!check.checkCommand) return null
  const word = commandWord(check.command)
  if (word === null || resolves(word, check.cwd, check.path)) return null
  const install = check.installLine(path.basename(word))
  return failure({
    kind: 'command-missing',
    exitCode: 127,
    why: `Command not found: ${word}.`,
    fix: install ? `Install it (${install}) or add it to PATH, then send again.` : `Install ${word} or add it to PATH, then send again.`
  })
}

/**
 * Does a recorded block still stand? Only its cause lifts it: a husk has a pane
 * listed, so "nothing stops it now" cannot be read off the pane.
 */
export function blockStands(known: LaunchFailure | null | undefined, cause: LaunchFailure | null): boolean {
  return known?.blocked === true && cause !== null
}

export interface ExitFacts {
  /** What to call it: the command's word, or the card's name. */
  name: string
  /** It runs a harness, not a login shell. */
  agent: boolean
  /** Null when the backend did not report one. */
  exitCode: number | null
  signal: string | null
  tail: readonly string[]
  ranMs: number
  /** It was running before this attach: its start was not seen, so an early end says nothing of it. */
  reattached: boolean
}

function howItEnded(facts: ExitFacts): string {
  if (facts.signal !== null) return ` (signal ${facts.signal})`
  return facts.exitCode === null ? '' : ` (exit ${facts.exitCode})`
}

/** What a process's end says about it, or null when it just ended. */
export function exitFailure(facts: ExitFacts): LaunchFailure | null {
  const early = !facts.reattached && facts.ranMs < LAUNCH_WINDOW_MS
  const errored = facts.signal !== null || (facts.exitCode !== null && facts.exitCode !== 0)
  // A login shell ends with the status of whatever ran last, so only an early
  // error says anything; `exit` typed a minute in is the shell doing its job.
  const failed = facts.agent ? early || errored : early && errored
  if (!failed) return null
  return failure({
    kind: 'exited',
    blocked: false,
    exitCode: facts.exitCode,
    lastLines: facts.tail,
    why: early
      ? `${facts.name} stopped right after it started${howItEnded(facts)}.`
      : `${facts.name} stopped${howItEnded(facts)}.`,
    fix: 'Its last lines are below. Send again to start it again.'
  })
}

/** The last lines of raw pane output, as a person would read them. */
export function cleanTail(raw: string): string[] {
  return raw
    .replace(ESCAPES, '')
    .split(/\r?\n|\r/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !MUX_LINE.test(line.trim()))
    .slice(-LAST_LINES)
    .map((line) => line.slice(0, LINE_MAX))
}
