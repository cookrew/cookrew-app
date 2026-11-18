// MAGPIE SWITCHED OFF: installed and running or not, nothing routes, no shared MCP,
// and the panel says why. Switched back on, the same card routes again.
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GatewayMonitor } from '../src/main/route/gateway'
import { RouteService, MAGPIE_SWITCHED_OFF } from '../src/main/route/service'
import { HarnessScan } from '../src/main/route/setup'
import { MAGPIE_WEB_PORTS } from '../src/main/route/magpie-web'
import type { TerminalNodeData } from '../src/shared/model'

let home = ''
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'route-off-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const terminal = (id: string, command: string): TerminalNodeData => ({ kind: 'terminal', id, name: id, preset: 'x', command, cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } })

describe('the Magpie switch', () => {
  it('turns every card direct and says why, and turns back on at once', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/hello') return res.end(JSON.stringify({ name: 'magpie' }))
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek/chat', owned_by: 'deepseek' }] }))
      res.end(JSON.stringify({ data: [] }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    let on = true
    const nodes = new Map<string, TerminalNodeData>([['c1', terminal('c1', 'claude')]])
    try {
      const svc = new RouteService({
        monitor: new GatewayMonitor({ discovery: { home, env: { MAGPIE_ADDR: `:${port}` } }, hasBinary: () => true, watchDir: null, helloTimeoutMs: 300, schedule: () => () => {} }),
        fetch: (i, init) => fetch(i, init),
        home,
        pathEnv: '',
        pluginDir: '/p',
        node: (id) => nodes.get(id) ?? null,
        updateNode: () => {},
        isServed: () => false,
        harnessOf: (c) => (/^claude/.test(c) ? 'claude' : null),
        phaseOf: () => 'idle',
        canRestoreExact: () => true,
        respawn: async () => true,
        dockCommands: () => [],
        switches: () => ({ magpie: on, magpieRemote: false }),
        remotePorts: () => [13425],
        scan: new HarnessScan({ home, pathEnv: '', dockCommands: () => [], harnessOfCommand: () => null, keychain: async () => false, installed: () => false }),
        schedule: (fn) => {
          const t = setTimeout(fn, 5)
          return () => clearTimeout(t)
        },
        writeFile: () => {}
      })
      await svc.refresh()
      svc.setDefault('deepseek/chat')
      const card = nodes.get('c1') as TerminalNodeData
      expect(svc.routeOf(card)).toBe('deepseek/chat')

      on = false
      const off = svc.state()
      expect(off).toMatchObject({ status: 'absent', switchedOff: true, why: MAGPIE_SWITCHED_OFF, defaultModel: null, models: [], sharedMcp: false })
      expect(svc.routeOf(card)).toBe('direct')
      expect(svc.envFor(card)).toMatchObject({ effective: 'direct', env: {}, args: [] })
      expect(svc.sharedMcpFor(card)).toEqual([])
      expect(svc.health().status).toBe('absent')

      on = true
      expect(svc.state().status).toBe('online')
      expect(svc.routeOf(card)).toBe('deepseek/chat')
      // The page's ports are denied to a served sandbox whatever the switch says.
      // A tunnel to another Magpie made by hand lands on its loopback, past its key: denied too.
      expect(svc.gatewayPorts()).toEqual(expect.arrayContaining([...MAGPIE_WEB_PORTS, 13425]))
    } finally {
      server.close()
    }
  })
})
