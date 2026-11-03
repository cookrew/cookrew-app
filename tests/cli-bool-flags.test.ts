// A valueless flag must never swallow the next argument.
//
// The CLI's parseArgv gave every `--key` the following token unless that token
// began with `--`. So `cookrew note create --new "x"` read "x" as the value of
// --new and made an EMPTY note, and `cookrew ask "A" --no-wait -` read the dash
// as the value of --no-wait and never touched stdin. The workaround was "put
// the flag last", which nobody remembered. Boolean flags are now declared, in
// any position; flags that take a value keep taking it.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOLEAN_CLI_FLAGS, staleBooleanFlagError } from '../src/main/cli-flags'
import { stdinPlaceholderError } from '../src/main/cli-stdin'
import { HELP_TEXT } from '../src/main/socket-server'
import type { CliRequest } from '../src/shared/model'

const CLI = path.resolve('cli/cookrew.mjs')
const BRIEF = 'Role with `backticks`, $(whoami) and $HOME kept literal.\nsecond line'

type Seen = { cmd: string; args: string[]; flags: Record<string, unknown> }
type Run = { code: number | null; out: string; err: string }

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

async function fakeApp(): Promise<{ socketPath: string; seen: Seen[] }> {
  const socketPath = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-flags-')), 'app.sock')
  const seen: Seen[] = []
  const server = net.createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const at = buffer.indexOf('\n')
      if (at === -1) return
      const request = JSON.parse(buffer.slice(0, at)) as Seen & { id: string }
      seen.push(request)
      socket.write(JSON.stringify({ id: request.id, ok: true, output: 'ok' }) + '\n')
    })
  })
  cleanup.push(() => server.close())
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return { socketPath, seen }
}

function run(socketPath: string, argv: string[], stdin: string | null = null): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, COOKREW_SOCKET: socketPath, COOKREW_TERMINAL_ID: 't-caller' }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('exit', (code) => resolve({ code, out, err }))
    child.stdin.end(stdin ?? '', 'utf8')
  })
}

async function parsed(argv: string[], stdin: string | null = null): Promise<Seen> {
  const { socketPath, seen } = await fakeApp()
  const result = await run(socketPath, argv, stdin)
  expect(result.err).toBe('')
  expect(result.code).toBe(0)
  expect(seen).toHaveLength(1)
  return seen[0]
}

describe('boolean flags never consume a value, in any position', () => {
  it('declares every flag whose handler only checks truthiness', () => {
    expect([...BOOLEAN_CLI_FLAGS].sort()).toEqual(
      ['all', 'canvas', 'disabled', 'help', 'new', 'no-wait', 'rotate'].sort()
    )
  })

  for (const flag of BOOLEAN_CLI_FLAGS) {
    const shapes: Array<[string, string[]]> = [
      ['before the positionals', ['note', `--${flag}`, 'create', 'body']],
      ['between the positionals', ['note', 'create', `--${flag}`, 'body']],
      ['after the positionals', ['note', 'create', 'body', `--${flag}`]]
    ]
    for (const [where, argv] of shapes) {
      it(`--${flag} ${where}`, async () => {
        const seen = await parsed(argv)
        expect(seen.cmd).toBe('note')
        expect(seen.args).toEqual(['create', 'body'])
        expect(seen.flags).toEqual({ [flag]: true })
      })
    }
  }

  it('note create --new "x" creates the note "x", not an empty one', async () => {
    const seen = await parsed(['note', 'create', '--new', 'x'])
    expect(seen.args).toEqual(['create', 'x'])
    expect(seen.flags.new).toBe(true)
  })

  it('ask "A" --no-wait - still reads the brief from stdin', async () => {
    const seen = await parsed(['ask', 'A', '--no-wait', '-'], BRIEF + '\n')
    expect(seen.args).toEqual(['A', BRIEF])
    expect(seen.flags['no-wait']).toBe(true)
  })

  it('ask --no-wait "A" "prompt" keeps both positionals', async () => {
    const seen = await parsed(['ask', '--no-wait', 'A', 'prompt'])
    expect(seen.args).toEqual(['A', 'prompt'])
    expect(seen.flags).toEqual({ 'no-wait': true })
  })

  it('several boolean flags side by side', async () => {
    const seen = await parsed(['list', '--all', '--canvas'])
    expect(seen.args).toEqual([])
    expect(seen.flags).toEqual({ all: true, canvas: true })
  })
})

describe('flags that take a value keep taking it', () => {
  it('recruit --preset/--prompt/--role/--dir carry their values before a name', async () => {
    const seen = await parsed(['recruit', '--preset', 'Codex', '--prompt', 'do it', '--role', 'R', '--dir', '/tmp', 'Helper'])
    expect(seen.args).toEqual(['Helper'])
    expect(seen.flags).toEqual({ preset: 'Codex', prompt: 'do it', role: 'R', dir: '/tmp' })
  })

  it('--workspace is still optional-valued: alone it is true, with a name it is the name', async () => {
    expect((await parsed(['list', '--workspace'])).flags).toEqual({ workspace: true })
    expect((await parsed(['list', '--workspace', 'Home'])).flags).toEqual({ workspace: 'Home' })
  })

  it('a value flag next to a boolean flag', async () => {
    const seen = await parsed(['browser', 'create', '--new', 'https://x.test', '--workspace', 'W', 'Name'])
    expect(seen.args).toEqual(['create', 'https://x.test', 'Name'])
    expect(seen.flags).toEqual({ new: true, workspace: 'W' })
  })
})

describe('role save --prompt - reads the role from stdin, like ask and recruit', () => {
  it('sends the heredoc, not a dash', async () => {
    const seen = await parsed(['role', 'save', 'Agent', 'Role', '--prompt', '-'], BRIEF + '\n')
    expect(seen.cmd).toBe('role')
    expect(seen.args).toEqual(['save', 'Agent', 'Role'])
    expect(seen.flags.prompt).toBe(BRIEF)
  })

  it('empty stdin is a usage error and nothing is sent', async () => {
    const { socketPath, seen } = await fakeApp()
    const result = await run(socketPath, ['role', 'save', 'Agent', 'Role', '--prompt', '-'], '\n')
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/usage/i)
    expect(result.err).toContain("<<'EOF'")
    expect(seen).toHaveLength(0)
  })

  it('an ordinary --prompt value is sent as is', async () => {
    const seen = await parsed(['role', 'save', 'Agent', 'Role', '--prompt', 'review diffs'])
    expect(seen.flags.prompt).toBe('review diffs')
  })
})

describe('the app refuses what an old client mis-parsed', () => {
  const request = (cmd: string, args: string[], flags: Record<string, string | boolean> = {}): CliRequest => ({
    id: 'r', cmd, args, flags, terminalId: 't'
  })

  it('a boolean flag carrying a string means an old client swallowed an argument', () => {
    const why = staleBooleanFlagError(request('note', ['create'], { new: 'x' }))
    expect(why).toContain('--new')
    expect(why).toContain('"x"')
    expect(staleBooleanFlagError(request('ask', ['A'], { 'no-wait': '-' }))).toContain('--no-wait')
  })

  it('lets real boolean flags and value flags through', () => {
    expect(staleBooleanFlagError(request('note', ['create', 'x'], { new: true }))).toBeNull()
    expect(staleBooleanFlagError(request('list', [], { workspace: 'Home', all: true }))).toBeNull()
    expect(staleBooleanFlagError(request('recruit', [], { prompt: 'p', preset: 'Codex' }))).toBeNull()
  })

  it('refuses role save --prompt - that no client expanded', () => {
    expect(stdinPlaceholderError(request('role', ['save', 'A', 'R'], { prompt: '-' }))).toMatch(/stdin/)
    expect(stdinPlaceholderError(request('role', ['save', 'A', 'R'], { prompt: 'text' }))).toBeNull()
  })
})

describe('cookrew help', () => {
  it('no longer tells anyone to put a flag last', () => {
    expect(HELP_TEXT).not.toMatch(/after the -/)
    expect(HELP_TEXT).not.toMatch(/flags? last/i)
  })

  it('teaches the dash form for role save', () => {
    expect(HELP_TEXT).toContain(`cookrew role save "Agent" "RoleName" --prompt -`)
  })
})
