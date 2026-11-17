import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLI_NOT_ON_WINDOWS, cliTransport } from '../src/main/cli-transport'
import { startSocketServer } from '../src/main/socket-server'
import { testSocketPath } from './support/ipc-path'

/**
 * WHERE THE APP SERVES NO CLI (cli-transport.ts): today, Windows. The app
 * binds nothing there and says why; the CLI, finding no app, says the CLI is
 * not available on Windows rather than asking whether the app is running.
 * Nothing here claims the CLI works on Windows.
 */

const CLI = path.resolve('cli/cookrew.mjs')
const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-transport-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('cliTransport', () => {
  it('is a Unix-domain socket on macOS and Linux', () => {
    expect(cliTransport('darwin')).toEqual({ kind: 'unix-socket' })
    expect(cliTransport('linux')).toEqual({ kind: 'unix-socket' })
  })

  it('is nothing on Windows, and says so', () => {
    expect(cliTransport('win32')).toEqual({ kind: 'none', reason: CLI_NOT_ON_WINDOWS })
    expect(CLI_NOT_ON_WINDOWS).toMatch(/not available on Windows/)
  })
})

describe('the app on an OS with no CLI transport', () => {
  it('binds nothing, owns nothing, and says why once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const socketPath = path.join(scratch(), 'cookrew.sock')
    const deps = { ptys: { socketPath }, platform: 'win32' } as unknown as Parameters<typeof startSocketServer>[0]
    const { server, claim } = startSocketServer(deps)
    const outcome = await claim
    expect(outcome).toMatchObject({ owned: false, path: socketPath, reason: CLI_NOT_ON_WINDOWS })
    expect(server.listening).toBe(false)
    expect(existsSync(socketPath)).toBe(false)
    expect(() => outcome.release()).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain(CLI_NOT_ON_WINDOWS)
  })
})

describe('the CLI with no app to reach', () => {
  it('prints the very words the app uses (the CLI cannot import them)', () => {
    expect(readFileSync(CLI, 'utf8')).toContain(CLI_NOT_ON_WINDOWS)
  })

  it('on this host: Windows names the missing CLI, elsewhere it asks whether the app is running', () => {
    const run = spawnSync(process.execPath, [CLI, 'list'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, COOKREW_SOCKET: testSocketPath(scratch(), 'nobody.sock'), COOKREW_TERMINAL_ID: '' }
    })
    expect(run.status).toBe(1)
    if (process.platform === 'win32') {
      expect(run.stderr).toContain(CLI_NOT_ON_WINDOWS)
      expect(run.stderr).not.toMatch(/Is it running/)
    } else {
      expect(run.stderr).toMatch(/Cannot reach the Cookrew app \(\w+\)\. Is it running\?/)
    }
  })
})
