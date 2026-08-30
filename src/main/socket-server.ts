import net from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  AgentRole,
  BrowserNodeData,
  CanvasNode,
  CliRequest,
  CliResponse,
  DEFAULT_NOTE_SIZE,
  DEFAULT_TERMINAL_SIZE,
  GitInfo,
  NoteNodeData,
  TeamForkSpec,
  TeamMeta,
  TerminalNodeData,
  WorkspaceList,
  WorkspaceMeta
} from '../shared/model'
import { resolveCallerTerminalId } from '../shared/caller-identity'
import { WorkspaceStore, WorkspaceNodeHit } from './store'
import type { MobileEndpoint } from './mobile-endpoints'
import { renderMobileHelp, renderRotated } from './mobile-cli-text'
import { readProxyConfig, tailnetProxyGaps } from './proxy-bypass'
import { AgentRegistry, AgentRegistryEntry } from './agent-registry'
import { planRecruitTarget } from '../shared/workspace-dirs'
import { PtyManager, multiplexer, sessionNameFor, type PtySession } from './pty'
import { askRaw, askTerminal, decodeRawEscapes } from './ask'
import {
  DeliveryError,
  deliverAndConfirm,
  replyText,
  terminalDeliveryDeps
} from './ask-delivery'
import { PRESETS } from './presets'
import { RoutineScheduler, parseInterval } from './routines'
import type { VoiceEngine } from './voice'
import type { TurnTracker } from './turn-tracker'
import type { DispatchService } from './dispatch'

export interface SocketServerDeps {
  store: WorkspaceStore
  ptys: PtyManager
  /** Spawn a terminal's PTY with turn tracking (same path as IPC creation). */
  spawnTerminal: (t: { id: string; command: string; cwd: string }) => void
  /** Turn history source for `cookrew fork` validation/output. */
  turns: TurnTracker
  /**
   * The attach-free dispatch engine, for `ask --no-wait` and `cookrew
   * dispatch <id>`. Optional so embedders and tests construct the socket
   * server without one; absent, --no-wait refuses honestly rather than
   * silently falling back to a blocking ask the caller did not ask for.
   */
  dispatch?: DispatchService
  /** Durable global agent directory (~/.cookrew/agents.json). */
  agents: AgentRegistry
  /** Fork an agent from one of its turns (same path as IPC forking). */
  forkTerminal: (sourceId: string, turnIndex?: number) => TerminalNodeData
  routines: RoutineScheduler
  /** Ask the renderer to run a browser command; resolves with its output. */
  browserCommand: (args: string[], terminalId: string) => Promise<string>
  notify: (message: string) => void
  /** Debug helper: capture the app window to a PNG, returns the file path. */
  captureWindow: () => Promise<string>
  /** Debug helper: inject real input events into the app window. */
  injectInput: (args: string[]) => Promise<string>
  voice: VoiceEngine
  /** LAN URLs of the mobile companion server. */
  mobileUrls: () => string[]
  /** The same endpoints, classified (tailnet / LAN) and ordered. */
  mobileEndpoints: () => MobileEndpoint[]
  /** Endpoint hosts the running HTTPS cert does not cover. */
  uncoveredCertHosts: () => string[]
  /** Revoke the pairing token; every paired device must re-pair. */
  rotatePairingToken: () => string
  /** LAN URLs of the TV wall (HTTP, wall-token bearing). */
  /** Workspace registry + switching (switching rebuilds PTYs). */
  listWorkspaces: () => WorkspaceList
  createWorkspace: (name: string, dir: string) => WorkspaceMeta
  /** FEATURE 1: workspace pre-populated from a saved team template. */
  createWorkspaceFromTeam: (name: string, dir: string, team: string) => Promise<WorkspaceMeta>
  switchWorkspace: (nameOrId: string) => WorkspaceMeta
  /** Workspace v2: remove + multi-directory + per-terminal cwd + git. */
  removeWorkspace: (nameOrId: string) => WorkspaceList
  addWorkspaceDir: (id: string, dir: string) => WorkspaceList
  removeWorkspaceDir: (id: string, dir: string) => WorkspaceList
  setPrimaryDir: (id: string, dir: string) => WorkspaceList
  /** Async: the respawn waits for the old session to actually be gone. */
  setTerminalCwd: (nodeId: string, dir: string) => Promise<CanvasNode>
  gitInfo: (dir: string) => Promise<GitInfo>
  /** Team fork/save + roles (spec note team-fork-roles-v1). */
  teamFork: (spec: TeamForkSpec) => Promise<WorkspaceMeta>
  // Whole-canvas by design: the CLI has no selection, so no nodeIds and no
  // teamCopy here — the selection bar's copy rides IPC / the mobile API.
  teamSave: (name?: string) => TeamMeta
  teamList: () => TeamMeta[]
  roleSave: (input: { nodeId: string; name: string; rolePrompt: string }) => AgentRole
  roleList: () => AgentRole[]
  roleDelete: (name: string) => boolean
}

/**
 * Newline-delimited JSON server on a Unix socket. This is the `cookrew` CLI's
 * backend over the local bridge socket.
 */
export function startSocketServer(deps: SocketServerDeps): net.Server {
  const { ptys } = deps
  if (existsSync(ptys.socketPath)) unlinkSync(ptys.socketPath)

  const server = net.createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        void handleLine(line, socket, deps)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => socket.destroy())
  })

  server.listen(ptys.socketPath)
  return server
}

async function handleLine(
  line: string,
  socket: net.Socket,
  deps: SocketServerDeps
): Promise<void> {
  let request: CliRequest
  try {
    request = JSON.parse(line) as CliRequest
  } catch {
    socket.write(JSON.stringify({ id: 'unknown', ok: false, error: 'Bad request JSON' }) + '\n')
    return
  }
  try {
    const output = await retryTransient(() => dispatch(request, deps))
    respond(socket, { id: request.id, ok: true, output })
  } catch (error) {
    respond(socket, {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      // Per-outcome exit code (delivery contract): a shell caller's next
      // action differs per outcome, so collapsing every failure to 1 would
      // rebuild the ambiguity one layer down.
      ...(error instanceof DeliveryError ? { exitCode: error.exitCode } : {})
    })
  }
}

/**
 * A dispatch failure that a brief wait may resolve: the target terminal's
 * PTY is momentarily unreachable during a workspace switch (teardown →
 * rebuild). Retried once; a persistent condition (wrong workspace, not the
 * orch, unknown command) is a plain Error and never retried.
 */
export class RetryableDispatchError extends Error {}

/** How long to wait before the single retry across a workspace switch. */
const SWITCH_RETRY_MS = 500

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Run a dispatch, retrying ONCE after a short delay if it fails with a
 * transient not-attached error — so a command that races a workspace switch
 * succeeds once the PTYs finish rebuilding instead of spuriously failing.
 * The retryable throws happen before any side effect (session lookup fails
 * before a prompt is sent), so a retry never double-acts.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (!(error instanceof RetryableDispatchError)) throw error
    await sleep(SWITCH_RETRY_MS)
    return fn()
  }
}

function respond(socket: net.Socket, response: CliResponse): void {
  try {
    socket.write(JSON.stringify(response) + '\n')
  } catch (error) {
    console.error('Socket write failed:', error)
  }
}

// ---- command dispatch ----

async function dispatch(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const { cmd, args } = request
  switch (cmd) {
    case 'list':
      return cmdList(request, deps)
    case 'ask':
      return cmdAsk(request, deps)
    case 'check':
      return cmdCheck(request, deps)
    case 'status':
      return cmdStatus(request, deps)
    case 'dispatch':
      return cmdDispatch(request, deps)
    case 'note':
      return cmdNote(request, deps)
    case 'connect':
      return cmdConnect(request, deps)
    case 'recruit':
      return cmdRecruit(request, deps)
    case 'dismiss':
      return cmdDismiss(request, deps)
    case 'orch':
      return cmdOrch(request, deps)
    case 'fork':
      return cmdFork(request, deps)
    case 'preset':
      return cmdPreset()
    case 'notify':
      requireOrch(request, deps)
      deps.notify(args.join(' '))
      return 'OK'
    case 'browser':
      return cmdBrowser(request, deps)
    case 'routine':
      return cmdRoutine(request, deps)
    case 'voice':
      return cmdVoice(request, deps)
    case 'mobile':
      return cmdMobile(request, deps)
    case 'workspace':
      return cmdWorkspace(request, deps)
    case 'team':
      return cmdTeam(request, deps)
    case 'role':
      return cmdRole(request, deps)
    case 'terminal':
      return cmdTerminalCwd(request, deps)
    case 'git':
      return cmdGit(request, deps)
    case 'app-shot':
      return deps.captureWindow()
    case 'ui':
      return deps.injectInput(args)
    case 'help':
      return HELP_TEXT
    default:
      throw new Error(`Unknown command '${cmd}'. Run 'cookrew help'.`)
  }
}

function self(request: CliRequest, deps: SocketServerDeps): TerminalNodeData {
  // `--as "Agent Name"`: the caller is a plain shell, not a pane, so it names
  // the terminal to speak as. Only consulted when there is no pane identity —
  // an agent inside its own pane can never impersonate another by passing it.
  if (!request.terminalId && typeof request.flags.as === 'string') {
    return resolveSelfByName(request.flags.as, deps.store, deps.agents)
  }
  // A pane's exported COOKREW_TERMINAL_ID is right for that pane's own agent
  // and wrong for one the harness spawned in the background under it, which
  // inherits the environment wholesale. The session→node binding is the fact
  // that travels with the agent, so it outranks the env when the two disagree.
  // Optional-call for the same reason `nodeAcrossWorkspaces?.()` is below: a
  // fake store in a test need not implement the global walk, and an identity
  // repair that cannot see the bindings simply does not repair.
  const identity = resolveCallerTerminalId({
    envTerminalId: request.terminalId,
    sessionId: request.sessionId ?? null,
    terminals: deps.store.terminalsAcross?.() ?? []
  })
  if (identity.repairedFrom !== null) {
    console.error(
      `cli identity repaired: env claimed ${identity.repairedFrom}, ` +
        `session binds to ${identity.terminalId}`
    )
  }
  return resolveSelf(identity.terminalId, deps.store, deps.agents)
}

/**
 * Resolve a caller identity from an agent NAME.
 *
 * Exists for `cookrew` on the system PATH: outside a pane there is no terminal
 * id, and every identity-scoped command needs one. Names are what the user
 * actually knows — they are what the canvas and `cookrew list` show.
 *
 * Ambiguity is an ERROR, not a first match: two agents may share a name across
 * workspaces, and silently picking one would send a prompt to the wrong agent.
 */
export function resolveSelfByName(
  name: string,
  store: WorkspaceStore,
  agents?: AgentRegistry
): TerminalNodeData {
  const wanted = name.trim().toLowerCase()
  const matches = (store.terminalsAcross?.() ?? store.terminals()).filter(
    (t) => t.name.trim().toLowerCase() === wanted
  )
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(
      `More than one terminal is named "${name}". Run it from that agent's own ` +
        'terminal, or rename one so the name is unambiguous.'
    )
  }
  // Same reboot-safe fallback resolveSelf has: the registry outlives workspace
  // files, so a name it still knows is a valid identity.
  const entry = agents?.list().find((e) => e.name.trim().toLowerCase() === wanted)
  if (entry) return terminalFromRegistry(entry)
  throw new Error(`No terminal named "${name}". See: cookrew list --all`)
}

/** Minimal terminal node synthesized from a registry entry (reboot fallback). */
function terminalFromRegistry(entry: AgentRegistryEntry): TerminalNodeData {
  return {
    kind: 'terminal',
    id: entry.id,
    name: entry.name,
    preset: entry.preset,
    command: entry.command,
    cwd: entry.cwd,
    orch: entry.orch,
    role: entry.role,
    position: { x: 0, y: 0 },
    size: DEFAULT_TERMINAL_SIZE
  }
}

/**
 * Neighbors of a node with their owning workspaces: cross-workspace when the
 * store supports it (mirrored edges resolve globally), else active-scoped.
 */
function connectedOf(store: WorkspaceStore, id: string): WorkspaceNodeHit[] {
  return (
    store.connectedToAcross?.(id) ??
    store.connectedTo(id).map((node) => ({ node, workspaceId: store.ownerOf(id) ?? store.focusedId }))
  )
}

/**
 * Resolve the terminal a CLI request came from. When the node isn't in the
 * active workspace, name BOTH workspaces explicitly — the home one it lives
 * in and the active one — so an orch command run from a switched-away
 * workspace says what to do instead of a bare "not attached". Split from
 * `self` so it is unit-testable without a full deps object.
 */
export function resolveSelf(
  terminalId: string,
  store: WorkspaceStore,
  agents?: AgentRegistry
): TerminalNodeData {
  const node = store.node(terminalId)
  if (node && node.kind === 'terminal') return node
  // Layer 1 (cross-workspace-orch-fix-dec): the orch keeps working after a
  // switch — resolve across ALL workspaces before touching error paths.
  // Optional-call: fake stores in tests may not implement the global lookup.
  const hit = store.nodeAcrossWorkspaces?.(terminalId)
  if (hit && hit.node.kind === 'terminal') return hit.node
  // Reboot-safe fallback: the durable agent registry still knows who this is
  // even when no workspace file does.
  const entry = agents?.lookup(terminalId)
  if (entry) return terminalFromRegistry(entry)
  if (!node) {
    const home = store.workspaceOfNode(terminalId)
    const active = store.activeMeta()
    if (home && home.id !== active.id) {
      throw new Error(
        `Your terminal lives in workspace "${home.name}", but "${active.name}" is active. ` +
          `Switch back with: cookrew workspace switch "${home.name}"`
      )
    }
  }
  if (!terminalId) {
    // The `cookrew` on the system PATH lands here: a plain shell has no pane,
    // so say what to do rather than only what is wrong.
    throw new Error(
      'No caller identity: this shell is not a Cookrew terminal. Name one with ' +
        '--as, e.g. `cookrew --as "Conductor" list`, or use `cookrew list --all`.'
    )
  }
  throw new Error('This shell is not attached to a Cookrew terminal node')
}

/**
 * The workspace a CLI command is ABOUT: the one owning the pane it came from.
 *
 * Every `cookrew` invocation arrives from inside a terminal, and that terminal
 * already knows which workspace it lives in — so the CLI never has to consult
 * what a desktop happens to be showing. This is what lets one global CLI socket
 * serve N concurrent workspace sessions (marketplace-architecture §11): scope
 * travels with the caller, not with focus.
 *
 * Falls back to focus only when the caller cannot be placed at all — a shell
 * invoking `cookrew --as "Name"` against a registry entry whose node is gone.
 */
export function callerWorkspaceId(request: CliRequest, deps: SocketServerDeps): string {
  return deps.store.ownerOf(self(request, deps).id) ?? deps.store.focusedId
}

/**
 * callerWorkspaceId for commands that must still work WITHOUT a caller.
 *
 * self() throws 'not attached to a Cookrew terminal' for a plain shell, which
 * is right for identity-scoped commands (ask, fork, recruit) and wrong for
 * commands that merely prefer the caller's scope. `cookrew workspace dir list`
 * from a normal terminal is a legitimate invocation and used to work; making
 * scope resolution throw would have regressed it.
 */
export function tryCallerWorkspaceId(
  request: CliRequest,
  deps: SocketServerDeps
): string | undefined {
  try {
    return deps.store.ownerOf(self(request, deps).id)
  } catch {
    return undefined
  }
}

function requireOrch(request: CliRequest, deps: SocketServerDeps): TerminalNodeData {
  const me = self(request, deps)
  if (!me.orch) throw new Error('This terminal is not the Orch')
  return me
}

function findConnected(
  request: CliRequest,
  deps: SocketServerDeps,
  name: string,
  kind: 'terminal' | 'note' | 'browser'
) {
  const me = self(request, deps)
  const hit = connectedOf(deps.store, me.id).find(
    (h) => h.node.kind === kind && h.node.name.toLowerCase() === name.toLowerCase()
  )
  if (hit) return hit.node
  // Reboot fallback: a teammate the workspace files lost but the durable
  // registry still tracks as active (agent-registry-spawn-broadca).
  if (kind === 'terminal') {
    const entry = deps.agents
      .list()
      .find((e) => e.active && e.name.toLowerCase() === name.toLowerCase())
    if (entry) return terminalFromRegistry(entry)
  }
  throw new Error(`${kind === 'terminal' ? 'Agent' : kind} '${name}' not found among your connections. Run 'cookrew list'.`)
}

/**
 * Why browser commands need a scope check that `ask`/`check`/`note` do not:
 * those act on store data or a tmux session, which resolveSelf deliberately
 * reaches ACROSS workspaces so an orch keeps working after a switch. A browser
 * is different — it is driven through a webview (or a headless instance) that
 * exists only for the ACTIVE workspace, while `cookrew list` enumerates
 * connections across all of them. That mismatch produced a closed loop: list
 * advertised a browser, the webview lookup answered "not found. Run 'cookrew
 * list'", and an agent could bounce between the two forever. Refuse up front,
 * naming the workspace to switch to. Pure so the wording is pinned by tests.
 */
export function browserWorkspaceError(scope: {
  active: { id: string; name: string }
  /** Workspace holding the CALLING terminal; absent = registry-only (post
   *  reboot), which is not evidence of a cross-workspace call. */
  caller?: { id: string; name: string }
  /** The browser the subcommand names, when it resolves to a connected node. */
  browser?: { name: string; workspaceId: string; workspaceName: string }
}): string | null {
  // The browser's own home is the more actionable answer, so it wins.
  if (scope.browser && scope.browser.workspaceId !== scope.active.id) {
    return (
      `Browser '${scope.browser.name}' lives in workspace "${scope.browser.workspaceName}", ` +
      `but "${scope.active.name}" is active. Browsers are driven in the active workspace only — ` +
      `switch with: cookrew workspace switch "${scope.browser.workspaceName}"`
    )
  }
  if (scope.caller && scope.caller.id !== scope.active.id) {
    return (
      `Your terminal lives in workspace "${scope.caller.name}", but "${scope.active.name}" is active. ` +
      `Browser commands run in the active workspace only — ` +
      `switch with: cookrew workspace switch "${scope.caller.name}"`
    )
  }
  return null
}

export async function cmdBrowser(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const me = self(request, deps)
  // DELIBERATELY focus, not the caller's workspace. Everything below resolves
  // through focused-scoped lookups (node/nodeByName) and browserCommand drives
  // the engine this process actually booted, so `active` here means "where a
  // browser can be driven", which is boot scope — the same question
  // bootsTerminalsFor() names in index.ts. Scoping it to the caller would emit
  // error messages that contradict what the engine then does. It converts when
  // the browser runtime is scoped per session, not before.
  const activeId = deps.store.focusedId
  const active = { id: activeId, name: workspaceName(deps, activeId) }
  const [sub, name] = request.args

  // Only `create` cares where the CALLER lives: it anchors the new node to the
  // caller's position and connects the two, which is impossible across a
  // workspace boundary. Every other subcommand just needs the BROWSER to be
  // here, so a caller parked elsewhere must keep working (it did before).
  if (sub === 'create') {
    if (!deps.store.node(me.id)) {
      const home = deps.store.workspaceOfNode(me.id)
      const error = browserWorkspaceError({
        active,
        caller: home ? { id: home.id, name: home.name } : undefined
      })
      if (error) throw new Error(error)
    }
    return deps.browserCommand(request.args, request.terminalId)
  }

  // Fast path (this runs per snapshot/click/type): an in-memory scan of the
  // ACTIVE workspace. Only when the name misses here do we pay the
  // across-workspaces reads — i.e. on the error path, never in the hot loop.
  // Resolving locally first also means a local browser always wins over a
  // same-named one parked elsewhere, matching what the engines will drive.
  if (name && !deps.store.nodeByName(name, 'browser')) {
    const parked = connectedOf(deps.store, me.id).find(
      (h) => h.node.kind === 'browser' && h.node.name.toLowerCase() === name.toLowerCase()
    )
    const error = parked
      ? browserWorkspaceError({
          active,
          browser: {
            name: parked.node.name,
            workspaceId: parked.workspaceId,
            workspaceName: workspaceName(deps, parked.workspaceId)
          }
        })
      : null
    if (error) throw new Error(error)
  }
  return deps.browserCommand(request.args, request.terminalId)
}

function workspaceName(deps: SocketServerDeps, id: string): string {
  return deps.listWorkspaces().workspaces.find((w) => w.id === id)?.name ?? id
}

function cmdList(request: CliRequest, deps: SocketServerDeps): string {
  if (request.flags.all) return cmdListAll(deps)
  const me = self(request, deps)
  // Relative to where the CALLER lives. An agent in workspace B asking what it
  // is connected to must be told "[workspace: X]" against B — its own canvas —
  // not against whichever workspace a desktop somewhere is displaying.
  const activeId = deps.store.ownerOf(me.id) ?? deps.store.focusedId
  const wsName = (id: string): string =>
    deps.listWorkspaces().workspaces.find((w) => w.id === id)?.name ?? id
  const connected = connectedOf(deps.store, me.id)
  const agents = connected.filter((h) => h.node.kind === 'terminal')
  const notes = connected.map((h) => h.node).filter((n) => n.kind === 'note') as NoteNodeData[]
  const browsers = connected.filter((h) => h.node.kind === 'browser')

  const lines: string[] = ['You:', `  - name: "${me.name}", orch: ${me.orch}`]
  if (agents.length > 0) {
    lines.push('', 'Connected agents (use `cookrew ask/check`):')
    for (const h of agents) {
      const a = h.node as TerminalNodeData
      const ws = h.workspaceId !== activeId ? ` [workspace: ${wsName(h.workspaceId)}]` : ''
      lines.push(`  - name: "${a.name}"${a.role ? `, role: "${a.role}"` : ''}${ws}`)
    }
  }
  if (browsers.length > 0) {
    lines.push('', 'Connected browsers (use `cookrew browser ...`):')
    for (const h of browsers) {
      const p = h.node as BrowserNodeData
      // Agents already carried this tag; browsers did not, so a listing could
      // advertise one that `cookrew browser ...` then refuses (it is driven in
      // the active workspace only). Say where it lives, and that it is parked.
      const ws =
        h.workspaceId !== activeId
          ? ` [workspace: ${wsName(h.workspaceId)} — switch to use it]`
          : ''
      lines.push(`  - name: "${p.name}" - url: ${p.url}${ws}`)
    }
  }
  if (notes.length > 0) {
    lines.push('', 'Connected notes (use `cookrew note read/write/edit`):')
    for (const n of notes) lines.push(`  - name: "${n.name}"${n.locked ? ' (locked)' : ''}`)
  }
  if (agents.length + notes.length + browsers.length === 0) {
    lines.push('', 'No connected agents, notes, or browsers. Connect nodes on the canvas or use `cookrew note create`.')
  }
  return lines.join('\n')
}

/** Global roster from the durable agent registry, grouped by workspace. */
function cmdListAll(deps: SocketServerDeps): string {
  const entries = deps.agents.list()
  if (entries.length === 0) return 'No agents recorded yet (the registry fills as agents spawn).'
  const activeId = deps.store.focusedId
  const byWorkspace = new Map<string, AgentRegistryEntry[]>()
  for (const e of entries) {
    byWorkspace.set(e.workspaceId, [...(byWorkspace.get(e.workspaceId) ?? []), e])
  }
  const lines: string[] = ['Global agent roster (all workspaces):']
  for (const [wsId, group] of byWorkspace) {
    const active = wsId === activeId ? ' (active workspace)' : ''
    lines.push('', `Workspace "${group[0].workspaceName}"${active}:`)
    for (const e of group) {
      const bits = [e.preset, e.orch ? 'orch' : '', e.role ?? ''].filter(Boolean).join(', ')
      lines.push(`  - "${e.name}" (${bits}) — ${e.active ? 'active' : 'inactive'} — ${e.cwd}`)
    }
  }
  return lines.join('\n')
}

async function cmdAsk(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const [name, prompt] = request.args
  if (!name) throw new Error('Usage: cookrew ask "Agent Name" "prompt" | cookrew ask "Agent" --raw "bytes"')
  const target = findConnected(request, deps, name, 'terminal') as TerminalNodeData
  let session = deps.ptys.get(target.id)
  if (!session) {
    // Cross-workspace / after reboot: the tmux session may be alive with its
    // PTY detached (workspace switch drops clients). Reattach through the
    // normal spawn path — tmux new-session -A rejoins, never restarts.
    try {
      deps.spawnTerminal(target)
    } catch (error) {
      console.error('Reattach failed:', error)
    }
    session = deps.ptys.get(target.id)
  }
  // Still transient during a workspace switch (PTYs rebuilding) — retried once.
  if (!session) throw new RetryableDispatchError(`Agent '${target.name}' has no running terminal`)
  if (request.flags.raw) {
    return askRaw(session, decodeRawEscapes(String(request.flags.raw)))
  }
  if (!prompt) throw new Error('Missing prompt')
  // No armed-dispatch check here, on purpose (Sol r5 P0-1): a route-level
  // refusal would only be a fast path with a check-to-submit race behind it.
  // The load-bearing serialization lives at the submit site — askTerminal
  // acquires the per-terminal producer lease (Sol r6 P0-1) and holds it
  // through submission acknowledgement: an armed dispatch is durably
  // preempted, a dispatch DELIVERING right now is preempted-then-displaced,
  // and a second concurrent owner ask throws 'another owner submission is in
  // flight' — surfaced to the CLI caller as this command's error.
  // --no-wait: hand back a DISPATCH ID instead of blocking.
  //
  // The id is the correlation, and that is the whole point. A caller that
  // waits for "the next turn.completed" matches whatever finishes next —
  // including the PREVIOUS round's turn replayed by the event stream on
  // connect, which is how an all-quiet gets declared over agents that never
  // started. A dispatch id did not exist when the previous turn ended, so it
  // cannot match it. Correct by construction rather than by careful timing.
  if (request.flags['no-wait']) {
    if (!deps.dispatch) throw new Error('--no-wait needs the dispatch engine, which is not wired')
    const result = await deps.dispatch.dispatch(target.id, { text: prompt })
    const body = result.body as { dispatchId?: string; error?: string }
    if (result.status !== 202 || !body.dispatchId) {
      throw new Error(body.error ?? `dispatch refused (${result.status})`)
    }
    return `${body.dispatchId}\n(started — await it with: cookrew dispatch ${body.dispatchId})`
  }

  // Same verified path the phone uses — the order lives in deliverAndConfirm.
  const { reply, submitRetries } = await deliverAndConfirm({
    terminalId: target.id,
    agentName: target.name,
    prompt,
    deliver: () => askTerminal(session, prompt),
    observe: terminalDeliveryDeps(deps.turns, (data) => session.write(data))
  })

  if (deps.voice.enabled) {
    deps.voice.speakReply(target.name, reply).catch((error) => {
      console.error('Voice reply failed:', error)
    })
  }
  return replyText(reply, submitRetries)
}



/**
 * The truthful busy/idle fact — from the TURN TRACKER, never herdr.
 *
 * herdr's agent_status is a per-pane detector and it flaps: measured stuck at
 * `idle` under a live 48-second spinner, and the owner watched it report idle
 * for six actively-working agents. A status that is wrong in the direction of
 * "done" is the worst one to build an orchestrator on, because the orchestrator
 * then dispatches into a busy agent or declares an all-quiet that is not.
 *
 * The tracker already knows, and its four phases carry a distinction nothing
 * surfaced before: `replied` means the turn ENDED and nobody has looked at it.
 * An agent that answered with a plan and stopped is in `replied`, not `idle`
 * and not `thinking` — which is exactly the state that "looks identical to
 * still working" from the outside. Every continuation needs a fresh dispatch,
 * and this is the fact that says so.
 *
 * THE LIMIT, STATED: this cannot see a WEDGED pane. A pane that has stopped
 * reading input produces no output, so the tracker sees quiescence and reports
 * `idle` — which is exactly how a wedge masquerades as an idle agent and a
 * lane stops silently for an hour. A wedge is only provable RELATIVE TO A
 * WRITE (bytes in, nothing painted), so it is detected on the delivery path
 * and surfaced there as `unresponsive`. Reading `idle` here means "no turn is
 * running", never "this agent is healthy and available".
 */
function cmdStatus(request: CliRequest, deps: SocketServerDeps): string {
  const [name] = request.args
  const activities = deps.turns.list()
  const rows = name
    ? activities.filter(
        (entry) =>
          entry.terminalId === (findConnected(request, deps, name, 'terminal') as TerminalNodeData).id
      )
    : activities

  if (rows.length === 0) {
    // No tracker entry is NOT idle — it is no view at all (a detached pane, a
    // dormant workspace). Saying "idle" here would be the same lie the
    // delivery contract refuses: our blindness reported as their state.
    return name
      ? `${name}: unverifiable — not tracked in this workspace (detached or dormant); no busy/idle fact available`
      : 'No tracked terminals in this workspace.'
  }

  return rows
    .map((entry) => {
      const label = deps.store.node(entry.terminalId)?.name ?? entry.terminalId.slice(0, 8)
      const meaning: Record<string, string> = {
        thinking: 'working',
        waiting: 'BLOCKED on a human',
        replied: 'turn ENDED, unread — a continuation needs a fresh dispatch',
        idle: 'idle'
      }
      const since =
        entry.turnStartedAt !== null && entry.turnStartedAt !== undefined
          ? ` (${Math.round((Date.now() - entry.turnStartedAt) / 1000)}s)`
          : ''
      return `${label}: ${entry.phase} — ${meaning[entry.phase] ?? entry.phase}${since} · ${entry.turnCount} turns`
    })
    .join('\n')
}

/**
 * `cookrew dispatch <id>` — what became of THAT dispatch.
 *
 * Correlated by identity, never by time. The record walks submitted → running
 * → done{turnIndex, reply} | failed | interrupted, so a caller polls one id
 * and can never be handed a different turn's completion. This is the
 * side-step for the SSE replay trap rather than a documentation of it: the
 * event stream replays history on connect, so a watcher started AFTER a
 * dispatch matches the previous round and fires instantly-false.
 */
function cmdDispatch(request: CliRequest, deps: SocketServerDeps): string {
  const [dispatchId] = request.args
  if (!dispatchId) throw new Error('Usage: cookrew dispatch <dispatchId>')
  if (!deps.dispatch) throw new Error('The dispatch engine is not wired')
  const result = deps.dispatch.lookup(dispatchId)
  if (result.status !== 200) {
    throw new Error((result.body as { error?: string }).error ?? 'no such dispatch')
  }
  const record = result.body as {
    state: string
    agentName?: string
    turnIndex?: number
    error?: string
    hasReply?: boolean
  }
  const lines = [`${record.agentName ?? dispatchId}: ${record.state}`]
  if (record.turnIndex !== undefined) lines.push(`turn ${record.turnIndex}`)
  if (record.hasReply) lines.push('reply recorded')
  if (record.error) lines.push(record.error)
  // A dispatch that ENDED without completing must not exit 0 — the same rule
  // the ask verb follows. `interrupted` is deliberately not `failed`: the work
  // may well have happened, we simply stopped being able to see it.
  if (record.state === 'failed' || record.state === 'interrupted') {
    throw new DeliveryError('unverifiable', record.agentName ?? dispatchId)
  }
  return lines.join(' · ')
}

function cmdCheck(request: CliRequest, deps: SocketServerDeps): string {
  const [name] = request.args
  if (!name) throw new Error('Usage: cookrew check "Agent Name"')
  const target = findConnected(request, deps, name, 'terminal') as TerminalNodeData
  let session = deps.ptys.get(target.id)
  if (!session) {
    // Cross-workspace / after reboot: the tmux session may be alive with its
    // PTY detached (workspace switch drops clients). Reattach through the
    // normal spawn path — tmux new-session -A rejoins, never restarts.
    try {
      deps.spawnTerminal(target)
    } catch (error) {
      console.error('Reattach failed:', error)
    }
    session = deps.ptys.get(target.id)
  }
  // Still transient during a workspace switch (PTYs rebuilding) — retried once.
  if (!session) throw new RetryableDispatchError(`Agent '${target.name}' has no running terminal`)
  return session.viewportText()
}

function cmdNote(request: CliRequest, deps: SocketServerDeps): string {
  const [sub, ...rest] = request.args
  const me = self(request, deps)
  switch (sub) {
    case 'create': {
      const content = rest[0] ?? ''
      const note = deps.store.createNote({
        customName: null,
        content,
        locked: false,
        position: { x: me.position.x - DEFAULT_NOTE_SIZE.width - 60, y: me.position.y },
        size: DEFAULT_NOTE_SIZE
      })
      deps.store.connectAcross(me.id, note.id)
      return `Created note "${note.name}"`
    }
    case 'read': {
      const note = findConnected(request, deps, rest[0], 'note') as NoteNodeData
      const lines = note.content.split('\n')
      const offset = rest[1] ? Math.max(1, parseInt(rest[1], 10)) : 1
      const limit = rest[2] ? parseInt(rest[2], 10) : lines.length
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const numbered = slice.map((l, i) => `${offset + i}\t${l}`)
      return [`[${lines.length} lines total]`, ...numbered].join('\n')
    }
    case 'write': {
      const note = findConnected(request, deps, rest[0], 'note') as NoteNodeData
      if (note.locked) throw new Error(`Note '${note.name}' is locked`)
      deps.store.writeNote(note.id, rest[1] ?? '')
      return 'OK'
    }
    case 'edit': {
      const note = findConnected(request, deps, rest[0], 'note') as NoteNodeData
      if (note.locked) throw new Error(`Note '${note.name}' is locked`)
      const [, oldText, newText] = rest
      if (oldText === undefined || newText === undefined) {
        throw new Error('Usage: cookrew note edit "Name" "old text" "new text"')
      }
      if (!note.content.includes(oldText)) {
        throw new Error(`Text not found in note '${note.name}'`)
      }
      deps.store.writeNote(note.id, note.content.replace(oldText, newText))
      return 'OK'
    }
    case 'delete': {
      const note = findConnected(request, deps, rest[0], 'note') as NoteNodeData
      deps.store.removeNode(note.id)
      return `Deleted note "${note.name}"`
    }
    default:
      throw new Error('Usage: cookrew note create|read|write|edit|delete ...')
  }
}

function cmdConnect(request: CliRequest, deps: SocketServerDeps): string {
  requireOrch(request, deps)
  const [fromName, toName] = request.args
  if (!fromName || !toName) throw new Error('Usage: cookrew connect "From" "To"')
  const me = self(request, deps)
  const reach = [me as CanvasNode, ...connectedOf(deps.store, me.id).map((h) => h.node)]
  const resolve = (name: string): CanvasNode => {
    const found =
      reach.find((n) => n.name.toLowerCase() === name.toLowerCase()) ??
      deps.store.nodeByName(name)
    if (!found) throw new Error(`'${name}' not found`)
    return found
  }
  const a = resolve(fromName)
  const b = resolve(toName)
  deps.store.connectAcross(a.id, b.id)
  return `Connected "${a.name}" and "${b.name}"`
}

function cmdRecruit(request: CliRequest, deps: SocketServerDeps): string {
  const me = requireOrch(request, deps)
  const [name] = request.args
  const presetName = String(request.flags.preset ?? 'Claude Code')
  const preset = PRESETS.find((p) => p.name.toLowerCase() === presetName.toLowerCase())
  if (!preset) {
    throw new Error(`Unknown preset '${presetName}'. Run 'cookrew preset list'.`)
  }
  const command = request.flags.command ? String(request.flags.command) : preset.command
  const dirFlag = request.flags.dir ? String(request.flags.dir) : null
  const cwd = dirFlag ?? me.cwd
  // Layer 2 (cross-workspace-orch-fix-dec): --dir routes to the workspace
  // OWNING that directory; an unowned dir is auto-added to the orch home.
  // Never silently spawn with a cwd outside the owning workspace.
  const home = deps.store.workspaceOfNode(me.id) ?? deps.store.activeMeta()
  const plan = planRecruitTarget(
    deps.listWorkspaces().workspaces.map((w) => ({ id: w.id, dirs: w.dirs })),
    home.id,
    dirFlag
  )
  if (plan.autoAddDir) deps.addWorkspaceDir(home.id, plan.autoAddDir)
  const siblings = connectedOf(deps.store, me.id).filter((h) => h.node.kind === 'terminal').length
  const terminal: TerminalNodeData = {
    kind: 'terminal',
    id: randomUUID(),
    name: name || preset.name,
    preset: preset.name,
    command,
    cwd,
    orch: false,
    role: request.flags.role ? String(request.flags.role) : null,
    position: {
      x: me.position.x + (siblings + 1) * (DEFAULT_TERMINAL_SIZE.width + 60),
      y: me.position.y + 120
    },
    size: DEFAULT_TERMINAL_SIZE
  }
  const added = deps.store.withOpContext({ actor: 'orch', via: 'recruit' }, () => {
    const node = deps.store.addNodeToWorkspace(plan.workspaceId, terminal) as TerminalNodeData
    deps.store.connectAcross(me.id, node.id)
    return node
  })
  deps.spawnTerminal(added)
  const wsName = (id: string): string =>
    deps.listWorkspaces().workspaces.find((w) => w.id === id)?.name ?? id
  const lines = [`Recruited "${added.name}" (${preset.name}) into workspace "${wsName(plan.workspaceId)}"`]
  if (plan.autoAddDir) {
    lines.push(`Added ${plan.autoAddDir} to workspace "${home.name}" (no workspace owned it)`)
  }
  // Layer 4 guard: never let a recruit land somewhere else silently. Measured
  // against the ORCH's own workspace — it is the one being surprised.
  if (plan.workspaceId !== (deps.store.ownerOf(me.id) ?? deps.store.focusedId)) {
    lines.push(
      `⚠ "${added.name}" lives in workspace "${wsName(plan.workspaceId)}", not the active one — switch with: cookrew workspace switch "${wsName(plan.workspaceId)}"`
    )
  }
  return lines.join('\n')
}

function cmdFork(request: CliRequest, deps: SocketServerDeps): string {
  requireOrch(request, deps)
  const [name] = request.args
  if (!name) throw new Error('Usage: cookrew fork "Agent" [--turn N]')
  const target = findConnected(request, deps, name, 'terminal') as TerminalNodeData
  const turnIndex = request.flags.turn ? parseInt(String(request.flags.turn), 10) : undefined
  if (request.flags.turn !== undefined && Number.isNaN(turnIndex)) {
    throw new Error('--turn must be a turn number (see the card pager or omit for the latest turn)')
  }
  const me = self(request, deps)
  const fork = deps.store.withOpContext({ actor: 'orch', via: 'fork' }, () => {
    const forked = deps.forkTerminal(target.id, turnIndex)
    deps.store.connectAcross(me.id, forked.id)
    return forked
  })
  return `Forked "${target.name}" at turn ${fork.forkOf?.turnIndex} → "${fork.name}" (context is being replayed to it now)`
}

/**
 * Promote one terminal to ORCH — the workspace's door.
 *
 * Exactly one per workspace: the orch is what a served crew exposes and what
 * routing resolves to, so promoting demotes whoever held it. Without this the
 * flag could only be set at creation, which made "make X the orch" impossible
 * without destroying and recreating the card (and its session with it).
 */
function cmdOrch(request: CliRequest, deps: SocketServerDeps): string {
  const name = request.args[0]
  if (!name) throw new Error('Usage: cookrew orch "Agent"')
  const node = deps.store.nodeByName(name, 'terminal')
  if (!node) throw new Error(`No terminal named '${name}' on the canvas`)
  const workspaceId = (deps.store.workspaceOfNode(node.id) ?? deps.store.activeMeta()).id
  const demoted: string[] = []
  for (const other of deps.store.workspaceState(workspaceId).nodes) {
    if (other.kind !== 'terminal' || other.id === node.id) continue
    if ((other as TerminalNodeData).orch) {
      deps.store.updateNodeUnsafe(other.id, { orch: false })
      demoted.push(other.name)
    }
  }
  deps.store.updateNodeUnsafe(node.id, { orch: true })
  return demoted.length > 0
    ? `"${name}" is now the orch (was ${demoted.map((d) => `"${d}"`).join(', ')})`
    : `"${name}" is now the orch`
}

function cmdDismiss(request: CliRequest, deps: SocketServerDeps): string {
  requireOrch(request, deps)
  const target = findConnected(request, deps, request.args[0], 'terminal')
  deps.ptys.kill(target.id)
  deps.store.withOpContext({ actor: 'orch', via: 'dismiss' }, () =>
    deps.store.removeNodeAcross(target.id)
  )
  deps.agents.deactivate(target.id)
  return `Dismissed "${target.name}"`
}

async function cmdVoice(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const [sub, ...rest] = request.args
  switch (sub) {
    case 'on':
      deps.voice.setEnabled(true)
      return 'Voice replies on — agents will speak when an ask completes.'
    case 'off':
      deps.voice.setEnabled(false)
      return 'Voice replies off'
    case 'status':
    case undefined:
      return deps.voice.status()
    case 'list':
      return deps.voice.listVoices()
    case 'set':
      if (!rest[0]) throw new Error('Usage: cookrew voice set "Voice Name" (see `cookrew voice list`)')
      deps.voice.setVoice(rest[0])
      return `Voice set to "${rest[0]}"`
    case 'rate': {
      const rate = parseInt(rest[0] ?? '', 10)
      if (Number.isNaN(rate)) throw new Error('Usage: cookrew voice rate 200')
      deps.voice.setRate(rate)
      return `Voice rate set to ${rate} wpm`
    }
    case 'say':
      if (!rest[0]) throw new Error('Usage: cookrew voice say "text"')
      await deps.voice.speak(rest.join(' '))
      return 'OK'
    default:
      throw new Error('Usage: cookrew voice on|off|status|list|set|rate|say')
  }
}

async function cmdWorkspace(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const [sub, name] = request.args
  if (sub === 'list' || sub === undefined) {
    const { workspaces, activeId } = deps.listWorkspaces()
    return workspaces
      .map((w) => {
        const extra = w.dirs.length > 1 ? ` (+${w.dirs.length - 1} more)` : ''
        return `${w.id === activeId ? '* ' : '  '}${w.icon} ${w.name}  —  ${w.dir}${extra}`
      })
      .join('\n')
  }
  if (sub === 'dir') return cmdWorkspaceDir(request, deps)
  // create/switch/remove restructure the canvas, so gate them behind Orch.
  requireOrch(request, deps)
  switch (sub) {
    case 'create': {
      if (!name) {
        throw new Error('Usage: cookrew workspace create "Name" --dir PATH [--team "Template"]')
      }
      const dir = request.flags.dir ? String(request.flags.dir) : ''
      if (request.flags.team) {
        const meta = await deps.createWorkspaceFromTeam(name, dir, String(request.flags.team))
        return `Created workspace "${meta.name}" from team template "${String(request.flags.team)}" (${meta.dir}) and switched to it`
      }
      const meta = deps.createWorkspace(name, dir)
      return `Created and switched to workspace "${meta.name}" (${meta.dir})`
    }
    case 'switch': {
      if (!name) throw new Error('Usage: cookrew workspace switch "Name"')
      const meta = deps.switchWorkspace(name)
      return `Switched to workspace "${meta.name}"`
    }
    case 'remove': {
      if (!name) throw new Error('Usage: cookrew workspace remove "Name"')
      deps.removeWorkspace(name)
      return `Removed workspace "${name}"`
    }
    default:
      throw new Error('Usage: cookrew workspace list|create|switch|remove|dir ...')
  }
}

/** Directory subcommands operate on the CALLER's workspace. */
function cmdWorkspaceDir(request: CliRequest, deps: SocketServerDeps): string {
  const [, action, dirPath] = request.args
  // An agent enrolling a directory means ITS workspace. Reading this from focus
  // meant a command run in one workspace could silently edit another's dirs the
  // moment a second seat looked elsewhere. A plain shell has no workspace of
  // its own, so it keeps the old behaviour rather than being refused.
  const activeId = tryCallerWorkspaceId(request, deps) ?? deps.listWorkspaces().activeId
  if (action === 'list' || action === undefined) {
    const ws = deps.listWorkspaces().workspaces.find((w) => w.id === activeId)
    return (ws?.dirs ?? [])
      .map((d, i) => `${i === 0 ? '* ' : '  '}${d}`)
      .join('\n')
  }
  requireOrch(request, deps)
  switch (action) {
    case 'add':
      if (!dirPath) throw new Error('Usage: cookrew workspace dir add PATH')
      deps.addWorkspaceDir(activeId, dirPath)
      return `Added directory ${dirPath}`
    case 'remove':
      if (!dirPath) throw new Error('Usage: cookrew workspace dir remove PATH')
      deps.removeWorkspaceDir(activeId, dirPath)
      return `Removed directory ${dirPath}`
    case 'primary':
      if (!dirPath) throw new Error('Usage: cookrew workspace dir primary PATH')
      deps.setPrimaryDir(activeId, dirPath)
      return `Primary directory is now ${dirPath}`
    default:
      throw new Error('Usage: cookrew workspace dir list|add|remove|primary ...')
  }
}

async function cmdTerminalCwd(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const dir = request.args[1]
  if (!dir) throw new Error('Usage: cookrew terminal cwd PATH')
  const me = self(request, deps)
  await deps.setTerminalCwd(me.id, dir)
  return `Terminal cwd set to ${dir} (respawned, session carried over)`
}

async function cmdGit(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const me = self(request, deps)
  const info = await deps.gitInfo(me.cwd)
  if (!info.isRepo) return `${me.cwd} is not a git repository`
  const state = [
    info.dirty ? 'dirty' : 'clean',
    info.ahead ? `↑${info.ahead}` : '',
    info.behind ? `↓${info.behind}` : ''
  ]
    .filter(Boolean)
    .join(' ')
  return `${info.branch ?? 'detached'} — ${state}  (${info.root})`
}

export function cmdMobile(request: CliRequest, deps: SocketServerDeps): string {
  // `flags`, not `args`: the CLI's parseArgv routes every `--token` into flags
  // and leaves args empty, so reading args[0] here meant `cookrew mobile
  // --rotate` exited 0, printed the ordinary URL list, and revoked NOTHING.
  // Silent success on a revocation path is the dangerous shape — an operator
  // burning a leaked token would believe it was dead while it stayed live.
  if (request.flags.rotate === true) {
    deps.rotatePairingToken()
    return renderRotated(deps.mobileEndpoints())
  }
  const endpoints = deps.mobileEndpoints()
  const tailnetHosts = endpoints
    .filter((endpoint) => endpoint.kind === 'tailscale')
    .map((endpoint) => endpoint.host)
  return renderMobileHelp({
    endpoints,
    secure: endpoints.some((endpoint) => endpoint.url.startsWith('https')),
    uncovered: deps.uncoveredCertHosts(),
    tailnet: endpoints.some((endpoint) => endpoint.kind === 'tailscale'),
    // Read at print time, not at startup: the user may well fix their bypass
    // list because of this warning, and the next run should stop nagging.
    proxyBypassGaps: tailnetProxyGaps(tailnetHosts, readProxyConfig())
  })
}

function cmdRoutine(request: CliRequest, deps: SocketServerDeps): string {
  requireOrch(request, deps)
  const [sub, name] = request.args
  switch (sub) {
    case 'list': {
      const all = deps.routines.list()
      if (all.length === 0) return "No routines yet. Create one with 'cookrew routine create \"Name\" --command \"...\" --every 30m'."
      return all
        .map((r) => {
          const schedule = r.schedule.type === 'every' ? `every ${Math.round(r.schedule.ms / 60000)}m` : `daily ${r.schedule.time}`
          return `  - "${r.name}" — ${schedule}, ${r.enabled ? 'enabled' : 'paused'}, fired ${r.fireCount}x`
        })
        .join('\n')
    }
    case 'create': {
      if (!name || !request.flags.command) {
        throw new Error('Usage: cookrew routine create "Name" --command "..." --every 30m | --daily 09:00')
      }
      const schedule = request.flags.every
        ? ({ type: 'every', ms: parseInterval(String(request.flags.every)) } as const)
        : request.flags.daily
          ? ({ type: 'daily', time: String(request.flags.daily) } as const)
          : null
      if (!schedule) throw new Error('Pick a schedule: --every 30m or --daily 09:00')
      let terminalId: string | null = null
      if (request.flags.terminal) {
        const target = findConnected(request, deps, String(request.flags.terminal), 'terminal')
        terminalId = target.id
      } else {
        terminalId = self(request, deps).id
      }
      const created = deps.routines.create({
        name,
        command: String(request.flags.command),
        schedule,
        terminalId,
        enabled: !request.flags.disabled
      })
      return `Created routine "${created.name}"`
    }
    case 'delete':
      return `Deleted routine "${deps.routines.remove(name).name}"`
    case 'enable':
      return `Enabled routine "${deps.routines.setEnabled(name, true).name}"`
    case 'disable':
      return `Paused routine "${deps.routines.setEnabled(name, false).name}"`
    case 'run':
      return `Fired routine "${deps.routines.run(name).name}"`
    default:
      throw new Error('Usage: cookrew routine list|create|delete|enable|disable|run ...')
  }
}

async function cmdTeam(request: CliRequest, deps: SocketServerDeps): Promise<string> {
  const [sub, name] = request.args
  switch (sub) {
    case 'list': {
      const all = deps.teamList()
      if (all.length === 0) return "No saved teams yet. Save one with 'cookrew team save [\"Name\"]'."
      return all
        .map(
          (t) =>
            `  - "${t.name}" — ${t.terminalCount} agents / ${t.nodeCount} nodes, saved ${new Date(t.savedAt).toLocaleString()}`
        )
        .join('\n')
    }
    case 'save': {
      requireOrch(request, deps)
      const meta = deps.teamSave(name)
      return `Saved team "${meta.name}" (${meta.terminalCount} agents, ${meta.nodeCount} nodes)`
    }
    case 'fork': {
      // CLI forks the whole live canvas at latest turns; fine-grained
      // selection (per-turn, assembled, roles) lives in the picker UI.
      // A saved team gets nodeIds: [] — "the whole snapshot" — since live
      // canvas ids never match snapshot node ids (BUG 1).
      requireOrch(request, deps)
      const fromSavedTeam = request.flags.from ? String(request.flags.from) : undefined
      const forkFrom = callerWorkspaceId(request, deps)
      const spec: TeamForkSpec = {
        name: request.flags.name ? String(request.flags.name) : undefined,
        // Both halves from the SAME workspace: ids and the canvas they index.
        nodeIds: fromSavedTeam ? [] : deps.store.workspaceState(forkFrom).nodes.map((n) => n.id),
        fromWorkspaceId: fromSavedTeam ? undefined : forkFrom,
        choices: [],
        fromSavedTeam
      }
      const meta = await deps.teamFork(spec)
      return `Forked team into workspace "${meta.name}" and switched to it`
    }
    default:
      throw new Error('Usage: cookrew team save ["Name"] | team list | team fork [--name N] [--from "Saved Team"]')
  }
}

function cmdRole(request: CliRequest, deps: SocketServerDeps): string {
  const [sub, agentName, roleName] = request.args
  switch (sub) {
    case 'list': {
      const all = deps.roleList()
      if (all.length === 0) return "No saved roles yet. Save one with 'cookrew role save \"Agent\" \"RoleName\" --prompt \"...\"'."
      return all
        .map((r) => `  - "${r.name}" (${r.preset}) — ${r.rolePrompt.slice(0, 80)}`)
        .join('\n')
    }
    case 'save': {
      if (!agentName || !roleName) {
        throw new Error('Usage: cookrew role save "Agent" "RoleName" --prompt "role instructions"')
      }
      const node = deps.store.nodeByName(agentName, 'terminal')
      if (!node) throw new Error(`No terminal named '${agentName}' on the canvas`)
      const prompt = request.flags.prompt
        ? String(request.flags.prompt)
        : ((node as TerminalNodeData).role ?? '')
      if (!prompt.trim()) {
        throw new Error(`Pass --prompt "..." (agent '${agentName}' has no stored role text)`)
      }
      const role = deps.roleSave({ nodeId: node.id, name: roleName, rolePrompt: prompt })
      return `Saved role "${role.name}" (${role.preset})`
    }
    case 'delete': {
      requireOrch(request, deps)
      if (!agentName) throw new Error('Usage: cookrew role delete "RoleName"')
      return deps.roleDelete(agentName)
        ? `Deleted role "${agentName}"`
        : `No saved role '${agentName}'`
    }
    default:
      throw new Error('Usage: cookrew role save "Agent" "RoleName" --prompt "..." | role list | role delete "RoleName"')
  }
}

function cmdPreset(): string {
  return [
    'Available agent presets (use as `--preset "Name"` for `cookrew recruit`):',
    ...PRESETS.map((p) => `  - "${p.name}"`)
  ].join('\n')
}

const HELP_TEXT = `Cookrew — an open-source spatial workspace for AI agents.

Usage:
  cookrew list                                  List connected agents, notes, and browsers
  cookrew ask "Agent" "prompt"                  Send a prompt to a connected agent, wait for the reply
  cookrew ask "Agent" --raw "bytes"             Send raw input (\\n Enter, \\t Tab, \\e ESC, \\xNN byte)
  cookrew check "Agent"                         Read the agent's current terminal output
  cookrew ask "Agent" "prompt" --no-wait        Dispatch without blocking; prints a dispatchId
  cookrew dispatch <dispatchId>                 What became of THAT dispatch (id-correlated)
  cookrew status ["Agent"]                      Busy/idle from the TURN TRACKER, not herdr:
                                                thinking | waiting (blocked on you) | replied
                                                (turn ENDED, needs a fresh dispatch) | idle
  cookrew note create ["content"]               Create a connected note on the canvas
  cookrew note read "Name" [offset] [limit]     Read a note with line numbers
  cookrew note write "Name" "content"           Replace a note's content
  cookrew note edit "Name" "old" "new"          Replace a substring within a note
  cookrew note delete "Name"                    Remove a connected note (destructive)
  cookrew browser create URL ["Name"]            Create a connected browser browser
  cookrew browser snapshot|click|fill|type|key|navigate|screenshot|evaluate|html|text|info "Browser" ...
  cookrew browser tabs "Browser"                  List the browser's tabs (pages opened by the site land here)
  cookrew browser tab-new "Browser" URL           Open a new tab in the browser
  cookrew browser tab-select|tab-close "Browser" N   Switch to / close tab N
  cookrew connect "From" "To"                   (Orch) Wire two nodes together
  cookrew recruit "Name" [--preset P] [--role R] [--dir PATH]   (Orch) Spawn a teammate
  cookrew dismiss "Name"                        (Orch) Remove a teammate
  cookrew orch "Name"                           Make this agent the workspace's orch (the door)
  cookrew fork "Agent" [--turn N]               (Orch) Fork a NEW agent from a past turn (original untouched)
  cookrew preset list                           List agent presets
  cookrew voice on|off|status                   Spoken replies when an ask completes (macOS say)
  cookrew voice list | set "Name" | rate 200    Pick the voice that talks back, set speed
  cookrew voice say "text"                      Speak now
  cookrew mobile                                Print (and QR) the phone companion URL — dictation + spoken replies
  cookrew workspace list                        List workspaces (* = active)
  cookrew workspace create "Name" --dir PATH [--team "Template"]   (Orch) New workspace (optionally from a saved team template) + switch
  cookrew team list                             List saved team templates (name, agents, saved date)
  cookrew workspace switch "Name"               (Orch) Switch workspace — stops the current one's terminals
  cookrew team save ["Name"]                    (Orch) Snapshot the team (nodes, layout, turn histories)
  cookrew team fork [--name N] [--from "Team"]  (Orch) Fork the whole canvas (or a saved team) into a new workspace
  cookrew role save "Agent" "RoleName" --prompt "..."   Save an agent as a reusable role
  cookrew role list                             List saved roles
  cookrew role delete "RoleName"                (Orch) Remove a saved role
  cookrew notify "message"                      (Orch) Desktop notification`
