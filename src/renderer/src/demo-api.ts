import type {
  CanvasNode,
  Connection,
  WorkspaceList,
  WorkspaceMeta,
  WorkspaceState
} from '../../shared/model'
import { noteNameFromContent, uniqueName } from '../../shared/model'
import type { CookrewApi } from './api'
import type { CardRouteState, RouteDecision, RouteState } from '../../shared/route'

/**
 * Browser demo backend: when the renderer runs outside Electron (plain
 * browser tab, or an embedded browser node) there is no preload bridge,
 * no PTYs and no socket. This mock keeps the whole canvas interactive with
 * an in-memory workspace and a simulated shell.
 */

const DEMO_PROMPT = '\x1b[32m➜\x1b[0m \x1b[36mdemo\x1b[0m $ '

/**
 * Extra terminal cards for the zoom-latency harness (scratchpad/zoom-latency):
 * `?demoCards=60` lays 60 more cards on the real grid pitch so a click-to-live
 * measurement runs against a canvas the size of the owner's, not three nodes.
 * Absent from the URL, this is empty and the demo is unchanged.
 */
function benchCards(): CanvasNode[] {
  if (typeof location === 'undefined') return []
  const count = Number(new URLSearchParams(location.search).get('demoCards') ?? 0)
  if (!Number.isFinite(count) || count <= 0) return []
  return Array.from({ length: Math.min(count, 400) }, (_, i) => ({
    kind: 'terminal',
    id: `demo-bench-${i}`,
    name: `Bench ${i}`,
    preset: 'Shell',
    command: '',
    cwd: '~',
    orch: false,
    role: null,
    position: { x: 340 + (i % 8) * 600, y: 560 + Math.floor(i / 8) * 560 },
    size: { width: 560, height: 560 }
  }))
}

function demoWorkspace(): WorkspaceState {
  const conductor: CanvasNode = {
    kind: 'terminal',
    id: 'demo-conductor',
    name: 'Conductor',
    preset: 'Shell',
    command: '',
    cwd: '~',
    orch: true,
    role: null,
    position: { x: 340, y: 120 },
    size: { width: 560, height: 360 }
  }
  const note: CanvasNode = {
    kind: 'note',
    id: 'demo-note',
    name: 'welcome-to-cookrew',
    customName: null,
    content:
      '# Welcome to Cookrew\n\nThis is the **browser demo** of Cookrew Desktop.\n\n- drag nodes by their headers\n- double-click me to edit\n- type in the terminal\n- use the toolbar to add nodes\n\nThe real app runs on Electron with live PTYs, a Unix-socket `cookrew` CLI, browsers and routines.',
    locked: false,
    position: { x: 40, y: 150 },
    size: { width: 260, height: 260 }
  }
  const browser: CanvasNode = {
    kind: 'browser',
    id: 'demo-browser',
    name: 'Browser',
    url: 'https://example.com',
    position: { x: 960, y: 140 },
    size: { width: 560, height: 420 }
  }
  return {
    name: 'Cookrew Demo',
    dir: '~',
    dirs: ['~'],
    nodes: [conductor, note, browser, ...benchCards()],
    connections: [
      { id: 'demo-c1', a: 'demo-conductor', b: 'demo-note' },
      { id: 'demo-c2', a: 'demo-conductor', b: 'demo-browser' }
    ]
  }
}

const DEMO_RESPONSES: Record<string, string> = {
  help: 'cookrew demo shell — try: help, list, about, clear',
  list: 'You:\r\n  - name: "Conductor", orch: true\r\n\r\nConnected notes:\r\n  - name: "welcome-to-cookrew"\r\nConnected browsers:\r\n  - name: "Browser"',
  about: 'Cookrew — open-source spatial workspace for AI agents. Electron + React Flow + xterm.js + node-pty.\r\nThis browser demo simulates the shell; the desktop app runs real PTYs.'
}

/** Connections minted so far — the tie-breaker that keeps demo ids unique within a millisecond. */
let demoConnections = 0

export function createDemoApi(): CookrewApi {
  // In-memory workspace registry so the demo can switch canvases too.
  const metas: WorkspaceMeta[] = [
    { id: 'demo-ws', name: 'Cookrew Demo', dir: '~', dirs: ['~'], icon: '🗂' }
  ]
  const states = new Map<string, WorkspaceState>([['demo-ws', demoWorkspace()]])
  let activeId = 'demo-ws'
  // A counter beside the clock: two workspaces made in the same millisecond
  // (a fixture seeding several at boot) must not share an id, or switching to
  // one lands on the other. Connection ids learned this the same way.
  let minted = 0
  const mintId = (): string => `demo-ws-${Date.now()}-${++minted}`
  let state = states.get(activeId)!

  const stateListeners = new Set<(s: WorkspaceState) => void>()
  const wsListeners = new Set<(l: WorkspaceList) => void>()
  const ptyListeners = new Map<string, (data: string) => void>()
  const lineBuffers = new Map<string, string>()
  // Signals on the cables, with no main behind them: a fixture page (the
  // harness preview, QA) puts one on a cable through `window.__cableSignal`.
  const signalListeners = new Set<(signal: unknown) => void>()
  // The route program's fixture: a gateway online with three providers, a
  // smart group as the default, two decisions in flight — enough for the
  // harness view to draw the panel and the rail's RTE dial without a main.
  const routeLive: RouteDecision[] = [
    { terminalId: 'card-0', session: 'cookrew:card-0', seq: 3, asked: 'group/smart', group: 'group/smart', model: 'claude/claude-sonnet-5-5', effort: 'high', tries: 1, done: false, status: null, at: Date.now() - 4000, ttftMs: 820, ms: null },
    { terminalId: 'card-1', session: 'cookrew:card-1', seq: 7, asked: 'group/smart', group: 'group/smart', model: 'deepseek/deepseek-chat', effort: null, tries: 2, done: true, status: '200', at: Date.now() - 12000, ttftMs: 410, ms: 6200 }
  ]
  let routeDefault: string | null = 'group/smart'
  const routeState = (): RouteState => ({
    status: 'online',
    gateway: { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', port: 3425, version: '0.1.1182', source: 'plugin' },
    why: null,
    defaultModel: routeDefault,
    providers: 3,
    models: [
      { id: 'group/smart', displayName: 'smart', ownedBy: 'magpie', group: true, reasoning: true, levels: ['low', 'high'], contextWindow: null },
      { id: 'claude/claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', ownedBy: 'claude', group: false, reasoning: true, levels: ['low', 'medium', 'high'], contextWindow: 1000000 },
      { id: 'deepseek/deepseek-chat', displayName: 'DeepSeek Chat', ownedBy: 'deepseek', group: false, reasoning: false, levels: [], contextWindow: 128000 },
      { id: 'ollama/qwen3', displayName: 'qwen3', ownedBy: 'ollama', group: false, reasoning: false, levels: [], contextWindow: 32768 }
    ],
    quotas: [
      { provider: 'claude', account: 'owner@example.com', alias: null, plan: 'max', kind: 'subscription', windows: [{ name: '5h', used: 12, limit: 100, resetsAt: Date.now() + 3600_000, display: '12 / 100' }], last: true, error: null },
      { provider: 'deepseek', account: null, alias: null, plan: null, kind: 'key', windows: [], last: false, error: null },
      { provider: 'ollama', account: null, alias: null, plan: null, kind: 'local', windows: [], last: false, error: null }
    ],
    live: routeLive,
    harnesses: [
      { id: 'claude', name: 'Claude Code', installed: true, signedIn: true, inDock: true, installLine: 'npm i -g @anthropic-ai/claude-code', loginLine: 'claude' },
      { id: 'codex', name: 'Codex', installed: true, signedIn: false, inDock: true, installLine: 'npm i -g @openai/codex', loginLine: 'codex login' },
      { id: 'opencode', name: 'OpenCode', installed: false, signedIn: null, inDock: true, installLine: 'curl -fsSL https://opencode.ai/install | bash', loginLine: 'opencode auth login' },
      { id: 'pi', name: 'Pi', installed: true, signedIn: null, inDock: true, installLine: 'npm i -g @earendil-works/pi-coding-agent', loginLine: null }
    ],
    checkedAt: Date.now(),
    setup: {
      installLine: 'curl -fsSL https://usemagpie.ai/install.sh | sh',
      serveLine: 'magpie autostart on',
      pluginLine: "magpie plugin add '/Applications/Cookrew Dev.app/Contents/Resources/magpie'",
      addSubscriptionLine: 'magpie accounts add codex',
      addKeyLine: 'magpie provider add ',
      addLocalLine: 'magpie provider add ollama',
      addGroupLine: 'magpie group add smart models=claude/claude-sonnet-5-5,deepseek/deepseek-chat routing=smart'
    }
  })
  const cardRoutes = new Map<string, string>()
  const cardRoute = (terminalId: string): CardRouteState => {
    const route = cardRoutes.get(terminalId) ?? routeDefault ?? 'direct'
    return {
      route,
      effective: route,
      appliesOn: 'now',
      live: routeLive.find((d) => d.terminalId === terminalId) ?? null,
      turn: terminalId === 'card-1' ? { model: 'deepseek/deepseek-chat', inputTokens: 1840, outputTokens: 312, cost: 0.0021, priced: true, at: Date.now() - 11000 } : null,
      offline: false,
      note: null,
      gateway: 'online'
    }
  }
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __cableSignal?: (moment: unknown) => void }).__cableSignal = (moment) => {
      const frame = { at: Date.now(), ...(typeof moment === 'object' && moment !== null ? moment : {}) }
      for (const listener of signalListeners) listener(frame)
    }
  }

  const broadcast = (next: WorkspaceState): void => {
    state = next
    states.set(activeId, next)
    for (const listener of stateListeners) listener(state)
  }
  const wsBroadcast = (): void => {
    const list = { workspaces: metas, activeId }
    for (const listener of wsListeners) listener(list)
  }

  const api: CookrewApi = {
    // The demo has no Ollama behind it. Say that, rather than hand back
    // untranslated text and let it read as a translation that did nothing.
    translateHost: () => Promise.resolve(null),
    translateCheckpoint: () => Promise.resolve({ ok: false as const, failure: 'disabled' as const }),
    getWorkspace: () => Promise.resolve(state),
    onWorkspaceState: (cb) => {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
    listWorkspaces: () => Promise.resolve({ workspaces: metas, activeId }),
    createWorkspace: (name, dir) => {
      const wsDir = dir.trim() || '~'
      const meta: WorkspaceMeta = {
        id: mintId(),
        name: uniqueName(name.trim() || 'Workspace', metas.map((m) => m.name)),
        dir: wsDir,
        dirs: [wsDir],
        icon: '🗂'
      }
      metas.push(meta)
      states.set(meta.id, {
        name: meta.name,
        dir: meta.dir,
        dirs: [wsDir],
        nodes: [],
        connections: []
      })
      states.set(activeId, state)
      activeId = meta.id
      broadcast(states.get(activeId)!)
      wsBroadcast()
      return Promise.resolve(meta)
    },
    templateImport: (team) =>
      Promise.resolve({ id: mintId(), name: `${team} · session`, dir: '~', dirs: ['~'], icon: '🗂' }),
    switchWorkspace: (id) => {
      if (states.has(id)) {
        states.set(activeId, state)
        activeId = id
        broadcast(states.get(activeId)!)
        wsBroadcast()
      }
      return Promise.resolve({ workspaces: metas, activeId })
    },
    renameWorkspace: (id, name) => {
      const meta = metas.find((m) => m.id === id)
      if (meta) {
        meta.name = name
        if (id === activeId) broadcast({ ...state, name })
        wsBroadcast()
      }
      return Promise.resolve({ workspaces: metas, activeId })
    },
    // Workspace v2 stubs: the demo has one in-memory dir, no git, no picker.
    removeWorkspace: () => Promise.resolve({ workspaces: metas, activeId }),
    addWorkspaceDir: () => Promise.resolve({ workspaces: metas, activeId }),
    removeWorkspaceDir: () => Promise.resolve({ workspaces: metas, activeId }),
    setPrimaryDir: () => Promise.resolve({ workspaces: metas, activeId }),
    setTerminalCwd: (nodeId) =>
      Promise.resolve(state.nodes.find((n) => n.id === nodeId) as CanvasNode),
    pickDir: () => Promise.resolve(null),
    gitInfo: () => Promise.resolve(null),
    // No git in the demo: no lanes to list, nothing to land.
    laneList: () => Promise.resolve([]),
    laneOpen: () => Promise.reject(new Error('Lanes need a git repo — not in the demo')),
    laneLand: () => Promise.resolve({ ok: false as const, reason: 'not-a-lane' as const, detail: 'not in the demo' }),
    laneClose: () => Promise.reject(new Error('Lanes need a git repo — not in the demo')),
    laneAuto: (nodeId) => Promise.resolve(state.nodes.find((n) => n.id === nodeId) as CanvasNode),
    onWorkspaceList: (cb) => {
      wsListeners.add(cb)
      return () => wsListeners.delete(cb)
    },
    addNode: (node) => {
      const typed = node as CanvasNode
      const named = {
        ...typed,
        name: uniqueName(typed.name, state.nodes.map((n) => n.name))
      } as CanvasNode
      broadcast({ ...state, nodes: [...state.nodes, named] })
      return Promise.resolve(named)
    },
    updateNode: (id, patch) => {
      let updated: CanvasNode | undefined
      const nodes = state.nodes.map((n) => {
        if (n.id !== id) return n
        updated = { ...n, ...(patch as Partial<CanvasNode>) } as CanvasNode
        if (updated.kind === 'note' && typeof (patch as { content?: string }).content === 'string' && !updated.customName) {
          updated = {
            ...updated,
            name: uniqueName(
              noteNameFromContent(updated.content),
              state.nodes.filter((o) => o.id !== id).map((o) => o.name)
            )
          }
        }
        return updated
      })
      if (updated) broadcast({ ...state, nodes })
      return Promise.resolve(updated)
    },
    removeNode: (id) => {
      broadcast({
        ...state,
        nodes: state.nodes.filter((n) => n.id !== id),
        connections: state.connections.filter((c) => c.a !== id && c.b !== id)
      })
      return Promise.resolve()
    },
    connectNodes: (a, b) => {
      // A clock alone is not an id: a fixture that seeds a board wires hundreds
      // of cables inside one millisecond, and duplicate ids collide in every
      // consumer keyed on them — React keys included, which made a harness
      // layer grow on each re-render (harness-preview, 2026-09-27).
      const conn: Connection = { id: `demo-${Date.now()}-${++demoConnections}`, a, b }
      broadcast({ ...state, connections: [...state.connections, conn] })
      return Promise.resolve(conn)
    },
    disconnect: (connId) => {
      broadcast({ ...state, connections: state.connections.filter((c) => c.id !== connId) })
      return Promise.resolve()
    },
    listPins: () => Promise.resolve([]),
    listPresets: () =>
      Promise.resolve([
        { name: 'Claude Code', command: 'claude --permission-mode bypassPermissions' },
        { name: 'Codex', command: 'codex' },
        { name: 'OpenCode', command: 'opencode' },
        { name: 'Pi', command: 'pi' },
        { name: 'Shell', command: '' }
      ]),
    createTerminal: (opts) => {
      const options = opts as { name: string; preset: string; position: { x: number; y: number }; orch: boolean }
      const terminal: CanvasNode = {
        kind: 'terminal',
        id: `demo-term-${Date.now()}`,
        name: uniqueName(options.name, state.nodes.map((n) => n.name)),
        preset: options.preset,
        command: '',
        cwd: '~',
        orch: options.orch,
        role: null,
        position: options.position,
        size: { width: 560, height: 360 }
      }
      broadcast({ ...state, nodes: [...state.nodes, terminal] })
      return Promise.resolve(terminal)
    },

    // No filesystem in the demo tab — attachments are a no-op.
    attachFiles: () => Promise.resolve([]),
    saveAttachmentBytes: () => Promise.resolve(''),
    pickFiles: () => Promise.resolve([]),

    ptyInput: (terminalId, data) => {
      const out = ptyListeners.get(terminalId)
      if (!out) return
      let buffer = lineBuffers.get(terminalId) ?? ''
      for (const char of data) {
        if (char === '\r') {
          const line = buffer.trim()
          buffer = ''
          const reply = line === 'clear'
            ? '\x1b[2J\x1b[H'
            : line.length > 0
              ? `\r\n${DEMO_RESPONSES[line] ?? `demo: simulated shell — '${line}' is not wired up (try 'help')`}`
              : ''
          out(`${reply}\r\n${DEMO_PROMPT}`)
        } else if (char === '\x7f') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1)
            out('\b \b')
          }
        } else {
          buffer += char
          out(char)
        }
      }
      lineBuffers.set(terminalId, buffer)
    },
    ptyResize: () => undefined,
    ptyJump: () => undefined,
    turnSeen: () => undefined,
    ptyAttach: (terminalId, onData) => {
      ptyListeners.set(terminalId, onData)
      setTimeout(() => {
        onData(
          `\x1b[90mCookrew browser demo — simulated shell (the desktop app runs real PTYs)\x1b[0m\r\n${DEMO_PROMPT}`
        )
      }, 100)
      return () => ptyListeners.delete(terminalId)
    },

    listActivity: () => Promise.resolve([]),
    onTerminalActivity: () => () => undefined,
    routeState: () => Promise.resolve(routeState()),
    routeSetDefault: (model) => {
      routeDefault = model
      return Promise.resolve(routeState())
    },
    terminalRoute: (terminalId) => Promise.resolve(cardRoute(terminalId)),
    terminalRouteSet: (terminalId, route) => {
      cardRoutes.set(terminalId, route)
      return Promise.resolve(cardRoute(terminalId))
    },
    onRoute: () => () => undefined,
    onCardRoute: () => () => undefined,
    onCableSignal: (cb) => {
      signalListeners.add(cb)
      return () => {
        signalListeners.delete(cb)
      }
    },

    // The demo shell has no turn tracking; forking degrades to a plain clone
    // so the canvas interaction still demonstrates the lineage edge.
    listTurns: () => Promise.resolve([]),
    teamFork: () => Promise.reject(new Error('Team fork needs the desktop app')),
    teamSave: () => Promise.reject(new Error('Team save needs the desktop app')),
    teamList: () => Promise.resolve([]),
    roleList: () => Promise.resolve([]),
    forkTerminal: (sourceId) => {
      const source = state.nodes.find((n) => n.id === sourceId)
      if (!source || source.kind !== 'terminal') {
        return Promise.reject(new Error('Fork source is not a terminal node'))
      }
      const fork: CanvasNode = {
        ...source,
        id: `demo-fork-${Date.now()}`,
        name: uniqueName(`${source.name} ⑂`, state.nodes.map((n) => n.name)),
        orch: false,
        forkOf: { sourceId: source.id, sourceName: source.name, turnIndex: 1 },
        position: {
          x: source.position.x + source.size.width + 80,
          y: source.position.y + 80
        }
      }
      const conn: Connection = { id: `demo-fork-conn-${Date.now()}`, a: source.id, b: fork.id }
      broadcast({
        ...state,
        nodes: [...state.nodes, fork],
        connections: [...state.connections, conn]
      })
      return Promise.resolve(fork)
    },

    onBrowserCommand: () => () => undefined,
    browserResult: () => undefined,
    browserThumb: () => undefined,
    interactiveBrowserEnabled: () => Promise.resolve(false),
    browserStreamToken: () => Promise.resolve(null),
    onBrowserOpenTab: () => () => undefined,
    onBrowserPhoneViewing: () => () => undefined,
    onCmdW: () => () => undefined,
    // No Sous in the demo: nothing to drive, so every sentence is `none`.
    sousCommand: () => Promise.resolve({ intent: 'none' as const, spoken: '' }),
    onUiCommand: () => () => undefined,
    listenAvailable: () => Promise.resolve(false),
    listenStart: () => Promise.resolve(false),
    listenStop: () => Promise.resolve(),
    onListenEvent: () => () => undefined,
    // No OS hands this surface a link: the phone and the demo are reached by
    // one, never launched by one.
    onDeepLink: () => () => undefined,

    // R30 serving. Owner-desktop surfaces: this transport cannot mount them,
    // and a stub that pretended to succeed would publish nothing while telling
    // the user it had. It refuses, visibly.
    servingServe: async () => ({ ok: false as const, reason: 'desktop-only' }),
    servingStop: async () => ({ ok: false }),
    servingPaymentStatus: async () => ({ x402: { ready: false }, stripe: { ready: false } }),
    servingSetPayTo: async () => ({ ok: false as const, reason: 'write-failed' as const }),
    servingSetStripeSecret: async () => ({ ok: false as const, reason: 'write-failed' as const }),
    servingList: async () => [],
    servingSessions: async () => [],
    servingEnd: async () => ({ stopped: 0 }),
    serveInspect: async () => ({ ok: false as const, reason: 'desktop-only' }),
    // Same refusal as inspect: importing a served team places a terminal, and
    // a phone has none to place.
    serveBrowse: async () => ({ ok: false as const, reason: 'desktop-only' }),
    serveImport: async () => ({ ok: false as const, reason: 'desktop-only' }),
    serveGate: async () => ({ ok: false as const, reason: 'desktop-only' }),
    serveCheckout: async () => ({ ok: false as const, reason: 'desktop-only' }),
    serveSettle: async () => ({ ok: false as const, reason: 'desktop-only' }),
    /** The demo has no compositor behind it and photographs nothing. */
    snapWorkspace: async () => false,
    workspaceShots: async () => ({}),
    quitApp: () => undefined
  }
  return api
}
