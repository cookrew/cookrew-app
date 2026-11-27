// Cookrew's ACP host (cli/cookrew-acp.mjs), driven like a pane drives it:
// keys on stdin, the screen on stdout, Cookrew's transcript on disk. The
// agent is tests/fixtures/hosted/acp-fake-agent.mjs, which speaks the slice
// of ACP v1 DeepSeek Harness answered with (2026-11-28).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseHostedTrace } from '../src/shared/hosted-trace'
import { menuHeldOnScreen, waitChoiceOfScreen } from '../src/shared/wait-choice'
import { hostedComposerDrawn } from '../src/main/harness-input'
import { detectLiveWork } from '../src/shared/turn'

const HOST = path.join(__dirname, '..', 'cli', 'cookrew-acp.mjs')
const FAKE = path.join(__dirname, 'fixtures', 'hosted', 'acp-fake-agent.mjs')
const running: ChildProcessWithoutNullStreams[] = []

afterEach(() => {
  for (const child of running.splice(0)) child.kill()
})

interface Host {
  child: ChildProcessWithoutNullStreams
  screen: () => string
  type: (keys: string) => void
  until: (test: () => boolean, what: string, ms?: number) => Promise<void>
  exited: Promise<number | null>
}

function host(home: string, cwd: string, extra: string[] = [], env: Record<string, string> = {}): Host {
  const child = spawn(process.execPath, [HOST, 'fake', '--command', JSON.stringify([process.execPath, FAKE]), ...extra], {
    cwd,
    env: { ...process.env, HOME: home, FAKE_ACP_STORE: path.join(home, 'fake-store.json'), COOKREW_TERMINAL_ID: 'card-1', HERDR_ENV: '', ...env }
  })
  running.push(child)
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const until = async (test: () => boolean, what: string, ms = 8000): Promise<void> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (test()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`timed out: ${what}\n${out.slice(-1500)}`)
  }
  return { child, screen: () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), type: (keys) => child.stdin.write(keys), until, exited }
}

function dirs(): { home: string; cwd: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'acp-host-'))
  const cwd = path.join(base, 'work')
  require('node:fs').mkdirSync(cwd)
  return { home: base, cwd }
}

const transcripts = (home: string): string[] => {
  const dir = path.join(home, '.cookrew', 'hosted', 'fake')
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n)) : []
}
const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean)
const records = (file: string): Array<Record<string, unknown>> => lines(file).map((l) => JSON.parse(l))

describe('the ACP host', () => {
  it('opens a session, draws its box, runs a turn and writes it down', async () => {
    const { home, cwd } = dirs()
    const h = host(home, cwd)
    await h.until(() => hostedComposerDrawn(h.screen()), 'input box')
    h.type('hello there\r')
    await h.until(() => transcripts(home).length === 1 && lines(transcripts(home)[0]).some((l) => l.includes('"t":"end"')), 'turn end')
    const file = transcripts(home)[0]
    expect(records(file).map((r) => r.t)).toEqual(['session', 'model', 'user', 'thought', 'tool', 'tool_done', 'text', 'end'])
    expect(records(file)[0]).toMatchObject({ v: 1, agent: 'fake', cwd: require('node:fs').realpathSync(cwd) })
    const [block] = parseHostedTrace(lines(file))
    expect(block).toMatchObject({ prompt: 'hello there', reply: 'you said: hello there', final: true })
    expect(block.activity).toEqual([expect.objectContaining({ tool: 'bash', args: 'Say hi', result: 'hi' })])
    expect(h.screen()).toContain('⏺ bash')
    await h.until(() => (h.screen().match(/⏎ send/g) ?? []).length >= 2, 'box drawn again')
  })

  it('holds its transcript open: the pane process names its session', async () => {
    if (process.platform === 'win32') return
    const { home, cwd } = dirs()
    const h = host(home, cwd)
    await h.until(() => transcripts(home).length === 1, 'transcript')
    const { execFileSync } = await import('node:child_process')
    const open = execFileSync('lsof', ['-p', String(h.child.pid), '-Fn']).toString()
    expect(open).toContain(path.basename(transcripts(home)[0]))
  })

  it('draws an approval as a numbered menu Cookrew reads, and a digit answers it', async () => {
    const { home, cwd } = dirs()
    const h = host(home, cwd)
    await h.until(() => hostedComposerDrawn(h.screen()), 'input box')
    h.type('please APPROVE this\r')
    await h.until(() => h.screen().includes('Allow this?'), 'menu')
    // Cookrew offers a menu only when the screen is not live work: the host's
    // own thinking line once carried a spinner glyph and a waiting approval read
    // as a running turn (found in the end-to-end run, 2026-11-28).
    expect(detectLiveWork(h.screen())).toBe(false)
    expect(menuHeldOnScreen(h.screen())).toBe(true)
    const choice = waitChoiceOfScreen(h.screen())
    expect(choice).toMatchObject({ kind: 'menu', question: 'bash: Say hi · Allow this?', cursor: 0 })
    expect(choice?.options.map((o) => o.label)).toEqual(['Allow once', 'Reject'])
    const file = transcripts(home)[0]
    expect(parseHostedTrace(lines(file))[0].final).toBeUndefined()
    h.type('1')
    await h.until(() => lines(file).some((l) => l.includes('"t":"end"')), 'turn end after approval')
    expect(records(file).filter((r) => r.t === 'answer')).toEqual([expect.objectContaining({ option: 'Allow once' })])
    expect(parseHostedTrace(lines(file))[0]).toMatchObject({ final: true, reply: expect.stringContaining('APPROVE') })
  })

  it('Esc on the menu rejects; Esc Esc stops a running turn, recorded as interrupted', async () => {
    const { home, cwd } = dirs()
    const h = host(home, cwd)
    await h.until(() => hostedComposerDrawn(h.screen()), 'input box')
    h.type('APPROVE\r')
    await h.until(() => h.screen().includes('Allow this?'), 'menu')
    h.type('\x1b')
    const file = transcripts(home)[0]
    await h.until(() => lines(file).some((l) => l.includes('"t":"end"')), 'rejected turn ends')
    expect(records(file).find((r) => r.t === 'answer')).toMatchObject({ option: 'Reject' })
    h.type('SLOW\r')
    await h.until(() => lines(file).filter((l) => l.includes('"t":"user"')).length === 2, 'second turn')
    await new Promise((r) => setTimeout(r, 100))
    h.type('\x1b')
    await new Promise((r) => setTimeout(r, 50))
    h.type('\x1b')
    await h.until(() => lines(file).filter((l) => l.includes('"t":"end"')).length === 2, 'cancelled turn ends')
    expect(parseHostedTrace(lines(file))[1]).toMatchObject({ final: true, outcome: 'interrupted' })
  })

  it('a paste arrives whole, newlines kept; a prompt typed during a turn is queued', async () => {
    const { home, cwd } = dirs()
    const h = host(home, cwd)
    await h.until(() => hostedComposerDrawn(h.screen()), 'input box')
    h.type('\x1b[200~line one\nline two\x1b[201~\r')
    h.type('next one\r')
    await h.until(() => transcripts(home).length === 1 && lines(transcripts(home)[0]).filter((l) => l.includes('"t":"end"')).length === 2, 'two turns')
    expect(parseHostedTrace(lines(transcripts(home)[0])).map((b) => b.prompt)).toEqual(['line one\nline two', 'next one'])
  })

  it('a second process resumes the session into the same transcript, with its memory', async () => {
    const { home, cwd } = dirs()
    const first = host(home, cwd)
    await first.until(() => hostedComposerDrawn(first.screen()), 'input box')
    first.type('the word is otter\r')
    await first.until(() => transcripts(home).length === 1 && lines(transcripts(home)[0]).some((l) => l.includes('"t":"end"')), 'first turn')
    const file = transcripts(home)[0]
    const id = path.basename(file, '.jsonl')
    first.type('\x04')
    expect(await first.exited).toBe(0)
    const second = host(home, cwd, ['--resume', id])
    await second.until(() => hostedComposerDrawn(second.screen()), 'resumed box')
    second.type('REMEMBER\r')
    await second.until(() => lines(file).filter((l) => l.includes('"t":"end"')).length === 2, 'resumed turn')
    expect(transcripts(home)).toEqual([file])
    expect(records(file).map((r) => r.t)).toContain('resume')
    expect(parseHostedTrace(lines(file))[1].reply).toContain('the word is otter')
  })

  it('a resume the agent refuses is said, never replaced by a silent new session', async () => {
    const { home, cwd } = dirs()
    const h = host(home, cwd, ['--resume', 'no-such-session'])
    await h.until(() => h.screen().includes('could not be resumed'), 'refusal')
    expect(transcripts(home)).toEqual([])
    h.type('\r')
    await h.until(() => transcripts(home).length === 1, 'a new session only on Enter')
  })

  it('/new closes one transcript and opens the next', async () => {
    const { home, cwd } = dirs()
    const h = host(home, cwd)
    await h.until(() => transcripts(home).length === 1, 'first')
    h.type('/new\r')
    await h.until(() => transcripts(home).length === 2 && h.screen().includes('New session'), 'second')
  })

  it('a model becomes a patch row for the agent, an effort its config option; a key command fills its env', async () => {
    const { home, cwd } = dirs()
    const h = host(home, cwd, ['--effort', 'low', '--effort-option', 'reasoning_effort'])
    await h.until(() => transcripts(home).length === 1, 'session')
    expect(records(transcripts(home)[0]).find((r) => r.t === 'model')).toMatchObject({ model: 'fake-1', effort: 'low' })
    const dsh = mkdtempSync(path.join(tmpdir(), 'acp-bin-'))
    writeFileSync(path.join(dsh, 'dsh'), `#!/bin/sh\necho "args=$*" > "${dsh}/seen"; echo "key=$DEEPSEEK_API_KEY url=$DEEPSEEK_BASE_URL" >> "${dsh}/seen"\n`, { mode: 0o755 })
    const real = spawn(process.execPath, [HOST, 'dsh', '--model', 'group/smart', '--base-url', 'http://127.0.0.1:9', '--key-command', 'echo k-1'], { cwd, env: { ...process.env, HOME: home, PATH: `${dsh}:${process.env.PATH}`, COOKREW_TERMINAL_ID: 'card-9' } })
    running.push(real)
    await new Promise((r) => real.on('exit', r))
    const seen = readFileSync(path.join(dsh, 'seen'), 'utf8')
    expect(seen).toMatch(/args=--profile acp --patch \S+card-9\.yml/)
    expect(seen).toContain('key=k-1 url=http://127.0.0.1:9')
    expect(readFileSync(path.join(home, '.cookrew', 'hosted', 'dsh', 'patches', 'card-9.yml'), 'utf8')).toContain('model: "group/smart"')
  })

  it('an agent that is not installed says how to install it', async () => {
    const { home, cwd } = dirs()
    const h = spawn(process.execPath, [HOST, 'dsh'], { cwd, env: { ...process.env, HOME: home, PATH: '/nonexistent' } })
    running.push(h)
    let err = ''
    h.stderr.on('data', (d) => { err += d })
    const code = await new Promise((r) => h.on('exit', r))
    expect(code).toBe(127)
    expect(err).toContain('npm i -g @deepseek-ai/dsh')
  })
})
