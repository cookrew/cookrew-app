import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installPaneExitHook, paneExitConf, takePaneExit } from '../src/main/pane-exit'

// On a REAL, PRIVATE tmux server (never `-L cookrew`). tmux takes a pane with
// the command that failed, and its exit status with it, so a dead card had
// nothing to say: the hook keeps both long enough to write them down.

const LABEL = `cookrew-exit-test-${process.pid}`
const hasTmux = spawnSync('tmux', ['-V']).status === 0
const tmux = (...args: string[]): string =>
  execFileSync('tmux', ['-L', LABEL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const sessionGone = (name: string): boolean => spawnSync('tmux', ['-L', LABEL, 'has-session', '-t', name], { stdio: 'ignore' }).status !== 0

describe.skipIf(!hasTmux)('the pane-died hook (real tmux)', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cookrew exit '))
    installPaneExitHook(dir)
    const conf = path.join(dir, 'tmux.conf')
    writeFileSync(conf, `${paneExitConf(dir).join('\n')}\n`)
    tmux('-f', conf, 'new-session', '-d', '-s', 'keeper', 'sleep', '60')
    tmux('source-file', conf)
  })

  afterAll(() => {
    spawnSync('tmux', ['-L', LABEL, 'kill-server'], { stdio: 'ignore' })
  })

  it('a failed command leaves its status and last lines, and the pane still goes', async () => {
    tmux('new-session', '-d', '-s', 'cookrew_fail', 'sh', '-c', 'echo about to fail; echo really >&2; exit 7')
    await expect.poll(() => sessionGone('cookrew_fail'), { timeout: 4000 }).toBe(true)
    const exit = takePaneExit(dir, 'cookrew_fail')
    expect(exit).toMatchObject({ exitCode: 7, signal: null })
    expect(exit?.tail).toEqual(expect.arrayContaining(['about to fail', 'really']))
  })

  it('a command not found reads as 127 with the shell\'s own words', async () => {
    tmux('new-session', '-d', '-s', 'cookrew_nf', 'sh', '-c', 'exec nosuchcmd-xyz')
    await expect.poll(() => sessionGone('cookrew_nf'), { timeout: 4000 }).toBe(true)
    const exit = takePaneExit(dir, 'cookrew_nf')
    expect(exit?.exitCode).toBe(127)
    expect(exit?.tail.join('\n')).toContain('nosuchcmd-xyz')
  })

  it('a killed process reads as its signal', async () => {
    tmux('new-session', '-d', '-s', 'cookrew_sig', 'sh', '-c', 'kill -9 $$')
    await expect.poll(() => sessionGone('cookrew_sig'), { timeout: 4000 }).toBe(true)
    expect(takePaneExit(dir, 'cookrew_sig')).toMatchObject({ exitCode: null, signal: 'kill' })
  })

  it('a clean exit leaves no record: nothing went wrong', async () => {
    tmux('new-session', '-d', '-s', 'cookrew_ok', 'sh', '-c', 'exit 0')
    await expect.poll(() => sessionGone('cookrew_ok'), { timeout: 4000 }).toBe(true)
    expect(takePaneExit(dir, 'cookrew_ok')).toBeNull()
  })

  it('Cookrew\'s own kill leaves no record', async () => {
    tmux('new-session', '-d', '-s', 'cookrew_killed', 'sleep', '30')
    tmux('kill-session', '-t', 'cookrew_killed')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(takePaneExit(dir, 'cookrew_killed')).toBeNull()
  })

  it('a record is read once: a later wake must not repeat an old death', async () => {
    tmux('new-session', '-d', '-s', 'cookrew_once', 'sh', '-c', 'exit 2')
    await expect.poll(() => sessionGone('cookrew_once'), { timeout: 4000 }).toBe(true)
    expect(takePaneExit(dir, 'cookrew_once')?.exitCode).toBe(2)
    expect(takePaneExit(dir, 'cookrew_once')).toBeNull()
  })

  it('the name is the session it should be: a path never leaves the folder', () => {
    expect(takePaneExit(dir, '../../etc/passwd')).toBeNull()
  })

  it('the hook script is executable text, not a file somebody must install', () => {
    const script = path.join(dir, 'pane-exit.sh')
    expect(existsSync(script)).toBe(true)
    expect(readFileSync(script, 'utf8')).toContain('capture-pane')
  })
})
