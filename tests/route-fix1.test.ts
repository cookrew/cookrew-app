// FIX ROUND 1 OF THE CORE LANE (docs/route-program/fix-core.md): the
// loopback pin, the long-poll floor, the key kept in main, record-on-create,
// the routed-only activity path, the boot sequence, the served refusals, the
// route-id check, and the cached harness scan with the Keychain probe.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discover, hostAllowed } from '../src/main/route/discovery'
import { GatewayMonitor } from '../src/main/route/gateway'
import { RouteDecisions } from '../src/main/route/decisions'
import { RouteService } from '../src/main/route/service'
import { HarnessScan } from '../src/main/route/setup'
import type { TerminalNodeData } from '../src/shared/model'
import type { RouteDecision } from '../src/shared/route'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fakeGateway() {
  const fake = { url: '', port: 0, calls: 0, routeAnswer: { route: null as unknown, seq: 0 }, close: async () => {} }
  const server = http.createServer((req, res) => {
    fake.calls += 1
    if (req.url === '/api/hello') return res.end(JSON.stringify({ name: 'magpie', version: 'x' }))
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'group/smart', owned_by: 'magpie' }, { id: 'claude/claude-sonnet-5-5', owned_by: 'claude' }] }))
    if (req.url === '/v1/magpie/quotas') return res.end(JSON.stringify({ data: [] }))
    if (req.url?.startsWith('/v1/magpie/route')) return res.end(JSON.stringify(fake.routeAnswer))
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

let home = ''
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'route-fix-'))
  mkdirSync(path.join(home, '.cookrew'), { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function serviceFor(fake: { port: number }, nodes: Map<string, TerminalNodeData>, extra: Partial<ConstructorParameters<typeof RouteService>[0]> = {}, env: Record<string, string> = {}) {
  const lookups: string[] = []
  const monitor = new GatewayMonitor({ discovery: { home, env: { MAGPIE_ADDR: `:${fake.port}`, ...env } }, hasBinary: () => true, watchDir: null, helloTimeoutMs: 500, schedule: () => () => {} })
  const svc = new RouteService({
    monitor,
    fetch: (i, init) => fetch(i, init),
    home,
    pathEnv: '',
    pluginDir: '/p',
    node: (id) => {
      lookups.push(id)
      return nodes.get(id) ?? null
    },
    updateNode: (id, patch) => {
      const n = nodes.get(id)
      if (n) nodes.set(id, { ...n, ...patch })
    },
    isServed: () => false,
    harnessOf: (c) => (/^claude/.test(c) ? 'claude' : null),
    phaseOf: () => 'idle',
    canRestoreExact: () => true,
    respawn: async () => true,
    dockCommands: () => [],
    scan: new HarnessScan({ home, pathEnv: '', dockCommands: () => [], harnessOfCommand: () => null, keychain: async () => false, installed: () => false }),
    schedule: (fn, ms) => {
      const t = setTimeout(fn, Math.min(ms, 5))
      return () => clearTimeout(t)
    },
    writeFile: () => {},
    ...extra
  })
  return { svc, lookups }
}

describe('1 · the loopback pin', () => {
  it('allows only this machine unless the owner says otherwise', () => {
    expect(hostAllowed('http://127.0.0.1:3425', {})).toBe(true)
    expect(hostAllowed('http://localhost:3425', {})).toBe(true)
    expect(hostAllowed('http://[::1]:3425', {})).toBe(true)
    expect(hostAllowed('https://evil.tld', {})).toBe(false)
    expect(hostAllowed('http://192.168.1.9:3425', {})).toBe(false)
    expect(hostAllowed('http://192.168.1.9:3425', { COOKREW_ROUTE_REMOTE: '1' })).toBe(true)
  })

  it('a plugin file naming another host reads as absent with a why, and MAGPIE_ADDR too', () => {
    writeFileSync(path.join(home, '.cookrew', 'magpie.json'), JSON.stringify({ route: { gateway: 'https://evil.tld', key: 'k', model: 'group/smart' } }))
    const found = discover({ home, env: {} }, true)
    expect(found.known).toBe(false)
    expect(found.why).toContain('evil.tld')
    expect(found.defaultModel).toBeNull()
    const fromEnv = discover({ home: path.join(home, 'none'), env: { MAGPIE_ADDR: 'http://10.0.0.5:3425' } }, true)
    expect(fromEnv.known).toBe(false)
    expect(fromEnv.why).toContain('MAGPIE_ADDR')
  })

  it('never spawns a card against a refused gateway: the state is absent, the env empty', async () => {
    const fake = await fakeGateway()
    try {
      writeFileSync(path.join(home, '.cookrew', 'magpie.json'), JSON.stringify({ route: { gateway: 'https://evil.tld', model: 'group/smart' } }))
      const nodes = new Map<string, TerminalNodeData>()
      const { svc } = serviceFor(fake, nodes)
      const state = await svc.refresh()
      expect(state.status).toBe('absent')
      expect(state.why).toContain('magpie.json names https://evil.tld')
      const node = terminal('c1', 'claude', { route: 'group/smart' })
      nodes.set('c1', node)
      expect(svc.envFor(node)).toEqual({ env: {}, args: [], effective: 'direct', offline: true })
      expect(fake.calls).toBe(0)
      svc.dispose()
    } finally {
      await fake.close()
    }
  })
})

describe('2 · the long-poll floor', () => {
  it('a gateway that answers at once gets at most 3 requests a second and one frame per change, then is left alone', async () => {
    const fake = await fakeGateway()
    try {
      const frames: RouteDecision[] = []
      const d = new RouteDecisions({
        fetch: (i, init) => fetch(i, init),
        gateway: () => ({ url: fake.url, key: 'k' }),
        waitSeconds: 1,
        lapFloorMs: 500,
        maxIdleLaps: 8,
        onDecision: (row) => frames.push(row),
        onTurn: () => {}
      })
      const t0 = Date.now()
      d.follow('c1')
      await sleep(1100)
      const perSecond = fake.calls / ((Date.now() - t0) / 1000)
      expect(perSecond).toBeLessThanOrEqual(3)
      expect(frames).toHaveLength(0)
      // A decision appears and stays the same: one frame, not one per lap.
      fake.routeAnswer = { route: { asked: 'group/smart', model: 'claude/x', done: false }, seq: 1 }
      await sleep(1600)
      expect(frames).toHaveLength(1)
      // Eight laps with nothing moving and the follow is abandoned.
      await sleep(3500)
      expect(d.following).toEqual([])
      const callsAtAbandon = fake.calls
      await sleep(600)
      expect(fake.calls).toBe(callsAtAbandon)
    } finally {
      await fake.close()
    }
  }, 15_000)
})

describe('4 · record on create', () => {
  it('a reattached card whose route differs from what it was handed reads applies-on-restart', async () => {
    const fake = await fakeGateway()
    try {
      const nodes = new Map<string, TerminalNodeData>()
      const { svc } = serviceFor(fake, nodes)
      await svc.refresh()
      svc.setDefault('group/smart')
      const node = terminal('c1', 'claude', { routeEffective: 'direct' })
      nodes.set('c1', node)
      // The spawner computed a route but the attach reattached: nothing recorded.
      const spawn = svc.envFor(node)
      expect(spawn.effective).toBe('group/smart')
      expect(nodes.get('c1')?.routeEffective).toBe('direct')
      expect(svc.cardState('c1')).toMatchObject({ route: 'group/smart', effective: 'direct', appliesOn: 'restart' })
      // A real create records it.
      svc.recordEffective('c1', spawn)
      expect(svc.cardState('c1')).toMatchObject({ route: 'group/smart', effective: 'group/smart', appliesOn: 'now' })
      svc.dispose()
    } finally {
      await fake.close()
    }
  })
})

describe('5 · activity touches only routed cards', () => {
  it('an activity event for an unrouted card does no node lookup', async () => {
    const fake = await fakeGateway()
    try {
      const nodes = new Map<string, TerminalNodeData>()
      const { svc, lookups } = serviceFor(fake, nodes)
      await svc.refresh()
      nodes.set('plain', terminal('plain', 'claude'))
      lookups.length = 0
      svc.onActivity('plain', 'thinking')
      svc.onActivity('plain', 'idle')
      expect(lookups).toEqual([])
      // A routed card is followed; its lookup is the harness session read.
      svc.setDefault('group/smart')
      const routed = terminal('r1', 'claude')
      nodes.set('r1', routed)
      svc.recordEffective('r1', svc.envFor(routed))
      lookups.length = 0
      svc.onActivity('r1', 'thinking')
      await sleep(30)
      expect(svc.health().live).toBe(1)
      svc.onActivity('r1', 'idle')
      expect(svc.health().live).toBe(0)
      svc.dispose()
    } finally {
      await fake.close()
    }
  })
})

describe('6 · the boot sequence', () => {
  it('refresh at boot plus a hold while the window lives routes the first card after a restart', async () => {
    const fake = await fakeGateway()
    try {
      const nodes = new Map<string, TerminalNodeData>()
      writeFileSync(path.join(home, '.cookrew', 'route.json'), JSON.stringify({ defaultModel: 'group/smart' }))
      const { svc } = serviceFor(fake, nodes)
      // Before boot: nothing probed, so a card is direct (the default applies only online).
      expect(svc.envFor(terminal('x', 'claude')).effective).toBe('direct')
      void svc.refresh()
      const release = svc.hold()
      await sleep(120)
      expect(svc.state().status).toBe('online')
      const node = terminal('c1', 'claude')
      nodes.set('c1', node)
      const spawn = svc.envFor(node)
      expect(spawn.effective).toBe('group/smart')
      expect(spawn.env.ANTHROPIC_BASE_URL).toBe(fake.url)
      release()
      svc.dispose()
    } finally {
      await fake.close()
    }
  })
})

describe('8 · 9 · served cards and route ids', () => {
  it('a served card is direct to every reader and refuses a PUT; a route id must look like one', async () => {
    const fake = await fakeGateway()
    try {
      const nodes = new Map<string, TerminalNodeData>()
      const served = new Set(['s1'])
      const { svc } = serviceFor(fake, nodes, { isServed: (id) => served.has(id) })
      await svc.refresh()
      svc.setDefault('group/smart')
      nodes.set('s1', terminal('s1', 'claude'))
      expect(svc.routeOf(nodes.get('s1')!)).toBe('direct')
      expect(svc.cardState('s1').route).toBe('direct')
      expect(await svc.setCardRoute('s1', 'group/smart')).toEqual({ error: 'a served session is never routed' })
      nodes.set('c1', terminal('c1', 'claude'))
      expect(await svc.setCardRoute('c1', 'has space')).toEqual({ error: 'not a route id' })
      expect(await svc.setCardRoute('c1', 'x'.repeat(129))).toEqual({ error: 'not a route id' })
      expect(await svc.setCardRoute('c1', 'group/smart')).toMatchObject({ route: 'group/smart' })
      svc.dispose()
    } finally {
      await fake.close()
    }
  })
})

describe('10 · 11 · the cached scan and the Keychain probe', () => {
  it('scans once per TTL and folds the Keychain answer in when it lands', async () => {
    let now = 1000
    let scans = 0
    let probes = 0
    const scan = new HarnessScan({
      home,
      pathEnv: '',
      dockCommands: () => [],
      harnessOfCommand: () => null,
      installed: () => {
        scans += 1
        return true
      },
      exists: () => false,
      keychain: async () => {
        probes += 1
        return true
      },
      now: () => now,
      ttlMs: 30_000
    })
    const first = scan.rows()
    expect(first.find((r) => r.id === 'claude')?.signedIn).toBe(false)
    scan.rows()
    scan.rows()
    expect(scans).toBe(4) // four harnesses, one scan
    await scan.rowsSettled()
    expect(scan.rows().find((r) => r.id === 'claude')?.signedIn).toBe(true)
    expect(probes).toBe(1)
    now += 31_000
    scan.rows()
    expect(scans).toBe(12)
    await scan.rowsSettled()
    expect(probes).toBe(2)
    expect(scan.rows().find((r) => r.id === 'pi')?.signedIn).toBeNull()
  })
})

// QA 2026-11-03: claude's settings env outranks the route's, so a `--model`
// left on a routed claude card ran group/smart; and an RTE restart while a
// prompt was still being typed in lost it, as the model dial's did.
describe('an RTE pick on a claude card', () => {
  it('takes the --model the route would lose to, keeps the effort, and restarts', async () => {
    const fake = await fakeGateway()
    try {
      const nodes = new Map<string, TerminalNodeData>([['c1', terminal('c1', 'claude --effort low --model opus')]])
      const respawned: string[] = []
      const routeSet: string[] = []
      const { svc } = serviceFor(fake, nodes, { respawn: async (id) => (respawned.push(id), true), onRouteSet: (id) => routeSet.push(id) })
      await svc.refresh()
      await svc.setCardRoute('c1', 'claude/claude-sonnet-5-5')
      expect(routeSet).toEqual(['c1'])
      expect(nodes.get('c1')).toMatchObject({ route: 'claude/claude-sonnet-5-5', command: 'claude --effort low' })
      expect(respawned).toEqual(['c1'])
      // Going direct keeps whatever the card carries: there is no route to outrank.
      nodes.set('c2', terminal('c2', 'claude --model haiku'))
      await svc.setCardRoute('c2', 'direct')
      expect(nodes.get('c2')?.command).toBe('claude --model haiku')
      svc.dispose()
    } finally {
      await fake.close()
    }
  })

  it('saves the route but does not restart while a prompt is on its way in', async () => {
    const fake = await fakeGateway()
    try {
      const nodes = new Map<string, TerminalNodeData>([['c1', terminal('c1', 'claude')]])
      const respawned: string[] = []
      const { svc } = serviceFor(fake, nodes, { respawn: async (id) => (respawned.push(id), true), delivering: () => true })
      await svc.refresh()
      await svc.setCardRoute('c1', 'group/smart')
      expect(nodes.get('c1')?.route).toBe('group/smart')
      expect(respawned).toEqual([])
      svc.dispose()
    } finally {
      await fake.close()
    }
  })
})
