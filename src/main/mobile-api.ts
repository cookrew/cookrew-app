import type http from 'node:http'
import type { WorkspaceStore } from './store'
import type { PtyManager } from './pty'
import type { TurnTracker } from './turn-tracker'
import type { EventLog, CookrewEvent, EventQuery } from './event-log'
import type { AgentRegistry } from './agent-registry'
import type {
  AgentRole,
  CanvasNode,
  GitInfo,
  TeamForkSpec,
  TeamMeta,
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
    roleName?: string
  }) => CanvasNode
  forkTerminal: (sourceId: string, turnIndex?: number) => TerminalNodeData
  listWorkspaces: () => WorkspaceList
  createWorkspace: (name: string, dir: string, team?: string) => WorkspaceMeta | Promise<WorkspaceMeta>
  switchWorkspace: (id: string) => WorkspaceMeta
  renameWorkspace: (id: string, name: string) => WorkspaceList
  /** Workspace v2: remove workspace + multi-dir + per-terminal cwd + git. */
  removeWorkspace: (id: string) => WorkspaceList
  addWorkspaceDir: (id: string, dir: string) => WorkspaceList
  removeWorkspaceDir: (id: string, dir: string) => WorkspaceList
  setPrimaryDir: (id: string, dir: string) => WorkspaceList
  setTerminalCwd: (nodeId: string, dir: string) => CanvasNode
  gitInfo: (dir: string) => Promise<GitInfo>
  /** Team fork/save + roles (spec note team-fork-roles-v1). */
  teamFork: (spec: TeamForkSpec) => Promise<WorkspaceMeta>
  teamSave: (name?: string) => TeamMeta
  teamList: () => TeamMeta[]
  roleSave: (input: {
    nodeId: string
    name: string
    rolePrompt: string
    sourceTurnUuid?: string
    sourceTurnPrompt?: string
    sessionCopyRef?: string
  }) => AgentRole
  roleList: () => AgentRole[]
  roleDelete: (name: string) => boolean
}

export interface MobileApiDeps {
  store: WorkspaceStore
  ptys: PtyManager
  turns: TurnTracker
  /** Observability event log (query/count) — spec observability-event-log-spec. */
  events: EventLog
  /** Durable agent roster cache (~/.cookrew/agents.json). */
  agents: AgentRegistry
  ops: MobileOps
  presets: readonly { name: string; command: string }[]
  /** Persist a phone-uploaded attachment; returns its absolute path. */
  saveAttachment: (name: string, data: Buffer) => string
}

/** Base64 inflates ~4/3, so this admits attachments up to the 20MB save cap. */
const ATTACH_BODY_LIMIT = 30_000_000

/**
 * Enrich a workspace state with git info for the phone: every terminal node
 * gains `git` (its cwd's GitInfo) and the payload gains `dirsGit` (per
 * workspace dir). All dirs are looked up once through the cache, so the
 * added round-trips are coalesced and cheap.
 */
export async function enrichStateWithGit(
  state: WorkspaceState,
  gitInfo: (dir: string) => Promise<GitInfo>
): Promise<WorkspaceState & { dirsGit: Record<string, GitInfo> }> {
  const dirs = new Set<string>(state.dirs)
  for (const n of state.nodes) if (n.kind === 'terminal') dirs.add(n.cwd)
  const entries = await Promise.all(
    [...dirs].map(async (dir) => [dir, await gitInfo(dir)] as const)
  )
  const byDir = new Map(entries)
  const nodes = state.nodes.map((n) =>
    n.kind === 'terminal' ? { ...n, git: byDir.get(n.cwd) ?? null } : n
  )
  const dirsGit = Object.fromEntries(
    state.dirs.map((d) => [d, byDir.get(d) as GitInfo] as const)
  )
  return { ...state, nodes, dirsGit }
}

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
    // Embed git per terminal (node.git) and per workspace dir (dirsGit) so
    // phone cards show branch/dirty without a round-trip (Fresco GitChip).
    respondJson(response, 200, await enrichStateWithGit(store.state, ops.gitInfo))
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
    const body = await readJson<{ name?: string; dir?: string; team?: string }>(request)
    respondJson(
      response,
      200,
      await ops.createWorkspace(body.name ?? 'workspace', body.dir ?? '', body.team)
    )
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
  // Workspace v2: remove + directory management + git (mobile = text input).
  const wsMatch = p.match(/^\/api\/workspaces\/([^/]+)$/)
  if (wsMatch && method === 'DELETE') {
    try {
      respondJson(response, 200, ops.removeWorkspace(wsMatch[1]))
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }
  const wsDirMatch = p.match(/^\/api\/workspaces\/([^/]+)\/dirs$/)
  if (wsDirMatch && (method === 'POST' || method === 'DELETE')) {
    const body = await readJson<{ path?: string }>(request)
    try {
      const list =
        method === 'POST'
          ? ops.addWorkspaceDir(wsDirMatch[1], body.path ?? '')
          : ops.removeWorkspaceDir(wsDirMatch[1], body.path ?? '')
      respondJson(response, 200, list)
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }
  const wsPrimaryMatch = p.match(/^\/api\/workspaces\/([^/]+)\/primary$/)
  if (wsPrimaryMatch && method === 'POST') {
    const body = await readJson<{ path?: string }>(request)
    try {
      respondJson(response, 200, ops.setPrimaryDir(wsPrimaryMatch[1], body.path ?? ''))
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }
  if (method === 'GET' && p === '/api/git') {
    respondJson(response, 200, await ops.gitInfo(url.searchParams.get('dir') ?? ''))
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
      roleName?: string
    }>(request)
    try {
      respondJson(response, 200, ops.createTerminal(opts))
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  // Team fork / save + roles (contract in note team-fork-roles-spec-v1).
  if (method === 'POST' && p === '/api/team/fork') {
    const body = await readJson<{ spec?: TeamForkSpec }>(request)
    try {
      if (!body.spec) throw new Error('Missing spec')
      respondJson(response, 200, await ops.teamFork(body.spec))
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }
  if (method === 'POST' && p === '/api/team/save') {
    const body = await readJson<{ name?: string }>(request)
    try {
      respondJson(response, 200, ops.teamSave(body.name))
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }
  if (method === 'GET' && p === '/api/teams') {
    respondJson(response, 200, ops.teamList())
    return true
  }
  if (method === 'GET' && p === '/api/roles') {
    respondJson(response, 200, ops.roleList())
    return true
  }
  if (method === 'POST' && p === '/api/role/save') {
    const body = await readJson<{
      nodeId?: string
      name?: string
      rolePrompt?: string
      sourceTurnUuid?: string
      sourceTurnPrompt?: string
    }>(request)
    try {
      if (!body.nodeId || !body.name || !body.rolePrompt) {
        throw new Error('Missing nodeId/name/rolePrompt')
      }
      respondJson(
        response,
        200,
        ops.roleSave({
          nodeId: body.nodeId,
          name: body.name,
          rolePrompt: body.rolePrompt,
          sourceTurnUuid: body.sourceTurnUuid,
          sourceTurnPrompt: body.sourceTurnPrompt
        })
      )
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }
  if (method === 'POST' && p === '/api/role/delete') {
    const body = await readJson<{ name?: string }>(request)
    respondJson(response, 200, { deleted: ops.roleDelete(body.name ?? '') })
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
  // Workspace v2: repoint a terminal's cwd (respawns the pty).
  const cwdMatch = p.match(/^\/api\/terminal\/([^/]+)\/cwd$/)
  if (cwdMatch && method === 'POST') {
    const body = await readJson<{ dir?: string }>(request)
    try {
      respondJson(response, 200, ops.setTerminalCwd(cwdMatch[1], body.dir ?? ''))
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }
  // Acknowledge-on-view: the phone popout counts as viewing the result.
  const seenMatch = p.match(/^\/api\/terminal\/([^/]+)\/seen$/)
  if (seenMatch && method === 'POST') {
    turns.seen(seenMatch[1])
    respondJson(response, 200, { ok: true })
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
    // Observability stream: every store mutation, cross-workspace (toasts).
    const onOp = (event: CookrewEvent): void => send('event', event)
    store.on('change', onChange)
    store.on('workspaces', onWorkspaces)
    turns.on('activity', onActivity)
    store.on('op', onOp)
    const heartbeat = setInterval(() => response.write(':hb\n\n'), 25000)
    request.on('close', () => {
      clearInterval(heartbeat)
      store.removeListener('change', onChange)
      store.removeListener('workspaces', onWorkspaces)
      turns.removeListener('activity', onActivity)
      store.removeListener('op', onOp)
    })
    return true
  }

  // Observability queries (metrics/history panel) + global agent roster.
  if (method === 'GET' && p === '/api/events/query') {
    const q = parseEventQuery(url.searchParams)
    respondJson(response, 200, { events: deps.events.query(q), counts: deps.events.count(q) })
    return true
  }
  if (method === 'GET' && p === '/api/agents') {
    respondJson(response, 200, { agents: deps.agents.list() })
    return true
  }

  return false
}

/** ?workspaceId=&type=&since=&until=&limit= — all optional. */
function parseEventQuery(params: URLSearchParams): EventQuery {
  const num = (key: string): number | undefined => {
    const raw = params.get(key)
    const parsed = raw === null ? NaN : Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return {
    workspaceId: params.get('workspaceId') ?? undefined,
    type: params.get('type') ?? undefined,
    since: num('since'),
    until: num('until'),
    limit: num('limit')
  }
}
