// `cookrew ask "Agent" -` and `cookrew recruit --prompt -`: a lone dash reads
// the brief from stdin, so a quoted heredoc reaches the agent byte for byte.
// A brief passed as an argument goes through the caller's shell first, and
// backticks, $(...), $VAR and ! were executed or eaten there — the brief still
// delivered, a word short, with no error.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HELP_TEXT } from '../src/main/socket-server'
import { stdinPlaceholderError } from '../src/main/cli-stdin'
import type { CliRequest } from '../src/shared/model'

const CLI = path.resolve('cli/cookrew.mjs')

// Everything a shell would have eaten, plus quotes, a tab, CRLF and non-ASCII.
const BRIEF = [
  'Run `npm test` and report $(whoami) back.',
  'Keep $HOME and ${PATH} literal; !! and !$ too.',
  `"double" 'single' \\backslash\ttab`,
  'crlf line\r',
  '\u4e2d\u6587 and emoji \u{1F373}',
  '',
  '  indented last line  '
].join('\n')

type Seen = { cmd: string; args: string[]; flags: Record<string, unknown> }

const run = (socketPath: string, argv: string[], stdin: string | null) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, COOKREW_SOCKET: socketPath, COOKREW_TERMINAL_ID: 't-caller' }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('exit', (code) => resolve({ code, out, err }))
    if (stdin === null) child.stdin.end()
    else child.stdin.end(stdin, 'utf8')
  })

describe('cookrew ask/recruit with a lone - reads the brief from stdin', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const close of cleanup.splice(0)) close()
  })

  const fakeApp = async () => {
    const socketPath = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-stdin-')), 'app.sock')
    const seen: Seen[] = []
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const at = buffer.indexOf('\n')
        if (at === -1) return
        const request = JSON.parse(buffer.slice(0, at)) as Seen & { id: string }
        seen.push(request)
        socket.write(JSON.stringify({ id: request.id, ok: true, output: 'delivered' }) + '\n')
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    return { socketPath, seen }
  }

  it('ask "Agent" - delivers a heredoc byte for byte (its closing newline is the heredoc, not the brief)', async () => {
    const { socketPath, seen } = await fakeApp()
    const result = await run(socketPath, ['ask', 'Agent', '-'], BRIEF + '\n')
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].cmd).toBe('ask')
    expect(seen[0].args).toEqual(['Agent', BRIEF])
  })

  it('keeps --no-wait working with the dash form', async () => {
    const { socketPath, seen } = await fakeApp()
    const result = await run(socketPath, ['ask', 'Agent', '-', '--no-wait'], BRIEF + '\n')
    expect(result.code).toBe(0)
    expect(seen[0].args).toEqual(['Agent', BRIEF])
    expect(seen[0].flags['no-wait']).toBe(true)
  })

  it('recruit --prompt - takes its first prompt from stdin', async () => {
    const { socketPath, seen } = await fakeApp()
    const result = await run(socketPath, ['recruit', 'Helper', '--prompt', '-', '--preset', 'Codex'], BRIEF + '\n')
    expect(result.code).toBe(0)
    expect(seen[0].cmd).toBe('recruit')
    expect(seen[0].args).toEqual(['Helper'])
    expect(seen[0].flags.prompt).toBe(BRIEF)
    expect(seen[0].flags.preset).toBe('Codex')
  })

  it('empty stdin is a usage error and nothing is sent', async () => {
    const { socketPath, seen } = await fakeApp()
    for (const argv of [['ask', 'Agent', '-'], ['recruit', '--prompt', '-']]) {
      for (const stdin of [null, '', '\n', '  \n\t\n']) {
        const result = await run(socketPath, argv, stdin)
        expect(result.code).toBe(1)
        expect(result.err).toMatch(/usage/i)
        expect(result.err).toContain("<<'EOF'")
      }
    }
    expect(seen).toHaveLength(0)
  })

  it('an ordinary argument brief never waits on stdin', async () => {
    const { socketPath, seen } = await fakeApp()
    // stdin is left open: a client that read it would hang until the timeout.
    const result = await new Promise<{ code: number | null }>((resolve) => {
      const child = spawn(process.execPath, [CLI, 'ask', 'Agent', 'plain brief'], {
        env: { ...process.env, COOKREW_SOCKET: socketPath, COOKREW_TERMINAL_ID: 't-caller' }
      })
      child.on('exit', (code) => resolve({ code }))
    })
    expect(result.code).toBe(0)
    expect(seen[0].args).toEqual(['Agent', 'plain brief'])
  })
})

describe('the app refuses a lone - that no client expanded', () => {
  const request = (cmd: string, args: string[], flags: Record<string, string | boolean> = {}): CliRequest => ({
    id: 'r', cmd, args, flags, terminalId: 't'
  })

  it('refuses ask "Agent" - and recruit --prompt - instead of delivering a dash', () => {
    expect(stdinPlaceholderError(request('ask', ['Agent', '-']))).toMatch(/stdin/)
    expect(stdinPlaceholderError(request('recruit', [], { prompt: '-' }))).toMatch(/stdin/)
  })

  it('lets everything else through', () => {
    expect(stdinPlaceholderError(request('ask', ['Agent', '- item one']))).toBeNull()
    expect(stdinPlaceholderError(request('ask', ['Agent'], { raw: '-' }))).toBeNull()
    expect(stdinPlaceholderError(request('recruit', [], { prompt: 'fix it' }))).toBeNull()
    expect(stdinPlaceholderError(request('note', ['write', 'N', '-']))).toBeNull()
  })
})

describe('cookrew help', () => {
  it('teaches the dash form for ask and recruit', () => {
    expect(HELP_TEXT).toContain(`cookrew ask "Agent" - <<'EOF'`)
    expect(HELP_TEXT).toContain('--prompt -')
  })
})
