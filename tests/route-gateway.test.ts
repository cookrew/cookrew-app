// THE GATEWAY MONITOR AGAINST A FAKE MAGPIE (route program, core lane).
// absent / offline / online transitions, the plugin file as a source, the
// clock that runs only while listened to, and the catalog mapping — all
// against node:http on a free port, never the real gateway.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GatewayMonitor, OFFLINE_BACKOFF_MS, ONLINE_EVERY_MS, type GatewayProbe } from '../src/main/route/gateway'
import { discover, parseAddr, readPluginRoute, settingsPort } from '../src/main/route/discovery'
import { fetchCatalog, fetchQuotas, providersOf, toCatalog, toQuotas } from '../src/main/route/catalog'

interface Fake {
  url: string
  port: number
  hits: string[]
  answer: boolean
  close: () => Promise<void>
}

async function fakeGateway(): Promise<Fake> {
  const fake: Fake = { url: '', port: 0, hits: [], answer: true, close: async () => {} }
  const server = http.createServer((req, res) => {
    fake.hits.push(`${req.method} ${req.url}`)
    if (!fake.answer) {
      res.writeHead(503)
      res.end()
      return
    }
    if (req.url === '/api/hello') return res.end(JSON.stringify({ name: 'magpie', version: '1.2.3' }))
    if (req.url === '/v1/models')
      return res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'deepseek/deepseek-chat', display_name: 'DeepSeek Chat', owned_by: 'deepseek', reasoning: false, context_window: 128000 },
            { id: 'group/smart', display_name: 'smart', owned_by: 'magpie', reasoning: true, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
            { id: 'claude/claude-opus-5', display_name: 'Claude Opus 5', owned_by: 'claude', reasoning: true, supported_reasoning_levels: [{ effort: 'medium' }], context_window: 200000 },
            { id: 'ollama/qwen3', owned_by: 'ollama' }
          ]
        })
      )
    if (req.url === '/v1/magpie/quotas')
      return res.end(
        JSON.stringify([
          { provider: 'claude', account: 'me@example.com', plan: 'Max', windows: [{ name: '5h', used: 12, limit: 100, resetsAt: '2026-10-11T12:00:00Z' }], last: true },
          { provider: 'deepseek', type: 'key' },
          { provider: 'ollama' }
        ])
      )
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  fake.port = address.port
  fake.url = `http://127.0.0.1:${address.port}`
  fake.close = () => new Promise((r) => server.close(() => r()))
  return fake
}

/** A clock the test turns by hand. */
function fakeClock() {
  const timers: { fn: () => void; ms: number; id: number }[] = []
  let next = 1
  return {
    timers,
    schedule: (fn: () => void, ms: number) => {
      const id = next++
      timers.push({ fn, ms, id })
      return () => {
        const at = timers.findIndex((t) => t.id === id)
        if (at >= 0) timers.splice(at, 1)
      }
    },
    /** Fire the timer armed for `ms` (the stat poll is always the shortest, so pick by delay). */
    async fire(ms: number) {
      const at = timers.findIndex((t) => t.ms === ms)
      if (at < 0) throw new Error(`no timer at ${ms} ms; armed: ${timers.map((t) => t.ms).join(',')}`)
      const [t] = timers.splice(at, 1)
      t.fn()
      await new Promise((r) => setTimeout(r, 30))
    }
  }
}

let home = ''
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'route-home-'))
  mkdirSync(path.join(home, '.cookrew'), { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('discovery', () => {
  it('reads the port from magpie settings, read-only, honouring XDG_CONFIG_HOME', () => {
    mkdirSync(path.join(home, '.config', 'magpie'), { recursive: true })
    writeFileSync(path.join(home, '.config', 'magpie', 'settings.json'), JSON.stringify({ port: 4000 }))
    expect(settingsPort({ home, env: {} })).toBe(4000)
    const xdg = path.join(home, 'xdg')
    mkdirSync(path.join(xdg, 'magpie'), { recursive: true })
    writeFileSync(path.join(xdg, 'magpie', 'settings.json'), JSON.stringify({ port: 5000 }))
    expect(settingsPort({ home, env: { XDG_CONFIG_HOME: xdg } })).toBe(5000)
    expect(settingsPort({ home: path.join(home, 'nowhere'), env: {} })).toBeNull()
  })

  it('parses MAGPIE_ADDR the three ways magpie takes it', () => {
    expect(parseAddr('127.0.0.1:3425')).toEqual({ url: 'http://127.0.0.1:3425', port: 3425 })
    expect(parseAddr(':4100')).toEqual({ url: 'http://127.0.0.1:4100', port: 4100 })
    expect(parseAddr('http://magpie.local:8080')).toEqual({ url: 'http://magpie.local:8080', port: 8080 })
    expect(parseAddr('')).toBeNull()
  })

  it('the plugin file wins, nested or dotted, and falls back to the app key', () => {
    writeFileSync(path.join(home, '.cookrew', 'magpie.json'), JSON.stringify({ route: { gateway: 'http://127.0.0.1:3425/', v1: 'http://127.0.0.1:3425/v1', key: 'magpie-cookrew', model: 'group/smart' } }))
    expect(readPluginRoute({ home, env: {} })).toEqual({ gateway: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', key: 'magpie-cookrew', model: 'group/smart' })
    writeFileSync(path.join(home, '.cookrew', 'magpie.json'), JSON.stringify({ 'route.gateway': 'http://127.0.0.1:3425', 'route.model': 'deepseek/deepseek-chat' }))
    const found = discover({ home, env: {} }, false)
    expect(found.known).toBe(true)
    expect(found.gateway.source).toBe('plugin')
    expect(found.key).toBe('magpie-cookrew')
    expect(found.gateway).not.toHaveProperty('key')
    expect(found.gateway.v1).toBe('http://127.0.0.1:3425/v1')
    expect(found.defaultModel).toBe('deepseek/deepseek-chat')
  })

  it('without a binary, a plugin file or MAGPIE_ADDR nothing is known', () => {
    expect(discover({ home, env: {} }, false).known).toBe(false)
    expect(discover({ home, env: {} }, true).known).toBe(true)
    expect(discover({ home, env: { MAGPIE_ADDR: ':3425' } }, false).known).toBe(true)
  })
})

describe('the monitor', () => {
  it('absent → online → offline with backoff, and the clock runs only while listened to', async () => {
    const fake = await fakeGateway()
    const clock = fakeClock()
    let binary = false
    const env: Record<string, string | undefined> = {}
    const monitor = new GatewayMonitor({ discovery: { home, env }, hasBinary: () => binary, schedule: clock.schedule, watchDir: null, helloTimeoutMs: 500 })
    try {
      expect((await monitor.refresh()).status).toBe('absent')
      expect(fake.hits).toEqual([])
      expect(clock.timers).toHaveLength(0)

      binary = true
      env.MAGPIE_ADDR = `:${fake.port}`
      const seen: GatewayProbe[] = []
      const stop = monitor.listen((p) => seen.push(p))
      await new Promise((r) => setTimeout(r, 50))
      expect(monitor.probe.status).toBe('online')
      expect(monitor.probe.gateway).toMatchObject({ url: fake.url, v1: `${fake.url}/v1`, port: fake.port, version: '1.2.3', source: 'probe' })
      expect(monitor.probe.key).toBe('magpie-cookrew')
      expect(seen.map((p) => p.status)).toEqual(['online'])
      // One clock timer at the online cadence, plus the stat poll.
      const clockTimer = clock.timers.find((t) => t.ms === ONLINE_EVERY_MS)
      expect(clockTimer).toBeDefined()

      fake.answer = false
      await clock.fire(ONLINE_EVERY_MS)
      expect(monitor.probe.status).toBe('offline')
      expect(clock.timers.some((t) => t.ms === OFFLINE_BACKOFF_MS[0])).toBe(true)
      await clock.fire(OFFLINE_BACKOFF_MS[0])
      expect(clock.timers.some((t) => t.ms === OFFLINE_BACKOFF_MS[1])).toBe(true)
      // watchDir is null here (no watch could be placed), so the stat poll is
      // the backstop, re-armed each time it fires.
      await clock.fire(10_000)
      expect(clock.timers.filter((t) => t.ms === 10_000)).toHaveLength(1)

      stop()
      expect(clock.timers).toHaveLength(0)
      fake.answer = true
      expect((await monitor.refresh()).status).toBe('online')
      expect(clock.timers).toHaveLength(0)
    } finally {
      await fake.close()
    }
  })

  it('the plugin file written → source plugin and the default model; removed → back to the probe', async () => {
    const fake = await fakeGateway()
    const clock = fakeClock()
    let dirListener: (() => void) | null = null
    const monitor = new GatewayMonitor({
      discovery: { home, env: { MAGPIE_ADDR: `:${fake.port}` } },
      schedule: clock.schedule,
      watchDir: (_dir, cb) => {
        dirListener = cb
        return () => {
          dirListener = null
        }
      },
      helloTimeoutMs: 500
    })
    try {
      const stop = monitor.listen(() => {})
      await new Promise((r) => setTimeout(r, 50))
      expect(monitor.probe.gateway?.source).toBe('probe')
      expect(monitor.probe.defaultModel).toBeNull()
      // A placed watch means no stat poll: only the probe clock is armed.
      expect(clock.timers.filter((t) => t.ms === 10_000)).toHaveLength(0)

      writeFileSync(path.join(home, '.cookrew', 'magpie.json'), JSON.stringify({ route: { gateway: fake.url, v1: `${fake.url}/v1`, key: 'magpie-cookrew', model: 'group/smart' } }))
      dirListener!()
      await new Promise((r) => setTimeout(r, 50))
      expect(monitor.probe.gateway?.source).toBe('plugin')
      expect(monitor.probe.defaultModel).toBe('group/smart')
      expect(monitor.probe.status).toBe('online')

      rmSync(path.join(home, '.cookrew', 'magpie.json'))
      dirListener!()
      await new Promise((r) => setTimeout(r, 50))
      expect(monitor.probe.gateway?.source).toBe('probe')
      expect(monitor.probe.defaultModel).toBeNull()
      stop()
    } finally {
      await fake.close()
    }
  })
})

describe('the catalog', () => {
  it('maps /v1/models with groups first and counts providers without them', async () => {
    const fake = await fakeGateway()
    try {
      const models = await fetchCatalog((i, init) => fetch(i, init), `${fake.url}/v1`, 'magpie-cookrew')
      expect(models.map((m) => m.id)).toEqual(['group/smart', 'deepseek/deepseek-chat', 'claude/claude-opus-5', 'ollama/qwen3'])
      expect(models[0]).toEqual({ id: 'group/smart', displayName: 'smart', ownedBy: 'magpie', group: true, reasoning: true, levels: ['low', 'high'], contextWindow: null })
      expect(models[2]).toMatchObject({ ownedBy: 'claude', group: false, reasoning: true, levels: ['medium'], contextWindow: 200000 })
      expect(models[3]).toMatchObject({ displayName: 'ollama/qwen3', ownedBy: 'ollama', reasoning: false, levels: [] })
      expect(providersOf(models)).toBe(3)
      expect(fake.hits).toContain('GET /v1/models')
    } finally {
      await fake.close()
    }
  })

  it('maps quotas, leaving what a row does not say as null', async () => {
    const fake = await fakeGateway()
    try {
      const quotas = await fetchQuotas((i, init) => fetch(i, init), fake.url, 'magpie-cookrew')
      expect(quotas).toHaveLength(3)
      expect(quotas[0]).toEqual({
        provider: 'claude', account: 'me@example.com', alias: null, plan: 'Max', kind: 'subscription',
        windows: [{ name: '5h', used: 12, limit: 100, resetsAt: Date.parse('2026-10-11T12:00:00Z'), display: null, remaining: null, unit: null, tokensUsed: null, valueUsed: null, since: null, estimateWhy: null }],
        last: true, error: null, balance: null, until: null, resetCredits: null, readAt: null
      })
      expect(quotas[1]).toMatchObject({ provider: 'deepseek', kind: 'key', windows: [], last: false, account: null })
      expect(quotas[2]).toMatchObject({ provider: 'ollama', kind: 'local' })
    } finally {
      await fake.close()
    }
  })

  it('tolerates an unknown shape', () => {
    expect(toCatalog(null)).toEqual([])
    expect(toCatalog({ data: [{ nope: 1 }] })).toEqual([])
    expect(toQuotas('x')).toEqual([])
  })
})
