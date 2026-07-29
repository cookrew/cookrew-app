import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sanitizeInput } from '../src/shared/cast-input'
import type { BrowserNodeData, BrowserTab } from '../src/shared/model'
import { HeadlessBrowserManager } from '../src/main/headless-browser-manager'
import { findChrome, HeadlessInstance, type FrameMeta } from '../src/main/headless-chrome'
import { jpegSize } from '../src/main/jpeg-size'

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
      response.end(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">` +
        `<title>${page.toUpperCase()}</title><h1>${page}</h1>`
      )
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
    let lastFrameRevision = 0
    let lastFrame: { data: string; meta: FrameMeta } | null = null
    let firstProcessTree: number[] = []
    first.frameListeners.add((data, meta) => {
      frames += 1
      lastFrameRevision = meta.revision ?? 0
      lastFrame = { data, meta }
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

      await first.evaluate(`
        sessionStorage.setItem('cookrew-session', 'same-target');
        document.documentElement.dataset.cookrewDom = 'preserved';
      `)
      const processBeforeReflow = first.processId
      const targetBeforeReflow = await activeTargetId(first.devToolsPort)
      first.registerViewportViewer('phone')
      first.offerViewport('phone', { width: 390, height: 700, mobile: true })
      await waitFor(() => first.viewportState.revision === 2)
      await waitFor(() => lastFrameRevision === 2)

      expect(first.processId).toBe(processBeforeReflow)
      expect(await activeTargetId(first.devToolsPort)).toBe(targetBeforeReflow)
      expect(first.viewportState).toMatchObject({
        width: 390,
        height: 700,
        mobile: true,
        revision: 2,
        ownerId: 'phone'
      })
      await expect(first.evaluate(`({
        width: innerWidth,
        height: innerHeight,
        touchPoints: navigator.maxTouchPoints,
        session: sessionStorage.getItem('cookrew-session'),
        cookie: document.cookie,
        dom: document.documentElement.dataset.cookrewDom
      })`)).resolves.toMatchObject({
        width: 390,
        height: 700,
        touchPoints: 2,
        session: 'same-target',
        cookie: expect.stringContaining('cookrew-profile=shared'),
        dom: 'preserved'
      })

      const tapFramePoint = async (
        framePoint: { x: number; y: number },
        mappingPageScaleFactor?: number
      ): Promise<{
        actual: { x: number; y: number }
        expected: { x: number; y: number }
        error: number
      }> => {
        const frame = lastFrame as { data: string; meta: FrameMeta } | null
        const size = frame ? jpegSize(Buffer.from(frame.data, 'base64')) : null
        expect(size).not.toBeNull()
        const deviceWidth = frame?.meta.deviceWidth ?? first.viewportState.width
        const pageScaleFactor = frame?.meta.pageScaleFactor ?? 1
        const jpegScale = (size?.width ?? deviceWidth) / deviceWidth
        const displayScale = jpegScale * pageScaleFactor
        const mappingScale = jpegScale * (mappingPageScaleFactor ?? pageScaleFactor)
        const viewport = await first.evaluate(`({
          offsetLeft: visualViewport?.offsetLeft ?? 0,
          offsetTop: visualViewport?.offsetTop ?? 0
        })`) as { offsetLeft: number; offsetTop: number }
        await first.evaluate(`
          window.__cookrewPrecisionClick = null;
          addEventListener('click', (event) => {
            window.__cookrewPrecisionClick = { x: event.clientX, y: event.clientY };
          }, { once: true });
        `)
        const commands = sanitizeInput({ t: 'tap', ...framePoint }, {
          displayScale: mappingScale,
          viewportWidth: first.viewportState.width,
          viewportHeight: first.viewportState.height
        })
        expect(commands).not.toBeNull()
        for (const command of commands ?? []) first.dispatchInput(command.method, command.params)
        await waitFor(async () => (
          await first.evaluate('window.__cookrewPrecisionClick')
        ) !== null)
        const actual = await first.evaluate(
          'window.__cookrewPrecisionClick'
        ) as { x: number; y: number }
        const expected = {
          x: framePoint.x / displayScale + viewport.offsetLeft,
          y: framePoint.y / displayScale + viewport.offsetTop
        }
        return {
          actual,
          expected,
          error: Math.hypot(actual.x - expected.x, actual.y - expected.y)
        }
      }

      const scaleOneTap = await tapFramePoint({ x: 195, y: 200 })
      expect(scaleOneTap.error).toBeLessThanOrEqual(2)

      const dispatchTouch = (raw: unknown): void => {
        const commands = sanitizeInput(raw, {
          displayScale: 1,
          viewportWidth: 390,
          viewportHeight: 700
        })
        expect(commands).not.toBeNull()
        for (const command of commands ?? []) first.dispatchInput(command.method, command.params)
      }
      const scaleBeforePinch = await first.evaluate('visualViewport?.scale ?? 1') as number
      dispatchTouch({ t: 'touchstart', x: 170, y: 350 })
      dispatchTouch({
        t: 'touchstart',
        points: [{ id: 0, x: 170, y: 350 }, { id: 1, x: 220, y: 350 }]
      })
      dispatchTouch({
        t: 'touchmove',
        points: [{ id: 0, x: 120, y: 350 }, { id: 1, x: 270, y: 350 }]
      })
      dispatchTouch({
        t: 'touchmove',
        points: [{ id: 0, x: 80, y: 350 }, { id: 1, x: 310, y: 350 }]
      })
      dispatchTouch({ t: 'touchend' })
      await waitFor(async () => (
        await first.evaluate('visualViewport?.scale ?? 1') as number
      ) > scaleBeforePinch)
      const scaleAfterPinch = await first.evaluate('visualViewport?.scale ?? 1') as number
      expect(scaleAfterPinch).toBeGreaterThan(scaleBeforePinch)
      await waitFor(() => (
        (lastFrame as { meta: FrameMeta } | null)?.meta.pageScaleFactor ?? 0
      ) > scaleBeforePinch)
      const oldZoomedTap = await tapFramePoint({ x: 195, y: 200 }, 1)
      const zoomedTap = await tapFramePoint({ x: 195, y: 200 })
      expect(zoomedTap.error).toBeLessThanOrEqual(2)
      if (process.env.COOKREW_REPORT_PRECISION === '1') {
        console.info('[precision]', JSON.stringify({
          scaleOne: scaleOneTap,
          pageScaleFactor: scaleAfterPinch,
          zoomedBefore: oldZoomedTap,
          zoomedAfter: zoomedTap
        }))
      }
      expect(first.processId).toBe(processBeforeReflow)
      expect(await activeTargetId(first.devToolsPort)).toBe(targetBeforeReflow)
      expect(first.viewportState.revision).toBe(2)
      await expect(first.evaluate(`({
        session: sessionStorage.getItem('cookrew-session'),
        cookie: document.cookie,
        dom: document.documentElement.dataset.cookrewDom
      })`)).resolves.toMatchObject({
        session: 'same-target',
        cookie: expect.stringContaining('cookrew-profile=shared'),
        dom: 'preserved'
      })

      let fallbackScale = 0
      const fallbackListener = (_data: string, meta: { pageScaleFactor?: number }): void => {
        fallbackScale = meta.pageScaleFactor ?? 0
      }
      first.frameListeners.add(fallbackListener)
      Object.assign(first, { lastFrameAt: 0, lastHash: '' })
      await (first as unknown as { pollTick: () => Promise<void> }).pollTick()
      first.frameListeners.delete(fallbackListener)
      expect(fallbackScale).toBeCloseTo(scaleAfterPinch, 3)

      first.registerViewportViewer('desktop')
      first.offerViewport('desktop', { width: 1000, height: 700, mobile: false })
      const releaseAgent = await first.beginAgentViewportActivity()
      expect(first.claimViewport('desktop', { width: 1000, height: 700, mobile: false })).toBe(false)
      expect(first.viewportState).toMatchObject({ revision: 2, agentHeld: true, ownerId: 'phone' })
      releaseAgent()

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
    expect(pid && processAlive(pid)).toBe(true)

    await manager.remove(node.id)
    await expect(starting).resolves.toBeNull()
    const stopped = await (instance as HeadlessInstance | null)?.stop()
    expect(stopped?.forced).toBe(false)
    if (pid) await expectNoProcesses(processes)
  }, 30_000)
})

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
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

async function activeTargetId(port: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (response) => {
      let body = ''
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => {
        try {
          const targets = JSON.parse(body) as Array<{ id?: string; type?: string }>
          resolve(targets.find((target) => target.type === 'page')?.id ?? null)
        } catch (error) {
          reject(error as Error)
        }
      })
    }).on('error', reject)
  })
}
