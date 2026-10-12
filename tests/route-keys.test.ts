// A GATEWAY KEY PER HARNESS (route program, E2E round): ~/.cookrew/route-keys.json
// names a key per harness; absent file or entry = magpie-cookrew; a served
// session still gets no route env at all; the names never reach RouteState.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GatewayMonitor } from '../src/main/route/gateway'
import { keyFor, readRouteKeys, routeKeysPath } from '../src/main/route/route-keys'
import { RouteService } from '../src/main/route/service'
import { HarnessScan } from '../src/main/route/setup'
import { ownerSecretPaths } from '../src/main/owner-secrets'
import type { TerminalNodeData } from '../src/shared/model'

let home = ''
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'route-keys-'))
  mkdirSync(path.join(home, '.cookrew'), { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('the keys file', () => {
  it('absent file, absent entry, malformed file and a bad name all fall back to the app key', () => {
    expect(readRouteKeys(home)).toEqual({})
    expect(keyFor({}, 'claude', 'magpie-cookrew')).toBe('magpie-cookrew')
    writeFileSync(routeKeysPath(home), JSON.stringify({ codex: 'magpie-codex', pi: 'has space', claude: 42, extra: 'x' }))
    const keys = readRouteKeys(home)
    expect(keys).toEqual({ codex: 'magpie-codex' })
    expect(keyFor(keys, 'codex', 'magpie-cookrew')).toBe('magpie-codex')
    expect(keyFor(keys, 'claude', 'magpie-cookrew')).toBe('magpie-cookrew')
    writeFileSync(routeKeysPath(home), '{not json')
    expect(readRouteKeys(home)).toEqual({})
  })

  it('is on the served deny list', () => {
    const paths = ownerSecretPaths(path.join(home, '.cookrew'))
    expect(paths.some((p) => p.endsWith(`${path.sep}route-keys.json`))).toBe(true)
  })
})

describe('the spawn env per harness', () => {
  function terminal(id: string, command: string, extra: Partial<TerminalNodeData> = {}): TerminalNodeData {
    return { kind: 'terminal', id, name: id, preset: 'x', command, cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, ...extra }
  }

  it('codex sends its own key when named; claude the app key; a served card nothing', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/hello') return res.end(JSON.stringify({ name: 'magpie' }))
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'group/auto', owned_by: 'ollama', magpie_label: 'auto · routing group' }, { id: 'ollama/qwen3:4b', owned_by: 'ollama' }] }))
      res.end(JSON.stringify({ data: [] }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      writeFileSync(routeKeysPath(home), JSON.stringify({ codex: 'magpie-codex' }), { mode: 0o600 })
      const nodes = new Map<string, TerminalNodeData>()
      const served = new Set(['s1'])
      const svc = new RouteService({
        monitor: new GatewayMonitor({ discovery: { home, env: { MAGPIE_ADDR: `:${port}` } }, hasBinary: () => true, watchDir: null, helloTimeoutMs: 300, schedule: () => () => {} }),
        fetch: (i, init) => fetch(i, init),
        home,
        pathEnv: '',
        pluginDir: '/p',
        node: (id) => nodes.get(id) ?? null,
        updateNode: () => {},
        isServed: (id) => served.has(id),
        harnessOf: (c) => (/^claude/.test(c) ? 'claude' : /^codex/.test(c) ? 'codex' : null),
        phaseOf: () => 'idle',
        canRestoreExact: () => true,
        respawn: async () => true,
        dockCommands: () => [],
        scan: new HarnessScan({ home, pathEnv: '', dockCommands: () => [], harnessOfCommand: () => null, keychain: async () => false, installed: () => false }),
        schedule: (fn) => {
          const t = setTimeout(fn, 5)
          return () => clearTimeout(t)
        },
        writeFile: () => {}
      })
      const state = await svc.refresh()
      expect(state.autoGroup).toBe(true)
      expect(JSON.stringify(state)).not.toContain('magpie-codex')
      svc.setDefault('group/auto')
      nodes.set('cx', terminal('cx', 'codex'))
      nodes.set('cl', terminal('cl', 'claude'))
      nodes.set('s1', terminal('s1', 'codex'))
      expect(svc.envFor(nodes.get('cx')!).env.MAGPIE_GATEWAY_KEY).toBe('magpie-codex')
      expect(svc.envFor(nodes.get('cl')!).env.ANTHROPIC_AUTH_TOKEN).toBe('magpie-cookrew')
      expect(svc.envFor(nodes.get('s1')!)).toEqual({ env: {}, args: [], effective: 'direct', offline: false })
      svc.dispose()
    } finally {
      server.close()
    }
  })
})
