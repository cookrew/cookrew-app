// ROUND 2 OF THE CORE LANE (docs/route-program/fix-core-2.md): facts from
// the real magpie 0.1.1182 that a fake gateway could not have shown — the
// install locations off a GUI PATH, the quota rows with errors and no local
// row, the codex and pi notes on a card.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toQuotas, withLocalRows } from '../src/main/route/catalog'
import { magpieInstalled } from '../src/main/route/discovery'
import { GatewayMonitor } from '../src/main/route/gateway'
import { RouteService } from '../src/main/route/service'
import { HarnessScan } from '../src/main/route/setup'
import type { TerminalNodeData } from '../src/shared/model'
import type { RouteModel } from '../src/shared/route'

let home = ''
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'route-fix2-'))
  mkdirSync(path.join(home, '.cookrew'), { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('3 · installed', () => {
  it('looks on PATH, then at ~/.local/bin/magpie, then at /Applications/magpie.app', () => {
    const present = new Set<string>()
    const exists = (p: string): boolean => present.has(p)
    const d = { home, env: { PATH: '/usr/bin:/opt/x/bin' } }
    expect(magpieInstalled(d, exists)).toBe(false)
    present.add(path.join(home, '.local', 'bin', 'magpie'))
    expect(magpieInstalled(d, exists)).toBe(true)
    present.clear()
    present.add('/Applications/magpie.app')
    expect(magpieInstalled(d, exists)).toBe(true)
    present.clear()
    present.add('/opt/x/bin/magpie')
    expect(magpieInstalled(d, exists)).toBe(true)
  })

  it('a stopped gateway with the app installed reads offline (START), never absent (INSTALL)', async () => {
    const monitor = new GatewayMonitor({
      discovery: { home, env: {} },
      hasBinary: () => magpieInstalled({ home, env: {} }, (p) => p === path.join(home, '.local', 'bin', 'magpie')),
      watchDir: null,
      helloTimeoutMs: 300,
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    const probe = await monitor.refresh()
    expect(probe.status).toBe('offline')
    expect(probe.gateway?.port).toBe(3425)
  })
})

describe('4 · quotas as the real gateway answers them', () => {
  // Verbatim shape from magpie 0.1.1182 (round 2), the email replaced.
  const real = {
    data: [
      { provider: 'claude', name: 'Claude Code', kind: 'subscription', plan: 'max', user: 'owner@example.com', windows: [], error: "Claude Code's /usage is temporarily unavailable" },
      { provider: 'workbuddy-ai', name: 'WorkBuddy AI', kind: 'subscription', plan: 'Free', user: 'owner@example.com', windows: [{ name: 'Credits', used: 0, remaining: 100, display: '0 / 130', limit: 130, unit: 'credits' }], readAt: '2026-10-11T14:12:53.553138+08:00' }
    ],
    object: 'list'
  }
  const models: RouteModel[] = [
    { id: 'group/smart', displayName: 'smart', ownedBy: 'magpie', group: true, reasoning: false, levels: [], contextWindow: null },
    { id: 'ollama/qwen3', displayName: 'qwen3', ownedBy: 'ollama', group: false, reasoning: false, levels: [], contextWindow: null },
    { id: 'claude/claude-opus-5-5', displayName: 'Claude Opus 5.5', ownedBy: 'claude', group: false, reasoning: true, levels: ['high'], contextWindow: 1000000 },
    { id: 'workbuddy-ai/x', displayName: 'x', ownedBy: 'workbuddy-ai', group: false, reasoning: false, levels: [], contextWindow: null }
  ]

  it('maps the error row, the display string, the email, and no reset time', () => {
    const quotas = toQuotas(real)
    expect(quotas[0]).toEqual({ provider: 'claude', account: 'owner@example.com', alias: 'Claude Code', plan: 'max', kind: 'subscription', windows: [], last: false, error: "Claude Code's /usage is temporarily unavailable", balance: null, until: null, resetCredits: null, readAt: null })
    expect(quotas[1].windows).toEqual([expect.objectContaining({ name: 'Credits', used: 0, limit: 130, resetsAt: null, display: '0 / 130' })])
    expect(quotas[1].error).toBeNull()
  })

  it('synthesises a local row for every catalog provider with no quota row — Ollama never appears', () => {
    const rows = withLocalRows(toQuotas(real), models)
    expect(rows.map((q) => [q.provider, q.kind])).toEqual([['claude', 'subscription'], ['workbuddy-ai', 'subscription'], ['ollama', 'local']])
    expect(rows[2]).toEqual({ provider: 'ollama', account: null, alias: null, plan: null, kind: 'local', windows: [], last: false, error: null })
    // A group is not a provider; a provider already present is not doubled.
    expect(withLocalRows(rows, models)).toHaveLength(3)
  })
})

describe('2 · the notes on a card', () => {
  function terminal(id: string, command: string, extra: Partial<TerminalNodeData> = {}): TerminalNodeData {
    return { kind: 'terminal', id, name: id, preset: 'x', command, cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, ...extra }
  }

  it('codex routed → the thinking-model note; pi → not routable yet; claude → none', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/hello') return res.end(JSON.stringify({ name: 'magpie' }))
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'group/smart', owned_by: 'magpie' }, { id: 'claude/claude-sonnet-5-5', owned_by: 'claude', context_window: 1000000 }] }))
      res.end(JSON.stringify({ data: [] }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const nodes = new Map<string, TerminalNodeData>()
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
        harnessOf: (c) => (/^claude/.test(c) ? 'claude' : /^codex/.test(c) ? 'codex' : /^pi\b/.test(c) ? 'pi' : null),
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
      await svc.refresh()
      svc.setDefault('group/smart')
      nodes.set('cx', terminal('cx', 'codex'))
      nodes.set('pi', terminal('pi', 'pi'))
      nodes.set('cl', terminal('cl', 'claude'))
      nodes.set('cd', terminal('cd', 'codex', { route: 'direct' }))
      expect(svc.cardState('cx').note).toBe('codex needs a thinking-capable model behind the gateway')
      expect(svc.cardState('cd').note).toBeNull()
      expect(svc.cardState('pi').note).toBeNull()
      expect(svc.cardState('pi').routable).toBe(true)
      expect(svc.cardState('cx').routable).toBe(true)
      expect(svc.cardState('cl').note).toBeNull()
      // The context window from the catalog reaches claude's env; a model without one leaves it unset.
      nodes.set('cw', terminal('cw', 'claude', { route: 'claude/claude-sonnet-5-5' }))
      expect(svc.envFor(nodes.get('cw')!).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1000000')
      expect(svc.envFor(nodes.get('cl')!).env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
      expect(svc.envFor(nodes.get('cl')!).env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT).toBe('1')
      svc.dispose()
    } finally {
      server.close()
    }
  })
})
