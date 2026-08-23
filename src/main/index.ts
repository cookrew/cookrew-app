import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from './store'
import { PtyManager, multiplexer, sessionNameFor } from './pty'
import type { PtySession } from './pty'
import type { PaneCardInfo } from './multiplexer'
import { agentStatus, statusFeed, type StatusObservation } from './herdr-agent-status'
import { resolveRotationChain, rotationCommitVerdict } from './claude-rotation'
import { BootLatency, shouldTimeBoot, type BootSample } from './boot-latency'
import { TurnTracker, type CompletedTurn } from './turn-tracker'
import { TurnStore } from './turn-store'
import {
  DispatchService,
  appendDispatchRecord,
  appendDispatchTombstone,
  compactDispatchRegistry,
  defaultDispatchRegistry,
  readDispatchRecords,
  readDispatchTombstones,
  turnDetails
} from './dispatch'
import { HerdrHostMultiplexer } from './herdr-host-multiplexer'
import { askTerminal, beginShutdown, cancelAllAsks, pasteAndSubmit } from './ask'
import { defaultProducerLease } from './producer-lease'
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
  CanvasPosition,
  DEFAULT_TERMINAL_SIZE,
  TeamClipStatus,
  TeamCopyResult,
  TeamForkSpec,
  RecoverResult,
  RestoreResult,
  TeamMeta,
  TerminalNodeData,
  WorkspaceMeta
} from '../shared/model'
import { DEFAULT_ORCH_PRESET, PRESETS } from './presets'
import { forkContextReady, forkTerminal as forkTerminalOp, injectWhenReady } from './fork'
import { AgentRegistry } from './agent-registry'
import { AgentExportStore } from './agent-export'
import { OwnerGrant, isOwnerSender } from './owner-grant'
import { buildGrantRoster } from './grant-roster'
import { CallCredentialService } from './call-credential'
import { makeCallCeremony } from './call-ceremony'
import { makeCallGate } from './call-gate'
import { CallConversationStore } from './call-conversation'
import { cutCallVersion } from './call-fork'
import { makeCallSession } from './call-session'
import { memoizeBriefly } from './call-cache'
import { CallsInFlight } from './call-inflight'
import { makeCallRun } from './call-run'
import { RecoverableStore, planRecovery } from './recoverable'
import { EventLog } from './event-log'
import { installProcessGuards } from './process-guards'
import { SessionRegistry } from './session-registry'
import { planWorkspaceSwitch } from './workspace-switch'
import { SwitchRunner } from './switch-runner'
import { looksLikeInstallLink, presetIdFromInstallUrl } from './registry-install-link'
import { terminalHasLiveWork } from './session-liveness'
import { isClaudeCommand } from '../shared/claude-fork'
import { canonicalExternalUrl } from '../shared/external-url'
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
import { isPiCommand, piAdoptableSession, piLaunchBinding, resolvePiSessionByPane } from './pi-bind'
import { harnessFor } from './harness'
import { canRestoreExact as exactGate, isRefOwned } from './recover-gate'
import { blocksResume, holderOf, liveSessionHolders, planHeldSessionFork } from './claude-live-session'
import { createRestoreHandlers, registerRestoreIpc, RestoreHandlers } from './restore'
import { withSessionLineage } from './session-lineage'
import { registryHostHelp, resolveRegistryHosts } from '../shared/registry-host'
import { RegistryHostSettings } from './registry-settings'
import { publishPreset, type PayoutBinding, type PublishOutcome } from './publish-preset'
import { pushToRegistry } from './registry-client'
import { buildManifest, loadPublishingKey, signManifest } from './preset-publish'
import { scrubForPublish } from './preset-scrub'
import type { PresetPricing } from '../shared/preset-manifest'
import { carrySessionToCwd } from './session-move'
import { moveTerminalCwd } from './terminal-cwd'
import { createBrowserCast } from './browser-cast'
import { BrowserThumbCache } from './browser-thumb-cache'
import { findChrome } from './headless-chrome'
import { HeadlessBrowserManager } from './headless-browser-manager'
import { HeadlessBrowserCommandEngine } from './headless-browser-command'

import { TraceReader, type SessionWatchSpec } from './trace'
import { SessionTurnSync } from './session-sync'
import { RoleStore } from './roles'
import { TeamStore, copyTeam, forkTeam, workspaceFromTemplate, type TeamSnapshot } from './teams'
import { PresetStore, isPresetId } from './preset-store'
import { PinStore } from './pin-store'
import type { VersionPinRecord } from '../shared/version-pin'
import { planPresetImport } from './preset-import'
import { TeamClipboard } from './team-clip'
import { UNCOPYABLE_PHASES } from '../shared/turn'
import { GitInfoCache, addWorktree } from './git'
import { buildRoleBootMessage } from '../shared/fork'
import { pageTurns } from '../shared/turn'
import type { TurnPageRequest } from '../shared/turn'
import { defaultAttachmentsDir, saveAttachment } from './attachments'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const store = new WorkspaceStore()
/** Installed marketplace presets — the dock's third chip family (§8). */
const presetStore = new PresetStore()
/** Version pins per terminal (§10) — what the rail's third marker class draws. */
const pinStore = new PinStore()

/**
 * Record an install's version against every TERMINAL it placed. Teams version
 * ATOMICALLY (§10): the tuple shares one number, so each member takes the same
 * pin rather than counting independently. Notes and browsers hold no
 * transcript, so they hold no pin.
 */
function recordPins(nodes: readonly CanvasNode[], pin: VersionPinRecord): void {
  for (const node of nodes) {
    if (node.kind !== 'terminal') continue
    try {
      pinStore.add(node.id, pin)
    } catch (error) {
      // A pin that cannot be written must not undo a placement that already
      // happened — the agent is on the canvas and working either way.
      console.error('Recording a version pin failed:', error)
    }
  }
}
const ptys = new PtyManager()
// Liveness covers EXISTENCE, not attachment: every terminal node — including
// inactive-workspace agents this process never spawns an attach for — pins
// its lease generation against tombstone eviction, and any write-ahead
// input-provenance fact from the previous process adopts fail-closed here.
defaultProducerLease().seedLive(store.terminalsAcross().map((node) => node.id))
/**
 * terminal.booted (p95-p98 spec, wave 3): spawn → the agent is reachable.
 *
 * The ready signal is herdr's PUSHED agent state — the first state it reports
 * for a pane that had none, which its detector cannot produce before an agent
 * is actually running (see boot-latency.ts). Wired here rather than inside
 * PtyManager so the emission rides the store's choke-point like every other
 * event, and so the whole feature is absent — not degraded — on a backend with
 * no lifecycle signal: `statusFeed()` is null under tmux and direct, nothing
 * subscribes, and no boot is ever timed. The asymmetry is deliberate: tmux can
 * say a pane exists, never that the agent inside it came up, and a metric that
 * meant different things per backend would be worse than one that is missing.
 */
const boots = new BootLatency()
boots.on('booted', ({ terminalId, durationMs }: BootSample) => {
  const node = store.node(terminalId)
  // Actor is the AGENT for the same reason turn.completed is: nobody typed
  // this event, an agent coming up produced it.
  store.withOpContext({ actor: 'agent' }, () =>
    store.recordEvent('terminal.booted', terminalId, node?.name ?? terminalId, undefined, durationMs)
  )
})
statusFeed()?.on('status', ({ sessionName }: StatusObservation) => boots.ready(sessionName))
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
const sessionSync = new SessionTurnSync(turns, undefined, {
  // Settle confirmation for background dispatches: on a quiet poll, let the
  // file observer close an armed dispatch — unless herdr's push feed says
  // the agent is still working/blocked. The positive signal may hold a turn
  // open (its real value through long silent tool calls); per the standing
  // asymmetry it never ends one, and its absence alone never completes
  // anything either — completion still needs the settled FINAL tail record.
  onQuiet: (terminalId) => {
    // No status veto here (Sol r3): completeFromHistory demands parser
    // finality plus exact identity, which is STRONGER evidence than any
    // status claim — a feed stuck at 'working' must never strand a
    // natively finalized dispatch. Status still holds the DRAIN open
    // (holdOpen below); it just cannot outrank a durable final row.
    turns.completeFromHistory(terminalId)
  },
  // Sol r1 P0: a switched-away human turn inside a long silent tool call must
  // not drain — herdr's working/blocked is the positive evidence that holds
  // the watch open (a hold, not a reset: drain fires on the first quiet tick
  // after it clears). Its absence is NOT evidence of rest; that asymmetry is
  // why drain also needs the full quiet window.
  // Soft hold: third-party status, subject to the 60s trust cap — a stuck
  // feed must not retain tracking forever (Sol r2/r3).
  holdOpen: (terminalId) => {
    const reported = agentStatus(sessionNameFor(terminalId))
    return reported === 'working' || reported === 'blocked'
  },
  // Hard hold: A4's observed-turn fact — first-party evidence the tracker
  // itself minted (live turn, confirmed delivery, surviving an untrack).
  // Exempt from the trust cap, like pins and subscribers; cleared only by
  // finality, interruption, or removal. The status feed supports the fact
  // but is never its sole representation (Sol r3).
  holdFact: (terminalId) => turns.hasOpenTurnFact(terminalId),
  isInTurn: (terminalId) => turns.inTurn(terminalId),
  onStale: (terminalId) => void rebindRotatedClaudeSession(terminalId),
  // Lets a subscriber START observation on a never-watched terminal — the
  // subscription is then the only hold, so a peek leaks nothing.
  resolveWatch: (terminalId) => traces.watchSpec(terminalId)
})
const routines = new RoutineScheduler(store, ptys)
const voice = new VoiceEngine()
const roles = new RoleStore()
const teams = new TeamStore()
const gitCache = new GitInfoCache()
const agents = new AgentRegistry()
/**
 * The internet gate's two stores (§9 · ④). The issuer signs this instance's
 * call credentials — owner-as-issuer, so nothing here reaches the registry —
 * and the grant record says who may call what. Both default closed: no agent is
 * callable until the owner exports it, and no caller holds a credential until
 * the owner enrols it.
 */
const callCredentials = new CallCredentialService()
const agentExports = new AgentExportStore()

/**
 * The owner's grant surface. THE WIRE CARRIES THE CEREMONY AND THE CALL, NEVER
 * THE GRANT — see owner-grant.ts for why this is the one thing that needs no
 * credential, and tests/grant-surface-shape.test.ts for the sweep that fails
 * if an HTTP route ever reaches it.
 *
 * Every decision lands on the ordinary observability stream. A grant is what
 * makes an agent reachable from the internet, so the owner should be able to
 * find out later that they made one without knowing to go looking.
 */
const ownerGrant = new OwnerGrant({
  store: agentExports,
  // REVOKE STOPS CALLS ALREADY RUNNING. The same set that keeps a workspace
  // resident while it serves a call is the set a revoke reaches into — one
  // truth, so a call that is counted is a call that can be stopped.
  cancelInFlight: (match) => callsInFlight.cancelWhere(match),
  audit: (line) => {
    events.append({
      type: `grant.${line.op}`,
      entityId: line.subject,
      entityName: line.subject,
      workspaceId: line.workspaceId,
      workspaceName: store.list().workspaces.find((w) => w.id === line.workspaceId)?.name ?? line.workspaceId,
      actor: 'user',
      timestamp: line.at,
      details: line.via
    })
  }
})
const callConversations = new CallConversationStore()
/**
 * The pre-credential lookup, memoized for a beat (Tinker HIGH-2).
 *
 * An unauthenticated call resolves a NAME before any credential is examined —
 * 404 before 401, so a caller cannot map the room — and for a workspace that is
 * not resident that read comes off disk. Cheap, not reordered: see
 * call-cache.ts for what the window can and cannot cost.
 */
/**
 * Calls currently being served, per workspace. Liveness fact 3 — see
 * call-inflight.ts for why the inferred turn-phase signal is not enough on its
 * own for a call to a PARKED workspace, which is the case §9 exists for.
 */
const callsInFlight = new CallsInFlight()
const callNodesOf = memoizeBriefly((workspaceId: string) => store.workspaceState(workspaceId).nodes)
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

// Installed the moment the store and the log exist, and before any boot path
// can start a background promise. Node ≥15 makes an unhandled rejection fatal,
// and this process holds every agent's PTY — so a stray promise nobody awaited
// takes the fleet with it. That is not hypothetical: it is how the app died
// silently mid-instantiate in August (post-mortem, archive/wave-c-20260816).
// Rejections are logged and SURVIVED; a genuine uncaught exception still
// exits, but flushes the durable witnesses on the way out.
installProcessGuards({
  append: (event) => events.append(event),
  workspace: () => {
    const meta = store.activeMeta()
    return { id: meta.id, name: meta.name }
  },
  // The three things this process is the ONLY witness to. Synchronous by
  // necessity — there is no awaiting anything on the way out of a fatal.
  flush: () => {
    store.flush()
    events.flush()
    turns.flushHistories()
  },
  // app.exit, not app.quit: the state is already suspect, so this must not
  // depend on the before-quit drain running to completion. The flush above is
  // what makes that safe.
  exit: (code) => app.exit(code)
})

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

/**
 * Open a boot sample — but only for a COLD spawn.
 *
 * `sessionExists` is the discriminator, and this is the last moment it can be
 * asked: ensureSession (inside the PtySession constructor) creates the pane, so
 * a check afterwards always answers "it exists". A pane that is already there
 * is being REATTACHED — the agent inside it booted minutes or days ago, and
 * timing the handover would report a multiplexer's attach cost as an agent's
 * boot cost. Those emit nothing at all.
 *
 * Costs one `pane list` on the boot path, and only where the metric is
 * possible: no status feed (tmux, direct) means no ready signal, so there is
 * nothing to sample and the probe is skipped entirely.
 *
 * A HUSK — a labelled pane whose agent died with the herdr server — reads as
 * existing and is therefore never timed, even though ensureSession is about to
 * boot a real agent into it. That under-reports; it does not fabricate, which
 * is the direction this metric is allowed to be wrong in.
 */
function beginBootTiming(terminalId: string): boolean {
  const hasReadySignal = statusFeed() !== null
  // Short-circuited, not merely gated: on a backend with no ready signal the
  // `pane list` this would cost is spent for an answer nobody can use.
  if (!hasReadySignal) return false
  const sessionName = sessionNameFor(terminalId)
  const sessionExists = multiplexer()?.sessionExists(sessionName) ?? false
  if (!shouldTimeBoot({ hasReadySignal, sessionExists })) return false
  boots.begin(sessionName, terminalId)
  return true
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

/**
 * The card a herdr-hosted pane should wear: name, role (falling back to the
 * preset/harness), the workspace it belongs to and where it works. Only
 * backends with their own chrome implement the binding (multiplexer.ts),
 * so this is a no-op under tmux/direct.
 */
function paneCard(t: {
  id: string
  name: string
  role: string | null
  preset: string
  cwd: string
}): PaneCardInfo {
  return {
    terminalId: t.id,
    title: t.name,
    agent: t.role ?? t.preset,
    workspace: store.focusedState.name,
    cwd: t.cwd
  }
}

/**
 * Which workspaces this process boots and holds PTYs for.
 *
 * Step 2 made this a RESIDENCY question, as commit 2 said it would — and it
 * changed here, in the one place, rather than in the eight call sites that
 * each used to spell `store.activeId`. Flag off, exactly one workspace is
 * resident and the answer is identical to focus; flag on, every resident
 * session holds its own runtimes.
 */
function bootsTerminalsFor(workspaceId: string): boolean {
  return store.resident().includes(workspaceId)
}

/**
 * The workspace half of the herdr binding: Cookrew's herdr workspace wears
 * the FOCUSED Cookrew workspace's name and identity tokens. Re-reported on
 * every switch (and once at boot); a no-op under tmux/direct.
 *
 * Commander's ruling (2026-08-20): panes already carry a cookrew_workspace
 * token, so a WorkspaceSession scopes by TOKEN under this single existing
 * label. No per-session relabeling — herdr reattach compat is not worth the
 * risk, and N labels get revisited only if token scoping proves insufficient.
 */
function reportWorkspaceBinding(): void {
  const focused = store.focusedMeta()
  if (!focused) return
  multiplexer()?.reportWorkspace?.({
    label: focused.name,
    tokens: { cookrew_workspace: focused.id, cookrew_dir: focused.dir }
  })
}

/**
 * How long to wait for a forked session file to appear, and how often to look.
 * Claude writes it as it boots; a pane that was merely reattached never will,
 * and that silence is the signal to leave the node's binding alone.
 */
const FORK_BIND_TIMEOUT_MS = 30_000
const FORK_BIND_POLL_MS = 500

/**
 * Rebind a node to the copy a held-session fork produced — but only once that
 * copy is really on disk.
 *
 * The old id goes onto the lineage, so the checkpoint rail keeps every turn
 * that happened before the fork and rewind can still reach into it.
 */
function bindForkWhenWritten(
  terminalId: string,
  from: string,
  forkedTo: string,
  cwd: string
): void {
  const deadline = Date.now() + FORK_BIND_TIMEOUT_MS
  const look = (): void => {
    if (!existsSync(claudeSessionFile(cwd, forkedTo))) {
      if (Date.now() < deadline) setTimeout(look, FORK_BIND_POLL_MS).unref()
      return
    }
    // Re-read: this lands seconds later and the node may have moved on.
    const node = store.node(terminalId)
    if (node?.kind !== 'terminal') return
    const current = node as TerminalNodeData
    if (current.claudeSessionId !== from) return
    store.updateNodeUnsafe(terminalId, withSessionLineage(current, forkedTo))
    console.error(
      `${current.name}: session ${from} was held by another claude process — ` +
        `resumed from a copy as ${forkedTo}`
    )
  }
  setTimeout(look, FORK_BIND_POLL_MS).unref()
}

/**
 * The Pi session an UNBOUND node should adopt, or null.
 *
 * Both the launcher and the recover gate ask this, and they must agree: a gate
 * that says "restorable" while the launcher boots fresh would strand the very
 * conversation the gate promised. Ownership is resolved against every node in
 * every workspace, so one session can never be handed to two terminals.
 */
function adoptablePiSession(terminalId: string, cwd: string): string | null {
  const peers = store.terminalsAcross()
  return (
    piAdoptableSession(cwd, {
      isOwned: (sessionId) => isRefOwned(peers, terminalId, 'piSessionId', sessionId)
    })?.id ?? null
  )
}

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
    // A session another LIVE claude process still holds cannot be resumed —
    // claude prints "currently running as a background agent … add
    // --fork-session" and exits. Nothing here noticed, so the pty booted, died
    // instantly, and the card reported READY over a black void (observed on
    // Forge, held by a leftover `claude bg-spare`). Forking branches off a copy
    // of the whole transcript, so the agent returns knowing what it knew; the
    // new id is picked up by the spawn-time rotation probe below, which records
    // the old one on the lineage so the rail keeps its history.
    const fork = planHeldSessionFork(
      claudeSpawnCommand(command, t.cwd, sessionId),
      sessionId,
      liveSessionHolders(),
      randomUUID
    )
    effective = fork.command
    // Bind the copy only once it EXISTS. Naming it ourselves is what makes the
    // binding possible at all, but a still-live tmux session is reattached by
    // `new-session -A`, which ignores this command entirely — so the fork may
    // never run. Binding on intent pointed a node at a session file that was
    // never written, which is worse than the bug it was fixing: the rail had
    // nothing to read and the exact-context gate could no longer pass.
    if (fork.forkedTo) bindForkWhenWritten(t.id, sessionId, fork.forkedTo, t.cwd)
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
      // An unbound node adopts an UNOWNED session from its own cwd scope
      // rather than booting fresh beside it. Ownership is checked here, not
      // in pi-bind, because only the store knows what every other node claims
      // — and that check is the whole reason this is not the most-recent
      // guess the exclusive-dir design exists to forbid.
      storedSessionId: t.piSessionId ?? adoptablePiSession(t.id, t.cwd)
    })
    effective = binding.command
    if (t.piSessionId !== binding.sessionId) {
      store.updateNodeUnsafe(t.id, { piSessionId: binding.sessionId })
    }
  }
  // The herdr pane wears the card's display info (no-op elsewhere). Resolved
  // from the store rather than threaded through every caller — the node is
  // always persisted before it spawns, so the store is the freshest source.
  const cardNode = store.node(t.id)
  const card = cardNode?.kind === 'terminal' ? paneCard(cardNode) : undefined
  // Before the spawn, because the spawn is what makes the pane exist.
  const timingBoot = beginBootTiming(t.id)
  // Tagged with its owning workspace so the PTY plane can answer per-session
  // questions (multi-instance step 2). ownerOf resolves across every
  // workspace; focus is only the fallback for a terminal no canvas claims yet.
  const session = ptys.spawn(
    { terminalId: t.id, command: effective, cwd: t.cwd, card },
    store.ownerOf(t.id) ?? store.focusedId
  )
  // One producer per conversation: every owner keystroke consults the
  // tracker BEFORE the byte reaches the child; a dispatch in flight is
  // preempted durably or the write is refused (Sol r4 P0-1).
  session.beforeOwnerInput = (terminalId, data) => turns.guardOwnerInput(terminalId, data)
  // Liveness: a registered id's lease generation is never tombstone-evicted,
  // so a rebound terminal cannot be mistaken for a dead one (Sol r9).
  defaultProducerLease().registerTerminal(t.id)
  // A terminal that dies before it is ready never booted: drop the pending
  // sample rather than leave it to time out. Registered only when a sample is
  // actually open — spawnTracked is called repeatedly for a REUSED session
  // (workspace switches), and an unconditional listener would pile up on it.
  if (timingBoot) session.once('exit', () => boots.cancel(sessionNameFor(t.id)))
  turns.track(session, command.trim().length > 0)
  recordSpawn(t.id, session)
  // Codex rollout bind (trace-sourced-context-final): the rollout file
  // appears seconds AFTER boot, so poll on a schedule, then keep a slow
  // retry tail until it binds (BIND_RETRY_TAIL_MS).
  // SPAWN-TIME successor probe, not only the quiet-pane watcher: a crash
  // recovery rotates the session while no pane exists, so by the time a pane
  // exists again the staleness watcher has nothing stale to notice.
  // resolveClaudeSessionId keeps a stored id merely because its file still
  // EXISTS — it never asks whether a newer file claims that file's uuids.
  // Measured on Conductor: 368/368 head uuids replayed into a successor and
  // the rail sat frozen until the binding was repointed by hand. So every
  // adopt asks the question too; the probe follows the chain to the newest
  // hop and refuses on every doubt, exactly as when a watcher raises it.
  if (isClaudeCommand(command) && t.claudeSessionId) {
    void rebindRotatedClaudeSession(t.id)
  }
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

/** Claude sessions owned by OTHER terminals — current bindings AND lineage.
 *  Lineage counts: an earlier segment of another node's conversation is still
 *  its history, and adopting one would cross-wire two rails. */
function claimedClaudeSessions(selfId: string): ReadonlySet<string> {
  return new Set(
    store
      .terminalsAcross()
      .filter((node) => node.id !== selfId)
      .flatMap((node) => [
        ...(node.claudeSessionId ? [node.claudeSessionId] : []),
        ...(node.sessionLineage ?? [])
      ])
  )
}

const rotationProbes = new Set<string>()

async function rebindRotatedClaudeSession(terminalId: string): Promise<void> {
  // Single-flight per terminal: never stack probes. The sync reports once per
  // stale window, but a window can close while the previous probe's bytes are
  // still in flight, and two probes racing to commit the same chain is a race
  // with nothing to win.
  if (rotationProbes.has(terminalId)) return
  try {
    const hit = store.nodeAcrossWorkspaces(terminalId)
    if (!hit || hit.node.kind !== 'terminal') return
    const node = hit.node as TerminalNodeData
    if (!isClaudeCommand(node.command)) return
    const bound = node.claudeSessionId
    if (!bound) return
    rotationProbes.add(terminalId)
    let chain: string[] | null
    try {
      chain = await resolveRotationChain({
        cwd: node.cwd,
        sessionId: bound,
        claimed: claimedClaudeSessions(terminalId)
      })
    } finally {
      rotationProbes.delete(terminalId)
    }
    if (chain === null) return
    // ---- last await is above this line; the commit re-reads and lands ----
    commitRotatedClaudeSession(terminalId, bound, chain)
  } catch (error) {
    console.error('Claude session rotation rebind failed:', error)
  }
}

/**
 * Land a proven rotation chain on the node — SYNCHRONOUSLY, and only if the
 * store still says what the probe assumed. Every fact is re-read here rather
 * than carried across the await: the node itself (it may have been killed or
 * repurposed), its binding (it may have been rebound by recover, fork or
 * another probe) and every other node's claims incl. lineage (a peer may have
 * taken a hop while we were reading). MUST NOT become async — see
 * rotationCommitVerdict.
 */
function commitRotatedClaudeSession(
  terminalId: string,
  bound: string,
  chain: readonly string[]
): void {
  const hit = store.nodeAcrossWorkspaces(terminalId)
  if (!hit || hit.node.kind !== 'terminal') return
  const node = hit.node as TerminalNodeData
  if (!isClaudeCommand(node.command)) return
  const verdict = rotationCommitVerdict({
    boundBefore: bound,
    boundNow: node.claudeSessionId,
    chain,
    claimed: claimedClaudeSessions(terminalId)
  })
  if (verdict !== 'commit') return
  const rotated = chain[chain.length - 1]
  // Folded hop by hop so EVERY session the agent passed through lands on
  // the lineage: the rail keeps each earlier segment behind its own clear
  // marker, and cross-clear rewind can still cut into them.
  const patch = chain.reduce(
    withSessionLineage,
    {
      claudeSessionId: node.claudeSessionId,
      sessionLineage: node.sessionLineage
    } as Pick<TerminalNodeData, 'claudeSessionId' | 'sessionLineage'>
  )
  store.updateNodeAcrossWorkspacesUnsafe(terminalId, patch)
  agents.setSessionRef(terminalId, rotated)
  // The successor file is the durable record now. MIGRATE the observer —
  // rebind swaps the file while the pin count, subscriber count and drain
  // state survive (an unwatch would wipe them: a background dispatch would
  // lose its pin and the fresh watch would never drain — Sol r2).
  // Deliberately NOT interrupting an open dispatch here: a rotation is the
  // SAME conversation continuing in a new file — the armed stamp (prompt
  // identity + armedAt) survives, and the successor's tail is exactly where
  // the dispatched turn will land. The observer migrates; the record lives.
  const spec = traces.watchSpec(terminalId)
  if (spec) {
    sessionSync.rebind(terminalId, spec.file, spec.parse)
    multiplexer()?.reportAgentSession?.(sessionNameFor(terminalId), spec.file)
  } else {
    sessionSync.unwatch(terminalId)
  }
  store.withOpContext({ actor: 'agent' }, () =>
    store.recordEventIn(
      hit.workspaceId,
      'terminal.session-rotated',
      terminalId,
      node.name,
      `${bound.slice(0, 8)} → ${rotated.slice(0, 8)}`
    )
  )
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
function watchSessionTurns(
  terminalId: string,
  opts: { deferInitial?: boolean } = {}
): SessionWatchSpec | null {
  const spec = traces.watchSpec(terminalId)
  if (!spec) return null
  sessionSync.watch(terminalId, spec.file, spec.parse, opts)
  // The multiplexer gets the transcript path too, when it models agents —
  // this is the same fact, and herdr's own detection can use it rather than
  // inferring the agent's state from what it painted.
  multiplexer()?.reportAgentSession?.(sessionNameFor(terminalId), spec.file)
  return spec
}

/**
 * Scrollback rows the dispatch engine reads when it asks "did the prompt land?".
 * Deep enough that a multi-minute turn's own output cannot bury the echo.
 */
const DISPATCH_CAPTURE_LINES = 2000

/**
 * The attach-free dispatch engine (v4 §3, on v5 tracking). Every dep is a
 * narrow function so the engine never learns what a PtySession is — the whole
 * point of the route is that the target has no terminal open on it.
 *
 * `beginWork`/`endWork` are the v5 replacement for the serviceState gate: a
 * dispatch is accepted for ANY resolvable agent, and the acceptance itself
 * brings up the tracking it needs — the session-file watch plus a drain pin
 * that holds it open through the longest quiet tool call — then hands the
 * terminal back to the ordinary drain clock when the record closes.
 *
 * `reattachFallback` is the single exception and the single PTY: it runs only
 * after the transcript has shown the prompt never landed, and it degrades to
 * "no fallback" whenever the agent has no live session to reattach.
 */
const dispatchService = new DispatchService({
  resolveAgent: (agentId) => {
    const hit = store.nodeAcrossWorkspaces(agentId)
    if (!hit || hit.node.kind !== 'terminal') return null
    return { name: hit.node.name, workspaceId: hit.workspaceId }
  },
  sessionNameFor,
  // Admission reads the bounded-staleness inventory (500ms) — a fresh herdr
  // fork per concurrent POST serialized the main thread (Sol r4/I6). A pane
  // that died inside the window becomes a classified delivery failure.
  sessionExists: (name) => {
    const mux = multiplexer()
    if (mux instanceof HerdrHostMultiplexer) return mux.sessionExistsCached(name)
    return mux?.sessionExists(name) === true
  },
  // Async capture for the delivery legs (Sol r10): the pane read rides the
  // async runner off the main thread; a cold inventory classifies as a
  // retryable failure instead of a synchronous fork.
  capture: (name) => {
    const mux = multiplexer()
    if (mux instanceof HerdrHostMultiplexer) return mux.captureAsync(name)
    return mux?.capture(name) ?? null
  },
  // The deep read the landing check needs: "is the prompt on screen?" is what
  // a re-send hangs on, and a viewport-sized capture answers no for every
  // prompt a long turn has already scrolled past. Backends that cannot go
  // deeper simply have no captureDeep and the engine uses the plain one.
  captureDeep: (name) => {
    const mux = multiplexer()
    if (mux instanceof HerdrHostMultiplexer) {
      return mux.captureDeepAsync(name, DISPATCH_CAPTURE_LINES)
    }
    return mux?.captureDeep?.(name, DISPATCH_CAPTURE_LINES) ?? null
  },
  agentStatus: (name) => agentStatus(name),
  promptAgent: (name, prompt, timeoutMs, signal) => {
    const mux = multiplexer()
    if (!mux?.capabilities.agentLifecycle || !mux.promptAgent) return Promise.resolve('failed')
    return mux.promptAgent(name, prompt, timeoutMs, signal)
  },
  // Submission-acknowledgement mode: the producer lease covers only the
  // irreversible delivery; the reply is observed by transcript correlation
  // outside the lease, so a minutes-long dispatched turn never locks the
  // owner's keyboard (Sol r9).
  submitAgent: (name, prompt, timeoutMs, signal) => {
    const mux = multiplexer()
    if (!mux?.capabilities.agentLifecycle || !mux.submitAgent) return Promise.resolve('failed')
    return mux.submitAgent(name, prompt, timeoutMs, signal)
  },
  noteDispatch: (agentId, dispatchId, prompt) => turns.noteDispatch(agentId, dispatchId, prompt),
  // Confirmed delivery hands the tracker the EXACT prompt: scrape closure
  // then correlates on delivered text, never on a truncated screen echo.
  noteDelivered: (agentId, prompt, gen) => turns.noteDispatchDelivered(agentId, prompt, gen),
  // Proven non-delivery retracts the attempted fact — and ONLY proven: an
  // unconfirmed submission keeps its bytes so a settled scrape turn can
  // still be correlated when they arrive late.
  retractDelivered: (agentId, prompt, gen) => turns.retractDispatchDelivered(agentId, prompt, gen),
  clearDispatch: (agentId, dispatchId) => turns.clearDispatch(agentId, dispatchId),
  // Accept time: the dispatch's turn must land in a watched session file, and
  // the pin holds that watch open until the record closes (v5 A4). False =
  // no durable observer could be installed AND no scrape covers the agent —
  // the engine refuses the dispatch rather than accept work only the sweep
  // can ever end (A2's exportability precondition). deferInitial: the accept
  // path must not pay a full-transcript parse inline; the poll covers it.
  beginWork: (agentId) => {
    // A2 exportability, sharpened by Sol r2: a 'boundary' harness only ever
    // finalizes a record when the NEXT one arrives — which a background
    // dispatch never sends — so a file target must prove NATIVE finality;
    // otherwise only a live scrape will do. Checked BEFORE any state
    // change, because false promises acceptance left nothing behind.
    const spec = traces.watchSpec(agentId)
    const grade =
      spec !== null && spec.finality === 'native'
        ? ('native-file' as const)
        : turns.isTracked(agentId)
          ? ('scrape' as const)
          : false
    if (grade === false) return false
    if (spec) watchSessionTurns(agentId, { deferInitial: true })
    sessionSync.pin(agentId)
    // A background target was watched BY this dispatch, not by focus, so the
    // watch must owe its drain from the start: released-but-pinned holds for
    // the whole dispatch and then drains on the ordinary quiet clock. A
    // focused target is repinned by presence on the next watch() anyway.
    // Focus is the conservative predicate here: releasing merely puts the
    // watch on the ordinary quiet clock, and a seat that IS rendering this
    // target repins it on the next watch(). With N windows this wants to ask
    // "is ANY seat watching" rather than "is it focused here" — safe either
    // way, because the answer only ever costs a repin.
    if (store.nodeAcrossWorkspaces(agentId)?.workspaceId !== store.focusedId) {
      sessionSync.release(agentId)
    }
    return grade
  },
  endWork: (agentId) => sessionSync.unpin(agentId),
  // The dispatch becomes VISIBLE the moment it exists: accepted and settled
  // flow through the ordinary event stream — toast layer, event panel and
  // the phone all get them for free (owner's product-surface rule).
  announce: ({ kind, record }) => {
    const node = store.nodeAcrossWorkspaces(record.agentId)
    const name = node?.node.name ?? record.agentId
    // Ownership first, focus only as a last resort: the record knows, then
    // the node knows, and focus is the guess of last resort when neither does.
    const workspaceId = record.workspaceId ?? node?.workspaceId ?? store.focusedId
    const type = kind === 'accepted' ? 'dispatch.accepted' : `dispatch.${record.state}`
    const details =
      kind === 'accepted'
        ? `→ ${name}`
        : record.error !== undefined
          ? `${name}: ${record.error}`
          : `→ ${name}`
    store.withOpContext({ actor: 'agent' }, () => {
      try {
        store.recordEventIn(workspaceId, type, record.agentId, name, details)
      } catch {
        store.recordEvent(type, record.agentId, name, details)
      }
    })
  },
  // The sweep must not spare a stuck-working agent whose durable final
  // answer already exists — status may hold, never outrank the row.
  hasFinalAnswer: (agentId, prompt, armedAt) => turns.hasFinalAnswer(agentId, prompt, armedAt),
  // The input box belongs to a composing owner: admission refuses and both
  // delivery legs stand down rather than pasting under their typing.
  ownerComposing: (agentId) => turns.ownerComposing(agentId),
  // Observer probation: a native-file acceptance must see its watch actually
  // reconcile; a path that never materializes interrupts at 60s, not 10min.
  observerLive: (agentId) => sessionSync.isVerified(agentId),
  persist: (record) => appendDispatchRecord(defaultDispatchRegistry(), record),
  loadRecords: () => readDispatchRecords(defaultDispatchRegistry()),
  persistTombstone: (tombstone) => appendDispatchTombstone(defaultDispatchRegistry(), tombstone),
  loadTombstones: () => readDispatchTombstones(defaultDispatchRegistry()),
  // Hydrate-time atomic compaction: the append-only registry stays bounded
  // across a commercial lifetime instead of parsing every historical line
  // on every restart forever.
  compactRegistry: () => void compactDispatchRegistry(defaultDispatchRegistry()),
  // "Cannot say" (absent liveness) must never classify a failure as death —
  // only a positive dead answer routes delivery errors to 'interrupted'.
  backendAlive: () => {
    const mux = multiplexer()
    return mux instanceof HerdrHostMultiplexer ? mux.serverAlive() : true
  },
  // The typed path and ONLY the typed path: askTerminal asks the multiplexer
  // first, so reaching for it here would hand the same prompt back to herdr —
  // a second identical submission on the exact outcome that means "herdr could
  // not deliver this". pasteAndSubmit cannot reach herdr by construction.
  reattachFallback: async (agentId, prompt, stillValid) => {
    const session = ptys.get(agentId)
    if (!session) return false
    // stillValid is checked before EVERY write: a dispatch cancelled during
    // the paste delay never emits its CR (Sol r6 P0-2).
    const outcome = await pasteAndSubmit(
      session,
      prompt,
      (data) => session.writeFromDispatch(data),
      stillValid
    )
    return outcome === 'submitted'
  }
})

// Backend death reaches the dispatch plane the moment the supervisor sees it:
// every open record the dead server hosted is stamped interrupted (billed as
// infrastructure, never as the agent failing), not left to the sweep.
ptys.onBackendDeath = (why) => {
  dispatchService.onBackendDeath(why)
  // Every pane died with the server: no first-party open-turn fact — and no
  // producer-lease hold — can outlive the process it observed.
  for (const node of store.terminalsAcross()) {
    turns.clearOpenTurnFact(node.id)
    defaultProducerLease().retire(node.id)
  }
}
// Owner typing into an agent mid-dispatch takes the agent over: the dispatch
// is interrupted BEFORE the owner's turn opens, so exact-bytes identity can
// never be asked to distinguish two producers on one conversation (Sol r3).
turns.onOwnerPreempt = (terminalId) => {
  dispatchService.interruptAgent(terminalId, 'preempted by owner input')
  // Success = the interrupt actually landed (fail-closed ledger can park it
  // open); a false verdict refuses the owner's write rather than letting two
  // producers share one conversation.
  return !dispatchService.hasOpenDispatch(terminalId)
}

/**
 * How often the sweep looks for dispatches nothing will ever close (D1).
 *
 * A minute: the sweep is a map scan over records the process already holds, and
 * the thing it frees is an agent's in-flight slot — an hour of 409 busy on a
 * dead dispatch is a worse trade than sixty cheap passes.
 */
const DISPATCH_SWEEP_MS = 60_000

const dispatchSweep = setInterval(() => {
  const stamped = dispatchService.sweep()
  if (stamped.length > 0) {
    console.error(`Dispatch sweep closed ${stamped.length} abandoned dispatch(es)`)
  }
}, DISPATCH_SWEEP_MS)
// Never hold the process open for a janitor.
dispatchSweep.unref?.()

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
    cwd: store.focusedState.dir,
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
  const meta = store.createWorkspace(name, dir || store.focusedState.dir)
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
    // An open dispatch dies WITH its workspace — interrupted (infrastructure),
    // never left submitted/busy until the sweep (Sol r1 P1).
    retireTerminal(id, 'workspace removed')
    defaultProducerLease().forgetTerminal(id)
    defaultProducerLease().clearProvenanceOnDeath(id)
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
 * Repoint a terminal to another directory and respawn its PTY there — a
 * running process can't change cwd, so the session is killed and recreated
 * in the new dir. The conversation travels with it (session-move.ts), so the
 * agent resumes where it left off and its checkpoints keep their ordinals; a
 * directory the workspace does not have yet is enrolled first, which is what
 * makes the file browser a working escape hatch. Order lives in terminal-cwd.ts.
 */
async function setTerminalCwd(nodeId: string, dir: string): Promise<CanvasNode> {
  return moveTerminalCwd(
    {
      store: {
        activeId: store.focusedId,
        node: (id) => store.node(id),
        dirs: () => store.dirs(),
        addWorkspaceDir: (workspaceId, target) => store.addWorkspaceDir(workspaceId, target),
        setTerminalCwd: (id, target) => store.setTerminalCwd(id, target)
      },
      release: (id) => {
        // A deliberate rebind is a permanent ending for the OLD session —
        // same primitive as remove/cut, so the reborn id can never inherit a
        // phantom in-turn fact from the dead one (Sol r6).
        retireTerminal(id, 'terminal rebound')
      },
      kill: (id) => ptys.killAndWait(id),
      spawn: (node) => spawnTracked(node),
      carry: (move) => carrySessionToCwd({ ...move, turns: turns.history(move.node.id) }),
      dirExists: (target) => {
        try {
          return statSync(target).isDirectory()
        } catch {
          return false
        }
      }
    },
    nodeId,
    dir
  )
}

// ---- node operations (shared by renderer IPC and the mobile HTTP API) ----

/** Per-kind side effects that bring a just-added ACTIVE-canvas node alive. */
function adoptLiveNode(added: CanvasNode): void {
  if (added.kind === 'terminal') spawnTracked(added)
  if (added.kind === 'browser') void browserManager.syncNode(added).catch(() => undefined)
}

/**
 * A copy made while this terminal's workspace was inactive stashed its
 * context preamble on the node (copyTeam) — deliver it once a PTY exists.
 * The stage is cleared only when a session is actually there to receive it;
 * a failed spawn keeps the preamble for the next boot.
 */
function deliverPendingInject(t: TerminalNodeData): void {
  if (!t.pendingInject) return
  const session = ptys.get(t.id)
  if (!session) return
  const inject = t.pendingInject
  store.updateNodeUnsafe(t.id, { pendingInject: null })
  injectWhenReady(session, inject).catch((error) => {
    console.error('Deferred copy context injection failed:', error)
  })
}

/** Boot one restored terminal: spawn + any deferred copy context. */
/**
 * Every resident session's browsers, not just the focused canvas's.
 *
 * replaceNodes() is a replace-the-WORLD call — anything absent is stopped — so
 * handing it one workspace's browsers while another session is resident would
 * silently kill that session's pages on every switch. The union is the honest
 * argument now that more than one canvas can be live.
 */
/**
 * The drain that makes residency bounded (multi-instance step 2, C3).
 *
 * Without this, SessionRegistry was a design with no caller: hydrating grew
 * the resident set monotonically and nothing ever released it — the unbounded
 * hold of ef5e13c, reinstated by the module written to prevent it. The three
 * liveness facts are read from where they already live, so there is still
 * nothing to set and nothing to leak.
 */
const sessions = new SessionRegistry<{ id: string }>({
  // One window today; step 4 turns this into a per-window count.
  boundWindows: (id) => (id === store.focusedId ? 1 : 0),
  // A phone or SSE reader watching any of this workspace's terminals.
  subscribers: (id) =>
    store.terminalIdsOf(id).reduce((n, tid) => n + sessionSync.subscriberCount(tid), 0),
  // Work in flight: a terminal mid-turn is work, whoever is looking.
  // A terminal mid-turn is work, whoever is looking — plus any remote call
  // this workspace is currently serving, which the inferred signals cannot see
  // during a cold fork's boot.
  inFlightWork: (id) =>
    store.terminalIdsOf(id).filter(hasLiveWork).length + callsInFlight.count(id),
  hydrate: (id) => ({ id }),
  release: (id) => {
    // Order matters, and the comment used to lie about it: detachWorkspace
    // RETURNS the ids, so releasing inside that loop stopped the watches
    // AFTER the PTYs had already gone. The switch path has it right — release
    // and untrack first, then detach — so a watch can never re-arm against a
    // terminal being torn out from under it. Read the set, then tear down.
    const held = store.terminalIdsOf(id)
    for (const tid of held) {
      sessionSync.release(tid)
      turns.untrack(tid)
    }
    ptys.detachWorkspace(id)
    store.releaseSession(id)
  },
  now: () => Date.now()
})

/** How often the drain looks; a session must be dead across two of these. */
const SESSION_DRAIN_TICK_MS = 5_000

const sessionDrain = setInterval(() => {
  // Materialise whatever the store is holding, then let liveness decide. The
  // registry never PINS anything — get() deliberately does not clear the death
  // clock, so a session that is merely resident still drains.
  for (const id of store.resident()) sessions.get(id)
  sessions.drainTick()
}, SESSION_DRAIN_TICK_MS)
sessionDrain.unref?.()

/**
 * Runs a switch plan without holding the main thread.
 *
 * Yields between boots so the companion server can answer in the gaps. See
 * switch-runner.ts for why serial order and the single attach batch both
 * survive that.
 */
const switchRunner = new SwitchRunner<TerminalNodeData, BrowserNodeData>({
  detach: (terminalId) => {
    // Detach (not kill): the tmux session stays alive so returning reattaches
    // it with its agent and scrollback intact.
    sessionSync.release(terminalId)
    turns.untrack(terminalId)
    ptys.detach(terminalId)
  },
  boot: (terminal) => bootTerminal(terminal),
  syncBrowsers: (browsers) => {
    void browserManager.replaceNodes([...browsers]).catch(() => undefined)
  },
  // The herdr workspace's chrome follows the focused Cookrew workspace.
  onBooted: () => reportWorkspaceBinding(),
  // ONE herdr inventory for the whole reattach. The baseline probe measured
  // unbatched pane resolution at 44.8x batched and linear in K (34 panes,
  // 2026-08-20), and a switch is exactly where K is largest.
  beginBatch: () => multiplexer()?.beginAttachBatch?.(),
  endBatch: () => multiplexer()?.endAttachBatch?.(),
  // setImmediate, not a timer: it runs after the poll phase, so pending HTTP
  // callbacks are served before the next boot rather than after a delay.
  yieldToLoop: () => new Promise<void>((resolve) => setImmediate(resolve))
})

function residentBrowsers(): BrowserNodeData[] {
  return store.resident().flatMap((id) =>
    store.workspaceState(id).nodes.filter((n): n is BrowserNodeData => n.kind === 'browser')
  )
}

function bootTerminal(t: TerminalNodeData): void {
  spawnTracked(t)
  deliverPendingInject(t)
}

function addNode(node: CanvasNode): CanvasNode {
  const added = store.addNode(node)
  adoptLiveNode(added)
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
  // A renamed/re-roled terminal re-binds its pane chrome (herdr only — the
  // method is absent elsewhere). The name the pane wears comes from the
  // store, so this runs AFTER the patch lands.
  if (updated?.kind === 'terminal' && ('name' in patch || 'role' in patch)) {
    multiplexer()?.reportPaneCard?.(sessionNameFor(id), paneCard(updated))
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
  return exactGate(node, {
    turnsHistory: (id) => turns.history(id),
    // Same question the launcher asks, so the two can never disagree about
    // whether this node's conversation is reachable.
    piAdoptable: (id, cwd) => adoptablePiSession(id, cwd)
  })
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
  // Asked ONCE per recovery, before anything boots: a session another live
  // claude process holds cannot be resumed, only forked. Cheap (sub-ms, see
  // claude-live-session.ts), so it costs nothing to always know.
  const holders = liveSessionHolders()
  const heldSession = (node: TerminalNodeData): boolean =>
    isClaudeCommand(node.command) &&
    !!node.claudeSessionId &&
    blocksResume(holderOf(node.claudeSessionId, holders))

  // (1) present-but-dead
  const hit = store.nodeAcrossWorkspaces(id)
  if (hit && hit.node.kind === 'terminal') {
    // Only report spawned when we actually (re)booted — an already-live
    // process is a no-op double-recover (LOW).
    const exact = canRestoreExact(hit.node as TerminalNodeData)
    const didSpawn = bootsTerminalsFor(hit.workspaceId) && !ptys.get(id) && exact
    const forked = didSpawn && heldSession(hit.node as TerminalNodeData)
    if (didSpawn) spawnTracked(hit.node)
    return {
      ok: true, id, name: hit.node.name, workspaceId: hit.workspaceId,
      workspaceName: workspaceName(hit.workspaceId), spawned: didSpawn, legacy: false, exact, forked
    }
  }

  const snap = recoverable.get(id)
  if (snap) {
    const orch = activeOrch()
    const plan = planRecovery(snap, {
      activeWorkspaceId: store.focusedId,
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
    const forked = didSpawn && heldSession(added)
    if (didSpawn) spawnTracked(added)
    recoverable.remove(id)
    return {
      ok: true, id, name: added.name, workspaceId: plan.targetWorkspaceId,
      workspaceName: workspaceName(plan.targetWorkspaceId), spawned: didSpawn, legacy: false, exact, forked
    }
  }

  // (3) legacy fallback from the registry (no full snapshot).
  const entry = agents.lookup(id)
  if (!entry) throw new Error(`No recoverable agent '${id}'`)
  const wsExists = store.list().workspaces.some((w) => w.id === entry.workspaceId)
  const targetWs = wsExists ? entry.workspaceId : store.focusedId
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
  const didSpawn = bootsTerminalsFor(targetWs) && exact
  const forked = didSpawn && heldSession(added)
  if (didSpawn) spawnTracked(added)
  return {
    ok: true, id, name: added.name, workspaceId: targetWs,
    workspaceName: workspaceName(targetWs), spawned: didSpawn, legacy: true, exact, forked
  }
}

/**
 * Permanent terminal retirement — ONE primitive for every path that ends a
 * terminal's life (remove, workspace remove, cut, rebind death). Ordering is
 * the contract: interrupt the dispatch while its stamp still exists, clear
 * the first-party facts (untrack deliberately preserves them for ordinary
 * switches, so an ending MUST clear them or a moved/recovered id inherits a
 * phantom in-turn veto — Sol r5), then tear down observation. The kill
 * itself stays with the caller: cut awaits it, remove fire-and-forgets.
 */
function retireTerminal(id: string, why: string): void {
  dispatchService.interruptAgent(id, why)
  turns.clearOpenTurnFact(id)
  // A dead generation's lease holder becomes invisible and its late release
  // a no-op — a reborn id must never inherit a stranded submission window.
  defaultProducerLease().retire(id)
  sessionSync.unwatch(id)
  turns.untrack(id)
}

async function removeNode(id: string): Promise<void> {
  retireTerminal(id, 'terminal removed')
  defaultProducerLease().forgetTerminal(id)
  // A permanently removed uuid never returns: its input-provenance fact
  // protects nothing and would otherwise sit in the WAL forever.
  defaultProducerLease().clearProvenanceOnDeath(id)
  // NOTE: turn history is deliberately NOT cleared on kill — it is the third
  // recovery net (resolveClaudeSessionId matches it to the real session when
  // no snapshot/registry ref exists). Disk-capped at 100/agent, negligible;
  // clearing it destroyed a recovery signal for nothing (R2 fix).
  ptys.kill(id)
  browserThumbs.forget(id)
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
          cwd: store.focusedState.dir
        })
      : null
  const terminal: TerminalNodeData = {
    kind: 'terminal',
    id: randomUUID(),
    name: opts.name || role?.name || preset.name,
    preset: role ? role.preset : preset.name,
    command: role ? role.command : preset.command,
    cwd: store.focusedState.dir,
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
    adoptNode: adoptLiveNode,
    isWorking: terminalIsWorking,
    carrySession: carrySessionToPastedCard,
    git: { gitInfo: (dir) => gitCache.info(dir), addWorktree },
    worktreeRoot: path.join(homedir(), '.cookrew', 'worktrees')
  }
}

/**
 * A CUT card arrives with its conversation. Two things have to move, because
 * the paste changes BOTH coordinates a session is found by:
 *
 *   the ledger  keyed by TERMINAL ID, and a terminal must re-id on paste —
 *               so without this the transcript opens blank even when the
 *               agent itself resumes perfectly (the “Homelab Codex” report).
 *   the session keyed by WORKDIR for claude and pi, and the copy adopts the
 *               target workspace's dirs — the same repoint the workdir move
 *               already does, which is why it is the same function.
 *
 * Codex and OpenCode need only the first: their refs are global addresses, so
 * carrying the binding is enough to resume from anywhere.
 */
function carrySessionToPastedCard(from: TerminalNodeData, to: TerminalNodeData): void {
  const history = turnStore.load(from.id)
  if (history.length > 0) turnStore.scheduleSave(to.id, history)
  carrySessionToCwd({
    node: from,
    fromCwd: from.cwd,
    toCwd: to.cwd,
    toNodeId: to.id,
    turns: history
  })
}

// ---- SELECT-mode clipboard: copy/cut a selection, paste it anywhere ----

/** Is this terminal mid-turn? Only phases in UNCOPYABLE_PHASES refuse; a
 *  detached (untracked) terminal reads as not-working — the paste result
 *  carries `staleSource` so that blindness is surfaced, not hidden. */
function terminalIsWorking(id: string): boolean {
  const activity = turns.list().find((a) => a.terminalId === id)
  return activity !== undefined && UNCOPYABLE_PHASES.has(activity.phase)
}

/**
 * Is there live work on this terminal? The rule lives in session-liveness.ts —
 * imported by this wiring AND by its test, so the two cannot drift. This
 * function only gathers the facts.
 */
/**
 * Is there live work on this terminal? The rule lives in session-liveness.ts.
 *
 * phaseOf, NOT list().find(): list() maps activityOf over every tracked
 * terminal and activityOf walks the whole xterm buffer, so asking it for one
 * scalar cost a full fleet walk PER TERMINAL — and the drain asks once per
 * terminal per resident workspace. That is O(workspaces x terminals^2 x
 * scrollback) every five seconds on the main thread, which is wave C's
 * O(attached x panes) wearing a different hat, in the module written to make
 * that impossible. Measured on the live app under the flag: it put an ~11s
 * floor under EVERY http route, including /api/workspaces, which does no work
 * at all.
 */
function hasLiveWork(id: string): boolean {
  return terminalHasLiveWork({
    phase: turns.phaseOf(id),
    hasOpenDispatch: dispatchService.hasOpenDispatch(id)
  })
}

const teamClipboard = new TeamClipboard({
  activeId: () => store.focusedId,
  workspaces: () => store.list().workspaces,
  workspaceState: (id) => store.workspaceState(id),
  activeNodes: () => store.focusedState.nodes,
  isWorking: terminalIsWorking,
  paste: (spec) => copyTeam(teamForkDeps(), spec),
  // Cut removal is WORKSPACE-SCOPED: identity-moved notes/browsers now
  // exist in the target under the SAME id, so an id-based cross-workspace
  // lookup could remove the freshly pasted card instead of the source.
  // The source is inactive by construction (same-workspace cut refused),
  // but its cut agents' detached sessions are still ALIVE — end them now
  // (killDetached reaches sessions with no live PTY), not at the next
  // startup reap. Moved notes/browsers have nothing to tear down.
  // A cut MOVES the session, so the copy will resume the very file the source
  // is still appending to. An inactive workspace's agents are detached, not
  // dead, so they are ended here — before the paste, not after it. killAndWait
  // throws on a survivor rather than letting `new-session -A` reattach it.
  stopCut: async (nodeIds, fromWorkspaceId) => {
    const state = store.workspaceState(fromWorkspaceId)
    for (const node of state.nodes) {
      if (node.kind !== 'terminal' || !nodeIds.includes(node.id)) continue
      retireTerminal(node.id, 'terminal cut')
      defaultProducerLease().forgetTerminal(node.id)
      defaultProducerLease().clearProvenanceOnDeath(node.id)
      await ptys.killAndWait(node.id)
    }
  },
  removeCut: async (nodeIds, fromWorkspaceId) => {
    const state = store.workspaceState(fromWorkspaceId)
    for (const node of state.nodes) {
      if (node.kind !== 'terminal' || !nodeIds.includes(node.id)) continue
      retireTerminal(node.id, 'terminal cut')
      defaultProducerLease().forgetTerminal(node.id)
      defaultProducerLease().clearProvenanceOnDeath(node.id)
      ptys.kill(node.id)
      ptys.killDetached(node.id)
      agents.deactivate(node.id)
    }
    store.removeNodesFromWorkspace(fromWorkspaceId, nodeIds)
  }
})

function teamClipSet(
  nodeIds: string[],
  cut: boolean,
  worktree?: { name: string }
): TeamClipStatus {
  return teamClipboard.set(nodeIds, cut, worktree)
}

function teamClipStatus(): TeamClipStatus | null {
  return teamClipboard.status()
}

async function teamPaste(): Promise<TeamCopyResult> {
  const cut = teamClipboard.status()?.cut === true
  const result = await teamClipboard.paste()
  // This is the paste's ONE operation event/toast. copyTeam batches its state
  // append without per-node/per-cable events, so a 30-node paste neither
  // floods the renderer nor schedules 59 redundant event-log entries.
  store.recordEvent(
    cut ? 'team.moved' : 'team.copied',
    result.workspaceId,
    result.workspaceName,
    `${result.copiedNodes} node${result.copiedNodes === 1 ? '' : 's'}` +
      (result.staleSource ? ' · context as of last visit' : '')
  )
  return result
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
  return workspaceFromTemplate(teamForkDeps(), { name, dir: dir || store.focusedState.dir, team })
}

function teamSaveTracked(name?: string, nodeIds?: string[]): TeamMeta {
  const meta = teamSaveInner(name, nodeIds)
  store.recordEvent('team.saved', meta.name, meta.name, `${meta.terminalCount} agents`)
  return meta
}

function teamSaveInner(name?: string, nodeIds?: string[]): TeamMeta {
  return teams.save(store.focusedState, (id) => turns.history(id), name, nodeIds)
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
 * Latest browser thumbnails. Kept here (not just in renderer state) so the
 * mobile companion can serve them as images to the phone's canvas cards —
 * pushed by the renderer's capturePage() loop with the flag off, taken from
 * the headless page main itself owns with the flag on.
 */
const browserThumbs = new BrowserThumbCache({
  // peek, not get: drawing a thumbnail must never be what launches a browser.
  // A page that cannot be photographed right now (navigating, mid-resize) is
  // ordinary, not an error: the card keeps its last frame and the next poll
  // tries again.
  capture: async (browserId) =>
    interactiveBrowserEnabled()
      ? ((await browserManager.peek(browserId)?.snapshot().catch(() => null)) ?? null)
      : null
})

/**
 * A phone polled /thumb. What that heartbeat has to trigger depends on who
 * owns the page: with the flag OFF the desktop renderer must keep its legacy
 * webview capture running even while hidden, and with it ON main takes the
 * picture itself — which is what a phone-only viewer needs, since the desktop
 * loop is paused whenever its window is hidden and skips the zoomed card.
 */
async function noteBrowserViewed(browserId: string): Promise<void> {
  if (interactiveBrowserEnabled()) {
    await browserThumbs.refresh(browserId)
    return
  }
  // The keep-alive decision (with its TTL) lives entirely in the renderer's
  // phoneViewingRef — main just relays the heartbeat. No map is held here, so
  // an unauth LAN client polling /thumb with junk ids cannot accumulate state.
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
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
/**
 * Registry hosts whose /install/<presetId> links this app understands (R21).
 *
 * Configured, never inferred: the app must not learn to trust a host because a
 * page it was showing claimed to be one. Empty by default, which recognises
 * nothing — the marketplace is not shipped yet, and an unconfigured registry
 * failing closed is the correct posture until it is.
 */
/**
 * Publish a saved team — the one owner action, wired to the real primitives.
 *
 * This is the caller Tinker's H1 found missing. `checkPayoutAddress` runs
 * inside publishPreset, and publishPreset is reached from here, so the payout
 * verification is in force rather than merely written.
 *
 * The transport posts the shape registry/src/publish-routes.ts actually reads
 * — {manifest, team, teamName} — rather than a shape invented from the commit
 * message. The registry lives in this tree now, so there is no excuse for a
 * guessed contract.
 */
async function publishSavedTeam(input: {
  team: string
  handle: string
  pricing?: unknown
  payout?: unknown
}): Promise<PublishOutcome> {
  const snapshot = teams.load(input.team)
  if (!snapshot) {
    return { ok: false, step: 'scrub', reason: `No saved team called '${input.team}'.` }
  }
  const key = loadPublishingKey()
  return publishPreset(
    {
      hosts: registryHosts,
      hostHelp: () => registryHostHelp(resolveRegistryHosts(registryHostInput()).rejected),
      scrub: (team) => scrubForPublish(team as TeamSnapshot),
      manifest: (built) => buildManifest(built as Parameters<typeof buildManifest>[0]),
      sign: (manifest) => signManifest(manifest, key.privateKey),
      push: (pushed) => pushToRegistry(pushed)
    },
    {
      snapshot,
      handle: input.handle,
      ...(input.pricing !== undefined ? { pricing: input.pricing as PresetPricing } : {}),
      ...(input.payout !== undefined ? { payout: input.payout as PayoutBinding } : {})
    }
  )
}

/** Installation-wide trust list; not workspace state, so it has its own file. */
const registryHostSettings = new RegistryHostSettings()

const registryHosts = (): string[] => resolveRegistryHosts(registryHostInput()).hosts

/**
 * The inputs the host resolution reads. Split out so the refusal path and the
 * recognition path can never disagree about what is configured.
 */
const registryHostInput = (): Parameters<typeof resolveRegistryHosts>[0] => ({
  configured: process.env.COOKREW_REGISTRY_HOST ?? '',
  settings: registryHostSettings.list(),
  // A PACKAGED build recognises nothing it was not told to. Loopback exists
  // only where a shipped app cannot carry it, so the journey is walkable in
  // dev without the product ever trusting a host nobody chose.
  packaged: app.isPackaged
})

/**
 * Why nothing is recognised, in words an owner can act on.
 *
 * The empty default was always deliberate; what was missing is that it never
 * said so. An install link whose only instruction cannot work is a dead end,
 * and a refusal without the fix is the same dead end with better manners.
 */
const registryHostRefusal = (): string => registryHostHelp()

/**
 * A browser card navigated to a marketplace install link (R21).
 *
 * The id is all that crosses. This does NOT install: main owns download,
 * signature verification and the review sheet, and the user owns the decision
 * — a page must never be able to install by being navigated to, only to ask.
 * The ask is announced on the ordinary event stream, so the toast layer, the
 * event panel and the phone all see it without a private channel.
 */
function noteRegistryInstallLink(browserId: string, url: string): void {
  const hosts = registryHosts()
  const presetId = presetIdFromInstallUrl(url, hosts)
  if (presetId === null) {
    // H2: the refusal that makes this NOT a dead end has to reach a human.
    //
    // A link that looks like an install link and is not recognised because NO
    // host is configured is precisely Magpie's give-up #2 — the shared link's
    // only instruction cannot work. Saying nothing here reproduces it exactly:
    // the owner sees a page, nothing happens, and there is no way to learn why.
    //
    // Only for links SHAPED like install links, and only when the list is
    // empty. An unrecognised host on a populated list is a deliberate refusal
    // and announcing it would teach the owner to add whatever host asked.
    if (hosts.length === 0 && looksLikeInstallLink(url)) {
      store.recordEventIn(
        store.ownerOf(browserId) ?? store.focusedId,
        'preset.install.refused',
        url,
        activeBrowserNode(browserId)?.name ?? browserId,
        registryHostHelp(resolveRegistryHosts(registryHostInput()).rejected)
      )
    }
    return
  }
  const node = activeBrowserNode(browserId)
  store.recordEventIn(
    store.ownerOf(browserId) ?? store.focusedId,
    'preset.install.requested',
    presetId,
    node?.name ?? browserId,
    'registry install link'
  )
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    // The renderer opens the review sheet. Only the id and where it came from
    // travel — the URL, its query and the page itself stay on the web side.
    mainWindow.webContents.send('preset:install-requested', { presetId, browserId })
  }
}

function recordHeadlessPageState(
  browserId: string,
  tabId: string,
  state: { url: string; title: string }
): void {
  // BEFORE the early returns below: an install link is worth noticing even
  // when the tab's recorded url/title have not changed (a re-navigation to the
  // same link is a fresh ask), and even for a node the canvas has since lost.
  noteRegistryInstallLink(browserId, state.url)
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
    phaseOf: (id) => turns.list().find((a) => a.terminalId === id)?.phase ?? null,
    // A detached/background target has no tracked phase but may carry an
    // armed dispatch or an open-turn fact — restore must not kill and rebind
    // a session mid-commissioned-work (Sol r4).
    hasArmedDispatch: (id) => turns.hasArmedDispatch(id),
    hasOpenWork: (id) => turns.hasOpenTurnFact(id)
  })

  startSocketServer({
    store,
    ptys,
    spawnTerminal: spawnTracked,
    agents,
    turns,
    // `ask --no-wait` and `cookrew dispatch <id>`: the SAME engine the HTTP
    // route uses, so a CLI-minted dispatch and an API-minted one are one
    // record with one lifecycle.
    dispatch: dispatchService,
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
    // Gates slug routing: off, /<slug>/... is not a route (see mobile-server).
    multiInstance: () => store.isMultiInstance,
    // THE INTERNET GATE (§9 · ④), mounted per workspace session. Reachable only
    // under a slug, so multi-instance gates it without a second flag: an
    // exported agent is addressable because the WORKSPACE is.
    //
    // Every lookup it is given is workspace-scoped at the call site.
    // workspaceState() reads the addressed workspace (from memory when it is
    // the active one, from disk otherwise) — deliberately NOT store.terminals()
    // or store.nodeByName(), both of which read focusedState and would answer
    // for whichever canvas the owner is looking at.
    calls: {
      decide: makeCallGate({
        nodesOf: callNodesOf,
        exportOf: (workspaceId, nodeId) => agentExports.exportOf(workspaceId, nodeId),
        // Live, at the call: a revoked caller stops being entitled the instant
        // the record says so, not when its credential expires.
        enrolled: (workspaceId, sub) => agentExports.enrolledKey(workspaceId, sub) !== null,
        issuer: callCredentials
      }),
      ceremony: makeCallCeremony({
        issuer: callCredentials,
        enrolledKey: (workspaceId, sub) => agentExports.enrolledKey(workspaceId, sub)
      }),
      slugOf: (workspaceId) => store.slugOf(workspaceId),
      // §10: a call runs against a fork, never the original — see call-fork.ts
      // for why that is a safety property and not a tidiness one. The fork
      // engine and the pin store are the SHIPPING ones (the owner's own ⑂
      // button and the rail's markers), so a marketplace copy cannot drift
      // from what the canvas shows.
      session: makeCallSession({
        conversations: callConversations,
        cutVersion: (sourceId) =>
          cutCallVersion(
            {
              fork: (id, turnIndex) => forkTerminal(id, turnIndex),
              turnsOf: (id) => turns.history(id),
              scrollLineOf: (id) => ptys.get(id)?.paneScrollState().historySize ?? null,
              pins: {
                list: (id) => pinStore.list(id),
                add: (id, pin) => pinStore.add(id, pin)
              },
              now: () => Date.now()
            },
            sourceId
          ),
        forkAlive: (forkId) => store.nodeAcrossWorkspaces(forkId) !== undefined,
        now: () => Date.now()
      }),
      // The only path from the internet into a pty. askTerminal brings the
      // producer lease and the 409 vocabulary with it; the fork id comes from
      // the session above, which cannot produce the original.
      run: makeCallRun({
        sessionOf: (forkId) => ptys.get(forkId),
        ready: (forkId) => forkContextReady(forkId),
        ask: (session, prompt, signal) => askTerminal(session as PtySession, prompt, { signal }),
        inFlight: (identity, cancel) => callsInFlight.enter(identity, cancel),
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      })
    },
    events,
    agents,
    traces,
    // Activity Board data plane. Without this /api/board answers 503 —
    // deliberately, so a missing wire-up is loud instead of an empty board.
    // probe (L2) is absent until the tmux sampler lands; rows then degrade to
    // their last known task rather than claiming a phase nobody observed.
    board: boardSources(),
    // Attach-free dispatch (v4 §3): the two /api routes answer 503 without it.
    dispatch: dispatchService,
    // While a dispatch is armed, the HTTP input/ask producers refuse 409 —
    // two writers racing one agent is two answers to one reservation.
    hasArmedDispatch: (terminalId) => turns.hasArmedDispatch(terminalId),
    // A live stream is a watcher (A4): open holds/starts the file watch,
    // close hands the terminal back to the drain clock.
    subscribeTerminal: (terminalId) => sessionSync.subscribe(terminalId),
    unsubscribeTerminal: (terminalId) => sessionSync.unsubscribe(terminalId),
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
      teamClipSet,
      teamClipGet: teamClipStatus,
      teamPaste,
      teamList: () => teams.list(),
      roleSave: roleSaveTracked,
      roleList: () => roles.list(),
      roleDelete: (name: string) => roles.delete(name)
    },
    saveAttachment: (name, data) => saveAttachment(defaultAttachmentsDir(), name, data),
    browserThumb: (id) => browserThumbs.frame(id),
    interactiveBrowserEnabled,
    browserThumbRequested: noteBrowserViewed,
    onUpgrade: (request, socket) => browserCast.upgrade(request, socket),
    // Built renderer bundle — served to phones so mobile gets the full
    // desktop canvas UI. Dev proxies Vite so LAN phones get live code; a
    // tailnet peer gets this bundle instead, because the unbundled graph is
    // 159 dependent requests and a relayed link never finishes them.
    rendererDir: path.join(dirname, '../renderer'),
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL,
    rendererSrcDir: path.join(app.getAppPath(), 'src/renderer/src')
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

  // Boot PTYs for terminals restored from the saved workspace — through
  // bootTerminal, so a pending copy preamble staged before the app quit is
  // delivered on cold start too, not only on workspace switches.
  for (const t of store.terminals()) bootTerminal(t)
  reportWorkspaceBinding()

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
  // Before anything is torn down: an open dispatch is commissioned work whose
  // outcome this process was the only witness to. Stamping it interrupted is
  // what separates "we lost sight of it" from "it never happened" for whoever
  // reads the ledger after the restart.
  clearInterval(dispatchSweep)
  clearInterval(sessionDrain)
  // Latch FIRST: no new ask may register after the drain snapshot begins
  // (Sol r11) — then interrupt commissioned work and retire the lease
  // generations, firing the abort seam into everything still in flight.
  beginShutdown()
  dispatchService.interruptAll('app quit')
  // Panes stay alive across a quit, but no herdr CLI child may survive it:
  // retire every lease generation (fires the abort seam into active asks and
  // deliveries) and await the bounded TERM→KILL settlements (Sol r10).
  defaultProducerLease().retireAll()
  browserCast.shutdown()
  store.flush()
  events.flush()
  sessionSync.dispose()
  turns.flushHistories()
  turns.disposeAll()
  ptys.disposeAll()
  // The bounded drain: asks, then every tracked herdr child, then in-flight
  // folds with their directory debts — no CLI process and no unproven rename
  // outlives the app (Sol r11).
  void cancelAllAsks()
    .catch(() => undefined)
    .then(() => {
      const mux = multiplexer()
      return mux instanceof HerdrHostMultiplexer
        ? mux.cancelAllHerdrOperations(4000)
        : undefined
    })
    .catch(() => undefined)
    .then(() => turnStore.drainFolds(2000))
    .catch(() => undefined)
    .then(() => browserManager.shutdown())
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
    mainWindow.webContents.send('workspace:state', store.focusedState)
  }
}

function registerIpc(handlers: RestoreHandlers): void {
  store.on('change', broadcast)

  // A workspace switch used to be a teardown: detach every outgoing PTY, boot
  // the incoming canvas, rebuild the browser runtime from scratch. That is the
  // singleton showing through — focus deciding what exists.
  //
  // With sessions resident (step 2) a switch is a FOCUS CHANGE. The workspace
  // you left keeps its live screens, so switching back costs nothing and the
  // work you looked away from was never interrupted. Only what is not resident
  // is torn down, which flag-off makes the outgoing workspace — today's
  // behaviour exactly.
  store.on('switch', ({ previousTerminalIds }: { previousTerminalIds: string[] }) => {
    // The DECISION lives in workspace-switch.ts and the EXECUTION in
    // switch-runner.ts; this handler only connects them. Both were once one
    // synchronous loop here, which is how a 16-terminal switch held the main
    // thread — and therefore the companion HTTP server — for ~90 seconds.
    const plan = planWorkspaceSwitch({
      previousTerminalIds,
      workspaceOfTerminal: (id) => ptys.workspaceOfTerminal(id),
      isResident: (workspaceId) => store.resident().includes(workspaceId),
      focusedTerminals: store.terminals(),
      residentBrowsers: residentBrowsers()
    })
    // Fire-and-forget by necessity: 'switch' is an EventEmitter callback with
    // nobody to await it.
    //
    // A boot that throws ABORTS THE REST OF THE SWITCH. The loop has no
    // per-iteration catch, so the throw unwinds out of it: the remaining
    // terminals are not booted, syncBrowsers and the chrome report are skipped,
    // and it surfaces here as one logged line. What it can no longer do is
    // strand the attach batch — the runner closes that in a finally — which is
    // the part the synchronous loop got wrong.
    //
    // Whether a failed boot SHOULD abort the rest is a real question and not
    // this commit's to answer: making it continue changes what a partially
    // booted workspace looks like to every seat reading it, and wants its own
    // test. Filed as a follow-up rather than slipped in between review and
    // merge.
    void switchRunner.run(plan).catch((error) => {
      console.error('Workspace switch failed:', error)
    })
  })

  // Push the workspace list to the renderer whenever it changes.
  store.on('workspaces', (list) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('workspace:list', list)
    }
  })

  // Renderer resolved a ⌘W to "nothing left to close" → quit.
  ipcMain.on('app:quit', () => app.quit())

  // ---- the owner's grant surface (owner-only IPC, never a route) ----
  //
  // Every handler goes through ownerOnly. "Owner-only IPC" is worth nothing if
  // a page the app merely RENDERS can reach the channel — a browser card hosts
  // whatever the owner browsed to, an install page comes from a registry, a
  // preset can ship a URL. So the sender must BE the owner window's top frame,
  // proved rather than assumed from the fact that IPC is not HTTP.
  const ownerOnly =
    <A extends unknown[], R>(op: (...args: A) => R) =>
    (event: Electron.IpcMainInvokeEvent, ...args: A): R | { ok: false; reason: string } => {
      if (!isOwnerSender(event.sender, event.senderFrame, mainWindow?.webContents)) {
        console.error('[cookrew] grant refused: sender is not the owner window top frame')
        return { ok: false, reason: 'not_owner' }
      }
      return op(...args)
    }

  ipcMain.handle(
    'grant:enrol',
    ownerOnly((workspaceId: string, sub: string, jwk: Record<string, unknown>) =>
      ownerGrant.enrol(workspaceId, sub, jwk)
    )
  )
  ipcMain.handle(
    'grant:revoke',
    ownerOnly((workspaceId: string, sub: string) => ownerGrant.revoke(workspaceId, sub))
  )
  ipcMain.handle(
    'grant:export',
    ownerOnly((workspaceId: string, nodeId: string, callers: string[]) =>
      ownerGrant.exportAgent(workspaceId, nodeId, callers)
    )
  )
  ipcMain.handle(
    'grant:unexport',
    ownerOnly((workspaceId: string, nodeId: string) => ownerGrant.unexport(workspaceId, nodeId))
  )
  // The deck's 10-second UNDO toast. A separate channel from enrol because
  // undoing a revoke and admitting a new caller are different decisions, and
  // collapsing them would let an undo quietly create someone.
  ipcMain.handle(
    'grant:restore',
    ownerOnly((workspaceId: string, sub: string) => ownerGrant.restore(workspaceId, sub))
  )
  // READ paths, so the owner can see what they granted. Same ownership check:
  // the roster of who may call your agents is not for a rendered page either.
  //
  // The ROSTER rather than the raw exports: the record's shape is not the
  // question's, and the revoke ruling made "is anything running right now" a
  // thing the surface has to be able to answer — a control that promises to
  // stop calls already running is unusable if it cannot say whether any are.
  ipcMain.handle(
    'grant:list',
    ownerOnly((workspaceId: string) =>
      buildGrantRoster({
        workspaceId,
        enrolledIn: (id) => agentExports.enrolledIn(id),
        revokedIn: (id) => agentExports.revokedIn(id),
        exportsIn: (id) => agentExports.exportsIn(id),
        callsIn: (id) => callsInFlight.listIn(id)
      })
    )
  )

  // ---- the author journey (Door A), reachable at last -------------------
  //
  // H1/H2/H3 of Tinker's review were ONE bug wearing three faces: the payout
  // check, the host refusal and the settings surface were all written, tested
  // and called by nothing. A check with no caller is not protection, and a
  // commit message that says it is will be believed by the next lane. These
  // handlers are the callers.

  /** The trust list, and the two ways an owner changes it. H3. */
  ipcMain.handle('registry:hosts', () => ({
    hosts: registryHosts(),
    configured: registryHostSettings.list(),
    source: resolveRegistryHosts(registryHostInput()).source,
    help: registryHostHelp(resolveRegistryHosts(registryHostInput()).rejected),
    rejected: resolveRegistryHosts(registryHostInput()).rejected
  }))
  ipcMain.handle('registry:host:add', (_e, host: string) => registryHostSettings.add(host))
  ipcMain.handle('registry:host:remove', (_e, host: string) =>
    registryHostSettings.remove(host)
  )

  /**
   * Publish a saved team. ONE owner action — the thing that did not exist.
   *
   * Every refusal comes back named, because the author has to act on it: a
   * bare failure sends them to the ~140 hand-written lines this replaces.
   */
  ipcMain.handle(
    'publish:preset',
    async (_e, input: { team: string; handle: string; pricing?: unknown; payout?: unknown }) =>
      publishSavedTeam(input)
  )

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
    // The active workspace's new name is what the herdr workspace wears.
    if (id === store.focusedId) reportWorkspaceBinding()
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

  // "Open in browser" from a browser card/popout. Validated HERE, not only in
  // the renderer: shell.openExternal on a non-web scheme launches whatever
  // local handler claims it. The CANONICAL href is what gets opened — WHATWG
  // URL strips embedded tab/newline, so validating the raw string and opening
  // it would let 'ht\ntps://…' pass one parser and mean something else to the
  // OS one. The `unknown` is honest: type annotations don't cross IPC.
  ipcMain.handle('shell:openExternal', (_e, url: unknown) => {
    const canonical = typeof url === 'string' ? canonicalExternalUrl(url) : null
    if (canonical === null) {
      throw new Error('Only http(s) URLs and renderable local files can be opened externally')
    }
    return shell.openExternal(canonical)
  })

  // Turn/summary activity for the canvas cards.
  turns.on('activity', (activity) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('terminal:activity', activity)
    }
  })

  // A completed turn is the fleet's headline latency (p95-p98 spec). The
  // tracker measures it and index.ts records it, so it enters the log through
  // the store's choke-point like everything else rather than growing a second
  // way in. Actor is the AGENT: nobody typed this event, an agent finishing
  // its work produced it. A terminal whose node has since gone (dismissed
  // between the reply and this tick) still reports — losing the sample would
  // bias the tail toward the agents that survive.
  turns.on(
    'turn',
    ({ terminalId, durationMs, dispatchId, turnIndex, latencyReported, outcome }: CompletedTurn) => {
      // One latency sample per exchange: an attached file-backed dispatch is
      // observed by the scrape first (no dispatchId) and closed by the file
      // path second — the second event carries latencyReported and must not
      // land a duplicate row in the event log.
      if (latencyReported !== true) {
        const node = store.node(terminalId)
        store.withOpContext({ actor: 'agent' }, () =>
          store.recordEvent(
            'turn.completed',
            terminalId,
            node?.name ?? terminalId,
            turnDetails(dispatchId),
            durationMs
          )
        )
      }
      // Close the dispatch this turn answered (v4 §3): submitted → running →
      // done {turnIndex, reply}. The event names the ANSWERING record — a
      // tail read would bill the follow-up prompt whenever the file closer
      // fired past a tail-overtake (Sol r2).
      if (dispatchId !== undefined) {
        const history = turns.history(terminalId)
        const completed =
          turnIndex !== undefined
            ? history.find((record) => record.index === turnIndex)
            : history[history.length - 1]
        dispatchService.completeTurn(dispatchId, {
          turnIndex: completed?.index ?? 0,
          ...(completed?.reply !== undefined ? { reply: completed.reply } : {}),
          ...(outcome !== undefined ? { outcome } : {}),
          // The answering identity survives rewinds; the ordinal is display.
          ...(completed?.uuid !== undefined ? { uuid: completed.uuid } : {})
        })
      }
    }
  )
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

  ipcMain.handle('workspace:get', () => store.focusedState)
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

  // ---- marketplace presets (§8): the dock's third chip family ----
  // `preset:*` was already taken by the HARNESS presets above. These are a
  // different list with a different shape, so they get their own namespace —
  // reusing the channel threw on registration (Electron refuses a second
  // handler) and took every handler after it down with it.
  ipcMain.handle('preset:installed:list', () => presetStore.list())
  /**
   * §10's read path. Asked per terminal, because a pin belongs to a transcript
   * and not to a workspace.
   */
  ipcMain.handle('pins:list', (_e, terminalId: string) => pinStore.list(terminalId))
  /**
   * R20 — the buyer's two answers to a key rotation.
   *
   * `seen` retires the SHEET and nothing else: the rotation itself stays, so
   * the chip keeps saying KEY CHANGED until it is resolved. Once as a sheet,
   * never once as a fact.
   *
   * `trust` moves the pin forward — and it can only ever confirm the rotation
   * the client itself recorded. The key is checked against what is on disk
   * rather than taken from the renderer, because a channel that accepted any
   * key id would be a way to pin an attacker's key by IPC alone, which is
   * precisely the decision the sheet exists to put in front of a person.
   */
  ipcMain.handle('preset:installed:rotation:seen', (_e, id: string) => {
    if (!isPresetId(id)) throw new Error('not a preset id')
    presetStore.markRotationSheetSeen(id)
  })
  ipcMain.handle('preset:installed:rotation:trust', (_e, id: string, newKeyId: string) => {
    if (!isPresetId(id)) throw new Error('not a preset id')
    const rotation = presetStore.rotationOf(id)
    if (rotation === null || rotation.newKeyId !== newKeyId) {
      throw new Error('no such rotation to trust')
    }
    presetStore.trustAuthorKey(id, newKeyId)
  })
  ipcMain.handle('preset:installed:uninstall', (_e, id: string) => {
    // C1: the id crosses from the renderer and ends at a recursive delete.
    // The store validates it too; this refuses at the boundary so a hostile
    // string never reaches a filesystem call in the first place.
    if (!isPresetId(id)) throw new Error('not a preset id')
    presetStore.uninstall(id)
  })
  /**
   * R2: the canvas click is the aimed confirm, so this both aims and commits.
   *
   * Both kinds place through the ordinary node-add path. A team used to be
   * handed to copyTeam, which is workspace-to-workspace and validates
   * nodeIds + intoWorkspaceId — so it threw on its first guard EVERY time, and
   * an `as never` on the argument is what let that compile. Adding the planned
   * nodes directly is also the only way `command` and `cwd` survive; forwarding
   * {name, preset, position, orch} to createTerminal dropped both and fell back
   * to a built-in preset whenever the name was not one of them.
   */
  ipcMain.handle(
    'preset:installed:place',
    async (_e, id: string, position: CanvasPosition, orch: boolean) => {
      if (!isPresetId(id)) throw new Error('not a preset id')
      // N4: THE GATE IS ENFORCED HERE, not in the renderer. The chip's click
      // handler declining to place a locked preset is presentation; the channel
      // is reachable without it, so a locked preset was placeable by anyone who
      // could call the IPC. Refuse where the decision is authoritative.
      if (presetStore.list().find((p) => p.id === id)?.entitled === false) {
        throw new Error('preset is not entitled')
      }
      const stored = presetStore.read(id)
      // Null covers absent, a blob that no longer matches its manifest, and a
      // signature that does not verify against the key pinned at install.
      if (stored === null) throw new Error('preset is missing or failed verification')
      const snapshot = JSON.parse(stored.teamBytes.toString('utf8')) as TeamSnapshot
      const plan = planPresetImport(snapshot, {
        dirs: store.focusedState.dirs?.length ? store.focusedState.dirs : [store.focusedState.dir],
        cutAt: Date.now(),
        position,
        manifestId: stored.manifest.id
      })
      const placed = plan.nodes.map((node) =>
        // orch is the placer's choice for the agents being placed; notes and
        // browsers have no such flag.
        node.kind === 'terminal' ? ({ ...node, orch } as CanvasNode) : node
      )
      if (plan.kind === 'single') {
        recordPins([addNode(placed[0])], plan.pin)
        return
      }
      // N2: ONE write and ONE broadcast for a team. The add-then-connect loop
      // cost a disk write and a state broadcast per node AND per cable — seven
      // of each for a four-node preset — and left the canvas legible in
      // between, so a paste arrived as a stutter of half-teams. This lands the
      // whole team in a single patch; adoptLiveNode still runs per node
      // afterwards, because spawning a PTY is inherently per-terminal.
      const added = store.appendTeamToWorkspace(store.focusedId, placed, plan.connections)
      for (const node of added) adoptLiveNode(node)
      recordPins(added, plan.pin)
    }
  )

  // Team fork / team save / roles (contract in note team-fork-roles-spec-v1).
  ipcMain.handle('team:fork', (_e, spec: TeamForkSpec) => teamFork(spec))
  ipcMain.handle('team:save', (_e, name?: string, nodeIds?: string[]) =>
    teamSaveTracked(name, nodeIds)
  )
  ipcMain.handle('team:clip:set', (_e, nodeIds: string[], cut: boolean, worktree?: { name: string }) =>
    teamClipSet(nodeIds, cut, worktree)
  )
  ipcMain.handle('team:clip:get', () => teamClipStatus())
  ipcMain.handle('team:clip:paste', () => teamPaste())
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
  const inputRefusalAnnounced = new Map<string, number>()
  ipcMain.on('pty:input', (_e, terminalId: string, data: string) => {
    const verdict = ptys.get(terminalId)?.write(data)
    // A refused byte must be VISIBLE (Sol r8): silently vanishing keystrokes
    // during a delivery window or a contaminated box read as a broken app.
    // Announced through the ordinary event stream (toast layer + phone),
    // throttled per terminal so held-down keys make one toast, not fifty.
    if (verdict && verdict !== 'allow') {
      const last = inputRefusalAnnounced.get(terminalId) ?? 0
      if (Date.now() - last > 3000) {
        inputRefusalAnnounced.set(terminalId, Date.now())
        const node = store.node(terminalId)
        store.withOpContext({ actor: 'agent' }, () =>
          store.recordEvent(
            'terminal.input-refused',
            terminalId,
            node?.name ?? terminalId,
            turns.refusalReason(terminalId) ??
              'a dispatch is being delivered — input refused for a moment'
          )
        )
      }
    }
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
    browserThumbs.putDataUrl(browserId, dataUrl)
  })

  /**
   * Card thumbnail with the flag ON. There is no renderer webview to capture
   * any more, so the picture has to come from the headless page that actually
   * owns the tab — without it every browser card sits on the placeholder
   * forever. The DESKTOP loop's entry point only: a phone reaches the same
   * cache through /api/browser/:id/thumb, which no longer waits on this.
   */
  ipcMain.handle('browser:snapshot', async (_e, browserId: unknown) => {
    if (typeof browserId !== 'string' || !interactiveBrowserEnabled()) return null
    await browserThumbs.refresh(browserId)
    return browserThumbs.dataUrl(browserId)
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
