import type {
  CanvasNode,
  Connection,
  WorkspaceList,
  WorkspaceMeta,
  WorkspaceState
} from '../../shared/model'
import { noteNameFromContent, uniqueName } from '../../shared/model'
import type { CookrewApi } from './api'

/**
 * Browser demo backend: when the renderer runs outside Electron (plain
 * browser tab, or embedded in a Maestri browser) there is no preload bridge,
 * no PTYs and no socket. This mock keeps the whole canvas interactive with
 * an in-memory workspace and a simulated shell.
 */

const DEMO_PROMPT = '\x1b[32m➜\x1b[0m \x1b[36mdemo\x1b[0m $ '

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
      '# Welcome to Cookrew\n\nThis is the **browser demo** of the open-source Maestri clone.\n\n- drag nodes by their headers\n- double-click me to edit\n- type in the terminal\n- use the toolbar to add nodes\n\nThe real app runs on Electron with live PTYs, a Unix-socket `cookrew` CLI, browsers and routines.',
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
    nodes: [conductor, note, browser],
    connections: [
      { id: 'demo-c1', a: 'demo-conductor', b: 'demo-note' },
      { id: 'demo-c2', a: 'demo-conductor', b: 'demo-browser' }
    ]
  }
}

const DEMO_RESPONSES: Record<string, string> = {
  help: 'cookrew demo shell — try: help, list, about, clear',
  list: 'You:\r\n  - name: "Conductor", orch: true\r\n\r\nConnected notes:\r\n  - name: "welcome-to-cookrew"\r\nConnected browsers:\r\n  - name: "Browser"',
  about: 'Cookrew — open-source Maestri clone. Electron + React Flow + xterm.js + node-pty.\r\nThis browser demo simulates the shell; the desktop app runs real PTYs.'
}

export function createDemoApi(): CookrewApi {
  // In-memory workspace registry so the demo can switch canvases too.
  const metas: WorkspaceMeta[] = [{ id: 'demo-ws', name: 'Cookrew Demo', dir: '~', icon: '🗂' }]
  const states = new Map<string, WorkspaceState>([['demo-ws', demoWorkspace()]])
  let activeId = 'demo-ws'
  let state = states.get(activeId)!

  const stateListeners = new Set<(s: WorkspaceState) => void>()
  const wsListeners = new Set<(l: WorkspaceList) => void>()
  const ptyListeners = new Map<string, (data: string) => void>()
  const lineBuffers = new Map<string, string>()

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
    getWorkspace: () => Promise.resolve(state),
    onWorkspaceState: (cb) => {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
    listWorkspaces: () => Promise.resolve({ workspaces: metas, activeId }),
    createWorkspace: (name, dir) => {
      const meta: WorkspaceMeta = {
        id: `demo-ws-${Date.now()}`,
        name: uniqueName(name.trim() || 'Workspace', metas.map((m) => m.name)),
        dir: dir.trim() || '~',
        icon: '🗂'
      }
      metas.push(meta)
      states.set(meta.id, { name: meta.name, dir: meta.dir, nodes: [], connections: [] })
      states.set(activeId, state)
      activeId = meta.id
      broadcast(states.get(activeId)!)
      wsBroadcast()
      return Promise.resolve(meta)
    },
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
      const conn: Connection = { id: `demo-${Date.now()}`, a, b }
      broadcast({ ...state, connections: [...state.connections, conn] })
      return Promise.resolve(conn)
    },
    disconnect: (connId) => {
      broadcast({ ...state, connections: state.connections.filter((c) => c.id !== connId) })
      return Promise.resolve()
    },
    listPresets: () =>
      Promise.resolve([
        { name: 'Claude Code', command: 'claude --permission-mode bypassPermissions' },
        { name: 'Codex', command: 'codex' },
        { name: 'OpenCode', command: 'opencode' },
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

    onBrowserCommand: () => () => undefined,
    browserResult: () => undefined,
    browserThumb: () => undefined,
    onBrowserOpenTab: () => () => undefined,
    onCmdW: () => () => undefined,
    quitApp: () => undefined
  }
  return api
}
