import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSetupLines, shellHoldsTerminal, type SetupLines } from '../src/main/setup-line'
import { SETUP_LINE_COPY } from '../src/shared/first-run-copy'

/**
 * THE REAL THING: a real tmux with Cookrew's status bar, a real login shell, and a
 * stand-in `brew` on the pane's PATH, since a line must pass the allowlist. This is
 * box round 3's N1 and N2 as they happened. Private socket: never the app's.
 */

const hasTmux = spawnSync('tmux', ['-V']).status === 0
const LABEL = `setup-line-test-${process.pid}`
const SESSION = 'setup'

const tmux = (...args: string[]): string => execFileSync('tmux', ['-L', LABEL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const hex = (bytes: string): string[] => [...Buffer.from(bytes)].map((b) => b.toString(16).padStart(2, '0'))

describe.skipIf(!hasTmux)('a Setup line on real tmux', () => {
  let dir: string
  let lines: SetupLines
  const ended = async (runId: string) => {
    let last = await lines.now(SESSION, runId)
    await vi.waitFor(async () => {
      last = await lines.now(SESSION, runId)
      expect(last.state).toBe('ended')
    }, { timeout: 12_000, interval: 150 })
    return last
  }
  const start = async (line: string): Promise<string> => {
    const answer = await lines.start({ terminalId: SESSION, line, enter: true, fresh: true })
    if (!answer.ok || answer.runId === null) throw new Error(`refused: ${JSON.stringify(answer)}`)
    return answer.runId
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'setup-line-tmux-'))
    const bin = path.join(dir, 'bin')
    mkdirSync(bin)
    const brew = path.join(bin, 'brew')
    writeFileSync(brew, ['#!/bin/sh', 'case "$2" in', '  cr-good) echo Pouring good; exit 0 ;;', '  cr-bad) echo no such formula >&2; exit 3 ;;', '  cr-asks) printf "[sudo] password for cooktest: "; read answer; echo "answered:$answer" > "$BREW_LOG"; exit 0 ;;', 'esac', ''].join('\n'))
    chmodSync(brew, 0o755)
    const conf = path.join(dir, 'tmux.conf')
    // The pane's command must not go through the person's shell: its rc files put the real brew first.
    writeFileSync(conf, ['set -g default-shell /bin/sh', 'set -g status on', "set -g status-left '#[bold] cookrew · #S #[nobold] '", 'set -g base-index 1', ''].join('\n'))
    tmux('-f', conf, 'new-session', '-d', '-s', SESSION, '-x', '120', '-y', '30', `exec env PATH=${bin}:/usr/bin:/bin BREW_LOG=${path.join(dir, 'answer')} ENV=/dev/null /bin/sh -i`)
    lines = createSetupLines({
      dir: path.join(dir, 'lines'),
      isSetupCard: () => true,
      view: () => () => undefined,
      shellPid: () => {
        const pid = Number(tmux('list-panes', '-t', SESSION, '-F', '#{pane_pid}').trim())
        return Number.isInteger(pid) && pid > 0 ? pid : null
      },
      holds: shellHoldsTerminal,
      type: (_id, bytes) => void tmux('send-keys', '-t', SESSION, '-H', ...hex(bytes)),
      screen: async () => tmux('capture-pane', '-p', '-t', SESSION),
      alive: () => spawnSync('tmux', ['-L', LABEL, 'has-session', '-t', SESSION], { stdio: 'ignore' }).status === 0
    })
  })

  afterAll(() => {
    spawnSync('tmux', ['-L', LABEL, 'kill-server'], { stdio: 'ignore' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('N1: a good install ends by itself, with its 0', async () => {
    expect(await ended(await start('brew install cr-good'))).toEqual({ state: 'ended', code: 0 })
  })

  it('a failed line ends with its own code', async () => {
    expect(await ended(await start('brew install cr-bad'))).toEqual({ state: 'ended', code: 3 })
  })

  it('N1: what a button reads comes from the pane, so the status bar cannot reach it', async () => {
    const runId = await start('brew install cr-asks')
    await vi.waitFor(async () => {
      const now = await lines.now(SESSION, runId)
      expect(now).toMatchObject({ state: 'running', asking: 'password' })
      if (now.state === 'running') expect(now.lastLine).not.toContain('cookrew ·')
    }, { timeout: 8000, interval: 150 })
    tmux('send-keys', '-t', SESSION, 'C-c')
    await ended(runId)
  })

  it('N2: an open prompt gets nothing, and Stop clears the way', async () => {
    const runId = await start('brew install cr-asks')
    await vi.waitFor(async () => expect(await lines.now(SESSION, runId)).toMatchObject({ asking: 'password' }), { timeout: 8000, interval: 150 })
    const second = await lines.start({ terminalId: SESSION, line: 'brew install cr-good', enter: true, fresh: false })
    expect(second).toEqual({ ok: false, reason: SETUP_LINE_COPY.BUSY, busy: true })
    expect(tmux('capture-pane', '-p', '-t', SESSION)).toContain('[sudo] password for cooktest:')
    tmux('send-keys', '-t', SESSION, 'C-c')
    expect(await ended(runId)).toEqual({ state: 'ended', code: 130 })
    expect(await ended(await start('brew install cr-good'))).toEqual({ state: 'ended', code: 0 })
  })

  it('N2: a person’s own command in the pane is a busy pane too', async () => {
    tmux('send-keys', '-t', SESSION, 'sleep 30', 'Enter')
    await vi.waitFor(async () => expect((await lines.start({ terminalId: SESSION, line: 'brew install cr-good', enter: true, fresh: false })).ok).toBe(false), { timeout: 5000, interval: 150 })
    tmux('send-keys', '-t', SESSION, 'C-c')
  })
})
