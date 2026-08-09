import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from './store'
import { PtyManager, multiplexer, sessionNameFor } from './pty'
import type { PtySession } from './pty'
import { TurnTracker } from './turn-tracker'
import { TurnStore } from './turn-store'
import {
  boardSourcesFrom,
  buildBoard,
  boardWindowMs,
  createProbeSampler,
  tmuxProbeDeps
} from './board-index'
import { loadOrCreateReadOnlyToken } from './readonly-token'
import { loadOrCreatePairingToken } from './pairing-token'
import { searchTurns } from '../shared/turn-search'
import { summarizeTurn } from './sous'
import { startSocketServer } from './socket-server'
import { RoutineScheduler } from './routines'
import { VoiceEngine } from './voice'
import {
  startMobileServer,
  mobileUrls,
  mobileEndpointList,
  uncoveredCertHosts,
  rotateActivePairingToken
} from './mobile-server'
import {
  activeBrowserTab,
  AgentRole,
  BrowserNodeData,
  BrowserTab,
  browserTabs,
  CanvasNode,
  DEFAULT_TERMINAL_SIZE,
  TeamForkSpec,
  RecoverResult,
  RestoreResult,
  TeamMeta,
  TerminalNodeData,
  WorkspaceMeta
} from '../shared/model'
import { DEFAULT_ORCH_PRESET, PRESETS } from './presets'
import { forkTerminal as forkTerminalOp, injectWhenReady } from './fork'
import { AgentRegistry } from './agent-registry'
import { RecoverableStore, planRecovery } from './recoverable'
import { EventLog } from './event-log'
import { isClaudeCommand } from '../shared/claude-fork'
import {
  claudeSessionFile,
  claudeSpawnCommand,
  resolveClaudeSessionId,
  resumeRoleSession,
  roleSessionDir,
  saveRoleSessionCopy
} from './claude-fork'
import { isCodexCommand, resolveCodexRolloutByPid } from './codex-bind'
import { isOpenCodeCommand, resolveOpencodeSessionByPid } from './opencode-bind'
import { isPiCommand, piLaunchBinding, resolvePiSessionByPane } from './pi-bind'
import { harnessFor } from './harness'
import { canRestoreExact as exactGate, isRefOwned } from './recover-gate'
import { createRestoreHandlers, registerRestoreIpc, RestoreHandlers } from './restore'
import { withSessionLineage } from './session-lineage'
import { createBrowserCast } from './browser-cast'
import { findChrome } from './headless-chrome'
import { HeadlessBrowserManager } from './headless-browser-manager'
import { HeadlessBrowserCommandEngine } from './headless-browser-command'

import { TraceReader } from './trace'
import { SessionTurnSync } from './session-sync'
import { RoleStore } from './roles'
import { TeamStore, forkTeam, workspaceFromTemplate } from './teams'
import { GitInfoCache, addWorktree } from './git'
import { buildRoleBootMessage } from '../shared/fork'
import { pageTurns } from '../shared/turn'
import type { TurnPageRequest } from '../shared/turn'
import { defaultAttachmentsDir, saveAttachment } from './attachments'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const store = new WorkspaceStore()
const ptys = new PtyManager()
// Held rather than inlined: both the Activity Board and checkpoint search read
// the WHOLE ledger (turnStore.loadAll()) to span workspaces the tracker cannot
// see. A second TurnStore would be a second cache serving stale turns.
const turnStore = new TurnStore()
// Read-only SCOPE token, persisted 0600 (~/.cookrew/wall-token). Authorizes
// GETs on the same routes as the pairing token — not a separate interface.
const wallToken = loadOrCreateReadOnlyToken()
/**
 * Pairing credential, passed EXPLICITLY so it reaches handleMobileApi. Without
 * this the token only ever reached the pairing URL builder, leaving
 * mobile-api's gate — and therefore /api/board — reading
 * `deps.pairingToken === undefined` and letting every request through.
 *
 * PERSISTED (~/.cookrew/pairing-token, 0600) rather than minted per run: a
 * per-run UUID unpaired every phone on every restart, which the phone had no
 * way to report. Because this value is supplied, it is what mobile-server
 * adopts — its own persisted fallback is only reached by callers that pass
 * nothing.
 */
const pairingToken = loadOrCreatePairingToken()
/**
 * L2 probe: phase for panes the TurnTracker cannot see (any workspace but the
 * active one). Only DETACHED sessions are captured — attached terminals are
 * already full-fidelity L1 — and the sampler parks itself when nothing is
 * detached, so an idle machine pays nothing.
 */
const turns = new TurnTracker(summarizeTurn, turnStore)
const sessionSync = new SessionTurnSync(turns)
const routines = new RoutineScheduler(store, ptys)
const voice = new VoiceEngine()
const roles = new RoleStore()
const teams = new TeamStore()
const gitCache = new GitInfoCache()
const agents = new AgentRegistry()
const boardProbe = createProbeSampler(
  tmuxProbeDeps({
    knownTerminalIds: () => agents.list().map((entry) => entry.id),
    isAttached: (terminalId) => ptys.get(terminalId) !== undefined
  })
)
/** Board sources incl. L2; probing restarts lazily whenever the board is read. */
function boardSources(): ReturnType<typeof boardSourcesFrom> {
  return boardSourcesFrom({
    store,
    turns,
    turnStore,
    agents,
    probe: () => {
      boardProbe.start()
      return boardProbe.phases()
    }
  })
}
const events = new EventLog()
const recoverable = new RecoverableStore()
// Snapshot every killed terminal (node + position + session refs + edges)
// so recoverAgent can restore it exactly as it was (agent-recover feature).
store.setTerminalRemovedHook((snapshot) => recoverable.capture(snapshot))
const traces = new TraceReader(store)
// Observability: the store's op choke-point feeds the durable event log;
// the log's live stream broadcasts to the renderer (mobile gets the same
// stream over the /api/events SSE, subscribed in mobile-api).
store.on('op', (e) => events.append(e))
events.on('event', (e) => mainWindow?.webContents.send('event:new', e))
let mainWindow: BrowserWindow | null = null

/**
 * Persisted commands from before a preset default changed, upgraded on
 * spawn (e.g. terminals saved as plain `claude` predate bypass-by-default).
 * Custom commands (recruit --command ...) never match and pass through.
 */
const LEGACY_COMMANDS: Record<string, string> = {
  claude: 'claude --permission-mode bypassPermissions'
}

/**
 * Record a spawn in the durable agent registry (~/.cookrew/agents.json) and
 * arm exit-deactivation. Detaches (workspace switch, app quit) are NOT exits:
 * the tmux session keeps running, so wasDisposed exits leave the entry active.
 */
/** The node's harness session reference (claude/codex/opencode), or null. */
function nodeSessionRef(node: TerminalNodeData): string | null {
  const harness = harnessFor(node.command)
  if (!harness) return null
  const ref = node[harness.sessionField]
  return typeof ref === 'string' ? ref : null
}

function recordSpawn(terminalId: string, session: PtySession): void {
  const hit = store.nodeAcrossWorkspaces(terminalId)
  if (!hit || hit.node.kind !== 'terminal') return
  const meta = store.list().workspaces.find((w) => w.id === hit.workspaceId)
  agents.upsert({
    id: hit.node.id,
    name: hit.node.name,
    preset: hit.node.preset,
    command: hit.node.command,
    role: hit.node.role,
    cwd: hit.node.cwd,
    workspaceId: hit.workspaceId,
    workspaceName: meta?.name ?? hit.workspaceId,
    orch: hit.node.orch,
    sessionRef: nodeSessionRef(hit.node as TerminalNodeData)
  })
  session.once('exit', () => {
    if (!session.wasDisposed) agents.deactivate(terminalId)
  })
}

/**
 * Slow retry tail for session-bind polls: after the fast spawn schedule runs
 * out, keep retrying once a minute until the bind lands or the terminal goes
 * away. Without this, an agent whose first session file appears late (or
 * whose lsof window is missed) stays unbound FOREVER — which is exactly how
 * the live Pi terminal ended up with no endpoint history.
 */
const BIND_RETRY_TAIL_MS = 60_000

/** Spawn (or reuse) a PTY for a terminal node and register turn tracking. */
function spawnTracked(t: {
  id: string
  command: string
  cwd: string
  claudeSessionId?: string | null
  codexSessionRef?: string | null
  opencodeSessionId?: string | null
  piSessionId?: string | null
  sessionLineage?: string[]
}): void {
  const upgraded = LEGACY_COMMANDS[t.command.trim()]
  const command = upgraded ?? t.command
  if (upgraded) store.updateNodeUnsafe(t.id, { command })
  let effective = command
  if (isClaudeCommand(command)) {
    // Bind every Claude terminal to a known session id (adopting one already
    // baked into an older fork command) so session-file features — native
    // fork, resume after a dead tmux session — never guess which session
    // file is this terminal's. tmux reuses live sessions, so the effective
    // command only matters when the terminal actually (re)boots.
    // Resolve against what claude is REALLY running: a stored id whose file is
    // gone (minted for an already-live session tmux reattach never rebooted,
    // or orphaned by a cold reboot) is recovered from turn history rather than
    // resumed blind — otherwise the agent boots an empty conversation. Invalid
    // stored ids (e.g. planted via the unauthenticated node-update endpoint)
    // are dropped inside the resolver before reaching any path/command.
    // NOTE: a still-live tmux session is reattached by `new-session -A`, which
    // ignores this command — so resume only takes on a session that was killed
    // and recreated, never on one that merely detached.
    const sessionId = resolveClaudeSessionId({
      command,
      cwd: t.cwd,
      storedId: t.claudeSessionId,
      turns: turns.history(t.id)
    })
    if (t.claudeSessionId !== sessionId) {
      // Re-resolve = a transition (e.g. the stored id's file vanished after a
      // /clear): record the old binding on the lineage so the rail keeps the
      // earlier segment visible and rewind can still cut into it.
      store.updateNodeUnsafe(t.id, withSessionLineage(t, sessionId))
    }
    effective = claudeSpawnCommand(command, t.cwd, sessionId)
  } else if (isCodexCommand(command) && t.codexSessionRef) {
    // Resume the bound Codex rollout as-is (Tinker: `codex resume <uuid>`,
    // uuid from the rollout filename; global opts kept before the subcommand).
    // Route through resumeKey so the ref is validated, not shelled raw (HIGH-2).
    const harness = harnessFor(command)
    const key = harness?.resumeKey(t.codexSessionRef) ?? null
    if (harness && key) effective = harness.resumeCommand(command, key, { terminalId: t.id, cwd: t.cwd })
  } else if (isOpenCodeCommand(command) && t.opencodeSessionId) {
    const harness = harnessFor(command)
    const key = harness?.resumeKey(t.opencodeSessionId) ?? null
    if (harness && key) effective = harness.resumeCommand(command, key, { terminalId: t.id, cwd: t.cwd })
  } else if (isPiCommand(command)) {
    // H4: wire the pi-bind machinery so the Pi preset actually uses it.
    // Every terminal gets an EXCLUSIVE session dir, so two Pi terminals in
    // the same cwd never share one session tree (the cross-agent race
    // pi-bind exists to eliminate). A node with a prior session in its dir
    // resumes it; otherwise a fresh session boots scoped to that dir.
    const binding = piLaunchBinding({
      command,
      cwd: t.cwd,
      terminalId: t.id,
      storedSessionId: t.piSessionId
    })
    effective = binding.command
    if (t.piSessionId !== binding.sessionId) {
      store.updateNodeUnsafe(t.id, { piSessionId: binding.sessionId })
    }
  }
  const session = ptys.spawn({ terminalId: t.id, command: effective, cwd: t.cwd })
  turns.track(session, command.trim().length > 0)
  recordSpawn(t.id, session)
  // Codex rollout bind (trace-sourced-context-final): the rollout file
  // appears seconds AFTER boot, so poll on a schedule, then keep a slow
  // retry tail until it binds (BIND_RETRY_TAIL_MS).
  if (isCodexCommand(command) && !t.codexSessionRef) {
    // DETERMINISTIC bind (EXACT-CONTEXT gate): the rollout is the file the
    // codex PROCESS holds open (lsof of the pane pid), never a most-recent
    // mtime guess — so it cannot grab a stray or cross-wire two agents. Poll
    // until the process opens its rollout (at session start / first turn).
    const attempt = (delays: number[]): void => {
      const delay = delays.length === 0 ? BIND_RETRY_TAIL_MS : delays[0]
      setTimeout(() => {
        try {
          const hit = store.nodeAcrossWorkspaces(t.id)
          if (!hit || hit.node.kind !== 'terminal') return
          if ((hit.node as TerminalNodeData).codexSessionRef) return
          const ref = resolveCodexRolloutByPid(ptys.panePid(t.id))
          if (!ref) return void attempt(delays.length === 0 ? [] : delays.slice(1)) // rollout not open yet
          // 1:1 authoritative: a rollout already owned by another node is never
          // reassignable (defense-in-depth; lsof already makes this 1:1).
          if (isRefOwned(store.terminalsAcross(), t.id, 'codexSessionRef', ref)) {
            return void attempt(delays.length === 0 ? [] : delays.slice(1))
          }
          store.updateNodeUnsafe(t.id, { codexSessionRef: ref })
          agents.setSessionRef(t.id, ref)
          // Rollout bound → durable turn history can start reconciling.
          watchSessionTurns(t.id)
        } catch (error) {
          console.error('Codex rollout bind failed:', error)
        }
      }, delay)
    }
    attempt([3000, 8000, 20000, 45000])
  }
  // OpenCode session bind (Tinker recipe): the ses_<id>.json appears at/after
  // the first turn, so retry on a schedule until it binds (MEDIUM-3 — the
  // lazy re-bind, not a single shot). recover snapshots then carry
  // opencodeSessionId so `opencode --session <id>` can resume.
  if (isOpenCodeCommand(command) && !t.opencodeSessionId) {
    // DETERMINISTIC bind via lsof of the pane pid (same 1:1 guarantee as
    // codex) — never an mtime guess that could stray/cross-wire.
    const attempt = (delays: number[]): void => {
      const delay = delays.length === 0 ? BIND_RETRY_TAIL_MS : delays[0]
      setTimeout(() => {
        try {
          const hit = store.nodeAcrossWorkspaces(t.id)
          if (!hit || hit.node.kind !== 'terminal') return
          if ((hit.node as TerminalNodeData).opencodeSessionId) return
          const sid = resolveOpencodeSessionByPid(ptys.panePid(t.id))
          if (!sid) return void attempt(delays.length === 0 ? [] : delays.slice(1))
          if (isRefOwned(store.terminalsAcross(), t.id, 'opencodeSessionId', sid)) {
            return void attempt(delays.length === 0 ? [] : delays.slice(1))
          }
          store.updateNodeUnsafe(t.id, { opencodeSessionId: sid })
          agents.setSessionRef(t.id, sid)
          // Registry-driven: no-op while opencode is scrape-only, automatic
          // the day it gains a session-file parser (contract rule 4).
          watchSessionTurns(t.id)
        } catch (error) {
          console.error('OpenCode session bind failed:', error)
        }
      }, delay)
    }
    attempt([3000, 8000, 20000, 45000])
  }
  // Pi session bind: a FRESH boot has no session id yet — the file appears
  // once Pi starts, so poll on a schedule (same recipe as codex/opencode).
  // Resolution follows the LIVE pane's own launch, not the command we would
  // build today: a pane created before the exclusive-dir wiring is reattached
  // as-is by `new-session -A` and keeps writing to pi's shared cwd dir, and
  // scanning only the exclusive dir left such nodes forever unbound (their
  // rail degraded to PTY scrapes labelled '(recovered turn)'). Adoption from
  // the shared dir is gated on the pane's start window plus the 1:1 ownership
  // check below, so no other agent's session can be taken.
  if (isPiCommand(command) && !t.piSessionId) {
    const attempt = (delays: number[]): void => {
      const delay = delays.length === 0 ? BIND_RETRY_TAIL_MS : delays[0]
      setTimeout(() => {
        try {
          const hit = store.nodeAcrossWorkspaces(t.id)
          if (!hit || hit.node.kind !== 'terminal') return
          if ((hit.node as TerminalNodeData).piSessionId) return
          const pane = ptys.paneLaunch(t.id)
          const session = resolvePiSessionByPane({
            cwd: t.cwd,
            terminalId: t.id,
            command: pane?.command ?? null,
            paneStartedAtMs: pane?.startedAtMs ?? null,
            exclude: claimedPiSessions(t.id)
          })
          if (!session) return void attempt(delays.length === 0 ? [] : delays.slice(1))
          store.updateNodeUnsafe(t.id, { piSessionId: session.id })
          agents.setSessionRef(t.id, session.id)
          // Session discovered → durable turn history can start reconciling.
          watchSessionTurns(t.id)
        } catch (error) {
          console.error('Pi session bind failed:', error)
        }
      }, delay)
    }
    attempt([3000, 8000, 20000, 45000])
  }
  // Session-bound terminals: the harness session file is the source of truth
  // for turn records — reconcile now (rebuilds legacy scraped records) and
  // keep reconciling so truncation and exact prompts flow through. The spec
  // is harness-generic (harness-integration-contract): any 'file'-capable
  // harness with a bound session ref gets durable history, not just Claude.
  watchSessionTurns(t.id)
}

/** Pi sessions already bound to OTHER terminals — a shared-dir session is
 *  never reassignable, exactly as for codex rollouts / opencode sessions. */
function claimedPiSessions(selfId: string): ReadonlySet<string> {
  return new Set(
    store
      .terminalsAcross()
      .filter((node) => node.id !== selfId && node.piSessionId)
      .map((node) => node.piSessionId as string)
  )
}

/** Start (or refresh) the session-file turn reconcile for a terminal whose
 *  harness carries 'file' turn history; a no-op for scrape-only/plain shells. */
function watchSessionTurns(terminalId: string): void {
  const spec = traces.watchSpec(terminalId)
  if (!spec) return
  sessionSync.watch(terminalId, spec.file, spec.parse)
  // The multiplexer gets the transcript path too, when it models agents —
  // this is the same fact, and herdr's own detection can use it rather than
  // inferring the agent's state from what it painted.
  multiplexer()?.reportAgentSession?.(sessionNameFor(terminalId), spec.file)
}

/**
 * Give the active workspace an orch terminal when it has none. It opens the
 * default orch preset — Claude with bypassed permissions — so the conductor
 * can act without stalling on approvals.
 */
function seedConductorIfEmpty(): void {
  if (store.terminals().length > 0) return
  store.addNode({
    kind: 'terminal',
    id: randomUUID(),
    name: 'Conductor',
    preset: DEFAULT_ORCH_PRESET.name,
    command: DEFAULT_ORCH_PRESET.command,
    cwd: store.state.dir,
    orch: true,
    role: null,
    position: { x: 240, y: 200 },
    size: DEFAULT_TERMINAL_SIZE
  })
}

// ---- workspace operations (shared by IPC and the cookrew CLI) ----
// Switching tears down the outgoing workspace's PTYs and boots the incoming
// canvas's terminals, so only the active workspace holds live processes.

function listWorkspaces(): ReturnType<WorkspaceStore['list']> {
  return store.list()
}

function createWorkspace(name: string, dir: string): WorkspaceMeta {
  const meta = store.createWorkspace(name, dir || store.state.dir)
  store.switchWorkspace(meta.id) // fires 'switch' → PTY teardown/spawn
  seedConductorIfEmpty()
  return meta
}

function switchWorkspace(nameOrId: string): WorkspaceMeta {
  const meta =
    store.list().workspaces.find((w) => w.id === nameOrId) ?? store.metaByName(nameOrId)
  if (!meta) throw new Error(`Workspace '${nameOrId}' not found`)
  return store.switchWorkspace(meta.id)
}

function removeWorkspace(nameOrId: string): ReturnType<WorkspaceStore['list']> {
  const meta =
    store.list().workspaces.find((w) => w.id === nameOrId) ?? store.metaByName(nameOrId)
  if (!meta) throw new Error(`Workspace '${nameOrId}' not found`)
  // Kill this workspace's terminals BEFORE deleting it — store.removeWorkspace
  // only switches away (detach) and rm's the state dir, so without this each
  // terminal's tmux session (a claude CLI, bypassPermissions) would leak
  // forever with no node left to reach it. Done before the switch-away so the
  // active workspace's terminals are killed, not merely detached. Kills are
  // by tmux session name, so parked (detached) terminals are reached too.
  for (const id of store.terminalIdsOf(meta.id)) {
    store.snapshotTerminal(id) // HIGH-1: capture recovery snapshot before the kill
    sessionSync.unwatch(id)
    ptys.killDetached(id)
    turns.untrack(id)
    // Keep turn history as the recovery signal (see removeNode, R2 fix).
    agents.deactivate(id)
  }
  store.removeWorkspace(meta.id) // switches away first if active (fires 'switch')
  return store.list()
}

// ---- workspace directories + per-terminal cwd (workspace v2) ----

function addWorkspaceDir(id: string, dir: string): ReturnType<WorkspaceStore['list']> {
  return store.addWorkspaceDir(id, dir)
}

function removeWorkspaceDir(id: string, dir: string): ReturnType<WorkspaceStore['list']> {
  return store.removeWorkspaceDir(id, dir)
}

function setPrimaryDir(id: string, dir: string): ReturnType<WorkspaceStore['list']> {
  return store.setPrimaryDir(id, dir)
}

/**
 * Repoint a terminal to another workspace directory and respawn its PTY
 * there — a running process can't change cwd, so the tmux session is killed
 * and recreated in the new dir (turn history survives; it's keyed by id).
 */
function setTerminalCwd(nodeId: string, dir: string): CanvasNode {
  const node = store.setTerminalCwd(nodeId, dir)
  sessionSync.unwatch(nodeId)
  turns.untrack(nodeId)
  ptys.kill(nodeId)
  spawnTracked(node)
  return node
}

// ---- node operations (shared by renderer IPC and the mobile HTTP API) ----

function addNode(node: CanvasNode): CanvasNode {
  const added = store.addNode(node)
  if (added.kind === 'terminal') spawnTracked(added)
  if (added.kind === 'browser') void browserManager.syncNode(added).catch(() => undefined)
  return added
}

function updateNode(id: string, patch: Partial<CanvasNode>): CanvasNode | undefined {
  const existing = store.node(id)
  if (existing?.kind === 'note' && typeof (patch as { content?: string }).content === 'string') {
    const { content, ...rest } = patch as { content: string } & Partial<CanvasNode>
    const written = store.writeNote(id, content)
    return Object.keys(rest).length > 0 ? store.updateNode(id, rest) : written
  }
  const updated = store.updateNode(id, patch)
  if (updated?.kind === 'browser') {
    void browserManager.syncNode(updated).catch(() => undefined)
  }
  return updated
}

function workspaceName(id: string): string {
  return store.list().workspaces.find((w) => w.id === id)?.name ?? id
}

/**
 * EXACT-CONTEXT gate (extracted + unit-tested in recover-gate.ts): can this
 * node's exact prior session be restored right now? Wired to live turn history.
 */
function canRestoreExact(node: TerminalNodeData): boolean {
  return exactGate(node, { turnsHistory: (id) => turns.history(id) })
}

/** The active workspace's orch terminal, for reachability wiring. */
function activeOrch(): TerminalNodeData | undefined {
  return store
    .terminals()
    .find((t) => t.orch)
}

/**
 * Recover an inactive teammate as it was (agent-recover feature). Order:
 *  1. Node still on a canvas (dead process) → respawn if its workspace is
 *     active (resumes its session), else leave it for workspace activation.
 *  2. Kill snapshot → re-add the node bound to its session (harness resume on
 *     spawn), reconnect SURVIVING peers, and only if none reaches an orch wire
 *     to the current orch. PTY boots ONLY when the target workspace is active
 *     (registry-consistent; inactive workspaces defer to activation).
 *  3. No snapshot (legacy pre-feature kill) → best-effort re-add from the
 *     registry + wire to the current orch.
 */
function recoverAgent(id: string): RecoverResult {
  // (1) present-but-dead
  const hit = store.nodeAcrossWorkspaces(id)
  if (hit && hit.node.kind === 'terminal') {
    // Only report spawned when we actually (re)booted — an already-live
    // process is a no-op double-recover (LOW).
    const exact = canRestoreExact(hit.node as TerminalNodeData)
    const didSpawn = hit.workspaceId === store.activeId && !ptys.get(id) && exact
    if (didSpawn) spawnTracked(hit.node)
    return {
      ok: true, id, name: hit.node.name, workspaceId: hit.workspaceId,
      workspaceName: workspaceName(hit.workspaceId), spawned: didSpawn, legacy: false, exact
    }
  }

  const snap = recoverable.get(id)
  if (snap) {
    const orch = activeOrch()
    const plan = planRecovery(snap, {
      activeWorkspaceId: store.activeId,
      workspaceExists: (wid) => store.list().workspaces.some((w) => w.id === wid),
      nodeExists: (pid) => store.nodeAcrossWorkspaces(pid) !== undefined,
      isOrch: (pid) => {
        const peer = store.nodeAcrossWorkspaces(pid)
        return peer?.node.kind === 'terminal' && (peer.node as TerminalNodeData).orch === true
      },
      currentOrchId: orch?.id ?? null
    })
    const added = store.addNodeToWorkspace(plan.targetWorkspaceId, snap.node) as TerminalNodeData
    for (const peerId of plan.peerEdges) store.connectAcross(added.id, peerId)
    if (plan.orchEdge) store.connectAcross(added.id, plan.orchEdge)
    // EXACT-CONTEXT gate: boot only when the exact session is restorable —
    // never a fresh/stray session masquerading as recovery.
    const exact = canRestoreExact(added)
    const didSpawn = plan.spawn && exact
    if (didSpawn) spawnTracked(added)
    recoverable.remove(id)
    return {
      ok: true, id, name: added.name, workspaceId: plan.targetWorkspaceId,
      workspaceName: workspaceName(plan.targetWorkspaceId), spawned: didSpawn, legacy: false, exact
    }
  }

  // (3) legacy fallback from the registry (no full snapshot).
  const entry = agents.lookup(id)
  if (!entry) throw new Error(`No recoverable agent '${id}'`)
  const wsExists = store.list().workspaces.some((w) => w.id === entry.workspaceId)
  const targetWs = wsExists ? entry.workspaceId : store.activeId
  const harness = harnessFor(entry.command)
  const node: TerminalNodeData = {
    kind: 'terminal', id, name: entry.name, preset: entry.preset,
    command: entry.command, cwd: entry.cwd, orch: entry.orch, role: entry.role,
    // Carry the recorded session ref so legacy recover resumes the exact
    // session (R2 fix), not a fresh one.
    ...(harness && entry.sessionRef ? { [harness.sessionField]: entry.sessionRef } : {}),
    position: { x: 240, y: 200 }, size: DEFAULT_TERMINAL_SIZE
  }
  const added = store.addNodeToWorkspace(targetWs, node) as TerminalNodeData
  const orch = activeOrch()
  if (orch && orch.id !== added.id) store.connectAcross(added.id, orch.id)
  const exact = canRestoreExact(added)
  const didSpawn = targetWs === store.activeId && exact
  if (didSpawn) spawnTracked(added)
  return {
    ok: true, id, name: added.name, workspaceId: targetWs,
    workspaceName: workspaceName(targetWs), spawned: didSpawn, legacy: true, exact
  }
}

async function removeNode(id: string): Promise<void> {
  sessionSync.unwatch(id)
  turns.untrack(id)
  // NOTE: turn history is deliberately NOT cleared on kill — it is the third
  // recovery net (resolveClaudeSessionId matches it to the real session when
  // no snapshot/registry ref exists). Disk-capped at 100/agent, negligible;
  // clearing it destroyed a recovery signal for nothing (R2 fix).
  ptys.kill(id)
  browserThumbs.delete(id)
  const browserStopped = browserManager.remove(id)
  store.removeNode(id)
  agents.deactivate(id)
  await browserStopped
}

/** Fork an agent from one of its turns — shared by IPC, CLI and mobile. */
function forkTerminal(sourceId: string, turnIndex?: number): TerminalNodeData {
  return forkTerminalOp({ store, ptys, turns, spawnTerminal: spawnTracked }, sourceId, turnIndex)
}

interface CreateTerminalOpts {
  name: string
  preset: string
  position: { x: number; y: number }
  orch: boolean
  /** Boot a fresh agent from a saved role instead of a bare preset. */
  roleName?: string
}

function createTerminal(opts: CreateTerminalOpts): CanvasNode {
  const role = opts.roleName ? roles.get(opts.roleName) : undefined
  if (opts.roleName && !role) throw new Error(`No saved role '${opts.roleName}'`)
  const preset = PRESETS.find((p) => p.name === opts.preset) ?? PRESETS[PRESETS.length - 1]
  // Native restore: a role saved from a checkpoint carries a truncated session
  // copy — materialize it under a fresh id so the booted Claude agent resumes
  // the checkpoint conversation. Codex/absent copy → boot fresh (rolePrompt
  // injection below is unchanged either way).
  const restoredSessionId =
    role?.sessionCopyRef && isClaudeCommand(role.command)
      ? resumeRoleSession({
          sessionCopyRef: role.sessionCopyRef,
          copyDir: roleSessionDir(),
          cwd: store.state.dir
        })
      : null
  const terminal: TerminalNodeData = {
    kind: 'terminal',
    id: randomUUID(),
    name: opts.name || role?.name || preset.name,
    preset: role ? role.preset : preset.name,
    command: role ? role.command : preset.command,
    cwd: store.state.dir,
    orch: opts.orch,
    role: role ? role.name : null,
    ...(restoredSessionId ? { claudeSessionId: restoredSessionId } : {}),
    position: opts.position,
    size: DEFAULT_TERMINAL_SIZE
  }
  const added = store.addNode(terminal)
  spawnTracked(added as TerminalNodeData)
  if (role) {
    const session = ptys.get(added.id)
    if (session) {
      injectWhenReady(session, buildRoleBootMessage(role.name, role.rolePrompt)).catch((error) =>
        console.error('Role boot injection failed:', error)
      )
    }
  }
  return added
}

// ---- team fork / save + roles (spec: team-fork-roles v1, Forge lane) ----

async function teamFork(spec: TeamForkSpec): Promise<WorkspaceMeta> {
  const meta = await teamForkInner(spec)
  store.recordEvent('team.forked', meta.id, meta.name)
  return meta
}

function teamForkDeps(): Parameters<typeof forkTeam>[0] {
  return {
    store,
    turns,
    roles,
    teams,
    ptys,
    switchWorkspace: (id) => void switchWorkspace(id),
    git: { gitInfo: (dir) => gitCache.info(dir), addWorktree },
    worktreeRoot: path.join(homedir(), '.cookrew', 'worktrees')
  }
}

function teamForkInner(spec: TeamForkSpec): Promise<WorkspaceMeta> {
  return forkTeam(teamForkDeps(), spec)
}

/**
 * FEATURE 1: workspace pre-populated from a saved team template. Routes
 * through the team-fork engine (native session restore included), so the
 * workspace.created event carries the 'team fork' detail.
 */
async function createWorkspaceFromTeam(
  name: string,
  dir: string,
  team: string
): Promise<WorkspaceMeta> {
  return workspaceFromTemplate(teamForkDeps(), { name, dir: dir || store.state.dir, team })
}

function teamSaveTracked(name?: string): TeamMeta {
  const meta = teamSaveInner(name)
  store.recordEvent('team.saved', meta.name, meta.name, `${meta.terminalCount} agents`)
  return meta
}

function teamSaveInner(name?: string): TeamMeta {
  return teams.save(store.state, (id) => turns.history(id), name)
}

interface RoleSaveInput {
  nodeId: string
  name: string
  rolePrompt: string
  /** Checkpoint provenance (save role from this checkpoint), optional. */
  sourceTurnUuid?: string
  sourceTurnPrompt?: string
  sessionCopyRef?: string
}

function roleSaveTracked(input: RoleSaveInput): AgentRole {
  const role = roleSaveInner(input)
  store.recordEvent('role.saved', role.name, role.name, role.preset)
  return role
}

function roleSaveInner(input: RoleSaveInput): AgentRole {
  const node = store.node(input.nodeId)
  if (!node || node.kind !== 'terminal') throw new Error('Role source is not a terminal node')
  // Produce the native restore point: a truncated copy of the source Claude
  // session at the checkpoint uuid. sessionCopyRef was dead plumbing — nothing
  // wrote it — so a role recovered only the prompt, not the conversation.
  let sessionCopyRef = input.sessionCopyRef
  if (!sessionCopyRef && input.sourceTurnUuid) {
    sessionCopyRef =
      saveRoleSessionCopy({
        command: node.command,
        cwd: node.cwd,
        sessionId: node.claudeSessionId,
        sourceTurnUuid: input.sourceTurnUuid,
        destDir: roleSessionDir()
      }) ?? undefined
  }
  return roles.save(node, input.name, input.rolePrompt, {
    sourceTurnUuid: input.sourceTurnUuid,
    sourceTurnPrompt: input.sourceTurnPrompt,
    sessionCopyRef
  })
}

/**
 * Debug input injection: drives the renderer through Electron's real input
 * pipeline (same hit-testing and event handlers as user clicks), so UI flows
 * can be verified headlessly alongside `app-shot`.
 */
async function injectInput(args: string[]): Promise<string> {
  if (!mainWindow) throw new Error('No window')
  const wc = mainWindow.webContents
  const [sub, ...rest] = args
  if (sub === 'click') {
    const x = parseInt(rest[0], 10)
    const y = parseInt(rest[1], 10)
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    return `Clicked ${x},${y}`
  }
  if (sub === 'dblclick') {
    const x = parseInt(rest[0], 10)
    const y = parseInt(rest[1], 10)
    for (const clickCount of [1, 2]) {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount })
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount })
    }
    return `Double-clicked ${x},${y}`
  }
  if (sub === 'type') {
    for (const char of rest.join(' ')) {
      wc.sendInputEvent({ type: 'char', keyCode: char })
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    return `Typed ${rest.join(' ').length} chars`
  }
  if (sub === 'key') {
    const keyCode = rest[0]
    // Optional modifiers as a 2nd arg: "meta", "meta+shift", etc.
    const modifiers = rest[1]
      ? (rest[1].split(/[+,]/) as Array<'shift' | 'control' | 'meta' | 'alt'>)
      : undefined
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    return `Pressed ${keyCode}${rest[1] ? ` +${rest[1]}` : ''}`
  }
  throw new Error('Usage: cookrew ui click X Y | dblclick X Y | type "text" | key Enter')
}

async function captureWindow(): Promise<string> {
  if (!mainWindow) throw new Error('No window')
  const image = await mainWindow.webContents.capturePage()
  const file = path.join(ptys.runtimeDir, `app-shot-${Date.now()}.png`)
  await import('node:fs/promises').then((fs) => fs.writeFile(file, image.toPNG()))
  return file
}

/** Pending browser command requests forwarded to the renderer. */
const browserWaiters = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>()

/**
 * Latest browser thumbnails, pushed from the renderer's capturePage() loop.
 * Kept here (not just in renderer state) so the mobile companion can serve
 * them as images to the phone's canvas cards.
 */
const browserThumbs = new Map<string, Buffer>()

// Flag-off phone browsers use the legacy /thumb feed. While one is polling,
// tell the renderer to keep that webview capture fresh even if the desktop is
// hidden. Flag-on phones use the headless stream and never enter this path.
function noteBrowserViewed(browserId: string): void {
  // The keep-alive decision (with its TTL) lives entirely in the renderer's
  // phoneViewingRef — main just relays the heartbeat. No map is held here, so
  // an unauth LAN client polling /thumb with junk ids cannot accumulate state.
  if (!interactiveBrowserEnabled() && mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('browser:phone-viewing', browserId)
  }
}

const interactiveBrowserEnabled = (): boolean =>
  process.env.COOKREW_INTERACTIVE_BROWSER === '1'
const desktopBrowserStreamToken = randomUUID()

function activeBrowserNode(browserId: string): BrowserNodeData | null {
  const node = store.node(browserId)
  return node?.kind === 'browser' ? node : null
}

/** Reflect real headless-page navigation/title state into the browser node. */
function recordHeadlessPageState(
  browserId: string,
  tabId: string,
  state: { url: string; title: string }
): void {
  const node = activeBrowserNode(browserId)
  if (!node) return
  const tabs = browserTabs(node)
  const tab = tabs.find((candidate) => candidate.id === tabId)
  if (!tab || (tab.url === state.url && tab.title === state.title)) return
  const nextTabs = tabs.map((candidate) =>
    candidate.id === tabId ? { ...candidate, url: state.url, title: state.title } : candidate
  )
  const active = activeBrowserTab(node).id === tabId
  store.updateNodeUnsafe(browserId, {
    tabs: nextTabs,
    ...(active ? { url: state.url } : {})
  })
}

/** Adopt a real target=_blank/window.open page into the browser-node tab model. */
function recordHeadlessTabOpened(browserId: string, tab: BrowserTab): void {
  const node = activeBrowserNode(browserId)
  if (!node) return
  const tabs = browserTabs(node)
  if (tabs.some((candidate) => candidate.id === tab.id)) return
  const updated = store.updateNodeUnsafe(browserId, {
    tabs: [...tabs, tab],
    activeTabId: tab.id,
    url: tab.url
  })
  if (updated?.kind === 'browser') void browserManager.syncNode(updated).catch(() => undefined)
}

/** A page target closed itself (window.close); keep the tab model truthful. */
function recordHeadlessTabClosed(browserId: string, tabId: string): void {
  const node = activeBrowserNode(browserId)
  if (!node) return
  const tabs = browserTabs(node)
  if (tabs.length <= 1 || !tabs.some((tab) => tab.id === tabId)) return
  const remaining = tabs.filter((tab) => tab.id !== tabId)
  const wasActive = activeBrowserTab(node).id === tabId
  const nextActive = wasActive ? remaining[0] : activeBrowserTab(node)
  const updated = store.updateNodeUnsafe(browserId, {
    tabs: remaining,
    activeTabId: nextActive.id,
    url: nextActive.url
  })
  if (updated?.kind === 'browser') void browserManager.syncNode(updated).catch(() => undefined)
}

// C-2 ownership: one headless process/profile per active browser node. Cast
// viewers and trusted agent commands both resolve through this manager.
const browserManager = new HeadlessBrowserManager({
  enabled: interactiveBrowserEnabled,
  chromePath: findChrome,
  profileRoot: () => path.join(app.getPath('userData'), 'interactive-browser'),
  resolveNode: activeBrowserNode,
  onPageState: recordHeadlessPageState,
  onTabOpened: recordHeadlessTabOpened,
  onTabClosed: recordHeadlessTabClosed
})

const browserCast = createBrowserCast({
  getInstance: (browserId) => browserManager.get(browserId),
  enabled: interactiveBrowserEnabled,
  desktopToken: () => desktopBrowserStreamToken
})

const headlessBrowserCommands = new HeadlessBrowserCommandEngine({
  store,
  manager: browserManager,
  addNode,
  updateNode,
  connectNodes: (aId, bId) => void store.connectAcross(aId, bId)
})

function rendererBrowserCommand(args: string[], terminalId: string): Promise<string> {
  if (!mainWindow) return Promise.reject(new Error('No window'))
  const id = randomUUID()
  const promise = new Promise<string>((resolve, reject) => {
    browserWaiters.set(id, { resolve, reject })
    setTimeout(() => {
      if (browserWaiters.has(id)) {
        browserWaiters.delete(id)
        reject(new Error('Browser command timed out'))
      }
    }, 30000)
  })
  mainWindow.webContents.send('browser:command', { id, args, terminalId })
  return promise
}

function browserCommand(args: string[], terminalId: string): Promise<string> {
  return interactiveBrowserEnabled()
    ? headlessBrowserCommands.run(args, terminalId)
    : rendererBrowserCommand(args, terminalId)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Cookrew',
    backgroundColor: '#FAF8F4',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(dirname, '../preload/index.cjs'),
      webviewTag: true
    }
  })

  // ⌘W is layered: the renderer closes the topmost closeable thing first (a
  // browser tab, then a zoomed-in overlay) and only quits when nothing is left.
  // ⌘Q always quits. Handled here (not via a menu) so both fire with focus
  // inside an xterm terminal or a browser webview, which have their own
  // webContents — the event is always routed to the main renderer to decide.
  const appShortcuts = (
    event: Electron.Event,
    input: Electron.Input
  ): void => {
    if (input.type !== 'keyDown' || !input.meta) return
    const key = input.key.toLowerCase()
    if (key === 'w') {
      event.preventDefault()
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('app:cmd-w')
      }
    } else if (key === 'q') {
      event.preventDefault()
      app.quit()
    }
  }
  mainWindow.webContents.on('before-input-event', appShortcuts)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(dirname, '../renderer/index.html'))
  }
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // Browser webviews: window.open / target=_blank must become a tab in the
  // same browser, never a detached native window. The renderer maps the
  // webContents id back to the owning browser and appends a tab.
  mainWindow.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url) && mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('browser:open-tab', { webContentsId: contents.id, url })
      }
      return { action: 'deny' }
    })
    // A browser webview has its own webContents, so ⌘W with focus inside a
    // browser wouldn't reach the main window without this.
    contents.on('before-input-event', appShortcuts)
  })
  mainWindow.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`)
  })
}

// ONE Cookrew per machine, enforced before anything else runs.
//
// Two instances do not merely conflict over ports — they FIGHT over the same
// multiplexer panes. Under herdr every attach uses --takeover, so instance B
// steals each pane from instance A, A's client exits, A reattaches and steals
// it back. That churn of near-instant PTY exits lands in node-pty's known
// ThreadSafeFunction crash window (Napi::Error thrown in CallJS -> libc++
// abort), which took the whole app down at launch on 2026-08-08 — see the
// Electron-*-172115.ips crash report. The lock turns "two instances slowly
// corrupt each other" into "the second instance exits immediately".
if (!app.requestSingleInstanceLock()) {
  console.error('Another Cookrew instance is already running — exiting.')
  app.exit(1)
}

app.whenReady().then(() => {
  // Dock icon must be set at runtime in dev; packaged builds also bundle
  // resources/icon.icns via the packager config when one is added.
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(dirname, '../../resources/icon.png')
    try {
      app.dock.setIcon(iconPath)
    } catch (error) {
      console.error('Dock icon failed to load:', error)
    }
  }
  // Ship the CLI next to the socket so PTYs get it on PATH.
  const cliSource = app.isPackaged
    ? path.join(process.resourcesPath, 'cli', 'cookrew.mjs')
    : path.join(dirname, '../../cli/cookrew.mjs')
  try {
    ptys.installCli(cliSource)
  } catch (error) {
    console.error('CLI install failed:', error)
  }
  // Push the current tmux config to sessions that survived a previous run,
  // so reattached terminals show the (possibly updated) status bar.
  ptys.reloadTmuxConfig()

  // Endpoint restore handlers: rewind a live agent to a checkpoint + undo.
  const { restoreCheckpoint, undoRestore } = createRestoreHandlers({
    store,
    ptys,
    traces,
    spawnTracked,
    // Restore/undo kill the CLI; refuse while a turn is in flight so the
    // session file is never truncated out from under a writing process.
    phaseOf: (id) => turns.list().find((a) => a.terminalId === id)?.phase ?? null
  })

  startSocketServer({
    store,
    ptys,
    spawnTerminal: spawnTracked,
    agents,
    turns,
    forkTerminal,
    routines,
    browserCommand,
    notify: showNotification,
    captureWindow,
    injectInput,
    voice,
    mobileUrls,
    mobileEndpoints: mobileEndpointList,
    uncoveredCertHosts,
    rotatePairingToken: rotateActivePairingToken,
    listWorkspaces,
    createWorkspace,
    createWorkspaceFromTeam,
    switchWorkspace,
    removeWorkspace,
    addWorkspaceDir,
    removeWorkspaceDir,
    setPrimaryDir,
    setTerminalCwd,
    gitInfo: (dir: string) => gitCache.info(dir),
    teamFork,
    teamSave: teamSaveTracked,
    teamList: () => teams.list(),
    roleSave: roleSaveTracked,
    roleList: () => roles.list(),
    roleDelete: (name: string) => roles.delete(name)
  })
  routines.start()

  startMobileServer({
    store,
    events,
    agents,
    traces,
    // Activity Board data plane. Without this /api/board answers 503 —
    // deliberately, so a missing wire-up is loud instead of an empty board.
    // probe (L2) is absent until the tmux sampler lands; rows then degrade to
    // their last known task rather than claiming a phase nobody observed.
    board: boardSources(),
    wallToken,
    pairingToken,
    recoverAgent,
    restoreCheckpoint,
    undoRestore,
    ptys,
    voice,
    turns,
    presets: PRESETS,
    ops: {
      addNode,
      updateNode,
      removeNode,
      createTerminal,
      forkTerminal,
      listWorkspaces,
      createWorkspace: (name: string, dir: string, team?: string) =>
        team ? createWorkspaceFromTeam(name, dir, team) : createWorkspace(name, dir),
      switchWorkspace,
      renameWorkspace: (id, name) => {
        store.renameWorkspace(id, name)
        return store.list()
      },
      removeWorkspace,
      addWorkspaceDir,
      removeWorkspaceDir,
      setPrimaryDir,
      setTerminalCwd,
      gitInfo: (dir: string) => gitCache.info(dir),
      teamFork,
      teamSave: teamSaveTracked,
      teamList: () => teams.list(),
      roleSave: roleSaveTracked,
      roleList: () => roles.list(),
      roleDelete: (name: string) => roles.delete(name)
    },
    saveAttachment: (name, data) => saveAttachment(defaultAttachmentsDir(), name, data),
    browserThumb: (id) => browserThumbs.get(id),
    interactiveBrowserEnabled,
    browserThumbRequested: noteBrowserViewed,
    onUpgrade: (request, socket) => browserCast.upgrade(request, socket),
    // Built renderer bundle — served to phones so mobile gets the full
    // desktop canvas UI. Dev proxies Vite so phones cannot load stale out/.
    rendererDir: path.join(dirname, '../renderer'),
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL
  })
  registerIpc({ restoreCheckpoint, undoRestore })
  void browserManager.replaceNodes(store.browsers()).catch(() => undefined)
  createWindow()

  // First launch: seed the active workspace with a bypass-permission orch.
  seedConductorIfEmpty()

  // Reap orphaned tmux sessions before booting: leaks from past
  // workspace-deletes (pre-fix) or crashes, whose ids match no terminal node
  // anywhere. Runs before spawn so the active workspace's own sessions (which
  // ARE owned) are never touched — spawn reattaches them via `new-session -A`.
  // Fail SAFE: if any workspace's terminals can't be enumerated (corrupt
  // workspace.json), reap NOTHING rather than mistake owned sessions for
  // orphans.
  try {
    const reaped = ptys.reapOrphanSessions(store.allTerminalIdsStrict())
    if (reaped.length > 0) console.error(`Reaped ${reaped.length} orphaned agent session(s)`)
  } catch (error) {
    console.error('Skipping orphan reap: could not enumerate all workspace terminals', error)
  }

  // Boot PTYs for terminals restored from the saved workspace.
  for (const t of store.terminals()) {
    spawnTracked(t)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

let appShutdownStarted = false
let appShutdownComplete = false

app.on('before-quit', (event) => {
  if (appShutdownComplete) return
  event.preventDefault()
  if (appShutdownStarted) return
  appShutdownStarted = true
  browserCast.shutdown()
  store.flush()
  events.flush()
  sessionSync.dispose()
  turns.flushHistories()
  turns.disposeAll()
  ptys.disposeAll()
  void browserManager
    .shutdown()
    .catch((error) => console.error('Headless browser shutdown failed:', error))
    .finally(() => {
      appShutdownComplete = true
      app.quit()
    })
})

function showNotification(message: string): void {
  new Notification({ title: 'Cookrew', body: message }).show()
}

function broadcast(): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('workspace:state', store.state)
  }
}

function registerIpc(handlers: RestoreHandlers): void {
  store.on('change', broadcast)

  // On workspace switch, tear down the outgoing PTYs and boot the incoming
  // canvas's terminals. Only the active workspace holds live processes.
  store.on('switch', ({ previousTerminalIds }: { previousTerminalIds: string[] }) => {
    // Detach (not kill): the outgoing workspace's tmux sessions stay alive so
    // switching back reattaches them with their agents and scrollback intact.
    for (const tid of previousTerminalIds) {
      sessionSync.unwatch(tid)
      turns.untrack(tid)
      ptys.detach(tid)
    }
    for (const t of store.terminals()) spawnTracked(t)
    void browserManager.replaceNodes(store.browsers()).catch(() => undefined)
  })

  // Push the workspace list to the renderer whenever it changes.
  store.on('workspaces', (list) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('workspace:list', list)
    }
  })

  // Renderer resolved a ⌘W to "nothing left to close" → quit.
  ipcMain.on('app:quit', () => app.quit())

  ipcMain.handle('workspace:list', () => store.list())
  ipcMain.handle('workspace:create', (_e, name: string, dir: string, team?: string) =>
    team ? createWorkspaceFromTeam(name, dir, team) : createWorkspace(name, dir)
  )
  ipcMain.handle('workspace:switch', (_e, id: string) => {
    switchWorkspace(id)
    return store.list()
  })
  ipcMain.handle('workspace:rename', (_e, id: string, name: string) => {
    store.renameWorkspace(id, name)
    return store.list()
  })
  // Workspace v2: remove + multi-directory + per-terminal cwd + git.
  ipcMain.handle('workspace:remove', (_e, id: string) => removeWorkspace(id))
  ipcMain.handle('workspace:dir:add', (_e, id: string, dir: string) => addWorkspaceDir(id, dir))
  ipcMain.handle('workspace:dir:remove', (_e, id: string, dir: string) =>
    removeWorkspaceDir(id, dir)
  )
  ipcMain.handle('workspace:dir:setPrimary', (_e, id: string, dir: string) =>
    setPrimaryDir(id, dir)
  )
  ipcMain.handle('terminal:setCwd', (_e, nodeId: string, dir: string) => setTerminalCwd(nodeId, dir))
  ipcMain.handle('git:info', (_e, dir: string) => gitCache.info(dir))
  ipcMain.handle('dir:pick', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Turn/summary activity for the canvas cards.
  turns.on('activity', (activity) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('terminal:activity', activity)
    }
  })
  ipcMain.handle('activity:list', () => turns.list())

  // Acknowledge-on-view: the renderer reports "user is viewing this
  // terminal's result" (overlay mount / phone popout) — fire-and-forget.
  ipcMain.on('turn:seen', (_e, terminalId: string) => turns.seen(terminalId))

  // Turn history + fork-from-turn for the canvas cards.
  ipcMain.handle('turn:history', (_e, terminalId: string) => turns.history(terminalId))
  // Checkpoint search: scan the whole ledger in MAIN and return matches with a
  // capped snippet. Turn bodies never cross the wire.
  ipcMain.handle('turn:search', (_e, query: string, limit?: number) =>
    searchTurns({ ledger: turnStore.loadAll(), query, limit })
  )
  // Context-view v2: paged transcript windows with full prompt+reply bodies.
  ipcMain.handle('turn:page', (_e, terminalId: string, request?: TurnPageRequest) =>
    pageTurns(turns.history(terminalId), request ?? {})
  )
  // Trace-sourced context: identity-keyed windows straight from agent files.
  ipcMain.handle('trace:index', (_e, terminalId: string) => traces.index(terminalId))
  ipcMain.handle('trace:markers', (_e, terminalId: string) => traces.boundaryMarkers(terminalId))
  ipcMain.handle('trace:page', (_e, terminalId: string, request?: unknown) =>
    traces.page(terminalId, (request ?? {}) as Parameters<TraceReader['page']>[1])
  )
  // Observability event log: filtered history + counts + agent roster.
  ipcMain.handle('events:query', (_e, query) => events.query(query ?? {}))
  ipcMain.handle('events:count', (_e, query) => events.count(query ?? {}))
  ipcMain.handle('agents:list', () => agents.list())
  // Activity Board snapshot for the desktop panel — same builder the HTTP
  // route and the SSE push use, so the three can never drift apart.
  ipcMain.handle('board:list', (_e, window?: unknown) =>
    buildBoard(
      boardSources(),
      boardWindowMs(typeof window === 'string' ? window : null)
    )
  )
  ipcMain.handle('agent:recover', (_e, id: string) => recoverAgent(id))
  // Endpoint restore channels live alongside the executor (M10).
  registerRestoreIpc(ipcMain.handle.bind(ipcMain), handlers)
  ipcMain.handle('terminal:fork', (_e, sourceId: string, turnIndex?: number) =>
    forkTerminal(sourceId, turnIndex)
  )

  ipcMain.handle('workspace:get', () => store.state)
  ipcMain.handle('browser:interactive-enabled', () => interactiveBrowserEnabled())
  ipcMain.handle('browser:stream-token', () => desktopBrowserStreamToken)

  ipcMain.handle('node:add', (_e, node: CanvasNode) => addNode(node))
  ipcMain.handle('node:update', (_e, id: string, patch: Partial<CanvasNode>) =>
    updateNode(id, patch)
  )
  ipcMain.handle('node:remove', (_e, id: string) => removeNode(id))

  // connectAcross, not connect: it VALIDATES both ids exist (in any workspace)
  // and mirrors a legitimate cross-workspace edge. store.connect writes an edge
  // for any pair of strings, which is how a renderer caller could leave one
  // pointing at a node the active workspace does not hold.
  ipcMain.handle('node:connect', (_e, aId: string, bId: string) => store.connectAcross(aId, bId))
  ipcMain.handle('node:disconnect', (_e, connId: string) => store.disconnect(connId))

  ipcMain.handle('preset:list', () => PRESETS)

  ipcMain.handle('terminal:create', (_e, opts: CreateTerminalOpts) => createTerminal(opts))

  // Team fork / team save / roles (contract in note team-fork-roles-spec-v1).
  ipcMain.handle('team:fork', (_e, spec: TeamForkSpec) => teamFork(spec))
  ipcMain.handle('team:save', (_e, name?: string) => teamSaveTracked(name))
  ipcMain.handle('team:list', () => teams.list())
  ipcMain.handle('role:save', (_e, input: RoleSaveInput) =>
    roleSaveTracked(input)
  )
  ipcMain.handle('role:list', () => roles.list())
  ipcMain.handle('role:delete', (_e, name: string) => roles.delete(name))

  // 📎 attach: native multi-file picker for the desktop renderer. Dropped
  // files never come through here — the preload resolves their paths locally.
  ipcMain.handle('attach:pick', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  // 📎 attach: save raw bytes (a pasted clipboard image) and return its path.
  // Same store + 20MB cap + name sanitize as phone uploads.
  ipcMain.handle('attach:save', (_e, name: string, bytes: Uint8Array) =>
    saveAttachment(defaultAttachmentsDir(), name, Buffer.from(bytes))
  )

  // Terminal stream bridging renderer xterm <-> PTY
  ipcMain.on('pty:input', (_e, terminalId: string, data: string) => {
    ptys.get(terminalId)?.write(data)
  })
  ipcMain.on('pty:resize', (_e, terminalId: string, cols: number, rows: number) => {
    ptys.get(terminalId)?.resize(cols, rows)
  })
  // Turn navigation: scroll the tmux view to a past ask (null returns live).
  ipcMain.on('pty:jump', (_e, terminalId: string, text: string | null) => {
    const session = ptys.get(terminalId)
    if (!session) return
    if (text) session.jumpToText(text)
    else session.exitCopyMode()
  })
  // One forwarder per terminal: React StrictMode double-mounts (and HMR
  // remounts) call attach repeatedly, and stacked listeners would duplicate
  // every byte of output in the renderer.
  const forwarders = new Map<string, (data: string) => void>()
  /** Replay-frame forwarders, kept beside `forwarders` so detach drops both. */
  const replayForwarders = new Map<string, (frame: string) => void>()
  ipcMain.handle('pty:attach', (event, terminalId: string) => {
    const session = ptys.get(terminalId)
    if (!session) return false
    const previous = forwarders.get(terminalId)
    if (previous) session.removeListener('data', previous)
    const listener = (data: string): void => {
      // The window can be closed or reloaded while the PTY keeps emitting;
      // sending to a destroyed webContents throws "Object has been destroyed".
      if (event.sender.isDestroyed()) {
        session.removeListener('data', listener)
        forwarders.delete(terminalId)
        return
      }
      event.sender.send(`pty:data:${terminalId}`, data)
    }
    forwarders.set(terminalId, listener)
    session.on('data', listener)
    // A geometry change re-serializes the mirror; forward that frame to the
    // popout so it never keeps applying herdr's absolute-addressed deltas onto
    // a screen laid out at the previous size. Same listener lifetime as the
    // data forwarder — pty:detach drops both.
    const onReplay = (frame: string): void => {
      if (event.sender.isDestroyed()) return
      event.sender.send(`pty:data:${terminalId}`, frame)
    }
    replayForwarders.set(terminalId, onReplay)
    session.on('replay', onReplay)
    // Geometry BEFORE bytes: the frame's wrapping is baked in at the mirror's
    // columns, so a popout that paints it at its own width re-wraps every long
    // line. The renderer sizes its xterm from this, then sends the resize kick.
    event.sender.send(`pty:hello:${terminalId}`, session.geometry())
    // A faithful ANSI frame, not plain text — see PtySession.replayFrame.
    event.sender.send(`pty:data:${terminalId}`, session.replayFrame())
    return true
  })
  // The popout detaches on close; without this the forwarder would keep
  // serializing every output chunk to a channel nobody listens on.
  ipcMain.on('pty:detach', (_e, terminalId: string) => {
    const listener = forwarders.get(terminalId)
    const onReplay = replayForwarders.get(terminalId)
    const session = ptys.get(terminalId)
    if (listener && session) session.removeListener('data', listener)
    if (onReplay && session) session.removeListener('replay', onReplay)
    forwarders.delete(terminalId)
    replayForwarders.delete(terminalId)
  })

  // Thumbnail frames from the renderer's browser capture loop (data URLs).
  ipcMain.on('browser:thumb', (_e, browserId: string, dataUrl: string) => {
    const base64 = dataUrl.split(',')[1]
    if (base64) browserThumbs.set(browserId, Buffer.from(base64, 'base64'))
  })

  // Browser command responses coming back from the renderer
  ipcMain.on('browser:result', (_e, id: string, ok: boolean, output: string) => {
    const waiter = browserWaiters.get(id)
    if (!waiter) return
    browserWaiters.delete(id)
    if (ok) waiter.resolve(output)
    else waiter.reject(new Error(output))
  })
}
