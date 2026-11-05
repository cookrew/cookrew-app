import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSetupLines, shellHoldsTerminal, type SetupLines } from '../src/main/setup-line'
import { SETUP_LINE_COPY } from '../src/shared/first-run-copy'

/**
 * THE SAME RUN ON A REAL HERDR, by hand only: COOKREW_HERDR_LIVE=1 npx vitest run …
 * Box round 3 had no herdr, and said N1 might be tmux-only.
 *
 * A probe from a Cookrew pane once stopped the app's own server: HERDR_SOCKET_PATH
 * outranks HERDR_SESSION. So every HERDR_* and COOKREW_* is dropped, and the server
 * here must be seen to be missing, with no cookrew_ pane, before anything starts.
 */

const LIVE = process.env.COOKREW_HERDR_LIVE === '1'
const SESSION = `setupline${process.pid}`
const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_') && !key.startsWith('COOKREW_'))), HERDR_SESSION: SESSION }
const herdr = (...args: string[]): string => execFileSync('herdr', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 })
const CARD = 'setup'

describe.skipIf(!LIVE)('a Setup line on real herdr', () => {
  let dir: string
  let paneId: string
  let lines: SetupLines
  const shellPid = (): number | null => {
    const info = JSON.parse(herdr('pane', 'process-info', '--pane', paneId)).result?.process_info as { shell_pid?: number } | undefined
    return info?.shell_pid ?? null
  }
  const typeBytes = (bytes: string): void => {
    if (bytes.startsWith('\x15')) herdr('pane', 'send-keys', paneId, 'ctrl+u')
    const text = bytes.replace(/^\x15/, '').replace(/\r$/, '')
    if (text !== '') herdr('pane', 'send-text', paneId, text)
    if (bytes.endsWith('\r')) herdr('pane', 'send-keys', paneId, 'enter')
  }
  const ended = async (runId: string) => {
    let last = await lines.now(CARD, runId)
    await vi.waitFor(async () => {
      last = await lines.now(CARD, runId)
      expect(last.state).toBe('ended')
    }, { timeout: 15_000, interval: 200 })
    return last
  }
  const start = async (line: string): Promise<string> => {
    const answer = await lines.start({ terminalId: CARD, line, enter: true, fresh: true })
    if (!answer.ok || answer.runId === null) throw new Error(`refused: ${JSON.stringify(answer)}`)
    return answer.runId
  }

  beforeAll(async () => {
    let seen = ''
    try {
      seen = herdr('pane', 'list')
    } catch (error) {
      seen = String((error as { stderr?: unknown }).stderr ?? error)
    }
    if (!seen.includes('server_not_running') || seen.includes('cookrew_')) throw new Error(`refusing to go on: this reached a server: ${seen.slice(0, 200)}`)
    dir = mkdtempSync(path.join(tmpdir(), 'setup-line-herdr-'))
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    const brew = path.join(bin, 'brew')
    writeFileSync(brew, ['#!/bin/sh', 'case "$2" in', '  cr-good) echo Pouring good; exit 0 ;;', '  cr-bad) exit 3 ;;', '  cr-asks) printf "[sudo] password for cooktest: "; read answer; exit 0 ;;', 'esac', ''].join('\n'))
    chmodSync(brew, 0o755)
    spawn('herdr', ['server'], { env, detached: true, stdio: 'ignore' }).unref()
    await vi.waitFor(() => expect(() => herdr('pane', 'list')).not.toThrow(), { timeout: 10_000, interval: 200 })
    herdr('workspace', 'create', '--cwd', dir)
    await vi.waitFor(() => {
      const panes = JSON.parse(herdr('pane', 'list')).result?.panes as { pane_id: string }[]
      expect(panes.length).toBeGreaterThan(0)
      paneId = panes[0].pane_id
    }, { timeout: 8000, interval: 200 })
    await vi.waitFor(() => expect(shellPid()).not.toBeNull(), { timeout: 8000, interval: 200 })
    typeBytes(`export PATH=${bin}:$PATH; clear\r`)
    lines = createSetupLines({
      dir: path.join(dir, 'lines'),
      isSetupCard: () => true,
      view: () => () => undefined,
      shellPid,
      holds: shellHoldsTerminal,
      type: (_id, bytes) => typeBytes(bytes),
      screen: async () => herdr('pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '40', '--format', 'text'),
      alive: () => true
    })
  }, 40_000)

  afterAll(() => {
    try {
      const seen = herdr('pane', 'list')
      if (!seen.includes('cookrew_')) herdr('server', 'stop')
    } catch {
      // Nothing was started.
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('N1: a good install ends by itself, with its 0, and a failed one with its code', async () => {
    expect(await ended(await start('brew install cr-good'))).toEqual({ state: 'ended', code: 0 })
    expect(await ended(await start('brew install cr-bad'))).toEqual({ state: 'ended', code: 3 })
  }, 40_000)

  it('N2: an open prompt gets nothing, and ^C clears the way', async () => {
    const runId = await start('brew install cr-asks')
    await vi.waitFor(async () => expect(await lines.now(CARD, runId)).toMatchObject({ asking: 'password' }), { timeout: 10_000, interval: 200 })
    const second = await lines.start({ terminalId: CARD, line: 'brew install cr-good', enter: true, fresh: false })
    expect(second).toEqual({ ok: false, reason: SETUP_LINE_COPY.BUSY, busy: true })
    herdr('pane', 'send-keys', paneId, 'ctrl+c')
    expect(await ended(runId)).toEqual({ state: 'ended', code: 130 })
    expect(await ended(await start('brew install cr-good'))).toEqual({ state: 'ended', code: 0 })
  }, 40_000)
})
