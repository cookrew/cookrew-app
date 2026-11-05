// A WHOLE-SUITE RUN IS THE HEAVIEST THING AN AGENT DOES, AND THEY ALL DO IT.
//
// Measured 2026-11-05: four whole-suite vitest runs at once, nine workers each,
// on ten cores: load 135 with memory already recovered, every run slower than
// it would have been alone, and the owner's app stalling under all of them.
// Agents reach for `npx vitest` directly, so the gate sits in the config every
// run loads, not in an npm script they could walk around.
//
// A slot is a file named `<takenAt>-<pid>`: a run that dies frees its slot by
// being dead, so no exit hook has to fire and no lock can go stale. Two racers
// both write, both list, and the older name is in, so the order needs no lock.
//
// Focused runs (any filter or name pattern) never queue: they are what an agent
// runs every few minutes, they are small, and making them wait behind a full
// suite is the slowdown this exists to remove. Nor do watch or ui sessions: they
// stay open for hours and would hold a slot the whole time. Waiting is capped,
// and giving up runs the suite anyway: a slow suite beats a failed one. A run
// that gave up keeps its file, so whoever comes next still queues behind it.
//
// SCOPE — plain ESM with a .d.mts beside it, because vitest.config.ts imports
// it before anything is compiled.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const DEFAULT_SLOTS = 2
const MAX_SLOT_AGE_MS = 2 * 3_600_000
const DEFAULT_MAX_WAIT_MS = 4 * 60_000
const DEFAULT_POLL_MS = 2000
const SLOT_NAME = /^(\d+)-(\d+)$/
const SUITE_DIRS = new Set(['tests', 'tests/', 'test', 'test/', './tests', './tests/'])
const NOT_A_RUN = new Set(['watch', 'dev', 'bench', 'init', 'list'])
const OPEN_ENDED_FLAGS = new Set(['--ui', '--watch', '-w', '--standalone'])
const NAME_PATTERN_FLAGS = new Set(['-t', '--testNamePattern'])
/** Flags whose next word is their value, not a filter. */
const VALUE_FLAGS = new Set([
  '--config', '-c', '--root', '-r', '--dir', '--project', '--reporter', '--outputFile', '--exclude', '--pool',
  '--shard', '--maxWorkers', '--minWorkers', '--testTimeout', '--hookTimeout', '--environment', '--mode', '--retry',
  '--bail', '--sequence.seed', '--coverage.reporter', '--coverage.reportsDirectory'
])

export const HEAVY_SLOT_DIR = path.join(homedir(), '.cookrew', 'heavy-slots')

/** The words that are not flags or a flag's value: the command, then filters. */
function positionals(args) {
  const words = []
  for (let i = 0; i < args.length; i += 1) {
    if (VALUE_FLAGS.has(args[i])) i += 1
    else if (!args[i].startsWith('-')) words.push(args[i])
  }
  return words
}

/**
 * True for a run that takes the whole suite and then ends. A bare `vitest` on a
 * terminal is watch mode; with no terminal (an agent's Bash tool) it is a run.
 */
export function isWholeSuiteRun(args, isTTY = false) {
  const flags = args.map((arg) => arg.split('=')[0])
  if (flags.some((flag) => OPEN_ENDED_FLAGS.has(flag) || NAME_PATTERN_FLAGS.has(flag))) return false
  const [first, ...rest] = positionals(args)
  if (NOT_A_RUN.has(first)) return false
  if (first !== 'run' && first !== undefined) return SUITE_DIRS.has(first) && rest.length === 0 && !isTTY
  if (first === undefined && isTTY) return false
  return rest.every((word) => SUITE_DIRS.has(word))
}

/** `COOKREW_HEAVY_SLOTS`: a count, 0 = gate off, garbage = default. */
export function slotCount(raw) {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SLOTS
  const slots = Number(raw)
  return Number.isInteger(slots) && slots >= 0 ? slots : DEFAULT_SLOTS
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Held slots, oldest first; a dead or impossibly old holder's file is swept. */
export function liveSlots(dir, { isAlive = pidAlive, now = Date.now() } = {}) {
  const live = []
  for (const name of readdirSync(dir)) {
    const match = SLOT_NAME.exec(name)
    if (!match) continue
    const fresh = now - Number(match[1]) < MAX_SLOT_AGE_MS
    if (fresh && isAlive(Number(match[2]))) live.push(name)
    else rmSync(path.join(dir, name), { force: true })
  }
  return live.sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || a.localeCompare(b))
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait for a slot. Resolves `{ taken, waitedMs }` and never rejects: nothing
 * about this gate may be the reason a test run fails. `taken: false` means run
 * anyway: the gate is off, the wait ran out, or the directory is unusable.
 */
export async function takeHeavySlot({
  dir = HEAVY_SLOT_DIR,
  slots = DEFAULT_SLOTS,
  pid = process.pid,
  isAlive = pidAlive,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  pollMs = DEFAULT_POLL_MS,
  now = Date.now,
  sleep = pause,
  onWait = () => {}
} = {}) {
  if (slots <= 0) return { taken: false, waitedMs: 0 }
  const started = now()
  const mine = `${started}-${pid}`
  const file = path.join(dir, mine)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, '')
    let told = false
    for (;;) {
      const live = liveSlots(dir, { isAlive, now: now() })
      const rank = live.indexOf(mine)
      const waitedMs = now() - started
      if (rank >= 0 && rank < slots) return { taken: true, waitedMs }
      if (waitedMs >= maxWaitMs) return { taken: false, waitedMs }
      if (!told) onWait(live.length)
      told = true
      await sleep(pollMs)
    }
  } catch {
    return { taken: false, waitedMs: now() - started }
  }
}

/** The whole gate for a vitest config: one call, one line of output when it waits. */
export async function awaitTestSlot(args = process.argv.slice(2), env = process.env) {
  if (env.CI || !isWholeSuiteRun(args, process.stdout.isTTY === true)) return
  await takeHeavySlot({
    slots: slotCount(env.COOKREW_HEAVY_SLOTS),
    onWait: (held) => console.error(`[heavy-slot] ${held - 1} whole-suite run(s) ahead on this machine; waiting for a slot (at most 4 min)`)
  })
}
