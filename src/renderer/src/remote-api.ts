import type { CookrewApi } from './api'
import type { CanvasNode, GitInfo, WorkspaceList, WorkspaceState } from '../../shared/model'
import type { TerminalActivity, TurnRecord } from '../../shared/turn'

/**
 * CookrewApi over HTTP + Server-Sent-Events, used when the renderer bundle is
 * served to a phone browser by the mobile server (window.COOKREW_MOBILE marker).
 * Same UI, no Electron: IPC invokes become fetches, IPC pushes become SSE.
 *
 * Browser commands stay silent here on purpose — the desktop renderer remains
 * the single browser automation engine; phones render browsers as iframes.
 */

async function req<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const options: RequestInit = { method }
  if (body !== undefined) {
    options.headers = { 'content-type': 'application/json' }
    options.body = JSON.stringify(body)
  }
  const response = await fetch(path, options)
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: String(response.status) }))
    throw new Error((detail as { error?: string }).error ?? `HTTP ${response.status}`)
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** Fire-and-forget POST for streams of small events (keystrokes, resizes). */
function post(path: string, body: unknown): void {
  void req(path, 'POST', body).catch(() => undefined)
}

/**
 * One shared /api/events stream for workspace state, workspace list and
 * terminal activity. EventSource reconnects on its own after network blips.
 */
let events: EventSource | null = null

function sharedEvents(): EventSource {
  if (!events) events = new EventSource('/api/events')
  return events
}

function subscribe<T>(event: string, cb: (data: T) => void): () => void {
  const source = sharedEvents()
  const listener = (e: MessageEvent): void => cb(JSON.parse(e.data) as T)
  source.addEventListener(event, listener)
  return () => source.removeEventListener(event, listener)
}

/** data-URL detour: base64 without blowing the call stack on big files. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Read failed'))
    reader.readAsDataURL(file)
  })
}

/** Base64-encode raw bytes (pasted clipboard image) for the upload endpoint. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function createRemoteApi(): CookrewApi {
  return {
    getWorkspace: () => req<WorkspaceState>('/api/workspace'),
    onWorkspaceState: (cb) => subscribe<WorkspaceState>('workspace', cb),
    listWorkspaces: () => req<WorkspaceList>('/api/workspaces'),
    createWorkspace: (name, dir, team) => req('/api/workspaces', 'POST', { name, dir, team }),
    switchWorkspace: (id) => req<WorkspaceList>('/api/workspaces/switch', 'POST', { id }),
    renameWorkspace: (id, name) => req<WorkspaceList>('/api/workspaces/rename', 'POST', { id, name }),
    removeWorkspace: (id) => req<WorkspaceList>(`/api/workspaces/${id}`, 'DELETE'),
    addWorkspaceDir: (id, dir) => req<WorkspaceList>(`/api/workspaces/${id}/dirs`, 'POST', { path: dir }),
    removeWorkspaceDir: (id, dir) =>
      req<WorkspaceList>(`/api/workspaces/${id}/dirs`, 'DELETE', { path: dir }),
    setPrimaryDir: (id, dir) =>
      req<WorkspaceList>(`/api/workspaces/${id}/primary`, 'POST', { path: dir }),
    setTerminalCwd: (nodeId, dir) => req<CanvasNode>(`/api/terminal/${nodeId}/cwd`, 'POST', { dir }),
    // No native picker on the phone — the UI collects a path via text input.
    pickDir: () => Promise.resolve(null),
    gitInfo: (dir) => req<GitInfo>(`/api/git?dir=${encodeURIComponent(dir)}`, 'GET'),
    onWorkspaceList: (cb) => subscribe<WorkspaceList>('workspaces', cb),

    addNode: (node) => req('/api/nodes', 'POST', node),
    updateNode: (id, patch) => req(`/api/nodes/${id}`, 'POST', patch),
    removeNode: (id) => req(`/api/nodes/${id}`, 'DELETE'),
    connectNodes: (a, b) => req('/api/connections', 'POST', { a, b }),
    disconnect: (connId) => req(`/api/connections/${connId}`, 'DELETE'),
    listPresets: () => req('/api/presets'),
    createTerminal: (opts) => req('/api/terminals', 'POST', opts),

    // Phones can't hand the desktop a local path — upload the bytes and let
    // the server persist them; the returned path is what gets pasted.
    attachFiles: async (files) => {
      const paths: string[] = []
      for (const file of files) {
        const uploaded = await req<{ path: string }>('/api/attachments', 'POST', {
          name: file.name,
          data: await fileToBase64(file)
        })
        paths.push(uploaded.path)
      }
      return paths
    },
    saveAttachmentBytes: async (name, bytes) => {
      const uploaded = await req<{ path: string }>('/api/attachments', 'POST', {
        name,
        data: bytesToBase64(bytes)
      })
      return uploaded.path
    },
    pickFiles: () => Promise.resolve([]),

    ptyInput: (terminalId, data) => post(`/api/terminal/${terminalId}/raw`, { data }),
    ptyJump: (terminalId, text) => post(`/api/terminal/${terminalId}/jump`, { text }),
    turnSeen: (terminalId) => post(`/api/terminal/${terminalId}/seen`, {}),
    ptyResize: (terminalId, cols, rows) =>
      post(`/api/terminal/${terminalId}/resize`, { cols, rows }),
    ptyAttach: (terminalId, onData) => {
      const stream = new EventSource(`/api/terminal/${terminalId}/stream`)
      const listener = (e: MessageEvent): void => onData(JSON.parse(e.data) as string)
      stream.addEventListener('data', listener)
      return () => stream.close()
    },

    listActivity: () => req<TerminalActivity[]>('/api/activity'),
    onTerminalActivity: (cb) => subscribe<TerminalActivity>('activity', cb),
    // Observability event log (observability-event-log-spec): the shared SSE
    // stream carries 'event'; queries/roster are plain GETs.
    onEvent: (cb) => subscribe('event', cb),
    queryEvents: async (query) => {
      const params = new URLSearchParams()
      const q = (query ?? {}) as Record<string, unknown>
      for (const key of ['workspaceId', 'type', 'since', 'until', 'limit']) {
        if (q[key] !== undefined) params.set(key, String(q[key]))
      }
      const result = await req<{ events: unknown[] }>(`/api/events/query?${params}`)
      return result.events
    },
    countEvents: async (query) => {
      const params = new URLSearchParams()
      const q = (query ?? {}) as Record<string, unknown>
      for (const key of ['workspaceId', 'type', 'since', 'until']) {
        if (q[key] !== undefined) params.set(key, String(q[key]))
      }
      const result = await req<{ counts: Record<string, number> }>(`/api/events/query?${params}`)
      return result.counts
    },
    listAgents: async () => {
      const result = await req<{ agents: unknown[] }>('/api/agents')
      return result.agents
    },
    listTurns: (terminalId) => req<TurnRecord[]>(`/api/terminal/${terminalId}/turns`),
    listTrace: async (terminalId, request) => {
      const params = new URLSearchParams()
      const r = (request ?? {}) as Record<string, unknown>
      for (const key of ['beforeIndex', 'afterIndex', 'aroundIndex', 'limit']) {
        if (r[key] !== undefined) params.set(key, String(r[key]))
      }
      return req(`/api/terminal/${terminalId}/trace?${params}`)
    },
    listTurnsPage: async (terminalId, request) => {
      const params = new URLSearchParams()
      const r = (request ?? {}) as Record<string, unknown>
      for (const key of ['offset', 'limit', 'aroundIndex']) {
        if (r[key] !== undefined) params.set(key, String(r[key]))
      }
      // At least one param forces the paged shape server-side.
      if ([...params.keys()].length === 0) params.set('limit', '20')
      return req(`/api/terminal/${terminalId}/turns?${params}`)
    },
    forkTerminal: (sourceId, turnIndex) =>
      req(`/api/terminal/${sourceId}/fork`, 'POST', { turnIndex }),
    teamFork: (spec) => req('/api/team/fork', 'POST', { spec }),
    teamSave: (name) => req('/api/team/save', 'POST', { name }),
    teamList: () => req('/api/teams'),
    roleList: () => req('/api/roles'),
    saveRole: (input) => req('/api/role/save', 'POST', input),

    // Desktop-only surfaces: browser automation, thumbnail push, app chrome.
    onBrowserCommand: () => () => undefined,
    browserResult: () => undefined,
    browserThumb: () => undefined,
    onBrowserOpenTab: () => () => undefined,
    onCmdW: () => () => undefined,
    quitApp: () => undefined
  }
}
