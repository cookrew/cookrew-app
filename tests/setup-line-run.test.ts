import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSetupLines, foregroundArgs, lineScript, paneLastLine, parseForeground, type SetupLineDeps } from '../src/main/setup-line'
import { SETUP_LINE_COPY } from '../src/shared/first-run-copy'
import { askingPassword, lineEndWords } from '../src/shared/setup-line'

/**
 * A SETUP LINE ENDS BY ITS EXIT STATUS, AND GOES ONLY TO A PANE AT ITS PROMPT.
 *
 * Box round 3, N1: on tmux the pane's last line is the status bar, so reading the
 * prompt off the screen never saw the end of a good install. N2: one shared pane
 * took Pi's whole line as an answer to Magpie's sudo prompt.
 */

const LINE = 'brew install tmux'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'setup-line-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function rig(over: Partial<SetupLineDeps> = {}) {
  const typed: string[] = []
  const holds = vi.fn(async (_pid: number): Promise<boolean | null> => true)
  const held = { now: 0 }
  const ticks: (() => void)[] = []
  const lines = createSetupLines({
    every: (_ms, tick) => {
      ticks.push(tick)
      return () => void ticks.splice(ticks.indexOf(tick), 1)
    },
    dir,
    isSetupCard: () => true,
    view: () => {
      held.now += 1
      return () => void (held.now -= 1)
    },
    shellPid: () => 4242,
    holds,
    type: (_id, bytes) => typed.push(bytes),
    screen: async () => null,
    alive: () => true,
    wait: async () => undefined,
    platform: 'darwin',
    ...over
  })
  return { lines, typed, holds, held, ticks }
}

const ask = (over: Record<string, unknown> = {}) => ({ terminalId: 't1', line: LINE, enter: true, fresh: false, ...over })
const started = async (lines: ReturnType<typeof rig>['lines']): Promise<string> => {
  const answer = await lines.start(ask())
  if (!answer.ok || answer.runId === null) throw new Error('did not start')
  return answer.runId
}
const statusFile = (): string => path.join(dir, 't1.status')

describe('what a press may type', () => {
  it('types nothing into a pane whose shell is not in the foreground, and says what to do', async () => {
    const { lines, typed } = rig({ holds: async () => false })
    const answer = await lines.start(ask())
    expect(answer).toEqual({ ok: false, reason: SETUP_LINE_COPY.BUSY, busy: true })
    expect(typed).toEqual([])
  })

  it('refuses when it cannot tell: not knowing is not a licence to type', async () => {
    const { lines, typed } = rig({ holds: async () => null })
    expect(await lines.start(ask())).toEqual({ ok: false, reason: SETUP_LINE_COPY.UNREADABLE, busy: true })
    expect(typed).toEqual([])
  })

  it('refuses a key line the same way: a key must never answer a password prompt', async () => {
    const { lines, typed } = rig({ holds: async () => false })
    const answer = await lines.start(ask({ line: 'magpie provider add openai ', enter: false }))
    expect(answer.ok).toBe(false)
    expect(typed).toEqual([])
  })

  it('never types a line the allowlist does not know, whoever sent it', async () => {
    const { lines, typed } = rig()
    expect((await lines.start(ask({ line: 'rm -rf ~' }))).ok).toBe(false)
    expect((await lines.start(null)).ok).toBe(false)
    expect((await lines.start(ask({ terminalId: 7 }))).ok).toBe(false)
    expect(typed).toEqual([])
  })

  it('types only into the Setup card: an agent’s pane also reads as its own foreground', async () => {
    const { lines, typed } = rig({ isSetupCard: () => false })
    expect((await lines.start(ask())).ok).toBe(false)
    expect(typed).toEqual([])
  })

  it('a second press while the first has not started yet is refused, not typed behind it', async () => {
    const { lines, typed } = rig()
    const [one, two] = await Promise.all([lines.start(ask()), lines.start(ask())])
    expect([one.ok, two.ok].sort()).toEqual([false, true])
    expect(typed).toHaveLength(1)
  })

  it('refuses while a run it started has not ended, though the shell still holds the pane for a moment', async () => {
    const { lines, typed } = rig()
    await started(lines)
    expect(await lines.start(ask({ line: 'brew install ollama' }))).toMatchObject({ ok: false, busy: true })
    expect(typed).toHaveLength(1)
  })

  it('clears a half-typed line first, and runs a fresh process, not the words in the person’s shell', async () => {
    const { lines, typed } = rig()
    await started(lines)
    expect(typed[0].startsWith('\x15')).toBe(true)
    expect(typed[0].endsWith('\r')).toBe(true)
    expect(typed[0]).toContain('/bin/sh ')
    expect(typed[0]).not.toContain(LINE)
  })

  it('leaves a key line open for the paste, with no Enter and no run to watch', async () => {
    const { lines, typed } = rig()
    const answer = await lines.start(ask({ line: 'magpie provider add openai ', enter: false }))
    expect(answer).toEqual({ ok: true, runId: null })
    expect(typed).toEqual(['\x15magpie provider add openai '])
  })

  it('gives a new pane time: its rc file runs children, and the shell has no pid yet', async () => {
    let tries = 0
    const { lines, typed } = rig({ shellPid: () => (++tries < 3 ? null : 4242) })
    expect((await lines.start(ask({ fresh: true }))).ok).toBe(true)
    expect(typed).toHaveLength(1)
  })

  it('on Windows, where there is no sh or ps, the line goes as typed and is not watched', async () => {
    const { lines, typed, holds } = rig({ platform: 'win32' })
    expect(await lines.start(ask())).toEqual({ ok: true, runId: null, unwatched: true })
    expect(typed).toEqual([`${LINE}\r`])
    expect(holds).not.toHaveBeenCalled()
  })
})

describe('the pane stays there for its line', () => {
  // A pane nobody views is dropped from the app after a while, and keys for one go nowhere.
  it('holds a view of it from before the keys until the line has ended', async () => {
    const { lines, held } = rig()
    const runId = await started(lines)
    expect(held.now).toBe(1)
    writeFileSync(statusFile(), '0\n')
    await lines.now('t1', runId)
    expect(held.now).toBe(0)
  })

  it('lets go at once when the press is refused', async () => {
    const { lines, held } = rig({ holds: async () => false })
    await lines.start(ask())
    expect(held.now).toBe(0)
  })

  it('lets go of a key line once it is typed: the person’s own screen holds it from there', async () => {
    const { lines, held } = rig()
    await lines.start(ask({ line: 'magpie provider add openai ', enter: false }))
    expect(held.now).toBe(0)
  })

  it('types nothing when the pane cannot be brought up', async () => {
    const { lines, typed } = rig({ view: () => null })
    expect(await lines.start(ask())).toEqual({ ok: false, reason: SETUP_LINE_COPY.UNREADABLE, busy: true })
    expect(typed).toEqual([])
  })
})

describe('a run is main’s to end, whoever is looking', () => {
  // A phone that closed mid-line left the pane held up until some later press.
  it('sees the end with no screen asking, and lets go', async () => {
    const { lines, held, ticks } = rig()
    await started(lines)
    writeFileSync(statusFile(), '0\n')
    ticks[0]()
    await vi.waitFor(() => expect(held.now).toBe(0))
    expect(ticks).toHaveLength(0)
  })

  it('names the run on a card, for a screen that came back to it', async () => {
    const { lines } = rig()
    expect(lines.current('t1')).toBeNull()
    const runId = await started(lines)
    expect(lines.current('t1')).toEqual({ runId, line: LINE })
    writeFileSync(statusFile(), '0\n')
    await lines.now('t1', runId)
    expect(lines.current('t1')).toBeNull()
  })

  it('lets go once, however many ask at the same moment', async () => {
    const { lines, held } = rig()
    const runId = await started(lines)
    writeFileSync(statusFile(), '0\n')
    await Promise.all([lines.now('t1', runId), lines.now('t1', runId), lines.now('t1', runId)])
    await lines.now('t1', runId)
    expect(held.now).toBe(0)
  })

  it('keeps no run, and no second letting go, when the keys could not be sent', async () => {
    const { lines, held, ticks } = rig({
      type: () => {
        throw new Error('no pane')
      }
    })
    expect((await lines.start(ask())).ok).toBe(false)
    expect(held.now).toBe(0)
    expect(lines.current('t1')).toBeNull()
    expect(ticks).toHaveLength(0)
  })
})

describe('how a run ends', () => {
  it('runs until its status file says how it went', async () => {
    const { lines } = rig({ holds: vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValue(false) })
    const runId = await started(lines)
    writeFileSync(statusFile(), 'running\n')
    expect((await lines.now('t1', runId)).state).toBe('running')
    writeFileSync(statusFile(), '0\n')
    expect(await lines.now('t1', runId)).toEqual({ state: 'ended', code: 0 })
    writeFileSync(statusFile(), '1\n')
    expect(await lines.now('t1', runId)).toEqual({ state: 'ended', code: 0 })
  })

  it('reads a failure as a failure', async () => {
    const { lines } = rig()
    const runId = await started(lines)
    writeFileSync(statusFile(), '127\n')
    expect(await lines.now('t1', runId)).toEqual({ state: 'ended', code: 127 })
  })

  it('a new run may start once the last one has ended', async () => {
    const { lines, typed } = rig()
    const runId = await started(lines)
    writeFileSync(statusFile(), '0\n')
    await lines.now('t1', runId)
    expect((await lines.start(ask({ line: 'brew install ollama' }))).ok).toBe(true)
    expect(typed).toHaveLength(2)
    expect(existsSync(statusFile())).toBe(false)
  })

  it('a run killed outright never says, so a shell back in front twice ends it with no code', async () => {
    const { lines } = rig()
    const runId = await started(lines)
    writeFileSync(statusFile(), 'running\n')
    expect((await lines.now('t1', runId)).state).toBe('running')
    expect(await lines.now('t1', runId)).toEqual({ state: 'ended', code: null })
  })

  it('a run that never reached the shell ends once the wait is over', async () => {
    let at = 0
    const { lines } = rig({ now: () => at })
    const runId = await started(lines)
    expect((await lines.now('t1', runId)).state).toBe('running')
    at = 60_000
    await lines.now('t1', runId)
    expect(await lines.now('t1', runId)).toEqual({ state: 'ended', code: null })
  })

  it('a pane that went away ends the run', async () => {
    const { lines } = rig({ alive: () => false })
    const runId = await started(lines)
    expect(await lines.now('t1', runId)).toEqual({ state: 'ended', code: null })
  })

  it('knows nothing of a run it did not start', async () => {
    const { lines } = rig()
    await started(lines)
    expect(await lines.now('t1', 'someone-else')).toEqual({ state: 'none' })
    expect(await lines.now('t2', 'someone-else')).toEqual({ state: 'none' })
  })

  it('says what the pane shows, from the pane, and notices a password prompt', async () => {
    const screens = ['$ /bin/sh /x/t1.sh\nbrew install tmux\nPouring tmux\n\n', '[sudo] password for cooktest: ']
    const { lines } = rig({ screen: async () => screens.shift() ?? null, holds: vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValue(false) })
    const runId = await started(lines)
    expect(await lines.now('t1', runId)).toEqual({ state: 'running', lastLine: 'Pouring tmux', asking: null })
    expect(await lines.now('t1', runId)).toEqual({ state: 'running', lastLine: '[sudo] password for cooktest:', asking: 'password' })
  })
})

describe('the words a pane read gives a button', () => {
  it('skips the runner and the line’s own echo', () => {
    expect(paneLastLine('% /bin/sh /x/t1.sh', LINE, 't1')).toBe('')
    expect(paneLastLine(`% /bin/sh /x/t1.sh\n${LINE}`, LINE, 't1')).toBe('')
  })

  it('is empty when the backend has no view of the pane', () => {
    expect(paneLastLine(null, LINE, 't1')).toBe('')
  })
})

describe('the foreground read', () => {
  it('asks ps for two columns on every ps: `-o a=,b=` is one column on Linux’s', () => {
    expect(foregroundArgs(4242)).toEqual(['-o', 'pgid=', '-o', 'tpgid=', '-p', '4242'])
  })

  it('finds the shell in front when the group the terminal gives the keyboard to is its own', () => {
    expect(parseForeground('24888 24888\n')).toBe(true)
    expect(parseForeground('  24888   25068\n')).toBe(false)
  })

  it('cannot tell from nothing', () => {
    expect(parseForeground('')).toBeNull()
    expect(parseForeground('24888\n')).toBeNull()
    expect(parseForeground('24888 -1\n')).toBeNull()
  })
})

describe('the runner, on the real sh', () => {
  const runScript = async (line: string): Promise<{ code: number | null; status: string; said: string }> => {
    const status = path.join(dir, 'x.status')
    const script = path.join(dir, 'x.sh')
    writeFileSync(script, lineScript(line, status))
    const run = spawnSync('/bin/sh', [script], { encoding: 'utf8', timeout: 15_000 })
    return { code: run.status, status: readFileSync(status, 'utf8').trim(), said: run.stdout }
  }

  it('records a good line’s 0, shows the line, and takes its own script away', async () => {
    const run = await runScript('true')
    expect(run.status).toBe('0')
    expect(run.said).toContain('true')
    expect(existsSync(path.join(dir, 'x.sh'))).toBe(false)
  })

  it('records a failed line’s code', async () => {
    expect((await runScript('sh -c "exit 7"')).status).toBe('7')
  })

  it('counts a failed download in a pipe: curl | sh is otherwise a good empty script', async () => {
    const quiet = await runScript('sh -c "exit 22" | sh')
    // dash has no pipefail: there the tool check is what says it failed.
    const hasPipefail = spawnSync('/bin/sh', ['-c', 'set -o pipefail'], { stdio: 'ignore' }).status === 0
    expect(quiet.status).toBe(hasPipefail ? '22' : '0')
  })

  it('still records after an interrupt: Stop is a way to end a line, not to lose it', async () => {
    const status = path.join(dir, 'x.status')
    const script = path.join(dir, 'x.sh')
    writeFileSync(script, lineScript('sleep 20', status))
    const child = execFile('/bin/sh', ['-c', `exec /bin/sh '${script}'`], { timeout: 15_000 })
    await vi.waitFor(() => expect(readFileSync(status, 'utf8')).toContain('running'), { timeout: 5000 })
    const ended = new Promise((resolve) => child.once('exit', resolve))
    // A terminal's ^C reaches every process in the foreground group.
    spawnSync('/bin/sh', ['-c', `pkill -INT -P ${child.pid}; kill -INT ${child.pid}`])
    await ended
    await vi.waitFor(() => expect(readFileSync(status, 'utf8').trim()).toMatch(/^\d+$/), { timeout: 5000 })
  })

  it('keeps the runner and its status in a folder nobody else can list', async () => {
    const { lines } = rig({ dir: path.join(dir, 'made') })
    await lines.start(ask())
    expect(statSync(path.join(dir, 'made')).mode & 0o777).toBe(0o700)
    expect(statSync(path.join(dir, 'made', 't1.sh')).mode & 0o777).toBe(0o600)
  })
})

describe('the words', () => {
  it('reads a sudo prompt and a Mac’s plain one as a password prompt', () => {
    expect(askingPassword('[sudo] password for cooktest:')).toBe(true)
    expect(askingPassword('Password:')).toBe(true)
    expect(askingPassword('Enter passphrase for key:')).toBe(true)
  })

  it('does not read a line about passwords as a prompt', () => {
    expect(askingPassword('Checking the password store')).toBe(false)
    expect(askingPassword('password: set')).toBe(false)
    expect(askingPassword('')).toBe(false)
  })

  it('has a sentence for every way a line ends but a good one', () => {
    expect(lineEndWords(0)).toBeNull()
    expect(lineEndWords(1)).toBe(SETUP_LINE_COPY.FAILED(1))
    expect(lineEndWords(130)).toBe(SETUP_LINE_COPY.STOPPED)
    expect(lineEndWords(null)).toBe(SETUP_LINE_COPY.LOST)
  })
})
