// `cookrew secret exec <name> -- <command…>`: the real CLI client against a
// fake app socket. The value reaches the command's env and nothing else —
// not stdout, not an argument.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { secretEnvName } from '../src/main/secret-cli'

const VALUE = 'sk_live_51Hx9QxEXECONLY0000'
const CLI = path.resolve('cli/cookrew.mjs')

const run = (socketPath: string, argv: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, COOKREW_SOCKET: socketPath, COOKREW_TERMINAL_ID: 't-owner' }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('exit', (code) => resolve({ code, out, err }))
  })

describe('cookrew secret exec', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const fakeApp = async (answer: (request: { cmd: string; args: string[]; flags: Record<string, unknown> }) => unknown) => {
    const socketPath = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-exec-')), 'app.sock')
    const seen: unknown[] = []
    const server = net.createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const at = buffer.indexOf('\n')
        if (at === -1) return
        const request = JSON.parse(buffer.slice(0, at)) as { id: string; cmd: string; args: string[]; flags: Record<string, unknown> }
        seen.push(request)
        socket.write(JSON.stringify({ id: request.id, ...(answer(request) as object) }) + '\n')
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    return { socketPath, seen }
  }

  it('names the env variable from the slot name', () => {
    expect(secretEnvName('stripe-key')).toBe('COOKREW_SECRET_STRIPE_KEY')
  })

  it('runs the command with the value in its env only, and prints only the command\'s output', async () => {
    const { socketPath, seen } = await fakeApp(() => ({ ok: true, output: VALUE }))
    const result = await run(socketPath, [
      'secret', 'exec', 'stripe-key', '--',
      process.execPath, '-e', 'process.stdout.write(`len=${process.env.COOKREW_SECRET_STRIPE_KEY.length} starts=${process.env.COOKREW_SECRET_STRIPE_KEY.slice(0,7)}`)'
    ])
    expect(result.code).toBe(0)
    expect(result.out).toBe(`len=${VALUE.length} starts=sk_live`)
    expect(result.out).not.toContain(VALUE)
    expect(result.err).toBe('')
    // The app saw `secret exec stripe-key` and nothing of the command.
    expect(seen).toHaveLength(1)
    expect((seen[0] as { args: string[] }).args).toEqual(['exec', 'stripe-key'])
    expect(JSON.stringify(seen[0])).not.toContain('-e')
  })

  it('carries the command\'s exit code, and the app\'s refusal code', async () => {
    const ok = await fakeApp(() => ({ ok: true, output: VALUE }))
    expect((await run(ok.socketPath, ['secret', 'exec', 'stripe-key', '--', process.execPath, '-e', 'process.exit(7)'])).code).toBe(7)
    const refused = await fakeApp(() => ({ ok: false, error: "refused: secrets are the owner's", exitCode: 3 }))
    const result = await run(refused.socketPath, ['secret', 'exec', 'stripe-key', '--', process.execPath, '-e', '0'])
    expect(result.code).toBe(3)
    expect(result.out).toBe('')
  })

  it('without a command after -- it is a usage error before any socket is touched', async () => {
    const { socketPath, seen } = await fakeApp(() => ({ ok: true, output: VALUE }))
    const result = await run(socketPath, ['secret', 'exec', 'stripe-key'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('usage')
    expect(seen).toHaveLength(0)
  })
})
