// WHEN DID THIS AGENT LAST DO ANYTHING? — asked of the agent, not guessed.
//
// Owner, 2026-11-01: "idle ten minutes and offline is unreasonable; many agents
// that were still running got killed." The audit agreed. Of the sleeps that
// day, Forge, Fresco, Velvet, Conductor, Dave and two more were MID-TURN: the
// model gateway was answering 502 and each claude sat on a retrying API
// request, spinner on, nothing new in its transcript. Cookrew's own signals
// (its turn tracker, herdr's screen guess) both said "not working" — and right
// after an app restart the tracker knows nothing at all, so the 20:19 burst
// came exactly one window after the 20:09 boot.
//
// The process knows. Claude writes ~/.claude/sessions/<pid>.json with
// `status: 'busy' | 'idle'` and `statusUpdatedAt`; a Bash-tool command
// (background ones too) runs as a child shell sourced from
// ~/.claude/shell-snapshots; a background agent writes under
// <session>/subagents/; a /loop that is waiting has a ScheduleWakeup in its
// transcript. So the sleep sweep's clock only nominates, and this decides:
// an agent sleeps when Claude itself says idle, nothing it started is still
// running, and the newest sign of life is a whole window old. Anything that
// cannot be read counts as "now" — a card we cannot see into stays awake.
//
// SCOPE — the decisions are pure; gatherSleepEvidence is the one reader (one
// async `ps`, a stat or two and a transcript tail per nominee, never per
// sweep for every card).

import { execFile } from 'node:child_process'
import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isPaneAgent } from '../shared/pane-agent.mjs'
import type { SessionHolder } from './claude-live-session'

const execFileAsync = promisify(execFile)

/** One row of `ps -axo pid=,ppid=,command=`. */
export interface ProcRow {
  ppid: number
  command: string
}

export type ProcTable = ReadonlyMap<number, ProcRow>

export function parsePsTable(text: string): Map<number, ProcRow> {
  const rows = new Map<number, ProcRow>()
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] })
  }
  return rows
}

/** Every process below `pid`, nearest first. */
export function descendantsOf(pid: number, table: ProcTable): number[] {
  const children = new Map<number, number[]>()
  for (const [child, row] of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), child])
  const out: number[] = []
  const queue = [...(children.get(pid) ?? [])]
  while (queue.length > 0 && out.length < 4096) {
    const next = queue.shift() as number
    out.push(next)
    queue.push(...(children.get(next) ?? []))
  }
  return out
}

/** How claude runs a Bash tool command: a shell that sources its snapshot. */
const TOOL_SHELL_RE = /\/shell-snapshots\/snapshot-/

/**
 * Work the pane's claude started that is still going: a Bash-tool command
 * (foreground or `run_in_background`) or a background agent of its own that
 * is not at rest. MCP servers are children too and never count.
 */
export function runningWorkUnder(pid: number, table: ProcTable, holders: readonly SessionHolder[]): string[] {
  const busyAgents = new Map(holders.filter((h) => h.status !== 'idle').map((h) => [h.pid, h]))
  const work: string[] = []
  for (const child of descendantsOf(pid, table)) {
    const row = table.get(child)
    if (row && TOOL_SHELL_RE.test(row.command)) work.push(`command ${child}`)
    else if (busyAgents.has(child)) work.push(`agent ${child}`)
  }
  return work
}

/** How far back a loop's last word is believed: a cron left from days ago is not a loop. */
export const LOOP_LOOKBACK_MS = 24 * 60 * 60_000

export interface LoopState {
  /** When the newest ScheduleWakeup fires; null when none is pending. */
  wakeAt: number | null
  /** A CronCreate without a matching CronDelete inside the lookback. */
  cronArmed: boolean
}

interface ToolUse {
  at: number
  name: string
  input: Record<string, unknown>
}

function toolUsesIn(lines: readonly string[]): ToolUse[] {
  const uses: ToolUse[] = []
  for (const line of lines) {
    // Cheap reject first: most lines are not a loop tool's call.
    if (!line.includes('"ScheduleWakeup"') && !line.includes('"Cron')) continue
    try {
      const entry = JSON.parse(line) as { type?: string; timestamp?: string; message?: { content?: unknown } }
      const at = Date.parse(entry.timestamp ?? '')
      if (entry.type !== 'assistant' || !Number.isFinite(at) || !Array.isArray(entry.message?.content)) continue
      for (const block of entry.message.content as Array<{ type?: string; name?: string; input?: unknown }>) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
        uses.push({ at, name: block.name, input: (block.input ?? {}) as Record<string, unknown> })
      }
    } catch {
      // A torn line at the tail's cut, or a half-written last line.
    }
  }
  return uses
}

/** A /loop or a cron waiting in the transcript's tail. */
export function loopStateOf(lines: readonly string[], now: number): LoopState {
  const uses = toolUsesIn(lines).filter((u) => now - u.at <= LOOP_LOOKBACK_MS)
  const wake = uses.filter((u) => u.name === 'ScheduleWakeup').at(-1)
  const delay = Number(wake?.input.delaySeconds)
  const wakeAt = wake && wake.input.stop !== true && Number.isFinite(delay) ? wake.at + delay * 1000 : null
  const created = uses.filter((u) => u.name === 'CronCreate').length
  const deleted = uses.filter((u) => u.name === 'CronDelete').length
  return { wakeAt, cronArmed: created > deleted }
}

export interface SleepEvidence {
  /** Claude's record for the pane's process; null when there is none to read. */
  claude: { status: string | null; since: number | null } | null
  /** What runningWorkUnder found. */
  running: readonly string[]
  /** Newest write to the conversation or any of its subagents' transcripts. */
  lastWrite: number | null
  loop: LoopState
}

/** A loop's wakeup counts as activity a little past its due time: it has to start. */
export const WAKE_GRACE_MS = 5 * 60_000

/**
 * The last moment this agent did, or will do, anything. `now` whenever it is
 * doing something or cannot be read; a time in the future for a loop that is
 * waiting to wake. The caller sleeps it once this is a whole window old.
 */
export function quietSince(e: SleepEvidence, now: number): { at: number; why: string } {
  if (!e.claude || e.claude.status === null) return { at: now, why: 'claude keeps no status for this pane' }
  if (e.claude.status !== 'idle') return { at: now, why: `claude says ${e.claude.status}` }
  if (e.running.length > 0) return { at: now, why: `still running ${e.running.join(', ')}` }
  if (e.loop.cronArmed) return { at: now, why: 'a cron job is armed' }
  const marks: Array<[number, string]> = [[e.claude.since ?? now, 'idle since']]
  if (e.lastWrite !== null) marks.push([e.lastWrite, 'last write'])
  if (e.loop.wakeAt !== null) marks.push([e.loop.wakeAt + WAKE_GRACE_MS, 'loop wakes'])
  const [at, why] = marks.reduce((a, b) => (b[0] > a[0] ? b : a))
  return { at, why }
}

/** The pane agent's own record, by the pane's pid (see pane-agent.mjs). */
export function paneHolder(
  panePid: number | null,
  holders: readonly SessionHolder[],
  cwd: string,
  real?: (dir: string) => string
): SessionHolder | null {
  if (panePid === null) return null
  const holder = holders.find((h) => h.pid === panePid)
  return holder && isPaneAgent(holder, cwd, real) ? holder : null
}

/** One process listing per sweep that nominated anybody; null when ps fails (see gatherSleepEvidence). */
export async function readProcTable(): Promise<Map<number, ProcRow> | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })
    return parsePsTable(stdout)
  } catch {
    return null
  }
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return null
  }
}

/** The transcript's newest write, or a subagent's under <session>/subagents/. */
async function lastWriteOf(transcript: string): Promise<number | null> {
  const own = await mtimeOf(transcript)
  const subDir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')
  let subs: string[] = []
  try {
    subs = (await readdir(subDir)).filter((name) => name.endsWith('.jsonl'))
  } catch {
    // No background agents ever ran in this session.
  }
  const times = await Promise.all(subs.map((name) => mtimeOf(path.join(subDir, name))))
  const all = [own, ...times].filter((t): t is number => t !== null)
  return all.length > 0 ? Math.max(...all) : null
}

/** The transcript's last `bytes`, as whole lines. */
export async function tailLines(file: string, bytes = 512 * 1024): Promise<string[]> {
  try {
    const handle = await open(file, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - bytes)
      const buffer = Buffer.alloc(size - start)
      await handle.read(buffer, 0, buffer.length, start)
      const lines = buffer.toString('utf8').split('\n')
      return start > 0 ? lines.slice(1) : lines
    } finally {
      await handle.close()
    }
  } catch {
    return []
  }
}

/**
 * Everything quietSince needs for one nominee. `procs === null` (ps failed)
 * reads as running work, so a failed listing can never be what lets a sleep
 * through.
 */
export async function gatherSleepEvidence(input: {
  holder: SessionHolder | null
  holders: readonly SessionHolder[]
  procs: ProcTable | null
  transcript: string
  now: number
}): Promise<SleepEvidence> {
  const { holder, holders, procs, transcript, now } = input
  const claude = holder ? { status: holder.status ?? null, since: holder.statusSince ?? null } : null
  const running = !holder ? [] : procs ? runningWorkUnder(holder.pid, procs, holders) : ['(process list unreadable)']
  const [lastWrite, lines] = await Promise.all([lastWriteOf(transcript), tailLines(transcript)])
  return { claude, running, lastWrite, loop: loopStateOf(lines, now) }
}
