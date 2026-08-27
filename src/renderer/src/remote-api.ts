import { AuthError, authStore, tokenParam, type AuthScope } from './auth-gate'
import { ReconnectingStream } from './live-stream'
import type { BoardSnapshotLike, CookrewApi } from './api'
import type { CanvasNode, GitInfo, WorkspaceList, WorkspaceState } from '../../shared/model'
import type { TerminalActivity, TurnRecord } from '../../shared/turn'
import type { VersionPinRecord } from '../../shared/version-pin'
import { apiPath } from './api-base'

/**
 * CookrewApi over HTTP + Server-Sent-Events, used when the renderer bundle is
 * served to a phone browser by the mobile server (window.COOKREW_MOBILE marker).
 * Same UI, no Electron: IPC invokes become fetches, IPC pushes become SSE.
 *
 * Browser commands stay silent here on purpose. With C-2 enabled, the
 * node-owned headless runtime owns automation while desktop and phone render
 * and drive its shared stream. Flag-off phones retain the legacy /thumb view.
 */

/**
 * Pairing token (C1): the desktop's pairing URL carries `?token=`; auth-gate
 * lifts it into storage and strips it from the address bar. Mutating routes
 * require it as a bearer header; read-only GETs/SSE stay open.
 */
/** Turn a server answer into a value, or into the right kind of failure. */
async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: String(response.status) }))
    const message = (detail as { error?: string }).error ?? `HTTP ${response.status}`
    if (response.status === 401) {
      // A stale credential is the most likely error this client will ever
      // see. Raise it as its own type so it reaches the re-pair screen
      // instead of being counted as a generic network hiccup.
      const failure = new AuthError(message, /read-only/i.test(message) ? 'read-only' : 'none')
      authStore().report(failure)
      throw failure
    }
    throw new Error(message)
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function req<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const options: RequestInit = { method }
  const headers: Record<string, string> = {}
  const token = authStore().token()
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  if (Object.keys(headers).length > 0) options.headers = headers
  return parse<T>(await fetch(path, options))
}

/**
 * Send one attachment as RAW BYTES.
 *
 * It used to go as base64 inside JSON, which put 33% more bytes on a link
 * where bytes are the scarce thing, and made the desktop's main process build
 * a 27 MB string and JSON.parse it — the whole app stalled for the length of
 * every upload. A Blob goes out as-is and streams.
 */
async function upload(name: string, body: Blob): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
  const token = authStore().token()
  if (token) headers.authorization = `Bearer ${token}`
  const result = await parse<{ path: string }>(
    await fetch(apiPath(`/api/attachments?name=${encodeURIComponent(name)}`), {
      method: 'POST',
      headers,
      body
    })
  )
  return result.path
}

/**
 * How many uploads may be in flight together.
 *
 * Uploading one at a time cost a full round trip per file, and on a relayed
 * tailnet a round trip is 300 ms to 2.5 s — five screenshots meant five of
 * them end to end. A small bound overlaps that latency without letting a
 * dozen large files fight each other for a thin link.
 */
const UPLOAD_CONCURRENCY = 3

/** Map with bounded concurrency, preserving input order in the result. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++
      results[at] = await run(items[at])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Fire-and-forget POST for streams of small events (keystrokes, resizes).
 * The rejection is still dropped here — there is no caller to hand it to —
 * but req() has already REPORTED an auth failure to the store by this point,
 * so the re-pair screen appears even though nothing awaits this promise. That
 * report is deduplicated, so a held-down key raises one screen, not hundreds.
 */
function post(path: string, body: unknown): void {
  void req(path, 'POST', body).catch(() => undefined)
}

/**
 * Ask the server what the current credential is worth. Used to verify a
 * pasted token during re-pairing, and on boot so an unpaired phone says so
 * before the user discovers it by pressing something.
 */
export async function checkAuth(candidate?: string): Promise<AuthScope> {
  const token = candidate ?? authStore().token()
  const response = await fetch(apiPath('/api/auth/status'), {
    headers: token ? { authorization: `Bearer ${token}` } : undefined
  })
  if (!response.ok) throw new Error(`Auth check failed (HTTP ${response.status})`)
  const body = (await response.json()) as { scope?: AuthScope; required?: boolean }
  // A server with no token configured authorizes everything; report that as
  // full access rather than as "none", which would strand the UI behind a
  // re-pair screen it can never satisfy.
  if (body.required === false) return 'pairing'
  return body.scope ?? 'none'
}

/**
 * One shared /api/events stream for workspace state, workspace list and
 * terminal activity — and the client's ONLY source of canvas updates, so it
 * heals itself. EventSource retries the failures it considers retryable and
 * gives up on the rest; a phone that loses this stream for good sits on
 * whatever it last drew, which after a reload is nothing at all.
 */
let events: ReconnectingStream | null = null

function sharedEvents(): ReconnectingStream {
  // tokenParam, not a header: EventSource has none. Reads are gated now, so a
  // tokenless stream is a 401 the client would retry forever.
  if (!events)
    events = new ReconnectingStream({
      open: () => new EventSource(tokenParam(apiPath('/api/events')))
    })
  return events
}

/**
 * One event, parsed ONCE, however many listeners want it.
 *
 * This used to be `cb(JSON.parse(e.data))` — inside the per-listener callback,
 * so the parse ran once PER SUBSCRIBER. Three components subscribe to
 * 'workspace' (App, EventToast, DirectoryManager) and that payload is 520 KB on
 * the owner's board, so every broadcast cost about 2 MB of JSON parsing and
 * left FOUR independent object graphs of the whole board alive at once —
 * measured on the phone, where the memory ceiling is real.
 *
 * The waste is worst where the need is smallest: EventToast parses half a
 * megabyte to read `s.name`, one string.
 *
 * A WeakMap keyed on the MessageEvent is what makes this safe. Every listener
 * for one event receives the SAME event object, so the first parse wins and the
 * rest are lookups; a different event is a different key, so nothing stale can
 * be served. Keeping it weak means the parsed board dies with the event rather
 * than being pinned by this cache — the opposite of the leak it would otherwise
 * introduce.
 *
 * Listeners still share one object instead of getting private copies. That was
 * already true of every IPC consumer on the desktop path, and these consumers
 * only read — a subscriber that mutated its payload was already broken.
 */
const parsedEvents = new WeakMap<MessageEvent, unknown>()

/** Exported for the test that pins "N listeners, one parse". */
export function parseOnce<T>(e: MessageEvent): T {
  const hit = parsedEvents.get(e)
  if (hit !== undefined) return hit as T
  const parsed = JSON.parse(e.data) as T
  parsedEvents.set(e, parsed)
  return parsed
}

function subscribe<T>(event: string, cb: (data: T) => void): () => void {
  return sharedEvents().on(event, (e) => cb(parseOnce<T>(e)))
}

/**
 * Ask once at boot whether this device is still paired.
 *
 * Only a hard 'none' raises the screen. A read-only device is a legitimate,
 * fully usable state — the TV wall is one by design — so it stays quiet until
 * the user actually attempts a write and gets a 401 back.
 */
function checkAuthOnBoot(): void {
  void checkAuth()
    .then((scope) => {
      if (scope === 'none') {
        authStore().report(new AuthError('This device is not paired.', 'none'))
      }
    })
    .catch(() => undefined)
}

export function createRemoteApi(): CookrewApi {
  checkAuthOnBoot()
  return {
    getWorkspace: () => req<WorkspaceState>(apiPath('/api/workspace')),
    onWorkspaceState: (cb) => subscribe<WorkspaceState>('workspace', cb),
    listWorkspaces: () => req<WorkspaceList>(apiPath('/api/workspaces')),
    createWorkspace: (name, dir, team) => req(apiPath('/api/workspaces'), 'POST', { name, dir, team }),
    templateImport: (team, position) =>
      req(apiPath('/api/templates/import'), 'POST', { team, position }),
    switchWorkspace: (id) => req<WorkspaceList>(apiPath('/api/workspaces/switch'), 'POST', { id }),
    renameWorkspace: (id, name) => req<WorkspaceList>(apiPath('/api/workspaces/rename'), 'POST', { id, name }),
    removeWorkspace: (id) => req<WorkspaceList>(apiPath(`/api/workspaces/${id}`), 'DELETE'),
    addWorkspaceDir: (id, dir) => req<WorkspaceList>(apiPath(`/api/workspaces/${id}/dirs`), 'POST', { path: dir }),
    removeWorkspaceDir: (id, dir) =>
      req<WorkspaceList>(apiPath(`/api/workspaces/${id}/dirs`), 'DELETE', { path: dir }),
    setPrimaryDir: (id, dir) =>
      req<WorkspaceList>(apiPath(`/api/workspaces/${id}/primary`), 'POST', { path: dir }),
    setTerminalCwd: (nodeId, dir) => req<CanvasNode>(apiPath(`/api/terminal/${nodeId}/cwd`), 'POST', { dir }),
    // No native picker on the phone — the UI collects a path via text input.
    pickDir: () => Promise.resolve(null),
    gitInfo: (dir) => req<GitInfo>(apiPath(`/api/git?dir=${encodeURIComponent(dir)}`), 'GET'),
    onWorkspaceList: (cb) => subscribe<WorkspaceList>('workspaces', cb),

    addNode: (node) => req(apiPath('/api/nodes'), 'POST', node),
    updateNode: (id, patch) => req(apiPath(`/api/nodes/${id}`), 'POST', patch),
    removeNode: (id) => req(apiPath(`/api/nodes/${id}`), 'DELETE'),
    connectNodes: (a, b) => req(apiPath('/api/connections'), 'POST', { a, b }),
    disconnect: (connId) => req(apiPath(`/api/connections/${connId}`), 'DELETE'),
    listPresets: () => req(apiPath('/api/presets')),
    // The phone's marketplace surface is the canvas BROWSER card (R1), not a
    // native chip row — and installing is a desktop act, since the store lives
    // on the machine that runs the agents. Empty and inert here until the
    // companion has a reason to differ.
    listInstalledPresets: () => Promise.resolve([]),
    placeInstalledPreset: () => Promise.resolve(),
    uninstallPreset: () => Promise.resolve(),
    // Trusting a signing key is a decision about the machine that holds the
    // store, so the phone does not get to make it either.
    markPresetRotationSeen: () => Promise.resolve(),
    trustPresetAuthorKey: () => Promise.resolve(),
    // The rail's third marker class travels to the phone now — same store the
    // desktop reads, over the scoped route, so the two rails cannot disagree.
    listPins: (terminalId) => req<VersionPinRecord[]>(apiPath(`/api/terminal/${terminalId}/pins`)),
    // apiPath, not a bare path: step 3 scopes the phone client's routes to the
    // workspace it is for, and a pin belongs to a transcript inside one.
    createTerminal: (opts) => req(apiPath('/api/terminals'), 'POST', opts),

    // Phones can't hand the desktop a local path — upload the bytes and let
    // the server persist them; the returned path is what gets pasted.
    // Concurrent, because the paths come back in order either way and the
    // round trips are the expensive part.
    attachFiles: (files) =>
      mapLimited(files, UPLOAD_CONCURRENCY, (file) => upload(file.name, file)),
    // Copy through a plain ArrayBuffer: a Uint8Array may be backed by a
    // SharedArrayBuffer, which Blob will not take.
    saveAttachmentBytes: (name, bytes) =>
      upload(name, new Blob([new Uint8Array(bytes).slice().buffer])),
    pickFiles: () => Promise.resolve([]),

    ptyInput: (terminalId, data) => post(apiPath(`/api/terminal/${terminalId}/raw`), { data }),
    ptyJump: (terminalId, text) => post(apiPath(`/api/terminal/${terminalId}/jump`), { text }),
    // Same contract as the desktop's IPC call: never rejects, the failure
    // reason comes back as data so the reader is told what to fix.
    translateHost: () => req(apiPath('/api/translate/host')),
    translateCheckpoint: (text, language) =>
      req(apiPath('/api/translate'), 'POST', { text, language }),
    turnSeen: (terminalId) => post(apiPath(`/api/terminal/${terminalId}/seen`), {}),
    ptyResize: (terminalId, cols, rows) =>
      post(apiPath(`/api/terminal/${terminalId}/resize`), { cols, rows }),
    ptyAttach: (terminalId, onData, onHello) => {
      const stream = new EventSource(tokenParam(apiPath(`/api/terminal/${terminalId}/stream`)))
      const listener = (e: MessageEvent): void => onData(JSON.parse(e.data) as string)
      // The server sends this before the first frame; sizing the xterm from it
      // is what keeps a 45x24 phone from re-wrapping a frame serialized at the
      // pane's 100x30 and then misplacing every absolute-addressed delta.
      const helloListener = (e: MessageEvent): void =>
        onHello?.(JSON.parse(e.data) as { cols: number; rows: number })
      stream.addEventListener('hello', helloListener)
      stream.addEventListener('data', listener)
      return () => stream.close()
    },

    listActivity: () => req<TerminalActivity[]>(apiPath('/api/activity')),
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
      const result = await req<{ events: unknown[] }>(apiPath(`/api/events/query?${params}`))
      return result.events
    },
    countEvents: async (query) => {
      const params = new URLSearchParams()
      const q = (query ?? {}) as Record<string, unknown>
      for (const key of ['workspaceId', 'type', 'since', 'until']) {
        if (q[key] !== undefined) params.set(key, String(q[key]))
      }
      const result = await req<{ counts: Record<string, number> }>(apiPath(`/api/events/query?${params}`))
      return result.counts
    },
    listAgents: async () => {
      const result = await req<{ agents: unknown[] }>(apiPath('/api/agents'))
      return result.agents
    },
    listBoard: (window?: string) =>
      req<BoardSnapshotLike>(
        apiPath(`/api/board${window ? `?window=${encodeURIComponent(window)}` : ''}`)
      ),
    recoverAgent: (id) => req(apiPath(`/api/agents/${id}/recover`), 'POST'),
    restoreCheckpoint: (id, checkpointIndex) =>
      req(apiPath(`/api/agents/${id}/restore`), 'POST', { checkpointIndex }),
    undoRestore: (id) => req(apiPath(`/api/agents/${id}/restore/undo`), 'POST'),
    listTurns: (terminalId) => req<TurnRecord[]>(apiPath(`/api/terminal/${terminalId}/turns`)),
    // Checkpoint search is desktop-only for now: the phone has no /api route
    // for it yet, and a silently-empty result would read as "no matches".
    searchTurns: undefined,
    listTraceIndex: (terminalId) => req(apiPath(`/api/terminal/${terminalId}/trace/index`)),
    listTraceMarkers: (terminalId) => req(apiPath(`/api/terminal/${terminalId}/trace/markers`)),
    // Trace-perf T1: the phone card's latest checkpoint, tail-read on the host.
    latestCheckpoint: (terminalId) =>
      req(apiPath(`/api/terminal/${terminalId}/latest`)),
    listTrace: async (terminalId, request) => {
      const params = new URLSearchParams()
      const r = (request ?? {}) as Record<string, unknown>
      for (const key of ['beforeIndex', 'afterIndex', 'aroundIndex', 'limit']) {
        if (r[key] !== undefined) params.set(key, String(r[key]))
      }
      return req(apiPath(`/api/terminal/${terminalId}/trace?${params}`))
    },
    listTurnsPage: async (terminalId, request) => {
      const params = new URLSearchParams()
      const r = (request ?? {}) as Record<string, unknown>
      for (const key of ['offset', 'limit', 'aroundIndex']) {
        if (r[key] !== undefined) params.set(key, String(r[key]))
      }
      // At least one param forces the paged shape server-side.
      if ([...params.keys()].length === 0) params.set('limit', '20')
      return req(apiPath(`/api/terminal/${terminalId}/turns?${params}`))
    },
    forkTerminal: (sourceId, turnIndex) =>
      req(apiPath(`/api/terminal/${sourceId}/fork`), 'POST', { turnIndex }),
    teamFork: (spec) => req(apiPath('/api/team/fork'), 'POST', { spec }),
    teamSave: (name, nodeIds) => req(apiPath('/api/team/save'), 'POST', { name, nodeIds }),
    teamClipSet: (nodeIds, cut, worktree) =>
      req(apiPath('/api/team/clip'), 'POST', { nodeIds, cut, worktree }),
    teamClipGet: () => req(apiPath('/api/team/clip')),
    teamPaste: () => req(apiPath('/api/team/paste'), 'POST', {}),
    teamList: () => req(apiPath('/api/teams')),
    roleList: () => req(apiPath('/api/roles')),
    saveRole: (input) => req(apiPath('/api/role/save'), 'POST', input),

    // No remote legacy webview bridge, thumbnail publisher, or desktop app chrome.
    // Headless capability is queried here; its phone stream is same-origin/tokenless.
    onBrowserCommand: () => () => undefined,
    browserResult: () => undefined,
    browserThumb: () => undefined,
    interactiveBrowserEnabled: async () => {
      const result = await req<{ interactive: boolean }>(apiPath('/api/browser/capabilities'))
      return result.interactive
    },
    browserStreamToken: () => Promise.resolve(null),
    reconnect: () => sharedEvents().revive(),
    onBrowserOpenTab: () => () => undefined,
    onBrowserPhoneViewing: () => () => undefined,
    onCmdW: () => () => undefined,

    // R30 serving + the dock's crews. Owner-desktop surfaces: this transport
    // cannot mount them, and a stub that pretended to succeed would publish
    // nothing while telling the user it had. It refuses, visibly.
    servingServe: async () => ({ ok: false as const, reason: 'desktop-only' }),
    servingStop: async () => ({ ok: false }),
    servingPaymentStatus: async () => ({ x402: { ready: false }, stripe: { ready: false } }),
    servingSetPayTo: async () => ({ ok: false as const, reason: 'write-failed' as const }),
    servingSetStripeSecret: async () => ({ ok: false as const, reason: 'write-failed' as const }),
    servingList: async () => [],
    servingSessions: async () => [],
    servingEnd: async () => ({ stopped: 0 }),
    crewList: async () => [],
    crewAdd: async () => ({ ok: false as const, reason: 'desktop-only' }),
    crewRemove: async () => ({ ok: false }),
    crewUnlock: async () => ({ ok: false as const, reason: 'desktop-only' }),
    crewPlace: async () => ({ ok: false as const, reason: 'desktop-only' }),
    quitApp: () => undefined
  }
}
