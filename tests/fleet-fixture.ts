// A fake desktop for the fleet tests: a store-shaped EventEmitter over two
// invented workspaces, the board's three layers, and the dials. Every name and
// prompt is invented.
import { EventEmitter } from 'node:events'
import type { BoardPhase } from '../src/shared/board'
import type { BoardSources } from '../src/main/board-index'
import type { CanvasNode, Connection, WorkspaceMeta, WorkspaceState } from '../src/shared/model'
import type { TerminalActivity, TurnRecord } from '../src/shared/turn'
import type { MachineProfile } from '../src/shared/fleet'
import type { WorkspaceStore } from '../src/main/store'
import { levelsSourcesFrom, type FleetRuntime } from '../src/main/fleet/sources'
import { createFleetService } from '../src/main/fleet/service'

export const NOW = 1_800_000_000_000

export const GIT = { isRepo: true, root: '/work/invented', branch: 'main', dirty: false, ahead: 0, behind: 0 }

const at = { position: { x: 0, y: 0 }, size: { width: 100, height: 100 } }

export const terminal = (id: string, name: string, command: string, extra: Record<string, unknown> = {}): CanvasNode => ({
  kind: 'terminal',
  id,
  name,
  preset: command || 'shell',
  command,
  cwd: '/work/invented',
  orch: false,
  role: null,
  ...at,
  ...extra
})

export const note = (id: string, content: string): CanvasNode => ({ kind: 'note', id, name: id, customName: null, content, locked: false, ...at })

export const browser = (id: string, name: string, urls: string[]): CanvasNode => ({
  kind: 'browser',
  id,
  name,
  url: urls[0],
  tabs: urls.map((url, i) => ({ id: `${id}-t${i}`, url, title: '' })),
  activeTabId: `${id}-t0`,
  ...at
})

const wire = (id: string, a: string, b: string): Connection => ({ id, a, b })

export const PROFILE: MachineProfile = {
  kind: 'desktop',
  model: 'Mac14,12',
  label: 'Mac mini (2023)',
  vendor: 'Apple',
  os: 'darwin',
  osVersion: 'macOS 26.1',
  arch: 'arm64',
  cpus: 12,
  memoryGb: 32,
  evidence: ['hw.model=Mac14,12', 'battery=absent']
}

export const activity = (terminalId: string, phase: TerminalActivity['phase'], extra: Partial<TerminalActivity> = {}): TerminalActivity => ({
  terminalId,
  agent: true,
  phase,
  prompt: null,
  pendingInput: null,
  lines: [],
  reply: null,
  glance: null,
  title: null,
  turnCount: 0,
  turnStartLine: null,
  scrollRow: null,
  tailLines: null,
  scrollBase: null,
  turnStartedAt: null,
  dispatchId: null,
  updatedAt: NOW,
  ...extra
})

export function fakeDesktop(options: { traits?: FleetRuntime['traits'] } = {}) {
  let metas: WorkspaceMeta[] = [
    { id: 'w1', name: 'Alpha Kitchen', dir: '/work/a', dirs: ['/work/a'], icon: '🍳', slug: 'alpha' },
    { id: 'w2', name: 'Beta Garden', dir: '/work/b', dirs: ['/work/b'], icon: '', slug: 'beta' }
  ]
  let states: Record<string, WorkspaceState> = {
    w1: {
      name: 'Alpha Kitchen',
      dir: '/work/a',
      dirs: ['/work/a'],
      nodes: [
        terminal('a1', 'Ada', 'claude --session-id x', { orch: true, brief: 'Own the invented loader' }),
        terminal('a2', 'Basil', ''),
        note('n1', '# Team plan\n\nsteps'),
        browser('b1', 'PR', ['https://github.com/acme/app/pull/1?secret=1#frag', 'https://docs.example.dev/q']),
        note('n2', 'Loose scratch')
      ],
      connections: [wire('c1', 'n1', 'a1'), wire('c2', 'a1', 'b1'), wire('c3', 'a2', 'n1')]
    },
    w2: {
      name: 'Beta Garden',
      dir: '/work/b',
      dirs: ['/work/b'],
      nodes: [
        terminal('g1', 'Cleo', 'codex', {
          cwd: '/work/beta',
          servedSession: { origin: 'https://door.example.dev', slug: 'invented-team', openedAt: NOW - 3600_000 }
        }),
        browser('b2', 'Preview', ['http://localhost:5280/'])
      ],
      connections: [wire('c4', 'g1', 'b2')]
    }
  }
  let focused = 'w1'
  // defineProperty, not Object.assign: assign would copy the getter's value once.
  const store = Object.defineProperty(
    Object.assign(new EventEmitter(), {
      list: () => ({ workspaces: metas, activeId: focused }),
      workspaceState: (id: string) => states[id]
    }),
    'focusedId',
    { get: () => focused }
  )
  let live: TerminalActivity[] = [
    activity('a1', 'thinking', {
      prompt: 'Rename the invented helper',
      turnStartedAt: NOW - 30_000,
      glance: { status: '✻ Simmering… (30s · ↓ 1k tokens)', tools: [], message: 'Looking at the helper now' }
    })
  ]
  let probe = new Map<string, BoardPhase>([['g1', 'working']])
  const ledger = new Map<string, TurnRecord[]>([
    [
      'a2',
      [
        { index: 1, prompt: 'Tidy the invented dotfiles', reply: 'Tidied.\nMore', startedAt: NOW - 90_000, endedAt: NOW - 80_000, seenAt: NOW },
        {
          index: 2,
          prompt: 'This session is being continued from a previous conversation that ran out of context.',
          reply: 'Picked it back up',
          startedAt: NOW - 60_000,
          endedAt: NOW - 50_000
        }
      ]
    ]
  ])
  let probeHolds = 0
  const probeListeners = new Set<() => void>()
  const board: BoardSources = {
    activeWorkspaceId: () => focused,
    live: () => live,
    ledger: () => ledger,
    registry: () => [],
    probe: () => probe,
    probeSubscribe: () => {
      probeHolds += 1
      return () => void (probeHolds -= 1)
    },
    probeOnChange: (listener) => {
      probeListeners.add(listener)
      return () => void probeListeners.delete(listener)
    }
  }
  const turns = new EventEmitter()
  const tuningBus = new EventEmitter()
  const clock = { now: NOW }
  let fleetReads = 0
  const sources = levelsSourcesFrom({
    store: store as unknown as WorkspaceStore,
    board,
    turns,
    tuning: {
      fleet: () => {
        fleetReads += 1
        return { a1: { model: 'anthropic/claude-opus-5-5', effort: 'high', at: NOW } }
      }
    },
    tuningBus,
    machine: { name: () => 'Invented studio', appVersion: '0.3.0', profile: () => PROFILE },
    now: () => clock.now,
    // Only Alpha's cwd has a cached git answer; Beta's has none and must not get one.
    traits: options.traits
  })
  const service = createFleetService({ ...sources, now: () => clock.now }, 30)
  return {
    service,
    store,
    turns,
    clock,
    probeHolds: () => probeHolds,
    tuningBus,
    fleetReads: () => fleetReads,
    setProbe: (next: Map<string, BoardPhase>) => {
      probe = next
      probeListeners.forEach((listener) => listener())
    },
    setLive: (next: TerminalActivity[]) => {
      live = next
      turns.emit('activity', {})
    },
    rename: (id: string, name: string) => {
      metas = metas.map((m) => (m.id === id ? { ...m, name } : m))
      store.emit('workspaces', store.list())
    },
    focus: (id: string) => {
      focused = id
      store.emit('switch', { previousTerminalIds: [] })
    },
    removeAgent: (workspaceId: string, agentId: string) => {
      const state = states[workspaceId]
      states = {
        ...states,
        [workspaceId]: {
          ...state,
          nodes: state.nodes.filter((n) => n.id !== agentId),
          connections: state.connections.filter((c) => c.a !== agentId && c.b !== agentId)
        }
      }
      store.emit('workspace-change', { workspaceId, state: states[workspaceId] })
    }
  }
}
