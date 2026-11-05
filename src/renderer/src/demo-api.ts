import type { CardRouteState, RouteState } from '../../shared/route'
import { cardRouteFixture, routeFixture } from '../../shared/route-fixture'
import type {
  CanvasNode,
  Connection,
  WorkspaceList,
  WorkspaceMeta,
  WorkspaceState
} from '../../shared/model'
import { noteNameFromContent, uniqueName } from '../../shared/model'
import { rankInbox } from '../../shared/inbox-rank'
import { checkBrief } from '../../shared/workspace-brief'
import { planRename } from '../../shared/rename-plan'
import type { Alternate } from '../../shared/sous-decide'
import type { CookrewApi } from './api'
import { freshDemoApi, freshMode } from './demo-first-run'

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

const demoSecrets = new Map<string, { name: string; served: boolean; updatedAt: number }>()

export function createDemoApi(): CookrewApi {
  // In-memory workspace registry so the demo can switch canvases too.
  const search = typeof location === 'undefined' ? '' : location.search
  const fresh = freshMode(search)
  const metas: WorkspaceMeta[] = [
    { id: 'demo-ws', name: fresh ? 'My Workspace' : 'Cookrew Demo', dir: '~', dirs: ['~'], icon: '🗂' }
  ]
  const states = new Map<string, WorkspaceState>([['demo-ws', fresh ? { ...demoWorkspace(), name: 'My Workspace', nodes: [], connections: [] } : demoWorkspace()]])
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
  // Magpie routing with no gateway behind it: the online fixture, switchable
  // from a fixture page through `window.__routeStatus('absent'|'offline'|'online')`
  // so the Routing panel's states can be photographed.
  let route: RouteState = routeFixture('online')
  const routeListeners = new Set<(state: RouteState) => void>()
  const sousUpdateListeners = new Set<(update: { token: string; alternates: Alternate[] }) => void>()
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __sousRevise?: (token: string, alternates: Alternate[]) => void }).__sousRevise = (token, alternates) => {
      for (const listener of sousUpdateListeners) listener({ token, alternates })
    }
  }
  const cardRoutes = new Map<string, CardRouteState>()
  const cardRouteListeners = new Set<(row: { terminalId: string } & CardRouteState) => void>()
  const routeChanged = (): void => {
    for (const listener of routeListeners) listener(route)
  }
  // A read that answers late, with the state as it was when asked — the
  // companion's GET through a slow link, for the fixture's race test.
  let routeReadLagMs = 0
  if (typeof window !== 'undefined') {
    const hooks = window as unknown as { __routeStatus?: (status: RouteState['status']) => void; __routePush?: () => void; __routeReadLag?: (ms: number) => void; __routeAuto?: (on: boolean) => void }
    hooks.__routeStatus = (status) => {
      route = routeFixture(status)
      routeChanged()
    }
    // The same state, pushed again — what main does after any probe.
    hooks.__routePush = () => routeChanged()
    hooks.__routeReadLag = (ms) => {
      routeReadLagMs = ms
    }
    // The local tier offered (the script's printed command on the setup lines, group/auto in the catalog) or not.
    hooks.__routeAuto = (on) => {
      route = on
        ? {
            ...route,
            models: route.models.some((m) => m.id === 'group/auto') ? route.models : [{ id: 'group/auto', displayName: 'auto', ownedBy: 'magpie', group: true, reasoning: false, levels: [], contextWindow: null }, ...route.models],
            setup: { ...route.setup, addAutoGroupLine: 'magpie group add auto models=ollama/qwen3:32b,ollama/qwen2.5:1.5b routing=smart stays=turn' }
          }
        : { ...route, models: route.models.filter((m) => m.id !== 'group/auto'), setup: { ...route.setup, addAutoGroupLine: null } }
      routeChanged()
    }
  }
  // Signals on the cables, with no main behind them: a fixture page (the
  // harness preview, QA) puts one on a cable through `window.__cableSignal`.
  const signalListeners = new Set<(signal: unknown) => void>()
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

  let telemetry = { on: false, locked: false }
  const api: CookrewApi = {
    telemetryStatus: async () => telemetry,
    setTelemetry: async (on) => {
      telemetry = { ...telemetry, on }
      return telemetry
    },
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
    setWorkspaceBrief: (id, brief) => {
      const checked = checkBrief(brief)
      if (!checked.ok) return Promise.reject(new Error(checked.reason))
      const at = metas.findIndex((m) => m.id === id)
      if (at < 0) return Promise.reject(new Error(`Workspace '${id}' not found`))
      const { brief: _previous, ...rest } = metas[at]
      metas[at] = checked.brief ? { ...rest, brief: checked.brief } : rest
      wsBroadcast()
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
    // The sealed slots, in memory: the harness view draws the block with a
    // store that forgets on reload and never had a file.
    secretPut: (name, _value, served) => {
      const row = { name, served, updatedAt: Date.now() }
      demoSecrets.set(name, row)
      return Promise.resolve(row)
    },
    secretList: () => Promise.resolve([...demoSecrets.values()]),
    secretRemove: (name) => Promise.resolve(demoSecrets.delete(name)),
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
    // Planned as the main process plans it (shared/rename-plan.ts): a clash refused, a note's name pinned.
    renameNode: (id, name) => {
      const node = state.nodes.find((n) => n.id === id)
      if (!node) return Promise.resolve({ ok: false as const, error: 'That card is not on any canvas.' })
      const plan = planRename({ id, current: node.name, wanted: name, siblings: state.nodes, onClash: 'refuse' })
      if (plan.ok) {
        const pin: Partial<CanvasNode> = node.kind === 'note' ? { customName: plan.name } : node.kind === 'terminal' ? { nameByHand: true } : {}
        broadcast({ ...state, nodes: state.nodes.map((n) => (n.id === id ? ({ ...n, name: plan.name, ...pin } as CanvasNode) : n)) })
      }
      return Promise.resolve(plan)
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
    readImage: () => Promise.resolve(null),
    pickFiles: () => Promise.resolve([]),

    answerMenu: async () => ({ ok: false, reason: 'refused' }),
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
    routeState: () => {
      const asked = route
      return routeReadLagMs > 0 ? new Promise((resolve) => setTimeout(() => resolve(asked), routeReadLagMs)) : Promise.resolve(asked)
    },
    routeSetDefault: (model) => {
      route = { ...route, defaultModel: model }
      routeChanged()
      return Promise.resolve(route)
    },
    routeSetSharedMcp: (on) => {
      route = { ...route, sharedMcp: on }
      routeChanged()
      return Promise.resolve(route)
    },
    terminalRoute: (terminalId) =>
      Promise.resolve(
        cardRoutes.get(terminalId) ??
          cardRouteFixture(route.status === 'online' ? {} : { route: 'direct', effective: null, live: null, turn: null, offline: route.status === 'offline' })
      ),
    terminalRouteSet: (terminalId, next) => {
      const row = cardRouteFixture({ route: next, effective: next === 'direct' ? null : next, appliesOn: 'restart', live: null, turn: null, offline: false })
      cardRoutes.set(terminalId, row)
      for (const listener of cardRouteListeners) listener({ terminalId, ...row })
      return Promise.resolve(row)
    },
    onRoute: (cb) => {
      routeListeners.add(cb)
      return () => {
        routeListeners.delete(cb)
      }
    },
    onCardRoute: (cb) => {
      cardRouteListeners.add(cb)
      return () => {
        cardRouteListeners.delete(cb)
      }
    },
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
    // Sous in the demo DECIDES but never drives: a sentence comes back as the
    // decision the box would show (so the harness view renders the echo),
    // and a commit answers as if the brief went out. Nothing is created.
    sousCommand: (text) => {
      const sentence = text.trim()
      if (sentence === '' || /\?|？$/.test(sentence)) {
        return Promise.resolve({ intent: 'none' as const, spoken: '' })
      }
      const recruit = /\b(every|all|refactor|audit|prune)\b|全部|所有|重构/i.test(sentence)
      const decision = recruit
        ? {
            kind: 'recruit' as const,
            harness: 'Codex' as const,
            name: sentence.split(/\s+/).slice(0, 3).join(' '),
            beside: { id: 'demo-conductor', name: 'Conductor' },
            alternates: [
              { kind: 'recruit' as const, id: 'harness:Claude Code', name: 'Claude Code', harness: 'Claude Code' as const, reasons: ['Claude Code instead'] },
              { kind: 'ask' as const, id: 'demo-bench-0', name: 'Bench 0', reasons: ['idle', 'same repo', 'no word matched · 2h'] }
            ],
            reasons: ['no idle card fits the brief', 'repo-wide → Codex', 'beside Conductor, wired to it'],
            direct: true,
            cwd: 'repo' as const,
            token: 'demo-decision',
            holdMs: 2500,
            sentence,
            mode: 'paused' as const,
            exposure: 2 as const,
            exposureWhy: 'touches every file in the repo',
            boundaries: 'push only after the check passes',
            domain: 'repo' as const,
            route: { route: 'group/smart', effective: null }
          }
        : {
            kind: 'ask' as const,
            target: { id: 'demo-conductor', name: 'Conductor' },
            alternates: [
              { kind: 'ask' as const, id: 'demo-bench-0', name: 'Bench 0', reasons: ['idle', 'same repo', 'last touched the bench'] },
              { kind: 'recruit' as const, id: 'harness:Claude Code', name: 'Claude Code', harness: 'Claude Code' as const, reasons: ['a brief with no shape → Claude Code'] }
            ],
            reasons: ['idle', 'same repo', 'last touched README · 2h'],
            recruit: { harness: 'Claude Code' as const, name: sentence.split(/\s+/).slice(0, 3).join(' '), beside: { id: 'demo-conductor', name: 'Conductor' }, direct: true },
            token: 'demo-decision',
            holdMs: 2500,
            sentence,
            mode: 'ticking' as const,
            exposure: 1 as const,
            exposureWhy: null,
            boundaries: null,
            domain: 'repo' as const,
            route: { route: 'group/smart', effective: 'deepseek/deepseek-v4' }
          }
      const spoken = decision.kind === 'ask' ? `→ Conductor (${decision.reasons.join(' · ')})` : `+ Codex card · ${decision.name} (${decision.reasons.join(' · ')})`
      return Promise.resolve({ intent: 'decide' as const, spoken, decision })
    },
    sousCommit: (_token, choice) =>
      Promise.resolve({ intent: 'ask' as const, spoken: `Sent to ${choice?.target === 'demo-bench-0' ? 'Bench 0' : 'Conductor'}`, agentId: choice?.target ?? 'demo-conductor' }),
    sousCancel: () => Promise.resolve(true),
    // HP: a fixture page pushes a late revision through `window.__sousRevise(token, alternates)`.
    onSousDecisionUpdated: (cb) => {
      sousUpdateListeners.add(cb)
      return () => {
        sousUpdateListeners.delete(cb)
      }
    },
    inboxAct: () => Promise.resolve({ ok: true }),
    inboxDismiss: () => Promise.resolve({ ok: true }),
    onUiCommand: () => () => undefined,
    // The inbox the harness view renders: one of each signal, on the demo's own cards.
    inbox: () =>
      Promise.resolve(
        rankInbox(
          [
            { kind: 'waiting', nodeId: 'demo-conductor', nodeName: 'Conductor', nodeKind: 'terminal', workspaceId: 'demo', workspaceName: 'Cookrew Demo', reason: 'asks you — "replace the Chinese headings too?"', since: Date.now() - 4 * 60_000, served: false, blockedDownstream: 2 },
            { kind: 'secret', nodeId: 'demo-note', nodeName: 'Bench 0', nodeKind: 'note', workspaceId: 'demo', workspaceName: 'Cookrew Demo', reason: 'needs STRIPE_SECRET_KEY — seal it', since: Date.now() - 60_000, served: false, blockedDownstream: 1, slot: 'STRIPE_SECRET_KEY', noteId: 'demo-note' },
            { kind: 'dispatch', nodeId: 'demo-bench-1', nodeName: 'Bench 1', nodeKind: 'terminal', workspaceId: 'demo', workspaceName: 'Cookrew Demo', reason: 'delivery failed — owner is composing', since: Date.now() - 12 * 60_000, served: false, blockedDownstream: 0 },
            { kind: 'sous', id: 'sous-1', nodeId: 'demo-bench-2', nodeName: 'Bench 2', nodeKind: 'terminal', workspaceId: 'demo', workspaceName: 'Cookrew Demo', reason: 'the brief never reached the card', since: Date.now() - 3 * 60_000, served: false, blockedDownstream: 0, action: 'retry', dismissable: true, text: 'Audit every README for stale install lines' },
            { kind: 'sous', id: 'sous-2', nodeId: 'demo-conductor', nodeName: 'Sous', nodeKind: 'terminal', workspaceId: 'demo', workspaceName: 'Cookrew Demo', reason: 'an answer', since: Date.now() - 60_000, served: false, blockedDownstream: 0, action: null, dismissable: true, text: 'Three cards are idle in this repo; Forge last touched README.' }
          ],
          Date.now()
        )
      ),
    onInbox: () => () => undefined,
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
  return fresh ? freshDemoApi(api, fresh, search) : api
}
