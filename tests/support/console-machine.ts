import { EventEmitter } from 'node:events'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAccountPairDoor } from '../../src/main/account-pair'
import { handleAccountPairRoutes } from '../../src/main/account-pair-routes'
import type { AgentRegistryEntry } from '../../src/main/agent-registry'
import { companionAccount } from '../../src/main/companion-account'
import { ADD_KEY_STEM, setupLines } from '../../src/main/route/setup'
import { createAdmittedDeviceStore } from '../../src/main/admitted-devices'
import { createCanvasBridge, loopbackDialer } from '../../src/main/canvas-bridge'
import { createCanvasLink, type CanvasLink } from '../../src/main/canvas-link'
import { handleFleetRoutes } from '../../src/main/fleet/routes'
import { createFleetService } from '../../src/main/fleet/service'
import { levelsSourcesFrom } from '../../src/main/fleet/sources'
import type { BoardSources } from '../../src/main/board-index'
import { bearerToken, readJson, respondJson, startSse, type SseSend } from '../../src/main/mobile-http'
import { takeRelayDevice } from '../../src/main/relay-device'
import { handleUseSourceRoutes, isUseSourceRoute } from '../../src/main/use-source-routes'
import type { WorkspaceStore } from '../../src/main/store'
import { handleStreamRoutes } from '../../src/main/stream-routes'
import { createStreamService } from '../../src/main/stream-service'
import { createV2CallTokenVerifier, v2KeysOverHttp } from '../../src/main/v2-call-token'
import type { AccountFile } from '../../src/main/account-v2'
import type { BoardPhase } from '../../src/shared/board'
import type { TerminalNodeData, WorkspaceMeta, WorkspaceState } from '../../src/shared/model'
import { PATH_REPORT_ROUTE } from '../../src/shared/path-report'
import type { AgentTuningState } from '../../src/shared/agent-tuning'
import type { CardRouteState, RouteState } from '../../src/shared/route'
import type { TerminalActivity, TurnRecord } from '../../src/shared/turn'
import { GIT, PROFILE, activity, browser, note, terminal } from '../fleet-fixture'

/**
 * ONE MACHINE OF AN ACCOUNT, FOR THE CONSOLE'S ACCEPTANCE: what the console
 * meets when it reaches a desktop through the relay, without the app.
 *
 * WHAT IS REAL: the line it holds to the registry and the bridge that turns
 * frames back into requests (main/canvas-link.ts, canvas-bridge.ts), the door
 * a browser enters with the account's pass (main/account-pair.ts, checked
 * against the registry's own keys), the list of devices that door admitted,
 * and the fleet feed (main/fleet). A request reaches the routes below exactly
 * as it reaches a desktop's: on loopback, marked by the bridge, naming the
 * device the registry says is asking.
 *
 * WHAT IS A FIXTURE: the canvas (two workspaces, three agents, a note and a
 * browser, all invented), the terminals (a few frames with colours, a wide
 * character and a cursor; what is typed is echoed and kept) and everything a
 * desktop answers from its own state. Every request is recorded, and so is
 * every address the fixture had no answer for: a route the console asks that
 * is missing here is a finding, not a silent 404.
 */

export const KITCHEN = 'w-kitchen'
export const GARDEN = 'w-garden'
export const ADA = 't-ada'
export const BASIL = 't-basil'
export const CLEO = 't-cleo'

export interface MachineRequest {
  readonly method: string
  readonly path: string
  readonly status: number
  readonly at: number
}

export interface TypedInput {
  readonly terminalId: string
  readonly data: string
  readonly id: string | null
  readonly at: number
}

export interface FixtureMachine {
  readonly deviceId: string
  readonly name: string
  readonly origin: string
  readonly requests: readonly MachineRequest[]
  /** `METHOD /path` of every address this fixture had no answer for, once each. */
  readonly unanswered: readonly string[]
  /** What was typed into a terminal, in the order it arrived. */
  readonly typed: readonly TypedInput[]
  /** Is the line to the registry held now. */
  held(): boolean
  /** Hold the line (a machine with Cookrew open), or let go of it (closed). */
  online(): Promise<void>
  offline(): Promise<void>
  close(): Promise<void>
}

export interface FixtureMachineOptions {
  /** The registry, as a desktop dials it. */
  readonly registry: string
  readonly username: string
  readonly deviceId: string
  readonly name: string
  readonly appVersion: string
  /** The desktop's own session at the registry: what holds its line. */
  readonly token: string
  readonly now?: () => number
}

const ESC = '\u001b'
const CLEAR = `${ESC}[2J${ESC}[H`

/** A terminal's screen as a desktop serializes it: cleared, then drawn, the cursor left after the prompt. */
export const terminalFrame = (name: string): string =>
  [
    CLEAR,
    `${ESC}[1;32m✓${ESC}[0m ${name} on the acceptance stage\r\n`,
    `${ESC}[31mred${ESC}[0m ${ESC}[32mgreen${ESC}[0m ${ESC}[34mblue${ESC}[0m ${ESC}[1;33mbold yellow${ESC}[0m ${ESC}[30;46m on cyan ${ESC}[0m\r\n`,
    `wide: 你好，世界 ｜ ok\r\n`,
    `${ESC}[38;5;208morange 256${ESC}[0m ${ESC}[38;2;120;200;255mtruecolor${ESC}[0m\r\n`,
    `$ `
  ].join('')

interface Session {
  readonly bus: EventEmitter
  readonly cols: number
  readonly rows: number
  screen: string
}

function canvas(): { metas: WorkspaceMeta[]; states: Record<string, WorkspaceState> } {
  const kitchen = {
    name: 'Kitchen',
    dir: '/work/kitchen',
    dirs: ['/work/kitchen'],
    nodes: [
      terminal(ADA, 'Ada', 'claude', { orch: true, brief: 'Keep the invented kitchen running', cwd: '/work/kitchen', git: GIT }),
      terminal(BASIL, 'Basil', '', { cwd: '/work/kitchen', git: GIT, position: { x: 480, y: 0 } }),
      note('n-plan', '# Kitchen plan\n\nmise en place, then service'),
      browser('b-menu', 'Menu', ['https://example.invalid/menu'])
    ],
    connections: [
      { id: 'c1', a: 'n-plan', b: ADA },
      { id: 'c2', a: ADA, b: 'b-menu' }
    ]
  } as unknown as WorkspaceState
  const garden = {
    name: 'Garden',
    dir: '/work/garden',
    dirs: ['/work/garden'],
    nodes: [terminal(CLEO, 'Cleo', 'codex', { cwd: '/work/garden', git: GIT })],
    connections: []
  } as unknown as WorkspaceState
  return {
    metas: [
      { id: KITCHEN, name: 'Kitchen', dir: '/work/kitchen', dirs: ['/work/kitchen'], icon: '🍳', slug: 'kitchen' },
      { id: GARDEN, name: 'Garden', dir: '/work/garden', dirs: ['/work/garden'], icon: '🌿', slug: 'garden' }
    ] as unknown as WorkspaceMeta[],
    states: { [KITCHEN]: kitchen, [GARDEN]: garden }
  }
}

export async function startFixtureMachine(options: FixtureMachineOptions): Promise<FixtureMachine> {
  const now = options.now ?? Date.now
  const started = now()
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-console-machine-'))
  const requests: MachineRequest[] = []
  const unanswered: string[] = []
  const typed: TypedInput[] = []
  const { metas, states } = canvas()
  const focused = KITCHEN

  // ── the canvas and its agents, as the fleet feed reads them ────────────────
  const store = Object.defineProperty(
    Object.assign(new EventEmitter(), {
      list: () => ({ workspaces: metas, activeId: focused }),
      workspaceState: (id: string) => states[id]
    }),
    'focusedId',
    { get: () => focused }
  )
  const live: TerminalActivity[] = [
    activity(ADA, 'thinking', { prompt: 'Plate the invented special', turnStartedAt: started - 20_000, updatedAt: started, glance: { status: '✻ Simmering…', tools: [], message: 'Tasting the sauce' } }),
    activity(CLEO, 'idle', { updatedAt: started })
  ]
  const ledger = new Map<string, TurnRecord[]>([
    [BASIL, [{ index: 1, prompt: 'Chop the invented herbs', reply: 'Chopped.', startedAt: started - 90_000, endedAt: started - 80_000 } as TurnRecord]]
  ])
  const board: BoardSources = {
    activeWorkspaceId: () => focused,
    live: () => live,
    ledger: () => ledger,
    registry: () => [],
    probe: () => new Map<string, BoardPhase>(),
    probeSubscribe: () => () => undefined,
    probeOnChange: () => () => undefined
  }
  const sources = levelsSourcesFrom({
    store: store as unknown as WorkspaceStore,
    board,
    turns: new EventEmitter(),
    machine: { name: () => options.name, appVersion: options.appVersion, profile: () => PROFILE },
    now,
    traits: () => []
  })
  const fleet = createFleetService({ ...sources, now }, 30)

  // ── the door, and who it has let in ───────────────────────────────────────
  const admitted = createAdmittedDeviceStore({ base, now })
  const verifier = createV2CallTokenVerifier({ keys: v2KeysOverHttp(options.registry), now })
  const account = { username: options.username, deviceId: options.deviceId, kind: 'desktop', name: options.name } as unknown as AccountFile
  const door = createAccountPairDoor({ account: () => account, grants: (token) => verifier.grant(token), admitted, platform: 'darwin', now })

  // ── the terminals ─────────────────────────────────────────────────────────
  const sessions = new Map<string, Session>()
  for (const state of Object.values(states)) {
    for (const node of state.nodes) {
      if (node.kind === 'terminal') sessions.set(node.id, { bus: new EventEmitter(), cols: 80, rows: 24, screen: terminalFrame(node.name) })
    }
  }

  const nodeOf = (terminalId: string): TerminalNodeData | null => {
    for (const state of Object.values(states)) {
      const node = state.nodes.find((one) => one.id === terminalId)
      if (node?.kind === 'terminal') return node
    }
    return null
  }
  // Everything the reader keeps (marks, its index) stays under this machine's own directory.
  const records = createStreamService({
    nodeOf,
    documentOf: () => Promise.reject(new Error('this fixture machine holds no transcript')),
    chainOptions: { projectsDir: path.join(base, 'projects'), lineageIds: () => [] },
    markOptions: { dir: path.join(base, 'marks') },
    stateOptions: { dir: path.join(base, 'stream') },
    now
  })

  const seatOf = (url: URL): string => {
    const seat = url.searchParams.get('seat')
    return seat !== null && states[seat] !== undefined ? seat : focused
  }
  const stateOf = (url: URL): WorkspaceState & { dirsGit: Record<string, unknown> } => {
    const state = states[seatOf(url)]
    return { ...state, dirsGit: Object.fromEntries(state.dirs.map((dir) => [dir, GIT])) }
  }
  // A seated request reads its seat as the workspace in front (mobile-api.ts · store.enterSeat).
  const listOf = (url: URL): { workspaces: WorkspaceMeta[]; activeId: string } => ({ workspaces: metas, activeId: seatOf(url) })
  /** The roster, as the agent registry lists it: every agent of every workspace. */
  const roster = (): AgentRegistryEntry[] =>
    metas.flatMap((meta) =>
      states[meta.id].nodes.flatMap((node): AgentRegistryEntry[] =>
        node.kind !== 'terminal'
          ? []
          : [{ id: node.id, name: node.name, preset: node.preset, command: node.command, role: node.role ?? null, cwd: node.cwd, workspaceId: meta.id, workspaceName: meta.name, orch: node.orch === true, spawnedAt: started, active: true, updatedAt: started }]
      )
    )
  /** Routing as a desktop without a gateway says it: absent, nothing routed. */
  const routeState = (): RouteState => ({
    status: 'absent',
    gateway: null,
    why: null,
    defaultModel: null,
    providers: 0,
    models: [],
    quotas: [],
    live: [],
    harnesses: [],
    checkedAt: now(),
    autoGroup: false,
    sharedMcp: true,
    mcpServers: null,
    setup: { ...setupLines('/work/plugin'), addKeyLine: ADD_KEY_STEM }
  })
  const streams = new Set<http.ServerResponse>()

  const route = async (request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<boolean> => {
    const method = request.method ?? 'GET'
    const p = url.pathname
    const bridged = takeRelayDevice(request)
    // Above the gate, as on a desktop: the door is for a device that holds no key here yet.
    if (await handleAccountPairRoutes(request, response, url, door, bridged)) return true
    if (method === 'POST' && p === '/api/pair') {
      // The door's last step shares its path with the offer; the routes above take GET and `/begin`.
      const reply = await door.finish({ body: await readJson<unknown>(request, 16 * 1024).catch(() => null), bridged: bridged === null ? null : { deviceId: bridged.deviceId } })
      respondJson(response, reply.status, reply.body)
      return true
    }
    const token = bearerToken(request)
    const holder = token === null ? null : admitted.deviceFor(token)
    if (method === 'GET' && p === '/api/auth/status') {
      respondJson(response, 200, { scope: holder === null ? 'none' : 'pairing', required: true, canWrite: holder !== null })
      return true
    }
    if (holder === null) {
      respondJson(response, 401, { error: 'Unauthorized — open the pairing URL shown on the desktop (it carries ?token=).' })
      return true
    }
    if (bridged !== null) admitted.record(bridged)
    if (handleFleetRoutes(request, response, url, { service: () => fleet, paired: () => true, gauges: { read: () => null } as never })) return true

    if (method === 'GET' && p === '/api/workspace') return respondJson(response, 200, stateOf(url)), true
    if (method === 'GET' && p === '/api/workspaces') return respondJson(response, 200, listOf(url)), true
    if (method === 'GET' && p === '/api/events') {
      const send = startSse(response)
      streams.add(response)
      request.on('close', () => streams.delete(response))
      if (!url.searchParams.get('boot')) send('workspace', stateOf(url))
      send('workspaces', listOf(url))
      for (const one of live) send('activity', one)
      return true
    }
    if (method === 'POST' && p === '/api/workspaces/switch') {
      const body = await readJson<{ id?: unknown }>(request).catch(() => ({}) as { id?: unknown })
      const id = typeof body.id === 'string' ? body.id : ''
      if (states[id] === undefined) return respondJson(response, 404, { error: `Workspace '${id}' not found` }), true
      // Nothing moves on the machine: the answer gives the device its seat.
      return respondJson(response, 200, { workspaces: metas, activeId: id, seat: id }), true
    }
    if (method === 'GET' && p === '/api/activity') return respondJson(response, 200, live.filter((one) => stateOf(url).nodes.some((node) => node.id === one.terminalId))), true
    if (method === 'GET' && p === '/api/account') return respondJson(response, 200, companionAccount(account, options.registry)), true
    if (method === 'GET' && p === '/api/agents') return respondJson(response, 200, { agents: roster() }), true
    if (method === 'GET' && (p === '/api/presets' || p === '/api/roles' || p === '/api/teams')) return respondJson(response, 200, []), true
    if (method === 'GET' && p === '/api/tuning') return respondJson(response, 200, {}), true
    if (method === 'GET' && p === '/api/route') return respondJson(response, 200, routeState()), true
    if (method === 'GET' && p === '/api/git') return respondJson(response, 200, GIT), true
    // No ear, no voice, no interactive browser: a desktop says so, it does not go silent.
    if (method === 'GET' && p === '/api/listen') return respondJson(response, 200, { available: false, locale: null }), true
    if (method === 'GET' && p === '/api/speak') return respondJson(response, 200, { available: false }), true
    if (method === 'GET' && p === '/api/browser/capabilities') return respondJson(response, 200, { interactive: false }), true
    if (method === 'GET' && p === '/api/browser/thumbs') return respondJson(response, 200, { frames: [] }), true
    if (method === 'GET' && /^\/api\/browser\/[^/]+\/thumb$/.test(p)) return respondJson(response, 404, { error: 'No thumbnail yet' }), true
    // An agent's record (the rail, a window of it, its open tail): the desktop's own routes over
    // the desktop's own reader. These agents have written no transcript yet, and that is what it says.
    if (await handleStreamRoutes(request, response, url, { stream: records, turnHistory: async (terminalId) => ledger.get(terminalId) ?? [] })) return true
    // Where a translation would be sent: nowhere, no remote model is configured.
    if (method === 'GET' && p === '/api/translate/host') return respondJson(response, 200, null), true
    // What is on the owner's screen: this machine has nothing to show one with, and says so in the desktop's own words.
    if (isUseSourceRoute(p)) return await handleUseSourceRoutes(request, response, p, { service: undefined, workspaceId: seatOf(url), paired: true, credential: token }), true
    if (method === 'GET' && p === '/api/terminal-session') return respondJson(response, 200, { stale: false, serverPid: null, serverStartedAt: null, loginAt: null }), true
    if (method === 'POST' && p === '/api/beacon') {
      await readJson<unknown>(request).catch(() => null)
      response.writeHead(204)
      response.end()
      return true
    }
    // No nearer way than the relay: no name on this network, no tailnet, and no direct link offered.
    if (method === 'GET' && p === '/api/reach') return respondJson(response, 200, { deviceId: options.deviceId, lan: [], tailnet: null, trusted: [] }), true
    if (method === 'POST' && p === '/api/rtc/offer') {
      await readJson<unknown>(request).catch(() => null)
      return respondJson(response, 503, { error: 'no direct link offered' }), true
    }
    if (method === 'POST' && p === PATH_REPORT_ROUTE) {
      await readJson<unknown>(request).catch(() => null)
      return respondJson(response, 204, {}), true
    }

    // One card's dials and its route: stock, and direct.
    if (method === 'GET' && /^\/api\/terminal\/[^/]+\/tuning$/.test(p)) {
      const tuning: AgentTuningState = { harness: null, knobs: [], tuning: null, asks: [], caveat: null, records: [] }
      return respondJson(response, 200, tuning), true
    }
    if (method === 'GET' && /^\/api\/terminal\/[^/]+\/route$/.test(p)) {
      const card: CardRouteState = { route: 'direct', effective: null, appliesOn: 'restart', live: null, turn: null, offline: false, note: null, gateway: 'absent', routable: true }
      return respondJson(response, 200, card), true
    }
    const pty = /^\/api\/terminal\/([^/]+)\/(stream|raw|resize|seed|seen|jump)$/.exec(p)
    if (pty) {
      const terminalId = decodeURIComponent(pty[1])
      const session = sessions.get(terminalId)
      if (!session) return respondJson(response, 404, { error: 'Terminal not running' }), true
      if (method === 'GET' && pty[2] === 'stream') {
        const send: SseSend = startSse(response)
        streams.add(response)
        // The size first, then the screen: a viewer sizes its grid before a byte is drawn.
        send('hello', { cols: session.cols, rows: session.rows, stream: randomUUID() })
        send('data', session.screen)
        const onData = (data: string): void => send('data', data)
        session.bus.on('data', onData)
        request.on('close', () => {
          streams.delete(response)
          session.bus.removeListener('data', onData)
        })
        return true
      }
      if (method === 'POST' && pty[2] === 'raw') {
        const body = await readJson<{ data?: unknown; id?: unknown }>(request).catch(() => ({}) as { data?: unknown; id?: unknown })
        if (typeof body.data === 'string' && body.data.length > 0) {
          typed.push({ terminalId, data: body.data, id: typeof body.id === 'string' ? body.id : null, at: now() })
          // What a shell does with keys: shows them.
          const echo = body.data.replace(/\r/g, '\r\n$ ')
          session.screen += echo
          session.bus.emit('data', echo)
        }
        return respondJson(response, 200, { ok: true }), true
      }
      if (method === 'POST' && pty[2] === 'seed') {
        await readJson<unknown>(request).catch(() => null)
        // No history beyond the screen: nothing to seed a viewer with.
        return respondJson(response, 200, { ok: false }), true
      }
      if (method === 'POST') {
        await readJson<unknown>(request).catch(() => null)
        return respondJson(response, 200, { ok: true }), true
      }
    }
    return false
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://machine.invalid')
    const method = request.method ?? 'GET'
    response.on('finish', () => requests.push({ method, path: `${url.pathname}${url.search}`, status: response.statusCode, at: now() }))
    response.on('close', () => {
      if (!response.writableFinished) requests.push({ method, path: `${url.pathname}${url.search}`, status: response.statusCode, at: now() })
    })
    void route(request, response, url)
      .then((handled) => {
        if (handled) return
        const what = `${method} ${url.pathname}`
        if (!unanswered.includes(what)) unanswered.push(what)
        respondJson(response, 404, { error: `this fixture machine has no ${url.pathname}` })
      })
      .catch((error: unknown) => {
        if (!response.headersSent) respondJson(response, 500, { error: error instanceof Error ? error.message : 'fixture failed' })
        else response.destroy()
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  // ── its line to the registry ──────────────────────────────────────────────
  let link: CanvasLink | null = null
  const online = async (): Promise<void> => {
    if (link !== null) return
    const made = createCanvasLink({ origin: () => options.registry, credential: () => ({ token: options.token, deviceId: options.deviceId }) })
    const bridge = createCanvasBridge({ send: (line) => made.send(line), dial: loopbackDialer(port) })
    made.onFrame(bridge.frame)
    made.onDrop(bridge.reset)
    made.start()
    link = made
    const deadline = Date.now() + 8000
    while (!made.held()) {
      if (Date.now() > deadline) throw new Error(`${options.name} never held its line to the registry`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const offline = async (): Promise<void> => {
    link?.stop()
    link = null
  }

  return {
    deviceId: options.deviceId,
    name: options.name,
    origin: `http://127.0.0.1:${port}`,
    requests,
    unanswered,
    typed,
    held: () => link?.held() ?? false,
    online,
    offline,
    close: async () => {
      await offline()
      for (const stream of streams) stream.destroy()
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
      rmSync(base, { recursive: true, force: true })
    }
  }
}
