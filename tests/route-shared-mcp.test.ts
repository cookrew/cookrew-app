// SHARED MCP (route program): every agent Cookrew spawns is handed Magpie's
// one MCP hub, so a fleet of agents shares one copy of each MCP server
// instead of each agent starting its own. On by default; a served seat never
// gets it (its sandbox is denied the gateway port anyway); nothing is handed
// while the gateway is not online; the switch survives a restart and leaves
// the default model in route.json as it was.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GatewayMonitor } from '../src/main/route/gateway'
import { RouteService } from '../src/main/route/service'
import { HUB_SERVER, hubUrl, sharedMcpArgs } from '../src/main/route/shared-mcp'
import type { TerminalNodeData } from '../src/shared/model'

async function fakeGateway() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/hello') return res.end(JSON.stringify({ name: 'magpie', version: '0.1.2597' }))
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }))
    if (req.url === '/v1/magpie/quotas') return res.end(JSON.stringify({ data: [] }))
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { port, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

function terminal(id: string, command: string): TerminalNodeData {
  return { kind: 'terminal', id, name: id, preset: 'x', command, cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }
}

let home: string
const served = new Set<string>()
const nodes = new Map<string, TerminalNodeData>()

function service(env: Record<string, string | undefined>): RouteService {
  const monitor = new GatewayMonitor({ discovery: { home, env }, hasBinary: () => true, watchDir: null, helloTimeoutMs: 500, schedule: () => () => {} })
  return new RouteService({
    monitor,
    fetch: (i, init) => fetch(i, init),
    home,
    pathEnv: '',
    pluginDir: '/app/resources/magpie',
    node: (id) => nodes.get(id) ?? null,
    updateNode: () => {},
    isServed: (id) => served.has(id),
    harnessOf: (c) => (/^claude/.test(c) ? 'claude' : /^codex/.test(c) ? 'codex' : /^pi\b/.test(c) ? 'pi' : null),
    phaseOf: () => undefined,
    canRestoreExact: () => true,
    respawn: async () => true,
    dockCommands: () => [],
    schedule: (fn) => {
      const t = setTimeout(fn, 5)
      return () => clearTimeout(t)
    }
  })
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'route-mcp-'))
  mkdirSync(path.join(home, '.cookrew'), { recursive: true })
  served.clear()
  nodes.clear()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('sharedMcpArgs', () => {
  const gw = 'http://127.0.0.1:3425'

  it('names the hub per harness under the gateway', () => {
    expect(hubUrl(gw, 'claude')).toBe('http://127.0.0.1:3425/mcp/magpie/hub/claude')
    expect(hubUrl(`${gw}/`, 'codex')).toBe('http://127.0.0.1:3425/mcp/magpie/hub/codex')
  })

  it('claude: one --mcp-config with the hub under the name magpie writes into its user config (same name = one entry)', () => {
    const args = sharedMcpArgs('claude', gw)
    expect(args[0]).toBe('--mcp-config')
    expect(args).toHaveLength(2)
    expect(JSON.parse(args[1])).toEqual({ mcpServers: { [HUB_SERVER]: { type: 'http', url: `${gw}/mcp/magpie/hub/claude` } } })
  })

  it('codex: one -c override of mcp_servers.magpie.url, a TOML string', () => {
    expect(sharedMcpArgs('codex', gw)).toEqual(['-c', `mcp_servers.${HUB_SERVER}.url="${gw}/mcp/magpie/hub/codex"`])
  })

  it('opencode and pi: nothing per process (magpie writes their own config files)', () => {
    expect(sharedMcpArgs('opencode', gw)).toEqual([])
    expect(sharedMcpArgs('pi', gw)).toEqual([])
  })
})

describe('RouteService.sharedMcpFor', () => {
  it('is on by default: a claude and a codex card get the hub once the gateway is online', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service({ MAGPIE_ADDR: `:${fake.port}` })
      expect(svc.state().sharedMcp).toBe(true)
      // Not online yet: nothing, so the agent never boots against a dead URL.
      expect(svc.sharedMcpFor(terminal('a', 'claude'))).toEqual([])
      await svc.refresh()
      expect(svc.sharedMcpFor(terminal('a', 'claude --resume x'))).toEqual(sharedMcpArgs('claude', fake.url))
      expect(svc.sharedMcpFor(terminal('b', 'codex'))).toEqual(sharedMcpArgs('codex', fake.url))
      // A shell card has no harness: nothing.
      expect(svc.sharedMcpFor(terminal('c', ''))).toEqual([])
      svc.dispose()
    } finally {
      await fake.close()
    }
  })

  it('never hands the hub to a served seat', async () => {
    const fake = await fakeGateway()
    try {
      const svc = service({ MAGPIE_ADDR: `:${fake.port}` })
      await svc.refresh()
      served.add('seat')
      expect(svc.sharedMcpFor(terminal('seat', 'claude'))).toEqual([])
      svc.dispose()
    } finally {
      await fake.close()
    }
  })

  it('off hands nothing; the switch persists in route.json beside the default model', async () => {
    const fake = await fakeGateway()
    try {
      const file = path.join(home, '.cookrew', 'route.json')
      writeFileSync(file, `${JSON.stringify({ defaultModel: 'group/smart' })}\n`)
      const svc = service({ MAGPIE_ADDR: `:${fake.port}` })
      await svc.refresh()
      const off = svc.setSharedMcp(false)
      expect(off.sharedMcp).toBe(false)
      expect(svc.sharedMcpFor(terminal('a', 'claude'))).toEqual([])
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ defaultModel: 'group/smart', sharedMcp: false })
      // Setting the default model keeps the switch.
      svc.setDefault(null)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ defaultModel: null, sharedMcp: false })
      svc.dispose()
      const again = service({ MAGPIE_ADDR: `:${fake.port}` })
      expect(again.state().sharedMcp).toBe(false)
      expect(again.setSharedMcp(true).sharedMcp).toBe(true)
      again.dispose()
    } finally {
      await fake.close()
    }
  })
})
