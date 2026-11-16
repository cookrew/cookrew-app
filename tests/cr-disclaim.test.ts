import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HeadlessInstance, findChrome } from '../src/main/headless-chrome'
import { orphanChromePids } from '../src/main/orphan-chrome'

// The launcher the browser cards start Chrome through (resources/cr-disclaim).
// Built at postinstall on macOS only, so the suite skips where it is absent.
const binary = path.join(__dirname, '..', 'resources', 'cr-disclaim', 'cr-disclaim')
const built = process.platform === 'darwin' && existsSync(binary)

describe.runIf(built)('cr-disclaim', () => {
  // HeadlessInstance keeps the ChildProcess it spawned: its pid is what stop()
  // signals and what the orphan reaper matches. The launcher must BECOME Chrome.
  it('becomes the program it starts, keeping its pid', async () => {
    const child = spawn(binary, ['/bin/sh', '-c', 'echo $$'], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    await new Promise((resolve) => child.on('exit', resolve))
    expect(Number(out.trim())).toBe(child.pid)
  })

  it('hands over the arguments and the exit status untouched', () => {
    const run = spawnSync(binary, ['/bin/sh', '-c', 'printf "%s|" "$@"; exit 7', 'sh', 'a b', '--x=1'], { encoding: 'utf8' })
    expect(run.stdout).toBe('a b|--x=1|')
    expect(run.status).toBe(7)
  })

  it('fails loudly, with nothing started, when the program cannot run', () => {
    expect(spawnSync(binary, ['/nonexistent/chrome'], { encoding: 'utf8' }).status).toBe(127)
    expect(spawnSync(binary, [], { encoding: 'utf8' }).status).toBe(64)
  })
})

const chrome = findChrome()
describe.runIf(built && chrome !== null && process.env.COOKREW_REAL_CHROME_TEST === '1')('a card Chrome through cr-disclaim', () => {
  it('serves the page, is Chrome by pid and by args (what the reaper matches), and stops gracefully', async () => {
    const profileDir = mkdtempSync(path.join(tmpdir(), 'cookrew-disclaim-'))
    const instance = new HeadlessInstance({
      executablePath: chrome as string,
      launcher: binary,
      profileDir,
      width: 720,
      height: 560,
      tabs: [{ id: 't', url: 'data:text/html,<title>disclaimed</title>', title: '' }],
      activeTabId: 't'
    })
    try {
      await instance.start()
      expect((await instance.pageInfo()).title).toBe('disclaimed')
      const pid = instance.processId as number
      const args = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim()
      expect(args.startsWith(chrome as string)).toBe(true)
      expect(orphanChromePids(`${pid} 1 ${args}`, profileDir)).toEqual([pid])
      expect(await instance.stop()).toEqual({ pid, forced: false })
    } finally {
      await instance.stop()
      rmSync(profileDir, { recursive: true, force: true })
    }
  }, 30_000)
})
