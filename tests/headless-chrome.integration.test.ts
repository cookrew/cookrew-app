import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserNodeData, BrowserTab } from '../src/shared/model'
import { HeadlessBrowserManager } from '../src/main/headless-browser-manager'
import { findChrome, HeadlessInstance } from '../src/main/headless-chrome'

const chrome = findChrome()
const enabled = process.env.COOKREW_REAL_CHROME_TEST === '1' && chrome !== null

describe.skipIf(!enabled)('HeadlessInstance real Chromium', () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'cookrew-headless-integration-'))
  let server: http.Server
  let origin = ''

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const page = request.url?.slice(1) || 'a'
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><title>${page.toUpperCase()}</title><h1>${page}</h1>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address')
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(profileDir, { recursive: true, force: true })
  })

  it('shares tabs, emits frames, persists profile state, and exits cleanly', async () => {
    const executablePath = chrome as string
    const tabs: BrowserTab[] = [
      { id: 'tab-a', url: `${origin}/a`, title: '' },
      { id: 'tab-b', url: `${origin}/b`, title: '' }
    ]
    const first = new HeadlessInstance({
      executablePath,
      profileDir,
      width: 720,
      height: 560,
      tabs,
      activeTabId: 'tab-a'
    })
    let frames = 0
    let firstProcessTree: number[] = []
    first.frameListeners.add(() => {
      frames += 1
    })

    try {
      await first.start()
      firstProcessTree = processTree(first.processId)
      expect((await first.pageInfo()).url).toBe(`${origin}/a`)
      await waitFor(() => frames > 0)
      await expect(
        first.evaluate(`localStorage.setItem('cookrew-test', 'shared'); localStorage.getItem('cookrew-test')`)
      ).resolves.toBe('shared')
      await expect(
        first.evaluate(
          `document.cookie = 'cookrew-profile=shared; path=/; Max-Age=3600; SameSite=Lax'; document.cookie`
        )
      ).resolves.toContain('cookrew-profile=shared')

      await first.syncTabs(tabs, 'tab-b')
      expect((await first.pageInfo()).url).toBe(`${origin}/b`)
      await first.navigate(`${origin}/c`)
      expect(await first.pageInfo()).toMatchObject({ url: `${origin}/c`, title: 'C' })
    } finally {
      const pid = first.processId
      const stopped = await first.stop()
      expect(stopped.forced).toBe(false)
      if (pid) await expectNoProcesses(firstProcessTree)
    }

    const second = new HeadlessInstance({
      executablePath,
      profileDir,
      width: 720,
      height: 560,
      tabs: [{ id: 'tab-a', url: `${origin}/a`, title: '' }],
      activeTabId: 'tab-a'
    })
    let secondProcessTree: number[] = []
    try {
      await second.start()
      secondProcessTree = processTree(second.processId)
      expect((await second.pageInfo()).url).toBe(`${origin}/a`)
      await expect(second.evaluate(`localStorage.getItem('cookrew-test')`)).resolves.toBe('shared')
      await expect(second.evaluate('document.cookie')).resolves.toContain('cookrew-profile=shared')
    } finally {
      const pid = second.processId
      const stopped = await second.stop()
      expect(stopped.forced).toBe(false)
      if (pid) await expectNoProcesses(secondProcessTree)
    }
  }, 45_000)

  it('leaves zero process after the bounded SIGKILL fallback', async () => {
    const instance = new HeadlessInstance({
      executablePath: chrome as string,
      profileDir: path.join(profileDir, 'forced'),
      width: 720,
      height: 560,
      tabs: [{ id: 'forced-tab', url: `${origin}/forced`, title: '' }],
      activeTabId: 'forced-tab'
    })
    await instance.start()
    const pid = instance.processId
    expect(pid).not.toBeNull()
    const processes = processTree(pid)

    const stopped = await instance.stop(0)
    expect(stopped.forced).toBe(true)
    if (pid) await expectNoProcesses(processes)
  }, 30_000)

  it('leaves zero process when cancelled during startup', async () => {
    const node: BrowserNodeData = {
      kind: 'browser',
      id: 'starting-browser',
      name: 'Starting',
      url: `${origin}/starting`,
      tabs: [{ id: 'starting-tab', url: `${origin}/starting`, title: '' }],
      activeTabId: 'starting-tab',
      position: { x: 0, y: 0 },
      size: { width: 720, height: 560 }
    }
    let instance: HeadlessInstance | null = null
    const manager = new HeadlessBrowserManager({
      enabled: () => true,
      chromePath: () => chrome,
      profileRoot: () => path.join(profileDir, 'starting'),
      resolveNode: (id) => (id === node.id ? node : null),
      onPageState: () => undefined,
      onTabOpened: () => undefined,
      onTabClosed: () => undefined,
      makeInstance: (options) => {
        instance = new HeadlessInstance({ ...options, startupDelayMs: 500 })
        return instance
      }
    })
    const starting = manager.syncNode(node)
    const pid = (instance as HeadlessInstance | null)?.processId ?? null
    expect(pid).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const processes = processTree(pid)
    expect(processes.length).toBeGreaterThan(1)

    await manager.remove(node.id)
    await expect(starting).resolves.toBeNull()
    const stopped = await (instance as HeadlessInstance | null)?.stop()
    expect(stopped?.forced).toBe(false)
    if (pid) await expectNoProcesses(processes)
  }, 30_000)
})

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function expectNoProcesses(pids: number[]): Promise<void> {
  await waitFor(() => pids.every((pid) => !processAlive(pid)))
  expect(pids.filter(processAlive)).toEqual([])
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function processTree(rootPid: number | null): number[] {
  if (!rootPid) return []
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]) }))
  const pids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!pids.has(row.pid) && pids.has(row.ppid)) {
        pids.add(row.pid)
        changed = true
      }
    }
  }
  return [...pids]
}
