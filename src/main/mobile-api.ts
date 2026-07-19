import type http from 'node:http'
import type { WorkspaceStore } from './store'
import type { PtyManager } from './pty'
import type { TurnTracker } from './turn-tracker'
import type {
  CanvasNode,
  TerminalNodeData,
  WorkspaceList,
  WorkspaceMeta,
  WorkspaceState
} from '../shared/model'
import { readJson, respondJson, startSse } from './mobile-http'

/**
 * Workspace operations shared with the renderer IPC handlers — the mobile
 * HTTP API and ipcMain both delegate to the same functions in index.ts so
 * phone edits behave exactly like desktop edits.
 */
export interface MobileOps {
  addNode: (node: CanvasNode) => CanvasNode
  updateNode: (id: string, patch: Partial<CanvasNode>) => CanvasNode | undefined
  removeNode: (id: string) => void
  createTerminal: (opts: {
    name: string
    preset: string
    position: { x: number; y: number }
    orch: boolean
  }) => CanvasNode
  forkTerminal: (sourceId: string, turnIndex?: number) => TerminalNodeData
  listWorkspaces: () => WorkspaceList
  createWorkspace: (name: string, dir: string) => WorkspaceMeta
  switchWorkspace: (id: string) => WorkspaceMeta
  renameWorkspace: (id: string, name: string) => WorkspaceList
}

export interface MobileApiDeps {
  store: WorkspaceStore
  ptys: PtyManager
  turns: TurnTracker
  ops: MobileOps
  presets: readonly { name: string; command: string }[]
  /** Persist a phone-uploaded attachment; returns its absolute path. */
  saveAttachment: (name: string, data: Buffer) => string
}

/** Base64 inflates ~4/3, so this admits attachments up to the 20MB save cap. */
const ATTACH_BODY_LIMIT = 30_000_000

/**
 * HTTP/SSE analogue of the renderer's IPC bridge, consumed by the desktop
 * renderer bundle running in a phone browser (remote-api.ts). Returns true
 * when the request was handled.
 */
export async function handleMobileApi(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: MobileApiDeps
): Promise<boolean> {
  const { store, ptys, turns, ops, presets } = deps
  const method = request.method ?? 'GET'
  const p = url.pathname

  if (method === 'GET' && p === '/api/workspace') {
    respondJson(response, 200, store.state)
    return true
  }
  if (method === 'GET' && p === '/api/presets') {
    respondJson(response, 200, presets)
    return true
  }
  if (method === 'GET' && p === '/api/activity') {
    respondJson(response, 200, turns.list())
    return true
  }

  if (method === 'GET' && p === '/api/workspaces') {
    respondJson(response, 200, ops.listWorkspaces())
    return true
  }
  if (method === 'POST' && p === '/api/workspaces') {
    const body = await readJson<{ name?: string; dir?: string }>(request)
    respondJson(response, 200, ops.createWorkspace(body.name ?? 'workspace', body.dir ?? ''))
    return true
  }
  if (method === 'POST' && p === '/api/workspaces/switch') {
    const body = await readJson<{ id?: string }>(request)
    ops.switchWorkspace(body.id ?? '')
    respondJson(response, 200, ops.listWorkspaces())
    return true
  }
  if (method === 'POST' && p === '/api/workspaces/rename') {
    const body = await readJson<{ id?: string; name?: string }>(request)
    respondJson(response, 200, ops.renameWorkspace(body.id ?? '', body.name ?? ''))
    return true
  }

  if (method === 'POST' && p === '/api/nodes') {
    const node = await readJson<CanvasNode>(request)
    respondJson(response, 200, ops.addNode(node))
    return true
  }
  const nodeMatch = p.match(/^\/api\/nodes\/([^/]+)$/)
  if (nodeMatch && method === 'POST') {
    const patch = await readJson<Partial<CanvasNode>>(request)
    respondJson(response, 200, ops.updateNode(nodeMatch[1], patch))
    return true
  }
  if (nodeMatch && method === 'DELETE') {
    ops.removeNode(nodeMatch[1])
    respondJson(response, 200, { ok: true })
    return true
  }

  if (method === 'POST' && p === '/api/connections') {
    const body = await readJson<{ a?: string; b?: string }>(request)
    respondJson(response, 200, store.connect(body.a ?? '', body.b ?? ''))
    return true
  }
  const connMatch = p.match(/^\/api\/connections\/([^/]+)$/)
  if (connMatch && method === 'DELETE') {
    store.disconnect(connMatch[1])
    respondJson(response, 200, { ok: true })
    return true
  }

  if (method === 'POST' && p === '/api/terminals') {
    const opts = await readJson<{
      name: string
      preset: string
      position: { x: number; y: number }
      orch: boolean
    }>(request)
    respondJson(response, 200, ops.createTerminal(opts))
    return true
  }

  if (method === 'POST' && p === '/api/attachments') {
    const body = await readJson<{ name?: string; data?: string }>(request, ATTACH_BODY_LIMIT)
    if (typeof body.data !== 'string' || body.data.length === 0) {
      respondJson(response, 400, { error: 'Missing data' })
      return true
    }
    try {
      const saved = deps.saveAttachment(body.name ?? 'file', Buffer.from(body.data, 'base64'))
      respondJson(response, 200, { path: saved })
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  const turnsMatch = p.match(/^\/api\/terminal\/([^/]+)\/turns$/)
  if (turnsMatch && method === 'GET') {
    respondJson(response, 200, turns.history(turnsMatch[1]))
    return true
  }
  const forkMatch = p.match(/^\/api\/terminal\/([^/]+)\/fork$/)
  if (forkMatch && method === 'POST') {
    const body = await readJson<{ turnIndex?: number }>(request)
    try {
      respondJson(response, 200, ops.forkTerminal(forkMatch[1], body.turnIndex))
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  const ptyMatch = p.match(/^\/api\/terminal\/([^/]+)\/(raw|resize|stream|jump)$/)
  if (ptyMatch) {
    const session = ptys.get(ptyMatch[1])
    if (!session) {
      respondJson(response, 404, { error: 'Terminal not running' })
      return true
    }
    if (method === 'POST' && ptyMatch[2] === 'raw') {
      const body = await readJson<{ data?: string }>(request)
      if (typeof body.data === 'string') session.write(body.data)
      respondJson(response, 200, { ok: true })
      return true
    }
    if (method === 'POST' && ptyMatch[2] === 'resize') {
      const body = await readJson<{ cols?: number; rows?: number }>(request)
      if (body.cols && body.rows) session.resize(body.cols, body.rows)
      respondJson(response, 200, { ok: true })
      return true
    }
    if (method === 'POST' && ptyMatch[2] === 'jump') {
      const body = await readJson<{ text?: string | null }>(request)
      if (typeof body.text === 'string' && body.text.length > 0) session.jumpToText(body.text)
      else session.exitCopyMode()
      respondJson(response, 200, { ok: true })
      return true
    }
    if (method === 'GET' && ptyMatch[2] === 'stream') {
      const send = startSse(response)
      // Same replay the IPC attach does: clear the fresh xterm, then paint
      // the current viewport text (a resize kick follows from the client).
      send('data', '\x1b[2J\x1b[3J\x1b[H' + session.viewportText() + '\r\n')
      const onData = (data: string): void => send('data', data)
      const onExit = (): void => send('exit', {})
      session.on('data', onData)
      session.on('exit', onExit)
      const heartbeat = setInterval(() => response.write(':hb\n\n'), 25000)
      request.on('close', () => {
        clearInterval(heartbeat)
        session.removeListener('data', onData)
        session.removeListener('exit', onExit)
      })
      return true
    }
  }

  if (method === 'GET' && p === '/api/events') {
    const send = startSse(response)
    send('workspace', store.state)
    send('workspaces', ops.listWorkspaces())
    for (const activity of turns.list()) send('activity', activity)
    const onChange = (state: WorkspaceState): void => send('workspace', state)
    const onWorkspaces = (list: WorkspaceList): void => send('workspaces', list)
    const onActivity = (activity: unknown): void => send('activity', activity)
    store.on('change', onChange)
    store.on('workspaces', onWorkspaces)
    turns.on('activity', onActivity)
    const heartbeat = setInterval(() => response.write(':hb\n\n'), 25000)
    request.on('close', () => {
      clearInterval(heartbeat)
      store.removeListener('change', onChange)
      store.removeListener('workspaces', onWorkspaces)
      turns.removeListener('activity', onActivity)
    })
    return true
  }

  return false
}
