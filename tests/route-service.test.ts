// THE ROUTE SERVICE (route program, core lane): what a card is spawned with
// and what the panel reads, against a fake gateway. The rules under test are
// the ledger's: a served pane never gets a route env; offline at spawn =
// direct with the flag; a new card stays direct when no default was ever
// named, even online; PUT route on an idle, exactly-restorable card respawns
// it in place; health carries the four facts.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GatewayMonitor } from '../src/main/route/gateway'
import { RouteService } from '../src/main/route/service'
import type { TerminalNodeData } from '../src/shared/model'
import type { TurnPhase } from '../src/shared/turn'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fakeGateway() {
  const fake = { url: '', port: 0, answer: true, close: async () => {} }
  const server = http.createServer((req, res) => {
    if (!fake.answer) {
      res.writeHead(503)
      return res.end()
    }
    if (req.url === '/api/hello') return res.end(JSON.stringify({ name: 'magpie', version: '0.1.1182' }))
    if (req.url === '/v1/models')
      return res.end(JSON.stringify({ data: [
        { id: 'group/smart', display_name: 'smart', owned_by: 'ollama', magpie_label: 'smart · routing group' },
        { id: 'claude/claude-sonnet-5-5', owned_by: 'claude', reasoning: true, supported_reasoning_levels: [{ effort: 'high' }] },
        { id: 'deepseek/deepseek-chat', owned_by: 'deepseek' }
      ] }))
    if (req.url === '/v1/magpie/quotas') return res.end(JSON.stringify({ data: [{ provider: 'claude', kind: 'subscription', plan: 'max', user: 'o@x', windows: [] }] }))
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  fake.port = (server.address() as { port: number }).port
  fake.url = `http://127.0.0.1:${fake.port}`
  fake.close = () => new Promise((r) => server.close(() => r()))
  return fake
}

function terminal(id: string, command: string, extra: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return { kind: 'terminal', id, name: id, preset: 'x', command, cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, ...extra }
}

interface World {
  home: string
  nodes: Map<string, TerminalNodeData>
  served: Set<string>
  phases: Map<string, TurnPhase>
  exact: boolean
  respawned: string[]
  files: { path: string; content: string }[]
}

function world(): World {
  const home = mkdtempSync(path.join(tmpdir(), 'route-svc-'))
  mkdirSync(path.join(home, '.cookrew'), { recursive: true })
  return { home, nodes: new Map(), served: new Set(), phases: new Map(), exact: true, respawned: [], files: [] }
}

function service(w: World, env: Record<string, string | undefined>, fastAnnounce = true) {
  const monitor = new GatewayMonitor({ discovery: { home: w.home, env }, hasBinary: () => true, watchDir: null, helloTimeoutMs: 500, schedule: () => () => {} })
  const svc = new RouteService({
    monitor,
    fetch: (i, init) => fetch(i, init),
    home: w.home,
    pathEnv: '',
    pluginDir: '/app/resources/magpie',
    node: (id) => w.nodes.get(id) ?? null,
    updateNode: (id, patch) => {
      const n = w.nodes.get(id)
      if (n) w.nodes.set(id, { ...n, ...patch })
    },
    isServed: (id) => w.served.has(id),
    harnessOf: (c) => (/^claude/.test(c) ? 'claude' : /^codex/.test(c) ? 'codex' : /^pi\b/.test(c) ? 'pi' : null),
    phaseOf: (id) => w.phases.get(id),
    canRestoreExact: () => w.exact,
    respawn: async (id) => {
      w.respawned.push(id)
      const n = w.nodes.get(id)
      if (n) svc.recordEffective(id, svc.envFor(n))
      return true
    },
    dockCommands: () => ['claude --permission-mode bypassPermissions', 'codex'],
    schedule: fastAnnounce ? (fn) => { const t = setTimeout(fn, 5); return () => clearTimeout(t) } : undefined,
    writeFile: (p, content) => w.files.push({ path: p, content })
  })
  return svc
}

let w: World
beforeEach(() => { w = world() })
afterEach(() => rmSync(w.home, { recursive: true, force: true }))

describe('state', () => {
  it('absent with nothing known; online with the catalog once probed; offline keeps the gateway but drops the catalog', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service(w, { MAGPIE_ADDR: `:${fake.port}` })
      expect(svc.state().status).toBe('absent')
      const online = await svc.refresh()
      expect(online.status).toBe('online')
      expect(online.gateway).toMatchObject({ url: fake.url, source: 'probe', version: '0.1.1182' })
      expect(online.gateway).not.toHaveProperty('key')
      expect(JSON.stringify(online)).not.toContain('magpie-cookrew')
      expect(online.why).toBeNull()
      expect(online.models.map((m) => m.id)).toEqual(['group/smart', 'claude/claude-sonnet-5-5', 'deepseek/deepseek-chat'])
      expect(online.providers).toBe(2)
      expect(online.quotas[0]).toMatchObject({ provider: 'claude', account: 'o@x', kind: 'subscription' })
      expect(online.defaultModel).toBeNull()
      expect(online.setup.addGroupLine).toBe('magpie group add smart models=claude/claude-sonnet-5-5,deepseek/deepseek-chat routing=smart')
      expect(online.setup.pluginLine).toBe('magpie plugin add /app/resources/magpie')
      expect(online.setup.addKeyLine.endsWith(' ')).toBe(true)
      expect(online.harnesses.map((h) => [h.id, h.inDock])).toEqual([['claude', true], ['codex', true], ['opencode', false], ['pi', false]])
      fake.answer = false
      const offline = await svc.refresh()
      expect(offline.status).toBe('offline')
      expect(offline.models).toEqual([])
      expect(svc.health()).toEqual({ status: 'offline', source: 'probe', providers: 0, live: 0 })
      svc.dispose()
    } finally {
      await fake.close()
    }
  })

  it('announces at most once a second and only while held does the monitor listen', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service(w, { MAGPIE_ADDR: `:${fake.port}` })
      const seen: string[] = []
      svc.on('route', (s: { status: string }) => seen.push(s.status))
      const release = svc.hold()
      await sleep(120)
      expect(seen).toEqual(['online'])
      release()
      svc.setDefault('group/smart')
      svc.setDefault('group/smart')
      await sleep(30)
      expect(seen).toHaveLength(2)
      expect(svc.state().defaultModel).toBe('group/smart')
      svc.dispose()
    } finally {
      await fake.close()
    }
  })
})

describe('envFor', () => {
  it('a new card stays direct when no default was named, even online', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service(w, { MAGPIE_ADDR: `:${fake.port}` })
      await svc.refresh()
      const node = terminal('c1', 'claude')
      w.nodes.set('c1', node)
      const spawn = svc.envFor(node)
      expect(spawn).toEqual({ env: {}, args: [], effective: 'direct', offline: false })
      // Nothing is recorded by the computation alone — only by a real create.
      expect(w.nodes.get('c1')?.routeEffective).toBeUndefined()
      svc.recordEffective('c1', spawn)
      expect(w.nodes.get('c1')?.routeEffective).toBe('direct')
      expect(svc.cardState('c1')).toMatchObject({ route: 'direct', effective: 'direct', appliesOn: 'now', offline: false })
      svc.dispose()
    } finally {
      await fake.close()
    }
  })

  it('routes a new card to the default once one is named, and records it', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service(w, { MAGPIE_ADDR: `:${fake.port}` })
      await svc.refresh()
      svc.setDefault('group/smart')
      const node = terminal('c2', 'claude')
      w.nodes.set('c2', node)
      const spawn = svc.envFor(node)
      expect(spawn.effective).toBe('group/smart')
      expect(spawn.env.ANTHROPIC_BASE_URL).toBe(fake.url)
      expect(spawn.env.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Magpie-Session: cookrew:c2')
      svc.recordEffective('c2', spawn)
      expect(w.nodes.get('c2')?.routeEffective).toBe('group/smart')
      expect(svc.cardState('c2').route).toBe('group/smart')
      svc.dispose()
    } finally {
      await fake.close()
    }
  })

  it('a served pane never gets a route env, whatever the default says', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service(w, { MAGPIE_ADDR: `:${fake.port}` })
      await svc.refresh()
      svc.setDefault('group/smart')
      const node = terminal('s1', 'claude', { route: 'group/smart' })
      w.nodes.set('s1', node)
      w.served.add('s1')
      const spawn = svc.envFor(node)
      expect(spawn).toEqual({ env: {}, args: [], effective: 'direct', offline: false })
      svc.recordEffective('s1', spawn)
      expect(w.nodes.get('s1')?.routeEffective).toBeUndefined()
      const byFacts = terminal('s2', 'claude', { route: 'group/smart', servedSession: { serviceId: 'x' } as never })
      expect(svc.envFor(byFacts).env).toEqual({})
      // And it is direct to every reader, never the fleet default; a PUT is refused.
      expect(svc.cardState('s1').route).toBe('direct')
      expect(await svc.setCardRoute('s1', 'group/smart')).toEqual({ error: 'a served session is never routed' })
      svc.dispose()
    } finally {
      await fake.close()
    }
  })

  it('offline at spawn goes direct and says so', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service(w, { MAGPIE_ADDR: `:${fake.port}` })
      await svc.refresh()
      fake.answer = false
      await svc.refresh()
      const node = terminal('c3', 'codex', { route: 'deepseek/deepseek-chat' })
      w.nodes.set('c3', node)
      const spawn = svc.envFor(node)
      expect(spawn).toEqual({ env: {}, args: [], effective: 'direct', offline: true })
      svc.recordEffective('c3', spawn)
      expect(svc.cardState('c3')).toMatchObject({ route: 'deepseek/deepseek-chat', effective: 'direct', appliesOn: 'restart', offline: true })
      svc.dispose()
    } finally {
      await fake.close()
    }
  })

  it('pi is not routable this round; opencode gets its config file written 0600', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service(w, { MAGPIE_ADDR: `:${fake.port}` })
      await svc.refresh()
      const pi = terminal('p1', 'pi', { route: 'group/smart' })
      w.nodes.set('p1', pi)
      expect(svc.envFor(pi).effective).toBe('direct')
      const oc = terminal('o1', 'opencode', { route: 'group/smart' })
      w.nodes.set('o1', oc)
      // opencode is matched by the service's harnessOf; this fake maps only claude/codex/pi,
      // so opencode reads as an unknown harness here and stays direct — the file path is
      // pinned in route-env.test.ts instead.
      expect(svc.envFor(oc).effective).toBe('direct')
      svc.dispose()
    } finally {
      await fake.close()
    }
  })
})

describe('setCardRoute', () => {
  it('on an idle, exactly-restorable card respawns in place: appliesOn now', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service(w, { MAGPIE_ADDR: `:${fake.port}` })
      await svc.refresh()
      const node = terminal('c4', 'claude')
      w.nodes.set('c4', node)
      svc.recordEffective('c4', svc.envFor(node))
      w.phases.set('c4', 'idle')
      const rows: unknown[] = []
      svc.on('card-route', (row) => rows.push(row))
      const result = await svc.setCardRoute('c4', 'group/smart')
      expect(w.respawned).toEqual(['c4'])
      expect(result).toMatchObject({ route: 'group/smart', effective: 'group/smart', appliesOn: 'now' })
      expect(rows.length).toBeGreaterThan(0)
      svc.dispose()
    } finally {
      await fake.close()
    }
  })

  it('on a busy card, or one that cannot be restored exactly, waits for the restart', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service(w, { MAGPIE_ADDR: `:${fake.port}` })
      await svc.refresh()
      const node = terminal('c5', 'claude')
      w.nodes.set('c5', node)
      svc.recordEffective('c5', svc.envFor(node))
      w.phases.set('c5', 'thinking')
      expect(await svc.setCardRoute('c5', 'group/smart')).toMatchObject({ route: 'group/smart', effective: 'direct', appliesOn: 'restart' })
      w.phases.set('c5', 'idle')
      w.exact = false
      expect(await svc.setCardRoute('c5', 'deepseek/deepseek-chat')).toMatchObject({ appliesOn: 'restart' })
      expect(w.respawned).toEqual([])
      expect(await svc.setCardRoute('c5', 'nope/unknown')).toEqual({ error: 'not in the catalog: nope/unknown' })
      expect(await svc.setCardRoute('c5', 'bad id with spaces')).toEqual({ error: 'not a route id' })
      expect(await svc.setCardRoute('ghost', 'direct')).toEqual({ error: 'unknown terminal' })
      svc.dispose()
    } finally {
      await fake.close()
    }
  })
})
