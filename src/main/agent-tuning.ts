// Reading and turning an agent's two dials (shared/agent-tuning) — the main
// half: the session file is the readout, the PTY is the control.
//
// Nothing here knows about Electron. The PTY table and the node store arrive
// as two functions, so the whole path — refuse mid-turn, type one line,
// remember the ask, read it back off the record — is exercisable in a test
// with a temp directory and a fake pane.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import {
  inputRefusal,
  isTuneKnob,
  tuneValueOk,
  type AgentTuning,
  type AgentTuningState,
  type HarnessTuning,
  type TuneAsk,
  type TuneKnob,
} from '../shared/agent-tuning'
import type { TerminalNodeData } from '../shared/model'
import { harnessFor, type HarnessWatchOptions } from './harness'

/**
 * How far back a COLD read looks, in escalating steps.
 *
 * The default suits a harness that stamps every reply: the dials are on the
 * last record, 32 KB reaches past a few ordinary turns, and 256 KB is the
 * retry for a turn with a long tool transcript.
 *
 * It does NOT suit a harness that stamps once per TURN. Codex writes its
 * `turn_context` when a turn STARTS, so the distance from EOF is the whole
 * turn's output — measured on this fleet, three live codex agents had their
 * last one 452 KB, 941 KB and 3.0 MB back in rollouts of 10-64 MB, and all
 * three showed no tag at all. So a harness may declare its own steps
 * (HarnessTuning.tailSteps) and codex declares much larger ones.
 *
 * The escalation is only ever paid ONCE per file: after a cold read the cache
 * below follows the file forward by its appended bytes alone.
 */
const TAIL_STEPS = [32 * 1024, 256 * 1024] as const

/**
 * How far back a WARM read looks past the last byte it already scanned.
 *
 * A record can straddle the boundary between what was read and what was
 * appended since, so the window starts slightly before the old end. One record
 * is far smaller than this; the overlap is cheap insurance against splitting
 * the very record we are looking for.
 */
const APPEND_OVERLAP = 64 * 1024

/** Dial turns remembered per terminal — enough to cover both knobs, twice. */
const ASKS_KEPT = 4

/**
 * The least a readout needs. NOT a canvas node: the per-card tag is drawn for
 * the whole roster, including workspaces that are not open, and there the
 * subject comes from the durable agent registry — one id, one command, one
 * cwd, one session ref.
 */
export interface TuningSubject {
  id: string
  command: string
  cwd: string
  /**
   * The harness's session reference. A canvas node keeps it in a per-harness
   * field (claudeSessionId, codexSessionRef, …); the registry keeps it in one
   * field. subjectOf() does that translation so nothing downstream repeats it.
   */
  sessionRef?: string | null
}

export function subjectOf(node: TerminalNodeData): TuningSubject {
  const harness = harnessFor(node.command)
  const ref = harness ? node[harness.sessionField] : null
  return {
    id: node.id,
    command: node.command,
    cwd: node.cwd,
    sessionRef: typeof ref === 'string' ? ref : null
  }
}

/** The session file holding this subject's dials, or null. */
function tuningFile(subject: TuningSubject, options: HarnessWatchOptions): string | null {
  const harness = harnessFor(subject.command)
  if (!harness?.tuning || !harness.watchFile) return null
  // WatchSubject is exactly {id, cwd, <sessionField>}: the resolvers read
  // nothing else, which is why the type was narrowed to say so.
  return harness.watchFile(
    { id: subject.id, cwd: subject.cwd, [harness.sessionField]: subject.sessionRef ?? null },
    options
  )
}

/**
 * The dials as the harness last recorded them, or null when nothing is
 * readable: no harness, no session bound yet, no file, no record in the tail.
 * Every one of those is "not known", and the card says nothing rather than
 * defaulting to a value the agent might not be running on.
 */
export function readTuning(
  subject: TuningSubject,
  options: HarnessWatchOptions = {}
): AgentTuning | null {
  const harness = harnessFor(subject.command)
  const file = tuningFile(subject, options)
  if (file === null || !harness?.tuning) return null
  return scanTail(file, harness.tuning)
}

function scanTail(file: string, tuning: HarnessTuning): AgentTuning | null {
  for (const step of tuning.tailSteps ?? TAIL_STEPS) {
    const { lines, from } = tailLines(file, step)
    const found = newestIn(lines, tuning)
    if (found !== null) return found
    // The window already reached byte 0 — a larger step would read the same
    // bytes again and find the same nothing.
    if (from === 0) break
  }
  return null
}

/** The newest dial-bearing record in these lines, scanning backwards. */
function newestIn(lines: readonly string[], tuning: HarnessTuning): AgentTuning | null {
  // Newest first: the dials are whatever the most recent record says, and a
  // forward scan would hand back the settings the session STARTED on.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line.length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      // A torn final line (the harness is mid-append) or the partial first
      // line of the window. Neither is an error; the next line back is fine.
      continue
    }
    const found = tuning.read(record)
    if (found !== null) return found
  }
  return null
}

/** The newest record carrying dials in [from, EOF), or null if there is none. */
function scanWindow(file: string, tuning: HarnessTuning, from: number): AgentTuning | null {
  let fd: number | null = null
  try {
    const size = statSync(file).size
    if (size <= from) return null
    const buffer = Buffer.allocUnsafe(size - from)
    fd = openSync(file, 'r')
    const read = readSync(fd, buffer, 0, size - from, from)
    const lines = buffer.subarray(0, read).toString('utf8').split('\n')
    return newestIn(from > 0 ? lines.slice(1) : lines, tuning)
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The last `window` bytes of a file as lines, minus the partial one in front. */
function tailLines(file: string, window: number): { lines: string[]; from: number } {
  let fd: number | null = null
  try {
    const size = statSync(file).size
    const from = Math.max(0, size - window)
    const length = size - from
    if (length <= 0) return { lines: [], from: 0 }
    const buffer = Buffer.allocUnsafe(length)
    fd = openSync(file, 'r')
    const read = readSync(fd, buffer, 0, length, from)
    const lines = buffer.subarray(0, read).toString('utf8').split('\n')
    // A window that did not start at byte 0 begins mid-record. Dropping it
    // costs one record of readout and saves a parse of half of one.
    return { lines: from > 0 ? lines.slice(1) : lines, from }
  } catch {
    return { lines: [], from: 0 }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * The readout for every card at once, without reading every file every time.
 *
 * A canvas holds dozens of agents and the tag is drawn on all of them, so the
 * question "what is this one running on?" is asked far more often than the
 * answer changes. A session file that has not grown cannot have a new last
 * record, so size+mtime gate the read: unchanged files cost one stat, and the
 * parse happens only where a turn actually landed.
 */
interface CachedRead {
  file: string
  size: number
  mtimeMs: number
  tuning: AgentTuning | null
}

export class TuningCache {
  private held = new Map<string, CachedRead>()

  of(subject: TuningSubject, options: HarnessWatchOptions = {}): AgentTuning | null {
    const harness = harnessFor(subject.command)
    const file = tuningFile(subject, options)
    if (file === null || !harness?.tuning) return null
    let stamp: { size: number; mtimeMs: number }
    try {
      const stat = statSync(file)
      stamp = { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return null
    }
    const prior = this.held.get(subject.id)
    if (
      prior !== undefined &&
      prior.file === file &&
      prior.size === stamp.size &&
      prior.mtimeMs === stamp.mtimeMs
    ) {
      return prior.tuning
    }
    // THE FILE ONLY GROWS, SO FOLLOW IT FORWARD.
    //
    // A session file that has grown can only have gained records at the end,
    // so a warm read scans the APPENDED bytes and nothing else. That is what
    // keeps an active agent cheap: without it, a codex card mid-turn would
    // re-escalate through megabytes on every single append.
    //
    // Finding nothing in the new bytes is NOT "unknown" — it means no new
    // stamp has been written, so the reading we already have is still what the
    // agent is running on. Only a NEWER record replaces it. (Same reasoning
    // the harness registry's own rollout notes give for a byte-offset cursor.)
    const grew = prior !== undefined && prior.file === file && stamp.size >= prior.size
    const tuning = grew
      ? (scanWindow(file, harness.tuning, Math.max(0, prior.size - APPEND_OVERLAP)) ??
        prior.tuning)
      : scanTail(file, harness.tuning)
    this.held.set(subject.id, { file, ...stamp, tuning })
    return tuning
  }

  forget(terminalId: string): void {
    this.held.delete(terminalId)
  }
}

/**
 * Dial turns that have not yet been settled by a reply.
 *
 * In memory on purpose. An ask is a claim about a line typed into a live pane,
 * and a pane does not survive the app — so an ask restored from disk after a
 * restart would be a memory of a request nobody can still confirm or refute.
 */
export class TuneAsks {
  private byTerminal = new Map<string, readonly TuneAsk[]>()

  record(terminalId: string, ask: TuneAsk): void {
    const kept = [...(this.byTerminal.get(terminalId) ?? []), ask]
    this.byTerminal.set(terminalId, kept.slice(-ASKS_KEPT))
  }

  of(terminalId: string): TuneAsk[] {
    return [...(this.byTerminal.get(terminalId) ?? [])]
  }

  /** A terminal that ended takes its unsettled asks with it. */
  forget(terminalId: string): void {
    this.byTerminal.delete(terminalId)
  }
}

export interface TuneDeps {
  node: (id: string) => TerminalNodeData | null
  /**
   * Type into the pane. Returns the PTY's own verdict — the input gate that
   * already guards every keystroke (delivery windows, a contaminated input
   * box). Reusing it is deliberate: a second gate invented here would be a
   * second thing to keep in step with the first.
   */
  write: (id: string, data: string) => string | undefined
  asks: TuneAsks
  /** Shared readout cache; an absent one reads the file every time (tests). */
  cache?: TuningCache
  watch?: HarnessWatchOptions
  now?: () => number
}

export type TuneResult = { ok: true; ask: TuneAsk } | { ok: false; reason: string }

/** The whole state of one card's dials, as the renderer's rail consumes it. */
export function tuningStateOf(deps: TuneDeps, terminalId: string): AgentTuningState {
  const node = deps.node(terminalId)
  const harness = node ? harnessFor(node.command) : null
  if (node === null || harness === null) {
    return { harness: null, knobs: [], records: [], tuning: null, asks: [], caveat: null }
  }
  const knobs = [...(harness.tuning?.knobs ?? [])]
  const tuning = (deps.cache ?? new TuningCache()).of(subjectOf(node), deps.watch ?? {})
  // A harness may name its own values, and pi's depend on the model currently
  // loaded — so the reading has to be in hand before the choices are asked for.
  const choices: Partial<Record<TuneKnob, readonly string[]>> = {}
  for (const knob of knobs) {
    const values = harness.tuning?.values?.(knob, tuning)
    if (values) choices[knob] = values
  }
  return {
    harness: harness.id,
    knobs,
    // Absent means "every knob it can set, it also writes down" — true of
    // claude, and the safe default for a harness that has not thought about it.
    records: [...(harness.tuning?.records ?? knobs)],
    tuning,
    asks: deps.asks.of(terminalId),
    caveat: harness.tuning?.caveat ?? null,
    ...(Object.keys(choices).length > 0 ? { choices } : {}),
  }
}

/**
 * Turn a dial: type one line into the pane and remember that we did.
 *
 * The ask is recorded only when the PTY accepted the line. An ask nobody typed
 * would show as pending forever, and "pending" is the rail's promise that
 * something is on its way.
 */
export function applyTuning(
  deps: TuneDeps,
  terminalId: string,
  knob: TuneKnob,
  value: string
): TuneResult {
  const node = deps.node(terminalId)
  if (node === null) return { ok: false, reason: 'no such terminal' }
  const harness = harnessFor(node.command)
  if (!harness?.tuning) return { ok: false, reason: 'this agent has no dials' }
  // Both arrive over IPC and both end up inside a line typed into a live pane.
  if (!isTuneKnob(knob)) return { ok: false, reason: 'not a dial' }
  if (!harness.tuning.knobs.includes(knob)) return { ok: false, reason: `this agent has no ${knob} dial` }
  // Against the HARNESS's values when it names them, not the shared defaults.
  // For pi this is the difference between setting a model and opening a picker
  // that swallows the pane's input.
  const offered =
    harness.tuning.values?.(knob, readTuning(subjectOf(node), deps.watch ?? {})) ?? null
  const allowed = offered === null ? tuneValueOk(knob, value) : offered.includes(value)
  if (!allowed) return { ok: false, reason: `not a ${knob} this agent offers` }
  const line = harness.tuning.line(knob, value)
  if (line === null) return { ok: false, reason: `this agent has no ${knob} dial` }

  const verdict = deps.write(terminalId, line)
  // Anything but 'allow' means the gate held the line back. Sending the
  // carriage return anyway would submit whatever IS in the box — which on a
  // contaminated box is someone else's half-typed prompt.
  if (verdict !== undefined && verdict !== 'allow') {
    return { ok: false, reason: inputRefusal(verdict) }
  }
  deps.write(terminalId, '\r')

  const ask: TuneAsk = { knob, value, at: (deps.now ?? Date.now)() }
  deps.asks.record(terminalId, ask)
  return { ok: true, ask }
}
