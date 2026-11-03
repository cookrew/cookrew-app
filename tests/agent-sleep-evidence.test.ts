// WHEN DID THIS AGENT LAST DO ANYTHING? — asked of the agent, not guessed.
//
// 2026-11-01: the sleep sweep ended Forge, Fresco, Velvet, Conductor and Dave
// mid-turn — each claude was retrying an API request through a 502 spell, so
// nothing new reached its transcript and Cookrew's own signals read idle.
// These cases are what the evidence must now refuse.
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  descendantsOf,
  gatherSleepEvidence,
  loopStateOf,
  paneHolder,
  parsePsTable,
  quietSince,
  runningWorkUnder,
  tailLines,
  WAKE_GRACE_MS,
  type SleepEvidence
} from '../src/main/agent-sleep-evidence'
import type { SessionHolder } from '../src/main/claude-live-session'

const MIN = 60_000
const NOW = 1_793_535_599_233
const SID = '26760182-51cc-4ec1-b671-9b1fd4b6c6ca'

/** The shape `ps -axo pid=,ppid=,command=` printed for a live agent that day. */
const PS = [
  '68756  1369 claude --permission-mode bypassPermissions --session-id 26760182-51cc-4ec1-b671-9b1fd4b6c6ca',
  '20032 68756 /bin/zsh -c source /Users/drej/.claude/shell-snapshots/snapshot-zsh-1793537411950-07dyui.sh 2>/dev/null || true && eval \'npm test\'',
  '20040 20032 node vitest run',
  ' 2258 68756 caffeinate -i -t 300',
  '69886 68756 npm exec @upstash/context7-mcp@latest',
  '69900 69886 node context7-mcp',
  '70502 68756 /Users/drej/.pencil/mcp/cursor/out/mcp-server-darwin-arm64 --app cursor',
  '71000 68756 claude --bg-agent',
  '  555     1 /bin/zsh -c source /Users/drej/.claude/shell-snapshots/snapshot-zsh-1.sh && orphan'
].join('\n')

const holder = (over: Partial<SessionHolder> = {}): SessionHolder => ({
  pid: 68756, sessionId: SID, kind: 'interactive', cwd: '/w', status: 'idle', statusSince: NOW - 90 * MIN, ...over
})

const evidence = (over: Partial<SleepEvidence> = {}): SleepEvidence => ({
  claude: { status: 'idle', since: NOW - 90 * MIN },
  running: [],
  lastWrite: NOW - 80 * MIN,
  loop: { wakeAt: null, cronArmed: false },
  ...over
})

const assistant = (at: number, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_use', id: 'x', name, input }] } })

describe('quietSince — the agent\'s own word decides', () => {
  it('a claude that says busy is active NOW, however long its transcript has been silent', () => {
    // Forge: "continue" at 19:59, four API retries, then 17 silent minutes — mid-turn.
    const e = evidence({ claude: { status: 'busy', since: NOW - 20 * MIN }, lastWrite: NOW - 17 * MIN })
    expect(quietSince(e, NOW)).toEqual({ at: NOW, why: 'claude says busy' })
  })

  it('no record for the pane (cold pid, old claude) cannot tell, so it is active now', () => {
    expect(quietSince(evidence({ claude: null }), NOW).at).toBe(NOW)
    expect(quietSince(evidence({ claude: { status: null, since: null } }), NOW).at).toBe(NOW)
  })

  it('a command or a background agent still running keeps it awake', () => {
    const q = quietSince(evidence({ running: ['command 20032'] }), NOW)
    expect(q.at).toBe(NOW)
    expect(q.why).toContain('command 20032')
  })

  it('an armed cron keeps it awake', () => {
    expect(quietSince(evidence({ loop: { wakeAt: null, cronArmed: true } }), NOW).at).toBe(NOW)
  })

  it('a /loop waiting on its next wakeup is active until just past it', () => {
    const wakeAt = NOW + 25 * MIN
    expect(quietSince(evidence({ loop: { wakeAt, cronArmed: false } }), NOW)).toEqual({ at: wakeAt + WAKE_GRACE_MS, why: 'loop wakes' })
  })

  it('a background agent writing its transcript is newer than the idle flip', () => {
    expect(quietSince(evidence({ lastWrite: NOW - 3 * MIN }), NOW)).toEqual({ at: NOW - 3 * MIN, why: 'last write' })
  })

  it('truly idle: the newest sign of life is the one counted', () => {
    expect(quietSince(evidence(), NOW)).toEqual({ at: NOW - 80 * MIN, why: 'last write' })
  })
})

describe('the process table', () => {
  const table = parsePsTable(PS)

  it('parses ps rows, leading spaces and all', () => {
    expect(table.get(2258)).toEqual({ ppid: 68756, command: 'caffeinate -i -t 300' })
    expect(table.size).toBe(9)
  })

  it('walks the whole subtree, not just children', () => {
    expect(descendantsOf(68756, table)).toEqual(expect.arrayContaining([20032, 20040, 69900]))
    expect(descendantsOf(68756, table)).not.toContain(555)
  })

  it('a Bash-tool shell under the agent is running work; MCP servers and caffeinate are not', () => {
    expect(runningWorkUnder(68756, table, [])).toEqual(['command 20032'])
  })

  it('a background claude under the agent counts only while it is not idle', () => {
    const quietTable = parsePsTable(PS.split('\n').filter((l) => !l.includes('snapshot')).join('\n'))
    expect(runningWorkUnder(68756, quietTable, [holder({ pid: 71000, kind: 'bg', status: 'busy' })])).toEqual(['agent 71000'])
    expect(runningWorkUnder(68756, quietTable, [holder({ pid: 71000, kind: 'bg', status: 'idle' })])).toEqual([])
  })
})

describe('loopStateOf — a /loop or cron waiting in the tail', () => {
  it('a pending ScheduleWakeup is when it fires', () => {
    const lines = [assistant(NOW - 10 * MIN, 'ScheduleWakeup', { delaySeconds: 1800, prompt: 'go', noop: true })]
    expect(loopStateOf(lines, NOW)).toEqual({ wakeAt: NOW + 20 * MIN, cronArmed: false })
  })

  it('a stop is no wakeup', () => {
    const lines = [
      assistant(NOW - 30 * MIN, 'ScheduleWakeup', { delaySeconds: 1800 }),
      assistant(NOW - 5 * MIN, 'ScheduleWakeup', { stop: true })
    ]
    expect(loopStateOf(lines, NOW).wakeAt).toBeNull()
  })

  it('a cron created and never deleted is armed; deleted is not; a day-old one is forgotten', () => {
    expect(loopStateOf([assistant(NOW - MIN, 'CronCreate', { cron: '*/5 * * * *', prompt: 'p' })], NOW).cronArmed).toBe(true)
    expect(loopStateOf([
      assistant(NOW - 2 * MIN, 'CronCreate', { cron: '*/5 * * * *', prompt: 'p' }),
      assistant(NOW - MIN, 'CronDelete', { id: 'c1' })
    ], NOW).cronArmed).toBe(false)
    expect(loopStateOf([assistant(NOW - 25 * 60 * MIN, 'CronCreate', { cron: '0 9 * * *', prompt: 'p' })], NOW).cronArmed).toBe(false)
  })

  it('the tool DEFINITIONS in an attachment are not a call, and torn lines are skipped', () => {
    const lines = [
      JSON.stringify({ type: 'attachment', timestamp: new Date(NOW).toISOString(), text: '"name":"ScheduleWakeup","input":{"delaySeconds":900}' }),
      '{"type":"assistant","timestamp":"2026-11-01T12:00:00.000Z","message":{"content":[{"type":"tool_use","name":"ScheduleWakeup"'
    ]
    expect(loopStateOf(lines, NOW)).toEqual({ wakeAt: null, cronArmed: false })
  })
})

describe('paneHolder', () => {
  it('is the record of the pane\'s own pid, never a background holder', () => {
    const own = holder()
    expect(paneHolder(68756, [own, holder({ pid: 71000, kind: 'bg' })], '/w')).toBe(own)
    expect(paneHolder(71000, [holder({ pid: 71000, kind: 'bg' })], '/w')).toBeNull()
    expect(paneHolder(null, [own], '/w')).toBeNull()
    expect(paneHolder(68756, [own], '/elsewhere')).toBeNull()
  })
})

describe('gatherSleepEvidence — the reader', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sleep-evidence-'))
  const transcript = path.join(dir, `${SID}.jsonl`)
  writeFileSync(transcript, [assistant(NOW - 10 * MIN, 'ScheduleWakeup', { delaySeconds: 1800 }), ''].join('\n'))
  utimesSync(transcript, (NOW - 10 * MIN) / 1000, (NOW - 10 * MIN) / 1000)
  mkdirSync(path.join(dir, SID, 'subagents'), { recursive: true })
  const sub = path.join(dir, SID, 'subagents', 'agent-1.jsonl')
  writeFileSync(sub, '{}\n')
  utimesSync(sub, (NOW - 2 * MIN) / 1000, (NOW - 2 * MIN) / 1000)

  it('reads status, running work, the newest write (subagents too) and the loop', async () => {
    const e = await gatherSleepEvidence({ holder: holder(), holders: [], procs: parsePsTable(PS), transcript, now: NOW })
    expect(e.claude).toEqual({ status: 'idle', since: NOW - 90 * MIN })
    expect(e.running).toEqual(['command 20032'])
    expect(e.lastWrite).toBe(NOW - 2 * MIN)
    expect(e.loop.wakeAt).toBe(NOW + 20 * MIN)
  })

  it('a failed process listing reads as running work, never as permission to sleep', async () => {
    const e = await gatherSleepEvidence({ holder: holder(), holders: [], procs: null, transcript, now: NOW })
    expect(quietSince(e, NOW).at).toBe(NOW)
  })

  it('a missing transcript is no write and no loop, not a crash', async () => {
    const e = await gatherSleepEvidence({ holder: null, holders: [], procs: null, transcript: path.join(dir, 'gone.jsonl'), now: NOW })
    expect(e).toEqual({ claude: null, running: [], lastWrite: null, loop: { wakeAt: null, cronArmed: false } })
  })

  it('tailLines drops the line the cut tore', async () => {
    const big = path.join(dir, 'big.jsonl')
    writeFileSync(big, ['x'.repeat(100), 'whole-1', 'whole-2'].join('\n'))
    expect(await tailLines(big, 20)).toEqual(['whole-1', 'whole-2'])
  })
})
