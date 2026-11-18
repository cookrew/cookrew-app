// THE ROUTE SERVICE ASKS BOTH SWITCHES ON EVERY CHOICE AND EVERY DISPATCH.
// A route that can reach another computer's Magpie is refused while "Magpie
// remote" is off, whichever way it arrives (picked on the card, saved before,
// the fleet default), and the switches are read again on each call.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GatewayMonitor } from '../src/main/route/gateway'
import { GATE_REMOTE_OFF, GATE_UNREAD, parseMagpieRouting, type MagpieRouting } from '../src/main/route/remote-gate'
import { RouteService } from '../src/main/route/service'
import { HarnessScan } from '../src/main/route/setup'
import type { LiveValues } from '../src/shared/launch-settings'
import type { TerminalNodeData } from '../src/shared/model'

const ROUTING = parseMagpieRouting(
  JSON.stringify({
    providers: [{ id: 'deepseek', preset: 'deepseek' }, { id: 'solis', preset: 'remote-magpie' }],
    groups: [{ id: 'mixed', members: ['deepseek/deepseek-chat', 'solis/claude-opus-5-5'] }]
  })
) as MagpieRouting

const terminal = (id: string, extra: Partial<TerminalNodeData> = {}): TerminalNodeData => ({ kind: 'terminal', id, name: id, preset: 'x', command: 'claude', cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, ...extra })

let home = ''
let server: http.Server | null = null
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'route-gate-'))
  mkdirSync(path.join(home, '.cookrew'), { recursive: true })
})
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
  rmSync(home, { recursive: true, force: true })
})

async function setup(): Promise<{ svc: RouteService; nodes: Map<string, TerminalNodeData>; world: { switches: LiveValues | null; routing: MagpieRouting | null } }> {
  server = http.createServer((req, res) => {
    if (req.url === '/api/hello') return res.end(JSON.stringify({ name: 'magpie' }))
    if (req.url === '/v1/models')
      return res.end(JSON.stringify({ data: [{ id: 'deepseek/deepseek-chat', owned_by: 'deepseek' }, { id: 'solis/claude-opus-5-5', owned_by: 'solis' }, { id: 'group/mixed', owned_by: 'magpie' }] }))
    res.end(JSON.stringify({ data: [] }))
  })
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const nodes = new Map<string, TerminalNodeData>()
  const world: { switches: LiveValues | null; routing: MagpieRouting | null } = { switches: { magpie: true, magpieRemote: false }, routing: ROUTING }
  const svc = new RouteService({
    monitor: new GatewayMonitor({ discovery: { home, env: { MAGPIE_ADDR: `:${port}` } }, hasBinary: () => true, watchDir: null, helloTimeoutMs: 300, schedule: () => () => {} }),
    fetch: (i, init) => fetch(i, init),
    home,
    pathEnv: '',
    pluginDir: '/p',
    node: (id) => nodes.get(id) ?? null,
    updateNode: (id, patch) => {
      const n = nodes.get(id)
      if (n) nodes.set(id, { ...n, ...patch })
    },
    isServed: () => false,
    harnessOf: (c) => (/^claude/.test(c) ? 'claude' : null),
    phaseOf: () => 'thinking',
    canRestoreExact: () => true,
    respawn: async () => true,
    dockCommands: () => [],
    switches: () => world.switches,
    routing: () => world.routing,
    scan: new HarnessScan({ home, pathEnv: '', dockCommands: () => [], harnessOfCommand: () => null, keychain: async () => false, installed: () => false }),
    schedule: () => () => {},
    writeFile: () => {}
  })
  await svc.refresh()
  return { svc, nodes, world }
}

describe('the route service gate', () => {
  it('refuses picking a remote route, a group with one in it, while remote is off', async () => {
    const { svc, nodes } = await setup()
    nodes.set('c1', terminal('c1'))
    for (const route of ['solis/claude-opus-5-5', 'group/mixed']) {
      expect(await svc.setCardRoute('c1', route)).toEqual({ error: GATE_REMOTE_OFF })
      expect(nodes.get('c1')?.route).toBeUndefined()
    }
    expect(await svc.setCardRoute('c1', 'deepseek/deepseek-chat')).toMatchObject({ route: 'deepseek/deepseek-chat' })
  })

  it('dispatches a saved remote route direct while remote is off, and says why', async () => {
    const { svc, nodes, world } = await setup()
    nodes.set('c1', terminal('c1', { route: 'solis/claude-opus-5-5' }))
    const card = (): TerminalNodeData => nodes.get('c1') as TerminalNodeData
    expect(svc.routeOf(card())).toBe('direct')
    expect(svc.envFor(card())).toMatchObject({ effective: 'direct', env: {}, args: [] })
    expect(svc.cardState('c1').note).toBe(GATE_REMOTE_OFF)

    world.switches = { magpie: true, magpieRemote: true }
    expect(svc.envFor(card())).toMatchObject({ effective: 'solis/claude-opus-5-5' })

    // Read again on the very next dispatch: no cached yes.
    world.switches = { magpie: true, magpieRemote: false }
    expect(svc.envFor(card()).effective).toBe('direct')
  })

  it('gates the fleet default the same way', async () => {
    const { svc, nodes, world } = await setup()
    nodes.set('c1', terminal('c1'))
    svc.setDefault('group/mixed')
    expect(svc.routeOf(nodes.get('c1') as TerminalNodeData)).toBe('direct')
    world.switches = { magpie: true, magpieRemote: true }
    expect(svc.routeOf(nodes.get('c1') as TerminalNodeData)).toBe('group/mixed')
  })

  it('refuses a route it cannot place when Magpie’s list cannot be read, and only while remote is off', async () => {
    const { svc, nodes, world } = await setup()
    nodes.set('c1', terminal('c1', { route: 'deepseek/deepseek-chat' }))
    world.routing = null
    expect(svc.envFor(nodes.get('c1') as TerminalNodeData).effective).toBe('direct')
    world.routing = ROUTING
    expect(svc.envFor(nodes.get('c1') as TerminalNodeData).effective).toBe('deepseek/deepseek-chat')
  })

  it('treats unreadable switches as off: nothing routed, nothing offered, and says why', async () => {
    const { svc, nodes, world } = await setup()
    nodes.set('c1', terminal('c1', { route: 'deepseek/deepseek-chat' }))
    world.switches = null
    expect(svc.state()).toMatchObject({ status: 'absent', switchedOff: true, why: GATE_UNREAD, models: [] })
    expect(svc.routeOf(nodes.get('c1') as TerminalNodeData)).toBe('direct')
    expect(svc.sharedMcpFor(nodes.get('c1') as TerminalNodeData)).toEqual([])
    expect(svc.health().status).toBe('absent')
    expect(await svc.setCardRoute('c1', 'deepseek/deepseek-chat')).toEqual({ error: GATE_UNREAD })
  })

  it('offers no remote model or group on the panel while remote is off', async () => {
    const { svc, world } = await setup()
    expect(svc.state().models.map((m) => m.id)).toEqual(['deepseek/deepseek-chat'])
    world.switches = { magpie: true, magpieRemote: true }
    expect(svc.state().models.map((m) => m.id).sort()).toEqual(['deepseek/deepseek-chat', 'group/mixed', 'solis/claude-opus-5-5'])
  })
})
