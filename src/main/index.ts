import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, net, Notification, powerMonitor, powerSaveBlocker, safeStorage, shell, systemPreferences } from 'electron'
import path from 'node:path'
import { readTerminalSession } from './terminal-session'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { WorkspaceStore } from './store'
import { PtyManager, multiplexer, paneSizes, sessionNameFor } from './pty'
import { buildInbox, type InboxNode } from './inbox'
import { cachedDispatchReader, wireInbox } from './inbox-wiring'
import { createWindowHold } from './inbox-window-hold'
import { deliverToRecruit, type RecruitWitness } from './recruit-delivery'
import { nameAgent } from './agent-namer'
import { autoNameIn, renameByHand, renameCardIn, type RenameDeps, type RenameOutcome } from './agent-rename'
import { recruitPatch, spawnInjectionFor } from './recruit-node'
import { placeBeside, type Alternate, type DecideCandidate, type Harness } from '../shared/sous-decide'
import { SousLedger } from './sous-ledger'
import { createJevDecider, jevEnabled, JEV_DEADLINE_MS } from './sous-jev'
import { createSousBreaker } from './sous-breaker'
import { retryVerdict } from './sous-retry'
import { buildCandidates } from './decide-candidates'
import type { PtySession } from './pty'
import type { PaneCardInfo } from './multiplexer'
import { paneCardFor, reportAllPaneBindings, type BindableTerminal } from './pane-bindings'
import {
  agentStatus,
  statusFeed,
  type HerdrStatus,
  type StatusObservation,
  type StatusRetraction
} from './herdr-agent-status'
import { resolveRotationChain, rotationCommitVerdict } from './claude-rotation'
import { BootLatency, shouldTimeBoot, type BootSample } from './boot-latency'
import { TurnTracker, type CompletedTurn } from './turn-tracker'
import { blockAsPaste, createPacedInput } from './enter-pacing'
import { createMenuAnswerer, parseMenuRequest, setMenuAnswerer } from './menu-answer'
import { waitChoiceOfScreen, type WaitChoice } from '../shared/wait-choice'
import { aboutOfScreen, wholeBrief } from '../shared/wait-about'
import { createBackendPhaseGate } from './backend-phase-gate'
import { TurnStore } from './turn-store'
import {
  DispatchService,
  appendDispatchRecord,
  appendDispatchTombstone,
  compactDispatchRegistry,
  defaultDispatchRegistry,
  readDispatchRecords,
  contextExhausted,
  readDispatchTombstones,
  turnDetails
} from './dispatch'
import { HerdrHostMultiplexer, HERDR_SESSION } from './herdr-host-multiplexer'
import { selfHostedLaunch, selfHostRefusalMessage } from './self-host-guard'
import { DEEP_LINK_SCHEME, createDeepLinkQueue, deepLinkInArgv, parseDeepLink } from './deep-link'
import { DEEP_LINK_CHANNEL } from '../shared/deep-link'
import { createRegistryTokenVerifier, registryKeyOverHttp } from './registry-token'
import { faceWords, harnessesOf } from './served-face'
import { askTerminal, beginShutdown, cancelAllAsks, ownerSubmit, pasteAndSubmit, waitForReady } from './ask'
import { CableSignalBus } from './cable-signal'
import { defaultProducerLease } from './producer-lease'
import {
  boardSourcesFrom,
  buildBoard,
  boardWindowMs,
  createProbeSampler,
  PROBE_INTERVAL_MS,
  tmuxProbeDeps
} from './board-index'
import { createBoardHolds } from './board-hold'
import { registerZoomFleetIpc } from './zoom-fleet'
import { setShellObserver } from './multiplexer'
import { createLoopHealth } from './loop-health'
import { loadOrCreateReadOnlyToken } from './readonly-token'
import { loadOrCreatePairingToken } from './pairing-token'
import { searchTurns } from '../shared/turn-search'
import { sousBreakerState, sousReadiness, summarizeTurn } from './sous'
import { translateBody } from './sous-translate'
import { remoteSousHost } from './sous-remote-config'
import { TRANSLATE_MAX_CHARS } from '../shared/translate'
import { startSocketServer, type SocketServerHandle, type SousDoor } from './socket-server'
import { RoutineScheduler } from './routines'
import { VoiceEngine } from './voice'
import { SousController } from './sous-control'
import { MacListener } from './listen'
import { hearAvailable, hearRecording } from './hear-file'
import { createLocalVoice } from './local-voice'
import { polishTranscript } from './sous-polish'
import { readSousVoiceConfig } from './sous-voice-config'
import type { IntentRoster, Surface as SousSurface } from '../shared/sous-intent'
import type { UiCommandEvent } from '../shared/sous-ui'
import { EventEmitter } from 'node:events'
import {
  cachedTailnet,
  startMobileServer,
  localFleetService,
  mobileUrls,
  mobileEndpointList,
  uncoveredCertHosts,
  rotateActivePairingToken,
  activePairingTokenValue,
  activeCertFingerprint,
  trustedOrigins,
  allowedCompanionOrigins,
  companionTokenAccepted,
  refreshMobileCert,
  advertisedHostsNow
} from './mobile-server'
import { createDesktopCert, type DesktopCert } from './desktop-cert'
import { createSecretsStore } from './secrets-store'
import { electronSealer, excludeFromBackup } from './secrets-seal'
import { noticeGate, secretNotice, withSecretActivity, type SecretActivityType, type SecretChange } from './secret-activity'
import { createRtcHost } from './rtc-peer'
import { createSocketBridge } from './socket-bridge'
import { BUILD_CHECK_MS, readBuildId } from './build-id'
import { secretAuditDetails, type SecretAudit } from './secret-cli'
import { ensureSecretSlotNote } from './secret-note'
import { createScrubber } from './scrub'
import { sousGatewayKey } from './sous-config'
import { scrubInboxRow, scrubSousResult } from './scrub-surfaces'
import { VphoneInstance } from './vphone-instance'
import { createSocketGuest, vphoneSocketPath } from './vphone-socket'
import { createUseInstances } from './use-instances'
import { createUseSourceService } from './use-source-service'
import { emptySourceList } from '../shared/use-sources'
import { UseSignalBus } from './use-signal-bus'
import { DEFAULT_NAME_ZONE } from '../shared/reach-names'
import { NameCertStore } from './name-cert-store'
import {
  activeBrowserTab,
  AgentRole,
  BrowserNodeData,
  BrowserTab,
  browserTabs,
  CanvasNode,
  CanvasPosition,
  DEFAULT_CANVAS_POSITION,
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
import { launchCommand, withoutRoutedPick } from '../shared/launch-tune'
import { launchOfferFor, withLaunchOffers } from './launch-offers'
import { GatewayMonitor } from './route/gateway'
import { RouteService } from './route/service'
import { magpieInstalled } from './route/discovery'
import { claudeComposerDrawn, forkContextReady, forkTerminal as forkTerminalOp, harnessReadyForInput, injectWhenReady } from './fork'
import { AgentRegistry, type AgentRegistryUpsert } from './agent-registry'
import { HARNESS_FACTS } from './route/setup'
import { AgentExportStore } from './agent-export'
import { OwnerGrant, isOwnerPage, isOwnerSender } from './owner-grant'
import { Accounts, DEFAULT_LOCK_AFTER_MS, registryOrigin } from './account-v2'
import { relayHandle } from './legacy-identity'
import { WorkspaceShots } from './workspace-shots'
import { closeLane, landLane, listLanes, openLane, repoOf } from './lanes'
import type { LaneInfo, LandResult } from '../shared/model'
import { laneGit } from './git'
import { republishDoors, servingChange } from './serving-identity'
import { createAdmittedDeviceStore } from './admitted-devices'
import { pairingHandout } from './pairing-handout'
import { pairingUrl } from '../shared/pairing-url'
import type { PairingHandout } from '../shared/account-v2'
import { createReachPublisher, type ReachPublisher } from './reach'
import { createNetworkWatch } from './network-watch'
import { createCanvasLink } from './canvas-link'
import { createCanvasBridge, loopbackDialer } from './canvas-bridge'
import { IdleLock } from './lock'
import { mintWatchInvite, registerAccountIpc } from './account-ipc'
import type { AccountDoor, LoginAudit } from './login-cli'
import { paneInputs } from './pane-input'
import { injectWindowInput } from './ui-input'
import { localDeviceName } from './device-name'
import { machineProfile } from './machine-profile'
import { COMPANION_BOOTSTRAPS } from '../shared/lan-token-mode'
import { Requests, answeredStoreIn } from './requests'
import {
  DoorCallers,
  DoorSeats,
  seatedCallersFor,
  seatsApiOverAccounts,
  type ServedTeamRef
} from './door-seats'
import { Factors } from './factors'
import { SeatSettleQueue } from './seat-settle'
import { emit, isFreshInstall, resumeTelemetry, setTelemetryOn, startTelemetry, telemetryStatus } from './telemetry'
import { TELEMETRY_DEFAULT_ON } from '../shared/funnel-events'
import { createV2CallTokenVerifier, v2KeysOverHttp } from './v2-call-token'
import type { ServedCallersRow } from '../shared/seats'
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
import { createSessionDrain, SESSION_DRAIN_TICK_MS } from './session-drain'
import { LazyTerminalAttachments } from './lazy-terminal'
import { planWorkspaceSwitch } from './workspace-switch'
import { SwitchRunner } from './switch-runner'
import { terminalHasLiveWork } from './session-liveness'
import { isClaudeCommand } from '../shared/claude-fork'
import { canonicalExternalUrl } from '../shared/external-url'
import { isChromiumErrorPage } from '../shared/browser-navigation'
import {
  claudeSessionFile,
  claudeSpawnCommand,
  claudeCwdRepair,
  locateClaudeSessionFile,
  realCwd,
  resolveClaudeSessionId,
  resumeRoleSession,
  roleSessionDir,
  saveRoleSessionCopy
} from './claude-fork'
import { isCodexCommand, resolveCodexRolloutByPid } from './codex-bind'
import { isOpenCodeCommand, resolveOpencodeSessionByPid } from './opencode-bind'
import { isPiCommand, piAdoptableSession, piLaunchBinding, resolvePiSessionByPane } from './pi-bind'
import {
  applyTuning,
  subjectOf,
  TuneAsks,
  TuningCache,
  tuningStateOf,
  type TuneDeps
} from './agent-tuning'
import type { AgentTuning, TuneKnob } from '../shared/agent-tuning'
import { relaunchInPlace, type RelaunchDeps } from './agent-relaunch'
import { MAC_VIEWER, restartConfirm, type RemoteBuild, type ViewerWho } from '../shared/remote-access'
import { parseUseUrl } from '../shared/use-url'
import { readMacListedApp, readMacSession } from './mac-bridge'
import { linuxScreenRefusal } from './linux-screen'
import { createRemoteDesk, remoteGate } from './remote-desk'
import { createUpdateCheck } from './update-check'
import { createUnlockDoor, loadUnlockKey } from './remote-unlock'
import type { SealKeyPair } from '../shared/relay-seal'
import { fingerprintOfDigest } from '../shared/key-fingerprint'
import { electronUpdateInstaller } from './update-install'
import type { UpdateStatus } from '../shared/update-check'
import { commandRun, createSessionReader, linuxSession, remoteBuild, remoteSettingsFile } from './remote-probe'
import { createRemoteTray } from './remote-tray'
import { claudeSettingsGateway, launchPick, newAgentPlan, withGatewayModel } from './claude-model-route'
import { harnessFor } from './harness'
import { canRestoreExact as exactGate, isRefOwned } from './recover-gate'
import { blocksResume, holderOf, liveSessionHolders, planHeldSessionFork } from './claude-live-session'
import {
  liveSessionOfPane,
  oracleVerdict,
  ORACLE_BOOT_DELAYS_MS,
  ORACLE_SWEEP_MS,
  PanePidCache
} from './claude-session-oracle'
import { RebindDamper } from './rebind-damper'
import { createRestoreHandlers, registerRestoreIpc, RestoreHandlers } from './restore'
import { withSessionLineage } from './session-lineage'
import { LineageSpill, installLineageSpill } from './lineage-spill'
import { buildManifest, loadPublishingKey, signManifest } from './preset-publish'
import type { PresetPricing } from '../shared/preset-manifest'
import { carrySessionToCwd } from './session-move'
import { moveTerminalCwd } from './terminal-cwd'
import { createBrowserCast } from './browser-cast'
import { createBrowserCastIpc } from './browser-cast-ipc'
import { WatchPairing } from './watch-pairing'
import { createWatchHost } from './watch-host'
import { inviteWatch, setWatchHost } from './watch-routes'
import { BrowserThumbCache } from './browser-thumb-cache'
import { findChrome } from './headless-chrome'
import { interactiveBrowserDefault, relayOrigin, widenedPath } from './launch-defaults'
import { HeadlessBrowserManager } from './headless-browser-manager'
import { HeadlessBrowserCommandEngine, withActiveUrl } from './headless-browser-command'
import { browserForCaller, keptBrowsers } from './browser-reach'
import { reapOrphanBrowserProfiles, removeBrowserProfile } from './browser-profile-store'
import { HeadlessReaper, reapOrphanChrome } from './orphan-chrome'
import { keepCachesOutOfIndex } from './cache-noindex'
import { installTscGate } from './tsc-gate'
import { pressureOf, readMachineMemory, sleepColdLookups, sleepWindowMs, type PressureLevel } from './machine-pressure'
import { staleAgentIds } from './agent-reconcile'
import { IdleSleep, idleSleepMsFrom, type SleepFacts } from './agent-sleep'
import { reasonAwake, sleepReport, writeSleepReport } from './sleep-report'
import { AgentWaker } from './agent-wake'
import { cronArmedIn, gatherSleepEvidence, paneHolder, quietSince, readProcTable, sessionMoved } from './agent-sleep-evidence'
import { purgeRegenerableProfileData, reapOrphanPartitions } from './browser-storage-gc'

import { TraceReader, type SessionWatchSpec } from './trace'
import { createStreamService } from './stream-service'
import {
  streamBlocks,
  streamIndex,
  streamMarks,
  streamOpen,
  streamTail,
  type StreamCursorRequest,
  type StreamIpcDeps
} from './stream-ipc'
import { copyMarks, type MarkPatch } from './marks'
import { LatestFileWatcher } from './latest-watch'
import { SessionTurnSync } from './session-sync'
import { RoleStore } from './roles'
import {
  TeamStore,
  copyTeam,
  forkTeam,
  resolveTargetDir,
  workspaceFromTemplate,
  entryAgentOf,
  orchAgentOf,
  type TeamSnapshot
} from './teams'
import http from 'node:http'
import { MOBILE_HTTPS_PORT, MOBILE_PORT } from './mobile-ports'
import { createRelayServing } from './relay-serving'
import { doorMovedSentence } from '../shared/door-ownership'
import { startRelayProxy, type RelayProxy } from './relay-proxy'
import { importedDoors, rememberDoor, resolveDoor } from './relay-doorbook'
import { SERVED_SESSION_END_PATH } from '../shared/served-transcript'
import { prepareChoresDir } from './claude-trust'
import { DoorTranscript } from './door-transcript'
import { DoorWatch } from './door-watch'
import { doorNameOf, transcriptSourceFor } from './transcript-source'
import { readJson, respondJson } from './mobile-http'
import { deriveSlug, uniqueSlug } from '../shared/workspace-slug'
import { publishedLocalAddresses } from './local-interfaces'
import { wireServing, type Serving } from './session-serving'
import { servedTemplateFile } from './served-persist'
import { bootWorkspaceInPlace } from './session-boot'
import { openWorkspace, workspaceCheck } from './workspace-door'
import { inspectForks, planWorkspaceRemove, removeFork, type ForkScope } from './workspace-fork-check'
import type { WorkspaceRemovePlan } from '../shared/workspace-door'
import { servedConfinement } from './session-spawn'
import { makeEntryTerminalLookup, rmSandbox } from './session-instantiator-mount'
import { ACCOUNT_SUB_PREFIX, ServedCallers } from './served-callers'
import { serviceGrants } from './service-grants-store'
import { requestHarnessCompletion, servedGrantPreflight } from './served-grant-preflight'
import { servedSessionProvisioner } from './served-onboarding'
import {
  doorOwnerOf,
  gateCaller,
  handleServedRoute,
  identifyCaller,
  type ServedEndpointDeps
} from './served-endpoints'
import { handleServedLineRoute, type LinePtyView } from './served-line'
import {
  orchTerminalNode,
  parseAccountAddress,
  parseServeAddress,
  safeFaceName,
  validateFace,
  type ImportFace,
  type ServeTarget
} from './import-session'
import {
  admitWithAccount,
  openAdmission,
  signInToDoor,
  startStripeCheckout,
  stripePaymentHeader
} from './served-admission'
import { doorBearer, type DoorBearerPort } from './door-bearer'
import { expiryWarningDue } from '../shared/session-renew'
import { gateDoorFor } from '../shared/gate-walk'
import { buildX402Payment, deviceWallet } from './x402-caller'
import { servedTurnReply } from './served-turn-reply'
import { handleServedPayRoute } from './served-pay-route'
import { railSettle } from './payment-rails'
import { createServedPaymentConfig } from './served-payment-config'
import {
  createStripeRedemptionStore,
  stripeCreateCheckout,
  stripeGet,
  stripePost,
  stripeSettle
} from './stripe-rail'
import {
  createNonceLedger,
  paymentRequirements,
  postJson,
  x402Settle,
  type PaymentRequirements
} from './x402-rail'
import { ServeRefused, type ServeAccess, type ServedTemplate } from './session-served'
import { servedPaymentRails } from '../shared/served-payment-rails'
import type { ServeTransport } from '../shared/serve-transport'
import { PinStore } from './pin-store'
import { rekeyPinsByUuid } from './pin-rekey'
import { cutVersionPin, type VersionPinRecord } from '../shared/version-pin'
import { TeamClipboard } from './team-clip'
import { TerminalCloser, type CloseOutcome, type Survivor } from './terminal-close'
import { blockStands, cleanTail, commandWord, exitFailure, launchBlock } from './launch-check'
import { takePaneExit } from './pane-exit'
import { PaneFollower } from './pane-follow'
import type { LaunchFailure } from '../shared/launch-failure'
import type { EventActor } from './event-log'
import { provedSessions, strayPanes } from './orphan-reap'
import type { StrayPane } from '../shared/stray-pane'
import { UNCOPYABLE_PHASES, type TurnPhase } from '../shared/turn'
import { GitInfoCache, addWorktree } from './git'
import { buildRoleBootMessage } from '../shared/fork'
import { pageTurns, uiCommandOpen } from '../shared/turn'
import type { TurnPageRequest } from '../shared/turn'
import { defaultAttachmentsDir, saveAttachment } from './attachments'
import { createPromptImageReader, imageRefOf } from './prompt-image'
import { adoptPictures } from './picture-adopt'
import { servedSessionKey } from './storage-gc-served'
import { sweepStorageInWorker } from './storage-gc-worker'

// ── COMPOSITOR BUDGET — the golden-frame flicker ─────────────────────────────
// Chromium sizes its raster-tile budget from a conservative GPU-memory guess.
// A 3.5K retina window full of layers (canvas cards, a zoomed WebGL terminal,
// half a dozen cr-blink animations invalidating every 500ms) exceeds it, the
// log floods with "tile memory limits exceeded, some content may not draw",
// and whole regions of chrome — header, dock, the zoom frame — blink in and
// out in step with the animations. Observed live 2026-08-26. Must be set
// before app ready; a real budget stops the tile drops at the source.
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '2048')

const dirname = path.dirname(fileURLToPath(import.meta.url))

// A Dock launch misses herdr and tmux. process.env.PATH picks the terminal host,
// so this is before PtyManager, and packaged only: a QA instance's narrow PATH is
// what keeps it off the fleet's host.
if (app.isPackaged) {
  process.env.PATH = widenedPath(process.env, homedir())
}

// The durable lineage, installed BEFORE the store can patch a node: every
// session id ever bound to a card gets a copy outside workspace.json, so the
// 2026-09-06 loss shape (the node's capped array was the only record, and the
// cap dropped the oldest id) cannot cost a transcript again. Installed here
// and nowhere else — a unit test that constructs a store gets the no-op sink.
installLineageSpill(new LineageSpill())

// Asked before the store writes its first file: after that, every home looks
// like an upgrade, and `installed` must not fire for everyone already here.
const freshInstall = isFreshInstall()
startTelemetry({ appVersion: app.getVersion(), defaultOn: app.isPackaged && TELEMETRY_DEFAULT_ON })

const store = new WorkspaceStore()
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
const ptys = new PtyManager({ instance: app.getPath('userData') })
// Another live Cookrew owns the herdr session (a QA run with its own userData
// slips past the single-instance lock below). This one has not run a single
// session command and must not: on 2026-09-18 such an instance closed all 56
// panes of the fleet. See host-claim.ts.
if (ptys.hostRefusal) {
  console.error(ptys.hostRefusal)
  // A Dock launch has no console: without the box the app just never appears.
  // showErrorBox is allowed before 'ready' and blocks until dismissed.
  dialog.showErrorBox('Cookrew is already running', ptys.hostRefusal)
  app.exit(1)
}
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
const turns = new TurnTracker(summarizeTurn, turnStore, undefined, sousReadiness)
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
// Bring templates saved before the entry-orchestrator field onto the new logic:
// stamp each with its orch entry point. Non-destructive; logged once at boot.
{
  const migrated = teams.migrateEntryAgents()
  if (migrated > 0) console.log(`teams: migrated ${migrated} template(s) to the entry-orch logic`)
}
const gitCache = new GitInfoCache()
const agents = new AgentRegistry()
/** Dial turns typed into a pane but not yet confirmed by a reply. */
const tuneAsks = new TuneAsks()
/** Size+mtime-gated readout, so dozens of cards cost dozens of stats. */
const tuningCache = new TuningCache()
/** What each card was last TOLD, so an unchanged readout sends nothing. */
const tuningAnnounced = new Map<string, string>()
/** The same change-gated announcement the renderer gets, for phone streams. */
const tuningBus = new EventEmitter()
/**
 * 'changed' when the registry has taken a reach card that differs from the
 * last one it took: this Mac's addresses moved and the zone answers the new
 * names. Phone streams relay it as `reach` (mobile-api) and the renderer gets
 * `reach:changed`; both mean "race the Mac's names now, not in a minute".
 */
const reachBus = new EventEmitter()
/**
 * THE BUILD THIS MAC SERVES (build-id.ts). Read now and every minute; a
 * change goes to every phone stream, whose page reloads itself when the
 * owner next switches away from it or back (renderer/build-watch.ts).
 */
const buildBus = new EventEmitter()
let buildId = readBuildId(app.getAppPath(), app.getVersion())
setInterval(() => {
  const next = readBuildId(app.getAppPath(), app.getVersion())
  if (next === buildId) return
  buildId = next
  buildBus.emit('build', next)
}, BUILD_CHECK_MS).unref()
/**
 * Signals on the cables: "A asked B" and "B answered A", one frame each, to
 * the desktop renderer over IPC and to every phone stream over SSE
 * (mobile-api). Minted by the CLI ask and by the dispatch engine; the owner's
 * own asks mint nothing, there being no cable from the owner.
 */
const cableSignals = new CableSignalBus()
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
 * THE SEALED SLOTS (R4): ~/.cookrew/secrets/, one 0600 file of ciphertext per
 * name, the key in the keychain under this app's ACL (secrets-seal.ts). The
 * value goes in from the note slot (IPC `secret:put`, or the phone's owner-
 * token PUT) and comes out through `cookrew secret read` in an owner pane,
 * and through nothing else — not an event, not workspace state, not a log.
 */
const secrets = createSecretsStore({
  sealer: electronSealer(safeStorage),
  // Elsewhere a machine with no keyring keeps the 0600 file: refusing there
  // would take the slots away. A Mac always has a keychain to refuse from.
  requireSealer: process.platform === 'darwin',
  excludeFromBackup: (dir) => excludeFromBackup(dir, { warn: (message) => console.error(`[cookrew] ${message}`) }),
  warn: (message) => console.error(`[cookrew] ${message}`)
})
/**
 * THE DIRECT LINK BY WEBRTC (rtc-peer.ts): a phone on the relay offers, this
 * Mac answers on exactly the addresses it publishes — the LAN first, then
 * the tailnet — and the link needs no name and no certificate authority.
 */
const rtcHost = createRtcHost({
  hosts: () => {
    const endpoints = mobileEndpointList()
    const v4 = (kind: string): string[] =>
      endpoints.filter((e) => e.kind === kind && /^\d{1,3}(\.\d{1,3}){3}$/.test(e.host)).map((e) => e.host)
    return [...new Set([...v4('lan'), ...v4('tailscale')])]
  },
  deviceId: () => accounts.account()?.deviceId ?? null,
  log: (message) => console.error(`[cookrew] ${message}`)
})
/**
 * THE SCRUB (scrub.ts): every string that leaves main for a pane, a phone,
 * a wall or a ledger. The sealed values are read per call from the store,
 * the tokens from where they live; nothing is cached across calls.
 */
const scrub = createScrubber({
  secrets: () =>
    secrets
      .list()
      .map((row) => secrets.read(row.name)?.value)
      .filter((value): value is string => typeof value === 'string'),
  // The pairing token, the gateway's bearer, and the scoped key Sous will
  // speak with (sous-config.ts) — read when the table is rebuilt.
  tokens: () => [activePairingTokenValue(), routeService.gatewayKey(), sousGatewayKey()],
  env: process.env,
  // A seal or a removal drops the table at once; otherwise it lives 2 s.
  onChange: (listener) => void secrets.onChange(listener)
})
/** The audit line every read and every missing read leaves: name only. */
/** The account for `cookrew login`, once its channels are registered. */
let accountDoor: AccountDoor | null = null

/**
 * A SIGN-IN ATTEMPT FROM A TERMINAL, ON THE RECORD, whichever way it went: a
 * refusal is the line an agent's try leaves. Nothing typed ever reaches this.
 */
const auditLogin = (event: LoginAudit): void => {
  const hit = store.nodeAcrossWorkspaces(event.terminalId)
  const home = store.workspaceOfNode(event.terminalId)
  const workspaceId = hit?.workspaceId ?? home?.id ?? store.focusedId
  events.append({
    type: event.type,
    entityId: event.terminalId,
    entityName: hit?.node.name ?? event.terminalId,
    workspaceId,
    workspaceName: home?.name ?? store.list().workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId,
    // A sign-in that went through got past every check for a person.
    actor: event.type === 'account.login-refused' ? 'agent' : 'user',
    timestamp: Date.now(),
    details: scrub(event.details)
  })
}

/**
 * A secret's activity, said aloud (secret-activity.ts). The toast is for the
 * owner at the window, so this is for the one who is not; it costs the gate's
 * quiet only when it actually speaks.
 */
const secretNoticeGate = noticeGate()
const noticeSecret = (type: SecretActivityType, who: string, name: string): void => {
  if (mainWindow?.isFocused()) return
  if (secretNoticeGate(`${type}|${who}|${name}`)) showNotification(secretNotice(type, who, name))
}

/** A seal or a delete from a door the owner uses. The name stays in `details`, the one field the wall loses. */
const recordSecretChange = (change: SecretChange): void => {
  const workspaceId = store.focusedId
  events.append({
    type: change.type,
    entityId: 'secrets',
    entityName: change.source,
    workspaceId,
    workspaceName: store.list().workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId,
    actor: 'user',
    timestamp: Date.now(),
    details: scrub(change.name)
  })
  noticeSecret(change.type, change.source, change.name)
}

const auditSecret = (event: SecretAudit): void => {
  const hit = store.nodeAcrossWorkspaces(event.terminalId)
  const home = store.workspaceOfNode(event.terminalId)
  const workspaceId = hit?.workspaceId ?? home?.id ?? store.focusedId
  // A name nobody sealed gets a slot to land on (secret-note.ts) BEFORE the
  // row is written, so the row can name the note. Best effort: a canvas that
  // refuses the note still gets its audit line.
  if (event.type === 'secret.requested') {
    try {
      ensureSecretSlotNote(
        {
          nodesOf: (id) => store.workspaceState(id).nodes,
          createNote: (partial, id) => store.createNote(partial, id),
          writeNote: (id, content) => store.writeNote(id, content),
          connect: (from, to) => void store.connectAcross(from, to)
        },
        {
          workspaceId,
          asker: hit?.node.kind === 'terminal' ? (hit.node as TerminalNodeData) : null,
          name: event.name
        }
      )
    } catch (error) {
      console.error(`[secrets] could not make a slot for ${event.name}:`, error)
    }
  }
  events.append({
    type: event.type,
    entityId: event.terminalId,
    entityName: hit?.node.name ?? event.terminalId,
    workspaceId,
    workspaceName: home?.name ?? store.list().workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId,
    actor: 'agent',
    timestamp: Date.now(),
    // `<name>` or `<name> note:<id>` when a note on that canvas has the slot —
    // scrubbed like every string that leaves main, for everyone, not only
    // the wall (which still gets no details at all).
    details: scrub(
      secretAuditDetails(
        event.name,
        store.workspaceState(workspaceId).nodes.flatMap((node) => (node.kind === 'note' ? [node] : []))
      )
    )
  })
  noticeSecret(event.type, hit?.node.name ?? event.terminalId, event.name)
}
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

// ── R30 SERVING — the instantiator subsystem, assembled once ─────────────────
//
// This constructs the machinery; the call path consults it (mobile-server) and
// the spawn path reads `servedSpawnContexts` to confine a served terminal. All
// side effects stay behind seams the composition root wires — see
// session-serving.ts. NOTE (app-verified): the mint→serve call at the listener
// and the per-backend Seatbelt wrap for herdr are the remaining live-tested
// steps; everything here compiles and is unit-tested.
const sessionsBase = path.join(homedir(), '.cookrew')
const servedPayments = createServedPaymentConfig({ base: sessionsBase })
const servedStripeRedemptions = createStripeRedemptionStore(
  path.join(sessionsBase, 'stripe-redemptions.json')
)
/** workspaceId → the served context its terminals spawn under. Set at boot. */
const servedSpawnContexts = new Map<
  string,
  { serviceId: string; sessionId: string; sandbox: string }
>()
/**
 * THE LEND (R30 G2). The owner's per-service grant file, read per call.
 *
 * Still nothing by default — an unlisted service is lent no key, no file and no
 * budget, exactly as before. What changed is that there is now a way to lend on
 * purpose: `~/.cookrew/service-grants.json`, one entry per service, each with a
 * session budget it cannot exceed. See service-grants.ts for why the budget
 * counts sessions rather than dollars.
 */
const grants = serviceGrants(sessionsBase)
// THE ROUTE (route program, 2026-10-11): is the Magpie gateway here, what it
// serves, where each card's turns go. One service; the panel, the rail, the
// phone and every spawn read it. Its emitter fans out to the renderer and
// the phone stream (routeBus) exactly like the dials' tuningBus.
const routeBus = new EventEmitter()
const routeService = new RouteService({
  // PATH, ~/.local/bin (the installer's symlink, off a GUI app's PATH) and the app bundle.
  monitor: new GatewayMonitor({ hasBinary: () => magpieInstalled({ home: homedir(), env: process.env }, existsSync) }),
  fetch: (input, init) => fetch(input, init),
  home: homedir(),
  pathEnv: process.env.PATH,
  pluginDir: app.isPackaged ? path.join(process.resourcesPath, 'magpie') : path.join(app.getAppPath(), 'resources', 'magpie'),
  node: (id) => {
    const node = store.nodeAcrossWorkspaces(id)?.node
    return node?.kind === 'terminal' ? node : null
  },
  updateNode: (id, patch) => void store.updateNodeUnsafe(id, patch),
  isServed: (id) => {
    const owner = store.ownerOf(id)
    return owner !== undefined && servedSpawnContexts.has(owner)
  },
  harnessOf: (command) => harnessFor(command)?.id ?? null,
  phaseOf: (id) => turns.phaseOf(id),
  delivering: (id) => turnUnseen(id),
  onRouteSet: (id) => tuneAsks.forgetKnob(id, 'model'),
  canRestoreExact: (node) => canRestoreExact(node),
  respawn: async (id) => respawnInPlace(id),
  dockCommands: () => PRESETS.map((p) => p.command),
  hasTurns: (id) => turns.history(id).length > 0,
  // The session file the node names, on disk: the harness resumes it itself,
  // whatever the lazy tracker has verified so far (claude and codex; the
  // other two keep the gate's answer).
  sessionOnDisk: (node) => {
    const harness = harnessFor(node.command)?.id
    if (harness === 'claude') return Boolean(node.claudeSessionId) && existsSync(claudeSessionFile(node.cwd, node.claudeSessionId as string))
    if (harness === 'codex') return typeof node.codexSessionRef === 'string' && existsSync(node.codexSessionRef)
    return false
  },
  terminalsAcross: () => store.terminalsAcross()
})
// The roster a page holds learns each change as it happens (agent-registry onChange).
agents.onChange((entry) => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('agents:changed', entry)
})
routeService.on('route', (state) => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('route', state)
  routeBus.emit('route', state)
})
routeService.on('card-route', (row) => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('card-route', row)
  routeBus.emit('card-route', row)
})
const grantPreflight = servedGrantPreflight({
  grants,
  orch: {
    commandOf(templateId) {
      const snapshot = teams.load(templateId)
      if (!snapshot) return null
      const orch = orchAgentOf(snapshot)
      if (orch === null) return null
      const node = snapshot.nodes.find(
        (candidate) =>
          candidate.kind === 'terminal' && candidate.orch === true && candidate.name === orch
      )
      return node?.kind === 'terminal' ? node.command : null
    }
  },
  request: requestHarnessCompletion
})

const serving: Serving = wireServing({
  base: sessionsBase,
  teams,
  // M1 PLACEHOLDER: a template's pin resolves to v1 addressed by its id. Real
  // S1c resolution reads the template's rail pins (the pinId content hash); this
  // stub lets serving compile ahead of that lookup and is flagged for the wire.
  pins: { resolve: (templateId) => ({ version: 1, pinAddress: templateId }) },
  forkEngine: {
    fork: async ({ name, templateId, dir, serviceId, sessionId }) => {
      const meta = await forkTeam(
        {
          ...teamForkDeps(),
          // Boot in place (no focus switch), and register the served context
          // FIRST so each terminal's spawn (spawnTracked) confines and scrubs.
          bootTerminals: (id) => {
            servedSpawnContexts.set(id, { serviceId, sessionId, sandbox: dir })
            remoteDesk.workspaceServed(id)
            const booted = bootWorkspaceInPlace(
              {
                nodesOf: (wid) => callNodesOf(wid),
                boot: (node) => bootTerminal(node as TerminalNodeData),
                // A partial boot must be LOUD: a served crew whose door never
                // spawned answers every ask with "no live door" and nothing
                // else says why.
                onError: (node, error) =>
                  console.error(`served boot failed for ${node.id}:`, error)
              },
              id
            )
            console.error(`served session ${sessionId}: booted ${booted} terminal(s) in ${id}`)
          }
        },
        { name, nodeIds: [], choices: [], fromSavedTeam: templateId, dirs: [dir], worktree: true }
      )
      return meta.id
    }
  },
  // The one fact that decides whether a crew may be served at all: does its
  // saved snapshot flag an orch? Never the first terminal — see orchAgentOf.
  door: { orchOf: (templateId) => {
    const snapshot = teams.load(templateId)
    return snapshot ? orchAgentOf(snapshot) : null
  } },
  entry: makeEntryTerminalLookup({
    nodesOf: (wid) =>
      callNodesOf(wid).map((n) => ({
        id: n.id,
        kind: n.kind,
        orch: (n as { orch?: boolean }).orch
      }))
  }),
  callsInFlight: { cancelWhere: (match) => callsInFlight.cancelWhere(match) },
  remover: rmSandbox,
  // First-run choices and the owner's grant land before the fork boots the
  // harness. The provisioner seeds only non-secret Claude state; credentials
  // still arrive exclusively through the grant.
  provision: servedSessionProvisioner(grants),
  grantPreflight,
  liveWorkspaceId: (slug) => store.bySlug(slug)?.id ?? null,
  // Serving survives a restart — an owner stops serving by saying stop.
  persist: servedTemplateFile(sessionsBase)
})
/** Who has signed in to each served crew (TOFU accounts, M1). */
const servedCallers = new ServedCallers()

/**
 * The address an owner hands out for a served team, AND how far it carries.
 *
 * The two are one answer, which is why they are returned together. The card
 * hands this string to a person who will send it to someone else, so the card
 * has to be able to say who that someone can be — a LAN address shared with a
 * colleague in another city is a link that cannot work, and the product used
 * to give it out with no indication of that.
 *
 * The tailnet wins when it is up, for the same reason the phone's endpoint
 * list puts it first: the owner already has the wider of two links, and
 * advertising the narrower one would be choosing worse on their behalf. The
 * relay (cookrew.dev) joins this function when it exists; nothing else has to
 * change, because everything downstream reads the transport rather than
 * guessing from the shape of the URL.
 */
/**
 * THE RELAY. Opt-in until cookrew.dev was standing there to keep the promise;
 * the default since 0.4.0 (launch-defaults.ts). `COOKREW_REGISTRY=` (empty)
 * still turns it off, and then everything below behaves as it did before —
 * which is what keeps every existing test about reach meaningful.
 */
const RELAY_ORIGIN = relayOrigin()
/** COOKREW_HANDLE as the environment set it — a development override now. */
const ENV_HANDLE = process.env.COOKREW_HANDLE ?? ''

/**
 * THE OWNER'S ACCOUNT (identity v2, phase 1) — one file, one lock.
 *
 * Local-only is a complete state (architecture P4): no account.json means the
 * app boots, works and serves nothing, and every call below answers rather
 * than throws. Nothing here is on the serving path.
 */
const accounts = new Accounts({
  // "<model> · <host>" (v3, D12): two Macs of one model are told apart by
  // host, and a name already on the account gets a counter — decided here,
  // never at the registry, which files what it is sent.
  deviceName: localDeviceName(),
  // The record also says what kind of machine this is (machine-profile.ts).
  machine: async () => ({ profile: await machineProfile(), appVersion: app.getVersion() }),
  // A provider's login page opens in the system browser and never in a window
  // of ours: a person must not type a GitHub password into a page this app
  // controls. The scheme is asked rather than assumed, because a development
  // copy shares its bundle id with every other Electron on the machine.
  openBrowser: (url) => shell.openExternal(url),
  schemeHandled: () => app.isPackaged || app.isDefaultProtocolClient(DEEP_LINK_SCHEME),
  // THE ACCOUNT CHANGED WITHOUT A CLICK ON THIS MAC. A password changed on the
  // web ends this session; nothing local would ever notice. Pushing the status
  // is what turns that into a password prompt the owner can actually answer.
  onChange: () => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('account:changed')
    }
    // A REVOKE IS AN ACCOUNT CHANGE, and the phone it cut off may be sitting on
    // this Wi-Fi right now. Cut 1's event carries no payload, so this cannot
    // know WHICH device changed; it asks the registry who is revoked and lets
    // the answer decide. That is what makes the withdrawal prompt instead of
    // waiting out the sweep below.
    sweepRevocations()
    // REACH v2.1 — A CLAIM IS THE MOMENT A CERTIFICATE BECOMES POSSIBLE.
    // `ensure` was only ever called at boot and hourly, so a Mac that claimed
    // its account after starting served self-signed for up to an hour and
    // published `trusted: []` the whole time — the first run of the product,
    // every time. The pass is idempotent (it holds a lock, a quiet window and
    // the chain it already has), so saying it on every account write costs a
    // function call and closes the gap.
    void nameCertificate.ensure('the account changed').catch(() => undefined)
    // AND THE SAME GAP, FOR THE APPROVAL QUEUE (V3-UI1 · F1). The comment
    // above is about a certificate that only ever ran at boot; the queue had
    // the identical shape, and on the first run of the product it meant the
    // only rung a factorless account has was never announced at all.
    followAccount()
    // AND THE DOORS (V3-FIX-SERVING-ID). Same trigger, same reason: the name
    // this Mac serves under is decided by the account, so it moves when the
    // account does — not when the process happened to start.
    followServingIdentity()
  }
})

/** The handle the key in ~/.cookrew/registry holds, if this Mac ever served. */
const legacyHandleNow = (): string | null => accounts.legacyHandle()

/**
 * WHICH NAME THIS MAC SERVES UNDER (identity v2, phase 6) — ASKED EACH TIME.
 *
 * THE ENVIRONMENT IS RETIRED AS IDENTITY. The account decides, then the key
 * this Mac already holds — which wins over a disagreeing account because a v1
 * door registration is signed with that key and the registry takes the handle
 * from the signature, so serving under a name we cannot sign for would refuse
 * the dial rather than rename the door. COOKREW_HANDLE decides only on a
 * machine that has neither, and is told what it is. The whole table is a pure
 * function (legacy-identity.ts) with a test per row.
 *
 * IT USED TO BE A `const`, AND THAT WAS THE BUG. Resolved once at module load,
 * a Mac that booted local-only and then claimed an account kept publishing its
 * doors under the environment's name or its old key's: the screen said
 * @magpie, cookrew.dev listed @drej/team, and a seat bought against
 * @magpie/team could not admit anyone there. Same shape as the certificate
 * `ensure` pass and the approval queue below — a fact that changes after boot,
 * read from the order the module happened to run in.
 */
const servingHandleNow = (): string =>
  relayHandle({
    account: accounts.account()?.username ?? null,
    legacy: legacyHandleNow(),
    env: ENV_HANDLE
  }).handle

// ONCE, at boot: a fact about how this process resolved its own name.
{
  const atBoot = relayHandle({
    account: accounts.account()?.username ?? null,
    legacy: legacyHandleNow(),
    env: ENV_HANDLE
  })
  if (atBoot.note !== null) console.error(atBoot.note)
}

/**
 * CREATED WHENEVER THERE IS A RELAY, not only when this Mac already had a name
 * for it (V3-SERVING-ID).
 *
 * The condition was `RELAY_ORIGIN && RELAY_HANDLE`, which on a first run — no
 * account, no key, no COOKREW_HANDLE — left this null for the life of the
 * process. The person then claimed an account and could not serve anything at
 * all until they restarted, with nothing on screen saying why. Serving needs a
 * handle at the moment a door goes up, which is where it is checked; `who`
 * below is read per dial for the same reason.
 */
const relayServing = RELAY_ORIGIN
  ? createRelayServing({
        origin: RELAY_ORIGIN,
        loopbackPort: () => MOBILE_PORT,
        /**
         * WHICH MAC IS DIALLING (V3-18). Read per dial rather than captured,
         * because signing in or out changes the answer and a door dialled
         * before the account existed must name this Mac on its next redial.
         * Null on a Mac with no account, and then the relay keeps refusing a
         * name already held — there is no other Mac to have taken it from.
         */
        who: () => {
          const account = accounts.account()
          if (account === null) return null
          return {
            deviceId: account.deviceId,
            name: account.name,
            // The session, when this Mac holds a live one. It is what lets the
            // SECOND Mac of an account serve at all — the v1 registry key it
            // would otherwise prove the handle with cannot be enrolled twice.
            ...(account.session === null ? {} : { session: account.session.token })
          }
        },
        /**
         * ANOTHER MAC OF THIS ACCOUNT TOOK ONE OF OUR DOORS (D14 · moved).
         *
         * By the time this runs, serving here has already stopped — that
         * decision is made in relay-serving, where the alternative was two
         * Macs taking the name from each other for ever. All that is left is
         * to say so, in the same breath on the canvas and in the system tray,
         * and to leave TAKE IT BACK where the person is looking.
         */
        onMoved: (door) => {
          doorsMovedHere = [
            ...doorsMovedHere.filter((held) => held.slug !== door.slug),
            { slug: door.slug, team: door.team, by: door.by, at: Date.now() }
          ]
          // The registry's own record of who holds what, brought into line the
          // moment this Mac knows — it no longer serves this name.
          publishDoorClaims()
          const sentence = doorMovedSentence(door.team, door.by)
          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('serving:moved', { slug: door.slug, team: door.team, by: door.by })
          }
          showNotification(sentence)
          console.error(`[cookrew] ${sentence}`)
        },
        log: (message) => console.error(message)
      })
    : null

/**
 * THE DOORS THIS MAC LOST WHILE IT WAS RUNNING (V3-18).
 *
 * Held here rather than only pushed at the renderer because the window may be
 * closed, minimised or reloading when a door moves, and a notice that existed
 * only as an event would be one the owner never sees. Cleared by taking the
 * door back or by serving it again.
 */
let doorsMovedHere: readonly { slug: string; team: string; by: string; at: number }[] = []

/**
 * THE SLUGS THIS MAC IS HOLDING AT THE RELAY — its claims, not its listings.
 *
 * Only a door actually on the relay holds a `@handle/team` name, so a team
 * served on the LAN alone claims nothing: there is no name for a second Mac
 * to collide with, and filing one would make a save sheet warn about a
 * conflict that cannot happen.
 */
function relayedSlugs(): readonly string[] {
  if (!relayServing) return []
  return serving.served
    .list()
    .map((template) => template.slug)
    .filter((slug) => relayServing.addressFor(slug) !== null)
}

/**
 * FILE THIS MAC'S DOOR CLAIMS — one name, one holder (V3-18 · A3).
 *
 * The registry keeps the claims on the desktop record, so the NEXT Mac to save
 * the same slug is told who holds it before the relay ever refuses the dial.
 * Best effort and silent: a claim that did not file costs a save sheet its
 * warning, and a door that works is worth more than a warning that does not.
 */
function publishDoorClaims(): void {
  if (accounts.account() === null) return
  void accounts
    .registerDesktop(
      store.list().workspaces.map((w) => ({ id: w.id, name: w.name })),
      undefined,
      undefined,
      relayedSlugs()
    )
    .catch(() => undefined)
}

/**
 * IDENTITY V2.1 — one credential, and the reach card.
 *
 * The admitted-phone list is created here, before the mobile server starts,
 * because the server records into it and the reach publisher needs the account
 * to sign. Both are inert without an account: no username, no hello, nothing
 * published.
 *
 * WHAT USED TO BE HERE: a six-character key ring, a cache of the registry's
 * signing key and a store of spent canvas tokens — the three moving parts of
 * the `?open=&key=&device=` ceremony. There is one credential now (the pairing
 * token this Mac mints), so a phone is authorised by holding it, on the relay
 * exactly as on the LAN, and none of the three has anything left to decide.
 */
const admittedDevices = createAdmittedDeviceStore()

/**
 * REACH v2.1 — THIS MAC'S OWN TRUSTED CERTIFICATE.
 *
 * The key is minted here and never leaves; cookrew.dev runs the ACME order and
 * answers a chain for `*.<deviceId>.d.cookrew.dev`. Held at module scope
 * because four surfaces read it and none of them hold the others' state: the
 * HTTPS listener (by SNI), the endpoint list `cookrew mobile` prints, the
 * origins the CORS gate allows, and the reach card's `trusted` list.
 *
 * `ensure` is only ever called on a timer and at boot, and it answers rather
 * than throws — a Mac with no account, no internet or a registry that certifies
 * no names keeps its self-signed certificate and everything it always did.
 */
const nameCertificate: DesktopCert = createDesktopCert({
  store: new NameCertStore(),
  // The one authenticated call, with the session checked before the socket.
  // The token stays inside Accounts; what comes back is a Response.
  fetch: (pathname, init) => accounts.authedResponse(pathname, init),
  deviceId: () => accounts.account()?.deviceId ?? null,
  // The registry is configurable (COOKREW_REGISTRY), so the zone it is
  // authoritative for has to be too — a self-hosted one certifies its own.
  zone: process.env.COOKREW_NAME_ZONE || DEFAULT_NAME_ZONE,
  // A new chain means new trusted origins, and those are NOT in the signed
  // card — nothing else would notice that a Mac which published "no names"
  // now has some.
  onIssued: () => void reachPublisher?.republish('certificate issued').catch(() => undefined),
  log: (message: string) => console.error(`[cookrew] ${message}`)
})

/**
 * THE ONE URL, for both surfaces that show it.
 *
 * `cookrew mobile` prints it and the avatar popout draws it as a QR; they call
 * the same function so the terminal and the window can never disagree about
 * which credential is current.
 *
 * The token is read LIVE rather than captured: `cookrew mobile --rotate`
 * replaces it inside the running server, and a handout holding the boot value
 * would keep printing a credential that no longer opens anything.
 */
const currentPairingHandout = (): PairingHandout | null =>
  pairingHandout({
    account: () => {
      const account = accounts.account()
      return account
        ? { username: account.username, deviceId: account.deviceId, name: account.name }
        : null
    },
    registryOrigin: () => registryOrigin(),
    endpoints: () => mobileEndpointList(),
    pairingToken: () => activePairingTokenValue() ?? pairingToken
  })
let reachPublisher: ReachPublisher | null = null

/**
 * The owner's display name and avatar, as of the last time anything read the
 * profile. A snapshot rather than a cache with a policy: nothing here expires
 * it, because a stale display name on a phone is not a fault worth a refresh
 * loop, and the username underneath it is always current.
 */
let profileFace: { displayName?: string; avatar?: string | null } | null = null
export const rememberProfileFace = (face: {
  displayName?: string
  avatar?: string | null
}): void => {
  profileFace = face
}

/**
 * THE DESKTOP'S OWN LINE AT cookrew.dev — the picker's third path.
 *
 * A phone on LTE cannot dial this Mac, so this Mac dials out and holds a line
 * for its OWN CANVAS; the phone's request travels down it backwards and lands
 * on the companion's own loopback listener, where the admission ceremony and
 * the pairing gate answer exactly as they do on the LAN. The relay adds no
 * authority — see canvas-bridge.ts.
 *
 * The credential is re-asked on every dial and every redial, so no account, an
 * expired session, or reachability switched off all mean the same thing: no
 * line. Both of the last two are the owner saying no, and neither is an error.
 */
const canvasLink = createCanvasLink({
  origin: () => registryOrigin(),
  credential: () => {
    const account = accounts.account()
    if (!account || !account.workspacesReachable) return null
    const session = account.session
    if (!session || session.exp <= Date.now()) return null
    return { token: session.token, deviceId: account.deviceId }
  },
  log: (message) => console.error(`[cookrew] ${message}`)
})
const canvasBridge = createCanvasBridge({
  send: (line) => canvasLink.send(line),
  dial: loopbackDialer(MOBILE_PORT),
  log: (message) => console.error(`[cookrew] ${message}`)
})
canvasLink.onFrame(canvasBridge.frame)
// A line that ended takes every exchange riding it with it; a local request
// left running would be an event stream nobody will ever read again.
canvasLink.onDrop(canvasBridge.reset)

/**
 * The idle lock covers the OWNER'S RENDERER and nothing else: agents keep
 * running, doors keep answering, the phone keeps its session.
 */
const ownerLock = new IdleLock({
  lockAfterMs: accounts.account()?.lockAfterMs ?? DEFAULT_LOCK_AFTER_MS,
  verify: (password) => accounts.verifyUnlock(password),
  // No account, or no passcode chosen yet: nothing could open this lock, so it
  // does not close.
  armed: () => accounts.lockable(),
  waiting: () => accounts.providerTripping(),
  onChange: (locked) => {
    // A provider trip in flight belongs to whoever just walked away.
    if (locked) accounts.providerCancel()
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('account:locked', locked)
    }
  }
})
/** Idleness is a question about a clock, so something has to ask it. */
setInterval(() => ownerLock.tick(), 15_000).unref()

/**
 * D7's row, kept honest by a slow poll.
 *
 * It is PUSHED at the two moments that matter (a session minted, a session
 * ended), and this is the backstop for every other way a session can start or
 * stop — the caller's own PTY line admits without passing through the /ask
 * seam, and a workspace the owner deletes ends a session from the far side.
 * The publish diffs before it sends, so an idle desktop sends nothing.
 */
setInterval(() => {
  if (serving.served.list().length > 0) publishServedCallers()
}, 15_000).unref()

/**
 * THE APPROVAL QUEUE (D6) AND THE FACTOR LADDER (D3).
 *
 * A waiting device is announced as a SYSTEM NOTIFICATION and as the avatar's
 * rose badge — never as a modal over the canvas. Clicking the notification
 * brings the window forward and opens the profile sheet on the request, which
 * is the same place the badge leads: one destination, so a person who saw the
 * toast and a person who saw the badge end up looking at the same card.
 */
const requests = new Requests({
  accounts,
  notify: ({ title, body, requestId }) => {
    const note = new Notification({ title, body })
    note.on('click', () => {
      if (!mainWindow || mainWindow.webContents.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      mainWindow.webContents.send('account:requests', requestId)
    })
    note.show()
  },
  onChange: () => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('account:requests', null)
    }
  },
  // THE TOAST'S HALF. A system notification is for the person who is not
  // looking at Cookrew; a toast is for the one who is, and an account that
  // changed under them deserves to be said in the window they are in rather
  // than only in a corner of the screen they may have permissions turned off
  // for.
  onEvent: (event, sentence) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('account:event', { ...event, sentence })
    }
  },
  answered: answeredStoreIn(),
  // ALLOW's own half (R2): this phone gets a token of its own, and the URL
  // that carries it is sealed to the key the request arrived with. The root
  // pairing credential never leaves this process for a device that asked
  // through the queue.
  reach: {
    admit: (device) => admittedDevices.admit(device),
    pairingUrlFor: (token) => {
      const account = accounts.account()
      if (!account) return null
      return pairingUrl({
        registryOrigin: registryOrigin(),
        username: account.username,
        deviceId: account.deviceId,
        pairingToken: token
      })
    }
  }
})
const factors = new Factors({ accounts, registry: registryOrigin() })

/**
 * Only the SENTENCE depends on this, so it is cached rather than fetched.
 *
 * The D6 line ends "no second factor on the account yet" when there is none.
 * Asking the registry for the factor list inside the poll would double every
 * request for one clause, so it is read at boot and every five minutes after
 * — a factor is added once in the life of an account, and the clause it
 * changes is the third one in a sentence about a device that is still waiting.
 */
const FACTOR_CACHE_MS = 300_000
let accountHasFactor = false
const readFactors = (): void => {
  void factors
    .view()
    .then((result) => {
      if (result.ok) accountHasFactor = result.value.totp || result.value.passkeys.length > 0
    })
    .catch(() => undefined)
}
/**
 * THE QUEUE AND THE FACTOR CACHE FOLLOW THE ACCOUNT (V3-UI1 · F1).
 *
 * Both of these used to be set up once, here, under `if (accounts.account())`
 * — and on the FIRST RUN of the product there is no account at that moment.
 * The person creates one a minute later and neither ever starts: no approval
 * poll, so no toast and no rose badge when their second Mac asks to join, and
 * a factor cache stuck at its boot-time default. Window focus was the only
 * other thing calling refresh, which is exactly the event a person already
 * looking at their canvas does not generate.
 *
 * Called at boot AND from `accounts.onChange`, so signing in, joining and
 * signing out all land in the right state. `follow` is idempotent and the
 * interval is guarded, so neither caller has to know which way it moved.
 */
let factorPoll: ReturnType<typeof setInterval> | null = null
const followAccount = (): void => {
  requests.follow()
  if (accounts.account()) {
    if (factorPoll === null) {
      readFactors()
      factorPoll = setInterval(readFactors, FACTOR_CACHE_MS)
      factorPoll.unref()
    }
    return
  }
  if (factorPoll !== null) {
    clearInterval(factorPoll)
    factorPoll = null
  }
  // A Mac with no account has no factors; leaving the last answer behind would
  // have D6's sentence describe an account that is not signed in here.
  accountHasFactor = false
}

/**
 * THE DOORS FOLLOW THE ACCOUNT TOO.
 *
 * Re-resolve the serving name and, if the doors on the relay are listed under
 * one that is no longer this Mac's, take them down and put them back under the
 * new one.
 *
 * IMMEDIATELY, AND ONLY WHEN THE NAME ACTUALLY MOVED. `accounts.onChange`
 * fires on every account write — a display name, a renewed session, a revoked
 * device — so the guard is not the event, it is `servingChange.republish`,
 * which compares what cookrew.dev is holding against what this Mac can now
 * prove. In the ordinary case that is a string compare and nothing happens.
 *
 * Immediately, because the window in between is the defect: a door listed
 * under a name the account cannot prove cannot honour a seat bought against
 * the account, and every minute of it is a person paying for a seat that does
 * not admit them. A debounce would buy nothing — the move happens once, when a
 * Mac gets an account — and "on the next serve" could be never, since serving
 * survives restarts and nobody re-serves a door that is already up.
 *
 * IT DOES COST SOMETHING and the cost is stated: republishing re-dials the
 * relay and MOVES THE ADDRESS, because the address is built from the handle.
 * Links to the old address stop resolving. That is the right trade exactly
 * once, because the link that still worked was a link to a door that refuses
 * the person the seat was bought for.
 *
 * One at a time, and failures are logged rather than thrown: this runs beside
 * the canvas, and a registry that is down must leave the Mac as it was.
 */
let republishing = false
const followServingIdentity = (): void => {
  if (!relayServing || republishing) return
  const change = servingChange({
    serving: relayServing.servingHandle(),
    account: accounts.account()?.username ?? null,
    legacy: legacyHandleNow(),
    env: ENV_HANDLE
  })
  if (!change.changed) return
  if (change.note !== null) console.error(change.note)
  if (!change.republish) {
    if (change.handle === '' && relayServing.servingHandle() !== '') {
      // Said, never done: withdrawing somebody's doors because they signed out
      // of a sheet would disconnect the callers those doors are carrying.
      console.error(
        `[cookrew] nothing names this Mac now, so its doors stay listed as @${relayServing.servingHandle()} — stop serving them to take them down.`
      )
    }
    return
  }
  const was = relayServing.servingHandle()
  console.error(`[cookrew] doors move from @${was} to @${change.handle}: re-listing them now.`)
  republishing = true
  void republishDoors({
    slugs: () => serving.served.list().map((template) => template.slug),
    withdraw: (slug) => relayServing.withdraw(slug),
    serve: async (slug) => {
      const template = serving.served.bySlug(slug)
      // A door withdrawn and then not served again is a door LOST, so neither
      // of these is allowed to pass quietly. `joinRelayFor` reports its own
      // refusals and returns either way, so the door's presence on the relay
      // is what is checked — the summary below has to be able to count.
      if (!template) throw new Error('it is no longer served here')
      await joinRelayFor(template)
      if (relayServing.addressFor(slug) === null) throw new Error('it did not go back up')
    },
    log: (message) => console.error(message)
  })
    .then(({ moved, failed }) => {
      console.error(
        `[cookrew] ${moved} door(s) now listed as @${change.handle}` +
          (failed.length === 0 ? '' : `; ${failed.join(', ')} could not be moved and stay as they were`)
      )
    })
    .finally(() => {
      republishing = false
      // ASK ONCE MORE. A move that arrived while this one was running was
      // dropped by the guard above; re-reading is a string compare that ends
      // immediately in every case but the one where it was needed.
      followServingIdentity()
    })
}

followAccount()
// NOT CALLED AT BOOT. Nothing is on the relay yet, so there is nothing to move
// — and the name this process resolved has already been said once, above.
// Every door that goes up from here reads the handle at the moment it goes up.

/**
 * Sign-in with a cookrew.dev token needs the registry's public key, and only
 * a door on the relay has a name a token could be minted for — so the verifier
 * exists exactly when the relay does. See registry-token.ts.
 */
const registryTokens = RELAY_ORIGIN
  ? createRegistryTokenVerifier({ keys: registryKeyOverHttp(RELAY_ORIGIN) })
  : null

/**
 * IDENTITY v2 AT THE DOOR (phase 5). Beside the v1 verifier, never replacing
 * it: both wire contracts are live until phase 6 retires the older one, and
 * which body arrives decides which is asked (served-endpoints.handleServedRoute).
 */
const v2CallTokens = RELAY_ORIGIN
  ? createV2CallTokenVerifier({
      keys: v2KeysOverHttp(RELAY_ORIGIN),
      // ONE FETCH, TWO READERS. The list is fetched for the doors; it is also
      // the only thing that can tell this Mac that a phone it opens for on the
      // LAN was cut off at the registry. A second poll of the same route would
      // be a second answer, and the two would drift.
      onRevoked: (revoked) => {
        for (const device of admittedDevices.prune(revoked)) {
          remoteDesk.forgetDevice(`device:${device.deviceId}`)
          // One line per phone, named. "Withdrew 1 admission" would leave the
          // owner with no idea which phone in their hand just stopped working.
          console.error(
            `Admission withdrawn: ${device.name ?? device.deviceId} was revoked at the registry`
          )
        }
      }
    })
  : null

/**
 * REVOCATION REACHES THIS MAC'S LAN ADMISSION.
 *
 * "Revoking a device kills its session now, its door tokens within the token
 * TTL, and its LAN admission on every Mac within a minute" — the security
 * model's fifth line. The first two were already true and the third was not: a
 * revoked phone went on opening this Mac over Wi-Fi until somebody pressed
 * FORGET here, which is why the copy had to admit as much.
 *
 * It hangs on a clock because there is nothing else to hang it on. A phone
 * that was cut off does not announce itself, and the door verifier asks the
 * registry anything only when a stranger calls a served crew — a Mac serving
 * nobody would never have asked at all. A minute is the number the security
 * model promises, so it is the number here.
 *
 * A function declaration rather than a const because `accounts`' onChange is
 * written above the verifier and calls it; it runs only after a write to the
 * account file, long after module scope has finished.
 */
const REVOCATION_SWEEP_MS = 60_000
function sweepRevocations(): void {
  if (!v2CallTokens) return
  // Nothing admitted is nothing to withdraw, and a Mac with no phone paired to
  // it should not be asking the registry a question it has no use for.
  if (admittedDevices.list().length === 0) return
  void v2CallTokens.refresh()
}
setInterval(sweepRevocations, REVOCATION_SWEEP_MS).unref()

/**
 * THE SESSION RENEWS ITSELF, AND SAYS SO WHEN IT CANNOT (v3, V3-17).
 *
 * A session lives thirty days, and until V3-16 the thirtieth day took every
 * door this Mac publishes offline — "no-relay" until a person happened to be
 * at the keyboard to retype a password. The marketplace's availability should
 * not be bounded by somebody's memory, so the Mac signs a registry nonce with
 * the device key that attached it in the first place.
 *
 * DAILY, NOT HOURLY. `renewDue` opens a whole week, so a day is six retries of
 * slack before anyone needs to be told; asking more often would only mean more
 * ways to be rate-limited on the day it matters.
 *
 * AND THE WARNING IS THE OTHER HALF. Renewal that keeps failing is the one
 * case a person must hear about BEFORE the doors go down, on every device they
 * have, naming the Mac that has to be opened. Twice a day is enough for a
 * two-day window and few enough that it is not noise.
 */
const RENEW_CHECK_MS = 24 * 60 * 60 * 1000
/** Boot is the likeliest moment for a Mac that was asleep through its week. */
const RENEW_AT_BOOT_MS = 30_000
let saidExpiring = 0

async function renewSessionIfDue(): Promise<void> {
  try {
    // A local "ended" mark is checked against the registry first: it has been
    // wrong (account-v2.ts · endSession), and while it is wrong the reach
    // card is never published and this Mac's names fall out of DNS. A mark
    // the registry does not confirm is lifted, and the card goes out at once.
    if (await accounts.reconcileEndedSession()) {
      void reachPublisher?.republish('session reconciled').catch(() => undefined)
    }
    await accounts.renew()
  } catch (error) {
    console.error('Could not renew this Mac\'s session:', error)
  }
  const account = accounts.account()
  if (!account || !expiryWarningDue(account.session, Date.now(), accounts.renewFailing())) return
  // Said at most twice a day. A warning repeated on every tick is a warning
  // the owner learns to dismiss, which is the one thing this must not become.
  if (Date.now() - saidExpiring < RENEW_CHECK_MS / 2) return
  saidExpiring = Date.now()
  const day = new Date(account.session?.exp ?? Date.now()).toLocaleDateString(undefined, { weekday: 'long' })
  const sentence = `@${account.username}'s doors go offline on ${day} unless ${account.name} renews — open Cookrew there once.`
  console.error(`[cookrew] ${sentence}`)
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('account:expiring', sentence)
  }
}

setTimeout(() => void renewSessionIfDue(), RENEW_AT_BOOT_MS).unref()
setInterval(() => void renewSessionIfDue(), RENEW_CHECK_MS).unref()
/** Who has signed in at each served door — the memory behind D7's avatars. */
const doorCallers = new DoorCallers()
/** The owner's seat routes at cookrew.dev, spoken with the owner's session. */
const doorSeats = new DoorSeats(seatsApiOverAccounts(accounts))

function servedReach(slug: string): { address: string; transport: ServeTransport } {
  // THE RELAY WINS when it is carrying this door, because it is the only
  // address that works for the person an owner is most likely to send it to.
  const relayed = relayServing?.addressFor(slug)
  if (relayed) return { address: relayed.address, transport: 'relay' }
  // MagicDNS name, never a raw tailnet IP: it survives re-auth, and it is the
  // one a caller can actually type back to us.
  const magic = cachedTailnet()?.magicDnsName
  if (magic) {
    return { address: `https://${magic}:${MOBILE_HTTPS_PORT}/${slug}`, transport: 'tailnet' }
  }
  // The first PUBLISHED address, not the first the OS listed: on a Mac with a
  // container runtime the OS's first answer can be a host-only bridge, and a
  // served door's address is a URL an owner sends to someone else.
  const [lan] = publishedLocalAddresses()
  return { address: `http://${lan ?? '127.0.0.1'}:${MOBILE_PORT}/${slug}`, transport: 'lan' }
}

function servedAddress(slug: string): string {
  return servedReach(slug).address
}

/**
 * Put a served team on the relay — the same door, whether it was just served
 * or is being served again after a restart. Serving is an INTENT that
 * survives the app dying (served-persist); the relay connection does not, so
 * boot re-dials every template it rehydrates. Without this a restart left
 * the registry saying `live: false` and every imported card saying "Nobody
 * is serving", while the owner's surface said the team was up.
 */
async function joinRelayFor(template: ServedTemplate): Promise<void> {
  if (!relayServing) return
  // ASKED NOW, not at module load. A Mac that claimed its account after
  // booting serves under the account from this point on; one that has no name
  // at all does not go up nameless — the door stays local and says so, rather
  // than being listed somewhere nobody can look it up.
  const handle = servingHandleNow()
  if (handle === '') {
    console.error(`serving ${template.slug}: no account or key names this Mac, so it is not on the relay`)
    return
  }
  const snapshot = teams.load(template.templateId)
  const joined = await relayServing.serve({
    slug: template.slug,
    team: template.slug,
    handle,
    face: {
      title: snapshot?.name ?? template.templateId,
      door: (snapshot ? orchAgentOf(snapshot) : null) ?? '',
      agents: (snapshot?.nodes ?? []).filter((n) => n.kind === 'terminal').length,
      access: template.access,
      ...(template.access === 'paid' && template.priceUsd !== undefined
        ? { priceUsd: template.priceUsd }
        : {}),
      rails: servedPaymentRails(
        servedPaymentTerms({
          slug: template.slug,
          ...(template.priceUsd !== undefined ? { priceUsd: template.priceUsd } : {})
        })
      ),
      // The owner's words, verbatim, and the harness NAMES behind the door —
      // products, never the roster (served-face.ts).
      ...(template.summary !== undefined ? { summary: template.summary } : {}),
      ...(template.tags !== undefined ? { tags: template.tags } : {}),
      ...(snapshot ? { harnesses: harnessesOf(snapshot) } : {})
    }
  })
  if (!joined.ok) console.error(`serving ${template.slug}: not on the relay (${joined.reason})`)
}

/**
 * The teams this desktop is serving, named the way cookrew.dev names them.
 *
 * `team` is null for a door that is not on the relay: a seat names a `@handle/
 * team`, and a door with no published name cannot hold one. The Seats tab
 * shows those rows anyway and says so — serving is a fact this Mac knows on
 * its own, and hiding a team because it is LAN-only would read as "stopped".
 */
function servedTeamRefs(): readonly ServedTeamRef[] {
  return serving.served.list().map((template) => {
    const snapshot = teams.load(template.templateId)
    return {
      serviceId: template.serviceId,
      slug: template.slug,
      team: relayServing?.addressFor(template.slug)?.name ?? null,
      title: snapshot?.name ?? template.templateId,
      access: template.access,
      ...(template.priceUsd === undefined ? {} : { priceUsd: template.priceUsd })
    }
  })
}

/**
 * A PAID SEAT IS REPORTED TO cookrew.dev, and never lost to an outage.
 *
 * The door took the money at its own checkout; the registry only records who
 * ended up paying. The queue writes the receipt to disk before its first
 * attempt and drains at boot, so a registry that is down while somebody buys a
 * seat costs a retry rather than a dollar (seat-settle.ts).
 */
const seatSettles = new SeatSettleQueue({
  seats: doorSeats,
  onStuck: (entry) =>
    console.error(
      `[cookrew] seat for @${entry.username} at ${entry.team} is not recorded at cookrew.dev ` +
        `(receipt ${entry.receipt}) — grant it by hand from Seats & Teams`
    )
})

/** D7's rows: every served door, its orch card's NAME, and who is at it. */
function servedCallerRows(): readonly ServedCallersRow[] {
  const sessions = serving.instantiator.sessions().map((session) => ({
    serviceId: session.serviceId,
    sessionId: session.identity.sessionId,
    caller: session.accountId,
    conductorId: serving.instantiator.conductorFor(session.identity.sessionId),
    openedAt: doorCallers.since(session.serviceId, session.accountId) ?? 0
  }))
  return serving.served.list().map((template) => {
    const snapshot = teams.load(template.templateId)
    return {
      serviceId: template.serviceId,
      slug: template.slug,
      // The orch's name in the SAVED team — the card the owner recognises as
      // the door. The renderer matches on it (CallerAvatars.callersForCard).
      orchName: (snapshot ? orchAgentOf(snapshot) : null) ?? null,
      callers: seatedCallersFor(template.serviceId, sessions, doorCallers)
    }
  })
}

/** Push the caller rows to the owner's canvas. Cheap, and only on a change. */
let lastCallerRows = ''
function publishServedCallers(): void {
  const rows = servedCallerRows()
  const encoded = JSON.stringify(rows)
  if (encoded === lastCallerRows) return
  lastCallerRows = encoded
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('serving:callers', rows)
  }
}

function servedPaymentReturn(slug: string): string {
  const url = new URL(servedAddress(slug))
  url.searchParams.set('payment', 'received')
  return url.toString()
}

/**
 * Nonces already settled, for this process's lifetime.
 *
 * Not the durable guard — an EIP-3009 authorization is single-use ON CHAIN, so
 * a replay fails at the facilitator whether or not we remember it. This just
 * refuses the second attempt for free, before a network round trip.
 */
const servedNonces = createNonceLedger()

/**
 * Where a served crew's money goes.
 *
 * COOKREW_PAY_TO is an ADDRESS, not a key — public by nature, and the whole
 * reason x402 was chosen over Stripe: nothing secret has to live here. Without
 * it there is no destination, so `paymentRequirements` cannot quote and the
 * paid door answers 503 rather than admitting anyone for free.
 */
function servedX402Config(): ReturnType<typeof servedPayments.x402Config> {
  return servedPayments.x402Config()
}

function servedStripeConfig(): ReturnType<typeof servedPayments.stripeConfig> {
  return servedPayments.stripeConfig()
}

/**
 * One quote composer for the gate and every surface that names its live rails.
 * Stripe extends this function's `accepts` list; no surface reads config itself.
 */
function servedPaymentTerms(
  template: Pick<ServedTemplate, 'priceUsd' | 'slug'>
): unknown | null {
  // The published name rides along so the quote says whose seat it is.
  const team = relayServing?.addressFor(template.slug)?.name ?? null
  return servedPayments.terms({ ...template, ...(team === null ? {} : { team }) })
}

/** Public address + presence/mode only. The Stripe value has no read path. */
function configuredServedPaymentStatus(): ReturnType<typeof servedPayments.status> {
  return servedPayments.status()
}

/**
 * THE SERVED-CREW ADAPTER — HTTP ⇄ the gate (share-on-save, caller side).
 *
 * Mounted at the mobile server's unknown-slug fall-through, so a live workspace
 * always wins a slug and a served crew can never shadow the owner's own canvas.
 * Everything decided lives in `handleServedRoute`; this only moves bytes and
 * supplies the four app-side facts (admit, conductor, ask, the crew's face).
 */
async function handleServedSlug(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  slug: string
): Promise<boolean> {
  const template = serving.served.bySlug(slug)
  if (!template) return false
  const method = (request.method ?? 'GET').toUpperCase()
  const pathname = url.pathname.slice(`/${slug}`.length) || '/'
  const headers: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }
  let body: unknown = null
  if (method === 'POST') {
    try {
      body = await readJson<unknown>(request)
    } catch {
      body = null
    }
  }
  const issuer = {
    challenge: (binding: string) => callCredentials.challenge(binding),
    consumeChallenge: (value: string, binding?: string) =>
      callCredentials.consumeChallenge(value, binding),
    mint: (sub: string, scope: string) => callCredentials.mint(sub, scope),
    verifyToken: (token: string) => callCredentials.verifyToken(token)
  }
  const checkout = await handleServedPayRoute(
    {
      issuer,
      createCheckout: async (input) => {
            const config = servedStripeConfig()
            if (config === null) return null
            const result = await stripeCreateCheckout(
              { config, post: stripePost },
              {
                priceUsd: input.amountUsd,
                serviceId: input.serviceId,
                sub: input.sub,
                slug: input.slug,
                successUrl: input.successUrl,
                ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }),
                ...(input.team === undefined ? {} : { team: input.team })
              }
            )
            return result.ok ? result.url : null
          },
      successUrl: (t) => servedPaymentReturn(t.slug),
      // A buyer paying FROM the team's page at cookrew.dev is sent back to it
      // — that page, at that origin, and nowhere else (returnUrlFor).
      doorName: (t) => relayServing?.addressFor(t.slug)?.name ?? null,
      registryOrigin: () => registryOrigin()
    },
    template,
    method,
    pathname,
    headers,
    body
  )
  if (checkout !== null) {
    for (const [key, value] of Object.entries(checkout.headers ?? {})) {
      response.setHeader(key, value)
    }
    respondJson(response, checkout.status, checkout.body)
    return true
  }

  // The gate verifies this again before it can call settle. Capturing the same
  // claims here gives the Stripe rail the expected subject without widening
  // the gate's two-argument settle seam.
  const authorization = headers.authorization ?? ''
  const settlementClaims = authorization.startsWith('Bearer ')
    ? issuer.verifyToken(authorization.slice(7))
    : null
  const servedDeps: ServedEndpointDeps = {
      issuer,
      callers: servedCallers,
      // A registry token is minted for ONE published name; a door that is not
      // on the relay has none, and refuses every such token.
      doorName: (template) => relayServing?.addressFor(template.slug)?.name ?? null,
      ...(registryTokens ? { registryTokens } : {}),
      ...(v2CallTokens ? { v2Tokens: v2CallTokens } : {}),
      // A v2 sign-in is the ONLY moment this door learns a caller's username;
      // after it every route works from `acct-<username>`. Recorded so the
      // owner's canvas can put a face on them (D7).
      onV2Seated: (entry) => {
        doorCallers.seated(entry)
        publishServedCallers()
      },
      // The money rung asks what the sign-in said: a seat, or the owner. A
      // caller nobody recorded (a key-based one) is quoted, as before.
      entitled: (serviceId, sub) => doorCallers.entitled(serviceId, sub),
      // The money moved. Report it to cookrew.dev as a bought seat, through
      // the queue that survives the registry being down (seat-settle.ts).
      onPaid: (payment) => {
        // Before the early return below: a caller with no account still paid.
        emit('paid')
        const template = serving.served.byService(payment.serviceId)
        const team = template ? (relayServing?.addressFor(template.slug)?.name ?? null) : null
        const username = payment.sub.startsWith(ACCOUNT_SUB_PREFIX)
          ? payment.sub.slice(ACCOUNT_SUB_PREFIX.length)
          : null
        // A key-based caller has no account for a seat to land on, and a door
        // with no published name has no team for one to be at. Both are
        // ordinary states, not failures — the caller is still admitted.
        // The door itself learns it first: the buyer's token still says no
        // seat, and their next session must not meet the 402 again.
        doorCallers.bought(payment.serviceId, payment.sub)
        if (team === null || username === null || username.length === 0) return
        void seatSettles
          .record({ team, username, by: payment.by, receipt: payment.receipt })
          .catch(() => undefined)
      },
      admit: async (serviceId, sub) => {
        const { session, created } = await serving.instantiator.admit(serviceId, sub)
        // A face appears when the SESSION does, not when the token was
        // checked: sign-in is a credential, an open session is a person in
        // the room, and the avatars are about the room.
        if (created) publishServedCallers()
        return { workspaceId: session.workspaceId, sessionId: session.identity.sessionId, created }
      },
      hasOpenSession: (serviceId, sub) =>
        serving.instantiator
          .sessions()
          .some((s) => s.serviceId === serviceId && s.accountId === sub),
      conductorFor: (sessionId) => serving.instantiator.conductorFor(sessionId),
      ask: async (conductorId, prompt) => {
        // The pty here is a MIRROR of the multiplexer pane, and it can be
        // absent while the agent itself is alive (the attach exited; observed
        // live: herdr held the minted Fresco pane, ptys.get() missed, every
        // ask 500'd). Re-attach exactly the way the zoomed transcript does
        // rather than refuse a crew that is actually standing there.
        if (!ptys.get(conductorId)) ensureTerminalMirror(conductorId)
        const session = ptys.get(conductorId)
        if (!session) throw new Error('the crew has no live door')
        return servedTurnReply(
          {
            history: () => turns.history(conductorId),
            deliver: () => askTerminal(session, prompt)
          },
          prompt
        )
      },
      endSession: (serviceId, sub) => {
        const session = serving.instantiator.sessionForCaller(serviceId, sub)
        if (session === null) return false
        endServedSession(session.identity.sessionId)
        return true
      },
      sessionForCaller: (serviceId, sub) => {
        const session = serving.instantiator.sessionForCaller(serviceId, sub)
        if (session === null) return null
        // A SESSION WHOSE WORKSPACE IS GONE IS OVER. The owner removed it from
        // the canvas; the record outlived it and answered every read with 503
        // ("not available right now — usually is again shortly") forever,
        // while the caller's line hung on "opening". Ended here, so the
        // caller is told 404 — no session — and their next line mints afresh.
        if (!store.list().workspaces.some((w) => w.id === session.workspaceId)) {
          serving.instantiator.end(session.identity.sessionId)
          return null
        }
        return {
          conductorId: serving.instantiator.conductorFor(session.identity.sessionId)
        }
      },
      turns,
      traces,
      grantBudget: { allowsNewSession: (serviceId) => grants.allowsNewSession(serviceId) },
      // The quote and the settle are ONE decision expressed twice: the caller
      // must be charged exactly what we asked for. Both read the same config
      // and the same template, so they cannot drift apart into a door that
      // quotes a dollar and accepts a cent.
      paymentTerms: servedPaymentTerms,
      settle: (payment, amountUsd) =>
        railSettle(
          {
            x402: async (x402Payment) => {
              const config = servedX402Config()
              const quoted = paymentRequirements(config, amountUsd, '', '')
              // No quotable price means no settlement to check against. Refusing to
              // VERIFY is our fault, so it apologises rather than accuses.
              if (quoted === null) return 'unverifiable'
              const requirements: PaymentRequirements = quoted.accepts[0]
              return x402Settle(
                { config, post: postJson, seen: servedNonces },
                x402Payment,
                requirements
              )
            },
            stripe: async (stripePayment) => {
              const config = servedStripeConfig()
              if (
                config === null ||
                settlementClaims === null ||
                settlementClaims.workspace !== template.serviceId
              ) {
                return 'refused'
              }
              return stripeSettle(
                {
                  config,
                  get: stripeGet,
                  redemptions: servedStripeRedemptions
                },
                stripePayment,
                {
                  amountUsd,
                  serviceId: template.serviceId,
                  sub: settlementClaims.sub
                }
              )
            }
          },
          payment
        ),
      crewFace: (t) => {
        const snapshot = teams.load(t.templateId)
        const nodes = snapshot?.nodes ?? []
        return {
          name: snapshot?.name ?? t.templateId,
          serviceId: t.serviceId,
          slug: t.slug,
          address: servedAddress(t.slug),
          version: 1,
          access: t.access,
          ...(t.priceUsd !== undefined ? { priceUsd: t.priceUsd } : {}),
          // The door's NAME only — the roster behind it is never listed. The
          // ORCH's name, and never an invented 'Conductor': a face that names a
          // door the mint cannot produce is the promise the 503 then breaks.
          // serve() refuses an orch-less crew, so a served template always has
          // one; the empty string is the unreachable branch said out loud.
          door: (snapshot ? orchAgentOf(snapshot) : null) ?? '',
          agents: nodes.filter((n) => n.kind === 'terminal').length
        }
      }
  }

  // The caller's PTY line (SSE + raw + resize) writes the response itself, so
  // it mounts beside the value-shaped routes rather than through them.
  const lineHandled = await handleServedLineRoute(
    {
      gate: (lineHeaders) => gateCaller(servedDeps, template, lineHeaders),
      identify: (lineHeaders) => identifyCaller(servedDeps, template, lineHeaders),
      admit: async (serviceId, sub) => {
        const { sessionId, created } = await servedDeps.admit(serviceId, sub)
        return { sessionId, created }
      },
      conductorFor: (sessionId) => serving.instantiator.conductorFor(sessionId),
      openConductorFor: (serviceId, sub) =>
        servedDeps.sessionForCaller(serviceId, sub)?.conductorId ?? null,
      hadSession: (serviceId, sub) => serving.instantiator.hadSession(serviceId, sub),
      attach: attachServedLine,
      resident: (conductorId) => ptys.get(conductorId) ?? null,
      write: async (conductorId, data) => {
        const session = ptys.get(conductorId)
        if (!session) return { ok: false, reason: 'the line is not up' }
        return ownerSubmit(session, data)
      }
    },
    template,
    method,
    pathname,
    { headers, body, request, response }
  )
  if (lineHandled) return true

  const answer = await handleServedRoute(servedDeps, template, method, pathname, {
    headers,
    body,
    query: Object.fromEntries(url.searchParams.entries())
  })
  if (answer === null) return false
  // The 401's www-authenticate carries the ceremony's challenge, so it is set
  // before the body goes out (respondJson writes the head itself).
  for (const [key, value] of Object.entries(answer.headers ?? {})) {
    response.setHeader(key, value)
  }
  if (answer.headers?.['content-type']?.startsWith('text/html')) {
    response.writeHead(answer.status)
    response.end(typeof answer.body === 'string' ? answer.body : '')
  } else {
    respondJson(response, answer.status, answer.body)
  }
  return true
}
/**
 * Boot the conductor's PTY mirror and wait (bounded, ~2s) for residency — the
 * served-line analogue of acquireViewWhenReady. ensureTerminalMirror is the
 * same primitive the /ask path re-attaches with, so a line and an ask can
 * never disagree about whether the crew is standing there.
 */
async function attachServedLine(conductorId: string): Promise<LinePtyView | null> {
  if (!ptys.get(conductorId)) ensureTerminalMirror(conductorId)
  for (let i = 0; i < 40; i += 1) {
    const session = ptys.get(conductorId)
    if (session) return session
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return ptys.get(conductorId) ?? null
}

/**
 * The main thread's own pulse — loop delay, ELU, and how long each periodic
 * loop held the thread — read by GET /api/health and sampled hourly by
 * scripts/perf-eval.mjs. Residency counts ride along so the O(active) claim
 * of the residency loops can be checked against what is actually held.
 */
const loopHealth = createLoopHealth({
  residency: () => ({ store: store.resident().length, registry: sessions.residentCount() }),
  // The Sous breaker, so a loaded machine's silent titles are explained.
  sous: () => sousBreakerState(),
  probe: () => boardProbe.stats()
})

// Every synchronous fork the multiplexers make lands in the loop ledger
// under its command's name, so a multi-second stall on /api/health says
// which `herdr` or `tmux` call held the thread (multiplexer.ts).
setShellObserver((label, ms) => loopHealth.observe(label, ms))

const boardProbe = createProbeSampler(
  tmuxProbeDeps({
    knownTerminalIds: () => agents.list().map((entry) => entry.id),
    isAttached: (terminalId) => ptys.get(terminalId) !== undefined
  }),
  PROBE_INTERVAL_MS,
  { observe: (ms) => loopHealth.observe('boardProbe', ms) }
)
/**
 * Board sources incl. L2. A one-shot read TOUCHES the probe (at most one
 * pass, never the timer); a consumer that stays — the SSE ?board=1 stream,
 * the desktop panel's board:subscribe — holds it open through
 * probeSubscribe and is pushed through probeOnChange. The probe's cadence
 * is events first (see the invalidations wired below), a backed-off pass
 * as the fallback.
 */
function boardSources(): ReturnType<typeof boardSourcesFrom> {
  return boardSourcesFrom({
    store,
    turns,
    turnStore,
    agents,
    probe: () => boardProbe.touch(),
    probeWarm: () => boardProbe.warm(),
    probeSubscribe: () => boardProbe.subscribe(),
    probeOnChange: (listener) => boardProbe.onChange(listener)
  })
}
// A turn boundary is a phase change for one terminal: recompute it, no listing.
turns.on('turn', ({ terminalId }: { terminalId: string }) => void boardProbe.invalidate(terminalId))
// A turn ended: the auto-lander looks at the lane (lanes.ts rule 3).
turns.on('turn', ({ terminalId }: { terminalId: string }) => scheduleAutoLand(terminalId))
const events = new EventLog()
const recoverable = new RecoverableStore()
// Snapshot every killed terminal (node + position + session refs + edges)
// so recoverAgent can restore it exactly as it was (agent-recover feature).
store.setTerminalRemovedHook((snapshot) => recoverable.capture(snapshot))
const traces = new TraceReader(store, {
  piSessionsRootFor: (node) => {
    const owner = store.ownerOf(node.id)
    const servedCtx = owner ? servedSpawnContexts.get(owner) : undefined
    return servedCtx ? path.join(servedCtx.sandbox, '.cookrew', 'pi-sessions') : undefined
  },
  piAgentDirFor: (node) => {
    const owner = store.ownerOf(node.id)
    const servedCtx = owner ? servedSpawnContexts.get(owner) : undefined
    return servedCtx ? path.join(servedCtx.sandbox, '.pi', 'agent') : undefined
  }
})

/**
 * THE ONE STREAM (docs/site/one-stream-2026-09-07.html, phase T2).
 *
 * The lineage's transcripts read as one conversation, joined once with the
 * marks ledger, serving /api/terminal/:id/stream* — and, behind
 * COOKREW_STREAM_ADAPTERS, the five old routes as well. It composes what
 * already exists rather than standing anything up: `traces.documentOf` is the
 * SAME windowed per-file cache the pager uses (two caches over 119 MB files
 * is the "out of application memory" incident, not an abstraction cost), and
 * `traces.watchSpec` is the registry's own file resolution for the harnesses
 * that do not rotate.
 */
const streamService = createStreamService({
  nodeOf: (terminalId) => {
    const hit = store.nodeAcrossWorkspaces(terminalId)
    return hit && hit.node.kind === 'terminal' ? hit.node : null
  },
  documentOf: (file, kind) => traces.documentOf(file, kind),
  fileOf: (node) => traces.watchSpec(node.id)?.file ?? null
})

/**
 * WHERE A SOUS TITLE AND AN ACKNOWLEDGE-ON-VIEW GO NOW (one-stream T4).
 *
 * Until T4 the tracker wrote them back into ~/.cookrew/turns as two fields on
 * a stored record. That store is a reader now, so the two facts that are NOT
 * in the transcript take the route the design gives them: a mark, keyed by the
 * identity the stream assigns, through the one writer this design has. Wired
 * here rather than passed to the constructor because the tracker is composed
 * before the stream service is — and because a mark is a nicety: a tracker
 * that cannot write one must still take turns.
 */
turns.onMark = (terminalId, patch) => {
  const result = streamService.writeMark(terminalId, patch)
  if (!result.ok) console.error(`mark write for ${terminalId}: ${result.error ?? 'failed'}`)
}

/** A prompt's pictures, for the prompt box and the CHAT/LOG views (prompt-image.ts). */
const promptImages = createPromptImageReader({
  chainFiles: async (terminalId) => (await streamService.chain(terminalId)).files.map((f) => f.file),
  attachmentsDir: defaultAttachmentsDir()
})

/** What the desktop's stream door reads through — the SAME service the HTTP
 *  routes use, and the same door/scrape provider the old routes use. */
const streamIpcDeps: StreamIpcDeps = {
  stream: streamService,
  turnHistory: (terminalId) => turnHistoryFor(terminalId)
}

/**
 * THE RECORD BEHIND A CARD comes from one of three places (transcript-source):
 * the harness's session file, the PTY scrape, or — for an imported card — the
 * DOOR the card is a line into. The five reads below are the only seam: the
 * renderer asks the same questions over the same IPC for every card, and the
 * rail, pager and idle preview are the same components. A remote card differs
 * from a preset card in where its record lives, and nowhere else.
 *
 * (The R30 crew lane once threaded a remote client through seven seams and a
 * second card type; the owner reverted it. This is one seam and no new card.)
 */
/**
 * The port the two post-import calls are asked through. `accounts` is this
 * Mac's session on cookrew.dev; the key store is the door's own file.
 */
const doorPort: DoorBearerPort = {
  admit: (target, team) => admitWithAccount(target, team, accounts),
  withKey: (target) => signInToDoor(target)
}

const doorTranscripts = new Map<string, Promise<DoorTranscript | null>>()

function doorTranscriptFor(terminalId: string): Promise<DoorTranscript | null> {
  const hit = store.nodeAcrossWorkspaces(terminalId)
  if (!hit || hit.node.kind !== 'terminal' || transcriptSourceFor(hit.node) !== 'door') {
    return Promise.resolve(null)
  }
  const existing = doorTranscripts.get(terminalId)
  if (existing) return existing
  const node = hit.node
  const facts = node.servedSession as NonNullable<TerminalNodeData['servedSession']>
  const name = doorNameOf(node)
  const made = (async (): Promise<DoorTranscript | null> => {
    // A relayed door is read at the relay's loopback end, exactly where the
    // card's own line goes; a dialled door at its address. Same sign-in
    // either way — the same key file and the same sub the line uses.
    const target = name
      ? { origin: `http://127.0.0.1:${(await relayProxy()).port}`, slug: name }
      : { origin: facts.origin, slug: facts.slug }
    return new DoorTranscript(target, { signIn: (at) => doorBearer(doorPort, at, name) })
  })().catch((error) => {
    console.error(`door transcript for ${terminalId}: ${String(error)}`)
    // NEVER the local file. A door card whose door cannot be reached is a
    // door card with a refusal to show, not a local card — so the answer is
    // a client that says 'not-serving' on every read, forgotten at once so
    // the next read tries the relay again.
    doorTranscripts.delete(terminalId)
    return new DoorTranscript(
      { origin: facts.origin, slug: facts.slug },
      {
        signIn: async () => {
          throw error instanceof Error ? error : new Error(String(error))
        }
      }
    )
  })
  doorTranscripts.set(terminalId, made)
  return made
}

/** Tell the door this card's session is over — as the same caller the card is. */
async function endSessionAtDoor(node: TerminalNodeData): Promise<void> {
  const facts = node.servedSession
  if (!facts) return
  try {
    const name = doorNameOf(node)
    const target = name
      ? { origin: `http://127.0.0.1:${(await relayProxy()).port}`, slug: name }
      : { origin: facts.origin, slug: facts.slug }
    const token = await doorBearer(doorPort, target, name)
    const res = await fetch(`${target.origin}/${target.slug}${SERVED_SESSION_END_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}` }
    })
    if (res.status !== 200 && res.status !== 404) {
      console.error(`ending the session behind ${node.name}: the door answered ${res.status}`)
    }
  } catch (error) {
    console.error(`ending the session behind ${node.name}: ${String(error)}`)
  }
}

/** Sync form, for the seams that must not await (pins, watch routing). The
 *  focused workspace is in memory and answers almost every call; the
 *  cross-workspace scan (which can read parked workspaces off disk) is only
 *  for a card that is not here. */
function isDoorCard(terminalId: string): boolean {
  const here = store.focusedState.nodes.find((node) => node.id === terminalId)
  const node = here ?? store.nodeAcrossWorkspaces(terminalId)?.node
  return node?.kind === 'terminal' && transcriptSourceFor(node) === 'door'
}

const turnHistoryFor = async (terminalId: string) => {
  const door = await doorTranscriptFor(terminalId)
  return door ? door.turns() : turns.history(terminalId)
}

const turnPageFor = async (terminalId: string, request: TurnPageRequest = {}) => {
  const door = await doorTranscriptFor(terminalId)
  return door ? door.turnsPage(request) : pageTurns(turns.history(terminalId), request)
}

const traceIndexFor = async (
  terminalId: string,
  request: Parameters<TraceReader['index']>[1] = {}
) => {
  const door = await doorTranscriptFor(terminalId)
  return door ? door.traceIndex(request) : traces.index(terminalId, request)
}

const traceMarkersFor = async (terminalId: string) => {
  const door = await doorTranscriptFor(terminalId)
  return door ? door.traceMarkers() : traces.boundaryMarkers(terminalId)
}

/** Earlier lineage segments (pre-compact/pre-clear checkpoints). Local files
 *  only: a remote card's earlier session files exist at the author's app, and
 *  an empty listing is the honest answer — the ◆ markers themselves still
 *  render, they just do not open anything (parity contract §3). */
const lineageSegmentsFor = async (terminalId: string) =>
  isDoorCard(terminalId) ? [] : traces.lineageSegments(terminalId)

const tracePageFor = async (
  terminalId: string,
  request: Parameters<TraceReader['page']>[1] = {}
) => {
  const door = await doorTranscriptFor(terminalId)
  return door ? door.tracePage(request) : traces.page(terminalId, request)
}

const latestCheckpointFor = async (terminalId: string) => {
  const door = await doorTranscriptFor(terminalId)
  return door ? door.latest() : traces.latestCheckpoint(terminalId)
}

/** What the record behind a remote card is doing; null for every local card. */
const transcriptStatusFor = async (terminalId: string) => {
  const door = await doorTranscriptFor(terminalId)
  if (!door) return null
  // A FRESH answer, not the last one: the state is re-read from the door
  // (one record, memoised for a second) so a card asked "why is the rail
  // empty" is not told about a refusal from before the door came up.
  await door.fingerprint().catch(() => undefined)
  return door.state()
}

/** Version pins are caller-side annotations of a LOCAL session; a remote rail
 *  draws none (parity contract Q4: absent-and-not-rendering). */
const pinsFor = (terminalId: string) => (isDoorCard(terminalId) ? [] : pinStore.list(terminalId))

// Trace-perf T4: push a "your checkpoint changed" nudge to the renderer the
// instant a watched session file grows, so a card reflects a new turn without
// waiting for its poll. Refcounted per file; the renderer keeps a slow poll as
// the backstop for anything fs.watch coalesces or drops.
const latestWatch = new LatestFileWatcher({
  resolveFile: (terminalId) => traces.watchSpec(terminalId)?.file ?? null,
  onChange: (terminalId) => mainWindow?.webContents.send('trace:latest-changed', terminalId)
})
// The same nudge for a record that lives at somebody else's app: while a
// remote card is subscribed, its door is asked on a short interval and the
// card is pushed when the answer changes (door-watch). Routed by source below.
const doorWatch = new DoorWatch({
  probe: async (terminalId) => {
    // Network traffic through the relay, unattended: not while nobody can
    // see the card. Null means "nothing new", and the poll simply resumes.
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) {
      return null
    }
    return (await doorTranscriptFor(terminalId))?.fingerprint() ?? null
  },
  onChange: (terminalId) => mainWindow?.webContents.send('trace:latest-changed', terminalId)
})

/** Resolve Herdr's sanitized pane label back to the persisted terminal id. */
function terminalIdForSessionName(sessionName: string): string | null {
  return (
    store.terminalsAcross().find((terminal) => sessionNameFor(terminal.id) === sessionName)?.id ??
    null
  )
}

/**
 * Herdr owns the long-lived agent process. The local PTY mirror is loaded only
 * for a zoomed transcript, then retained without a viewer only during work.
 */
const lazyTerminals = new LazyTerminalAttachments({
  attach: (terminalId) => ensureTerminalMirror(terminalId),
  detach: (terminalId) => detachTerminalMirror(terminalId),
  // Only a resident mirror can be kept alive — trim() is reached for every
  // terminal at boot and on every status event, and a linger armed for a
  // terminal with no mirror would defer its watch/tracker release for nothing.
  resident: (terminalId) => ptys.isLive(terminalId),
  isWorking: (terminalId) =>
    agentStatus(sessionNameFor(terminalId)) === 'working' || turns.inTurn(terminalId),
  watchWorking: (terminalId) => {
    if (watchSessionTurns(terminalId, { deferInitial: true })) sessionSync.release(terminalId)
  }
})

/**
 * The backend's word on a mirrorless terminal, in the card's own vocabulary.
 *
 * 'idle' and 'done' map to null rather than to 'idle': a card with no mirror
 * has nothing to say about a resting agent that its checkpoint preview does
 * not say better, and claiming READY is what this whole path exists to stop.
 * Only the two states a person needs to SEE from across the canvas are
 * published — the same mapping the board plane already makes.
 */
const backendPhaseOf = (status: HerdrStatus): TurnPhase | null =>
  status === 'working' ? 'thinking' : status === 'blocked' ? 'waiting' : null

/** The pane's rows as they stand, for a menu a mirror cannot show (none attached, or taller than its viewport). */
const paneRows = async (terminalId: string): Promise<string | null> => {
  const mux = multiplexer()
  const name = sessionNameFor(terminalId)
  if (mux instanceof HerdrHostMultiplexer) return mux.captureRowsAsync(name)
  return mux?.capture(name) ?? null
}

/** Rows a permission box may run to on a narrow pane: a long command, wrapped at a phone's 43 columns. */
const BOX_HISTORY_ROWS = 600

/** Further back than paneRows, where a box taller than the screen keeps its top. */
const paneHistory = async (terminalId: string): Promise<string | null> => {
  const mux = multiplexer()
  return mux instanceof HerdrHostMultiplexer ? mux.captureRowsAsync(sessionNameFor(terminalId), BOX_HISTORY_ROWS) : null
}
turns.paneHistory = paneHistory

/** A menu read off a pane, its box whole if the box outgrew those rows. */
const withPaneBox = async (terminalId: string, choice: WaitChoice | null): Promise<WaitChoice | null> => {
  if (!choice?.about?.partial) return choice
  const history = await paneHistory(terminalId)
  return history === null ? choice : wholeBrief(choice, aboutOfScreen(history))
}

/** The latest read of each pane's menu: the gate's reads overlap, and a slow one must not land over a newer. */
const menuReads = new Map<string, number>()

/** The menu a pane shows, for a card with no mirror to read it from. */
const readPaneMenu = async (terminalId: string): Promise<void> => {
  const mine = (menuReads.get(terminalId) ?? 0) + 1
  menuReads.set(terminalId, mine)
  const screen = await paneRows(terminalId)
  if (screen === null) return
  const choice = await withPaneBox(terminalId, uiCommandOpen(screen) ? null : waitChoiceOfScreen(screen))
  if (menuReads.get(terminalId) === mine) turns.observeBackendChoice(terminalId, choice)
}

// herdr's word reaches the tracker through the pane: a slash command's own
// UI (the /model picker) is not a turn, whatever herdr's screen guess says.
const herdrPhases = createBackendPhaseGate({
  read: async (terminalId) => {
    const mux = multiplexer()
    const name = sessionNameFor(terminalId)
    if (mux instanceof HerdrHostMultiplexer) return mux.captureAsync(name)
    return mux?.capture(name) ?? null
  },
  current: (terminalId) => {
    const status = agentStatus(sessionNameFor(terminalId))
    return status ? backendPhaseOf(status) : null
  },
  apply: (terminalId, phase, agent) => turns.observeBackendPhase(terminalId, phase, agent),
  menu: readPaneMenu,
  turnOpen: (terminalId) => turns.turnOpen(terminalId)
})

statusFeed()?.on('status', ({ sessionName, status }: StatusObservation) => {
  const terminalId = terminalIdForSessionName(sessionName)
  if (!terminalId) return
  idleSleep.touch(terminalId, Date.now())
  lazyTerminals.observeStatus(terminalId, status)
  herdrPhases.observe(terminalId, backendPhaseOf(status), isAgentTerminal(terminalId))
  // herdr's push IS the board's phase for this pane: fold it in at once.
  void boardProbe.invalidate(terminalId)
})
// herdr withdrawing a state is a change too: the pane is pixels-only again,
// and without this it would wait for the fallback pass at whatever rung.
statusFeed()?.on('retracted', ({ sessionName }: StatusRetraction) => {
  const terminalId = terminalIdForSessionName(sessionName)
  if (terminalId) void boardProbe.invalidate(terminalId)
})

/**
 * Re-ask herdr about every terminal, INCLUDING the ones it has nothing to
 * say about.
 *
 * The status feed only ever pushes; three silences never arrive as events —
 * the feed disconnecting (it clears its map and emits nothing), a retraction
 * to `unknown` (deleted, not recorded), and a pane that simply went away. A
 * phase learned once and never retracted is the stuck `working` that
 * herdr-agent-status was hardened against, and here it would outlive the
 * terminal: a ghost board row, a drain that never reaches zero. agentStatus
 * answers null for all three, so passing that null through is the whole
 * retraction channel.
 */
function syncBackendPhases(): void {
  for (const terminal of store.terminalsAcross()) {
    const status = agentStatus(sessionNameFor(terminal.id))
    if (status) lazyTerminals.observeStatus(terminal.id, status)
    herdrPhases.observe(
      terminal.id,
      status ? backendPhaseOf(status) : null,
      terminal.command.trim().length > 0
    )
  }
}

/** Does this terminal run an agent, or is it a bare shell? */
function isAgentTerminal(terminalId: string): boolean {
  const hit = store.nodeAcrossWorkspaces(terminalId)
  return hit?.node.kind === 'terminal' && (hit.node as TerminalNodeData).command.trim().length > 0
}

// The feed may have seeded its cache before this listener was installed.
// This is also where a COLD canvas learns what its agents are doing: nothing
// is attached yet, so without it every card paints READY until someone zooms
// one open.
syncBackendPhases()
// Observability: the store's op choke-point feeds the durable event log;
// the log's live stream broadcasts to the renderer (mobile gets the same
// stream over the /api/events SSE, subscribed in mobile-api).
store.on('op', (e) => events.append(e))
events.on('event', (e) => mainWindow?.webContents.send('event:new', e))
cableSignals.on((signal) => mainWindow?.webContents.send('cable:signal', signal))
let mainWindow: BrowserWindow | null = null

/**
 * DEEP LINKS — `cookrew://import/@handle/team` and its kin (deep-link.ts).
 *
 * A link can arrive before the window exists (the app was launched BY it),
 * so it is queued until the renderer has loaded and delivered on
 * `app:deep-link` as the PARSED object; a link that does not parse goes
 * nowhere. Main never acts on a link itself — the renderer opens the same
 * sheet a person would, and the sheet still asks before anything is placed.
 */
const deepLinks = createDeepLinkQueue((link) => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(DEEP_LINK_CHANNEL, link)
  }
})

function acceptDeepLink(raw: string): void {
  // A PROVIDER'S WAY BACK STOPS HERE. It carries a handoff, so it never joins
  // the queue to the renderer; `accounts` drops it unless it started this trip.
  if (accounts.oauthReturn(raw)) return
  const link = parseDeepLink(raw)
  if (link === null) {
    // The link itself is not logged: it is whatever a stranger's page put in
    // an href, and a log line is not the place to reproduce it.
    console.error('deep link refused: not a shape this app acts on')
    return
  }
  deepLinks.push(link)
}

/** A link's arrival is the person asking for this window. */
function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

/**
 * Claim the `cookrew://` scheme. A packaged app registers its own bundle; in
 * development the running Electron binary has to be told which script it
 * launches with, or the OS would open a bare Electron shell on the link
 * (the form Electron's own docs prescribe).
 *
 * ON macOS THAT FORM IS NOT ENOUGH. The OS binds a scheme to a bundle id and
 * ignores the arguments, and every project's node_modules Electron.app shares
 * the id com.github.Electron — so the link can open another project's copy,
 * bare, with the Electron welcome page (seen 2026-10-04). The claim is still
 * made, because it is right whenever this repository's copy is the only one
 * registered; scripts/dev-deeplink-doctor.mjs lists the others and unregisters
 * them. A packaged build has its own id and none of this applies.
 */
function registerDeepLinkScheme(): void {
  const claimed = app.isPackaged
    ? app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
    : process.argv.length >= 2 &&
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
        path.resolve(process.argv[1])
      ])
  if (!claimed) console.error(`could not register ${DEEP_LINK_SCHEME}:// with the OS`)
}

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

/** Terminals whose close is under way, for the whole removal: see spawnTracked. */
const closingTerminals = new Set<string>()

/** A card as the registry records it. */
function registryInput(terminalId: string): AgentRegistryUpsert | null {
  const hit = store.nodeAcrossWorkspaces(terminalId)
  if (!hit || hit.node.kind !== 'terminal') return null
  const meta = store.list().workspaces.find((w) => w.id === hit.workspaceId)
  return {
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
  }
}

/** What the pane's boot script will export, so a check here is a check there. */
const paneSearchPath = (): string => `${ptys.runtimeDir}:${process.env.PATH ?? ''}`

/** The multiplexer's strict word on one pane: null when it could not say. */
function panePresence(id: string): boolean | null {
  const mux = multiplexer()
  const name = sessionNameFor(id)
  if (!mux) return false
  return mux.sessionPresence ? mux.sessionPresence(name) : mux.sessionExists(name)
}

/** Every live session now, or a rejection when the backend cannot be read. */
async function liveNow(): Promise<ReadonlySet<string>> {
  const mux = multiplexer()
  if (!mux) return new Set()
  return mux.liveSessions ? mux.liveSessions() : new Set(mux.listSessions())
}

type LaunchSubject = { id: string; command: string; cwd: string; claudeSessionId?: string | null }

/** What would stop this card booting, whatever runs now. Never a served one: its sandbox is its own. */
function bootBlockOf(t: LaunchSubject): LaunchFailure | null {
  const home = store.ownerOf(t.id)
  if (home !== undefined && servedSpawnContexts.has(home)) return null
  // spawnTracked moves a card to where its claude session lives first, so the check looks there too.
  const repaired = isClaudeCommand(t.command) && t.claudeSessionId ? claudeCwdRepair({ cwd: t.cwd, sessionId: t.claudeSessionId }) : null
  return launchBlock({
    cwd: repaired ?? t.cwd,
    command: t.command,
    path: paneSearchPath(),
    // The direct backend boots through a login shell, whose PATH this cannot see.
    checkCommand: multiplexer()?.capabilities.persistsAcrossRestart === true,
    installLine: (word) => HARNESS_FACTS.find((harness) => harness.bin === word)?.installLine ?? null
  })
}

/**
 * What stops this card starting now. A running agent whose folder went away is
 * still running, so a pane that is there, or may be, blocks nothing. Asked last:
 * it costs a fork, and only a card with a cause pays it. `live` saves a sweep that
 * fork per card. A strict read, never the admission cache: a cold cache says no pane.
 */
function launchBlockOf(t: LaunchSubject, live?: ReadonlySet<string>): LaunchFailure | null {
  const block = bootBlockOf(t)
  if (!block) return null
  const open = live ? live.has(sessionNameFor(t.id)) : panePresence(t.id) !== false
  return open ? null : block
}

/** Put the failure on the card. `announce` when someone just tried, not when a sweep looked. */
function noteLaunchFailure(terminalId: string, failure: LaunchFailure, announce: boolean): void {
  const input = registryInput(terminalId)
  if (!input) return
  const known = agents.lookup(terminalId)?.failure
  if (known?.kind === failure.kind && known.why === failure.why) return
  agents.fail(input, failure)
  if (announce) store.recordEventIn(input.workspaceId, 'terminal.launch-failed', terminalId, input.name, failure.why)
}

/**
 * Could this offline card start now? Asked before words are sent to it (the box
 * keeps them when the answer is no) and by the sweep. A cause that has gone
 * lifts its failure, so a folder put back is not a card still saying it is lost.
 */
function checkLaunch(terminalId: string, announce = true, live?: ReadonlySet<string>): LaunchFailure | null {
  const hit = store.nodeAcrossWorkspaces(terminalId)
  if (!hit || hit.node.kind !== 'terminal' || ptys.get(terminalId)) return null
  const block = launchBlockOf(hit.node as TerminalNodeData, live)
  if (block) {
    noteLaunchFailure(terminalId, block, announce)
    return agents.lookup(terminalId)?.failure ?? block
  }
  const known = agents.lookup(terminalId)?.failure
  if (!known?.blocked) return null
  if (blockStands(known, bootBlockOf(hit.node as TerminalNodeData))) return known
  agents.clearFailure(terminalId)
  return null
}

/** The cards on one workspace's screen: a stat each and one listing, never the whole machine. */
async function refreshLaunchBlocks(workspaceId: string): Promise<void> {
  try {
    const live = await liveNow()
    for (const id of store.terminalIdsOf(workspaceId)) checkLaunch(id, false, live)
  } catch (error) {
    console.error('Checking which cards can start failed:', error)
  }
}

/** What a mirror's process ending says about it, when the process did end. */
function failureOfExit(terminalId: string, session: PtySession, exitCode: number): LaunchFailure | null {
  const name = sessionNameFor(terminalId)
  // An attach client can go while its pane runs on: that is no death to report.
  if (multiplexer()?.sessionExists(name) === true) return null
  const record = takePaneExit(ptys.runtimeDir, name)
  const command = session.command ?? ''
  return exitFailure({
    name: commandWord(command) ?? store.nodeAcrossWorkspaces(terminalId)?.node.name ?? 'It',
    agent: command.trim().length > 0,
    // An attach client's own code says nothing of the pane; with no backend between, it IS the agent's.
    exitCode: record?.exitCode ?? (session.usesTmux ? null : exitCode),
    signal: record?.signal ?? null,
    tail: record && record.tail.length > 0 ? record.tail : cleanTail(session.outputTail),
    ranMs: Date.now() - session.startedAt,
    reattached: session.reattached
  })
}

/** recordSpawn runs again for a REUSED session; the death is to be read once. */
const exitWatched = new WeakSet<PtySession>()

function recordSpawn(terminalId: string, session: PtySession): void {
  const input = registryInput(terminalId)
  if (!input) return
  agents.upsert(input)
  if (exitWatched.has(session)) return
  exitWatched.add(session)
  session.once('exit', (exitCode: number) => {
    if (session.wasDisposed) return
    const failure = failureOfExit(terminalId, session, exitCode)
    if (failure) noteLaunchFailure(terminalId, failure, true)
    else agents.deactivate(terminalId)
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
function paneCard(t: BindableTerminal): PaneCardInfo {
  // The card's OWN workspace, not the focused one — a terminal being re-bound
  // may live on a canvas nobody is looking at (pane-bindings.ts).
  const owner = store.ownerOf(t.id)
  return paneCardFor(t, owner ? workspaceName(owner) : store.focusedState.name)
}

/**
 * herdr's agent names, kept (herdr-host-multiplexer.ts · reconcileAgentNames):
 * a name drops whenever an agent restarts in its pane. One async listing per
 * tick, single-flight inside the backend; the first tick also names the
 * panes of workspaces not attached since boot.
 */
const AGENT_NAME_TICK_MS = 30_000
function keepAgentNames(): void {
  const tick = (): void => {
    void multiplexer()?.reconcileAgentNames?.().catch(() => 0)
  }
  setTimeout(tick, 10_000).unref()
  setInterval(tick, AGENT_NAME_TICK_MS).unref()
}

/**
 * Every pane wears its card again.
 *
 * ensureSession re-reports the binding for terminals it ATTACHES, which is the
 * resident workspaces only; a herdr server that was replaced under the fleet
 * (a `herdr update --handoff`, a restart) drops the metadata for all the rest,
 * and they stay nameless in herdr's chrome until each card is opened. Measured
 * across the 0.8.2 -> 0.9.0 handoff: 33 named panes before, 5 after.
 *
 * Display-only and best-effort: it must never be able to fail a boot.
 */
function reportPaneBindings(): void {
  const mux = multiplexer()
  const report = mux?.reportPaneCard
  if (!mux || !report) return
  try {
    reportAllPaneBindings({
      terminals: () => store.terminalsAcross(),
      workspaceOf: (id) => {
        const owner = store.ownerOf(id)
        return owner ? workspaceName(owner) : ''
      },
      sessionName: (id) => sessionNameFor(id),
      report: (name, card) => report.call(mux, name, card),
      beginBatch: () => mux.beginAttachBatch?.(),
      endBatch: () => mux.endAttachBatch?.()
    })
  } catch (error) {
    console.error('Could not re-assert pane card bindings:', error)
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

/**
 * Spawn (or reuse) a PTY for a terminal node and register turn tracking. False
 * when no session came of it: the card says why, and the caller must not say it started.
 */
function spawnTracked(t: {
  id: string
  command: string
  cwd: string
  claudeSessionId?: string | null
  codexSessionRef?: string | null
  opencodeSessionId?: string | null
  piSessionId?: string | null
  sessionLineage?: string[]
}): boolean {
  // A card being closed takes no new pane: it would outlive the card, or be
  // what the close's own retry ends.
  if (closingTerminals.has(t.id)) return false
  // A card whose Claude session lives under ANOTHER directory than its cwd
  // (launched in an adopted pane that kept its old directory) moves to where
  // the session is BEFORE anything below derives a path from the cwd: the
  // resume check, the fork, the boot's `cd`. Left alone, a respawn boots a
  // blank conversation under the same id, and the session observer never
  // finds the transcript (2026-11-04: eight GOAT Team cards, every --no-wait
  // ask to them interrupted at 60 s). Once moved, the file is found at the
  // cwd and this never fires again.
  // A served card is never moved: its sandbox is its boundary.
  const home = store.ownerOf(t.id)
  const repairedCwd =
    isClaudeCommand(t.command) && t.claudeSessionId && !(home !== undefined && servedSpawnContexts.has(home))
      ? claudeCwdRepair({ cwd: t.cwd, sessionId: t.claudeSessionId })
      : null
  if (repairedCwd !== null) {
    console.error(`[cookrew] ${t.id}: cwd ${t.cwd} -> ${repairedCwd}, where its claude session lives`)
    // Enrolled like any cwd a card moves to (terminal-cwd.ts), so a later move
    // and its rollback treat it as the workspace's own directory.
    const workspace = home === undefined ? undefined : store.list().workspaces.find((w) => w.id === home)
    if (workspace && !workspace.dirs.includes(repairedCwd)) store.addWorkspaceDir(workspace.id, repairedCwd)
    store.updateNodeUnsafe(t.id, { cwd: repairedCwd })
    return spawnTracked({ ...t, cwd: repairedCwd })
  }
  // Before any pane exists: a pane that cannot start only hides why. Under herdr
  // a bad folder would not even fail, the agent starts wherever the pane was.
  const blocked = ptys.get(t.id) ? null : launchBlockOf(t)
  if (blocked) {
    noteLaunchFailure(t.id, blocked, true)
    return false
  }
  const owner = store.ownerOf(t.id) ?? store.focusedId
  const servedCtx = servedSpawnContexts.get(owner)
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
    const resolved = resolveClaudeSessionId({
      command,
      cwd: t.cwd,
      storedId: t.claudeSessionId,
      turns: turns.history(t.id),
      // The pane's own process is the authority over any file (the 2026-09-06
      // adoption defect, claude-session-adoption.ts) — but ONLY from the warm
      // cache: a cold pane-pid lookup is a synchronous herdr child process,
      // and a fleet respawning at once would pay for one each. A card with no
      // cached pid resolves exactly as before and the oracle's boot retries
      // land the live answer seconds later.
      live: { panePid: panePids.isWarm(t.id) ? panePids.pidOf(t.id) : null }
    })
    const sessionId = dampedSpawnSession(t, resolved)
    if (t.claudeSessionId !== sessionId) {
      // Re-resolve = a transition (e.g. the stored id's file vanished after a
      // /clear): record the old binding on the lineage so the rail keeps the
      // earlier segment visible and rewind can still cut into it.
      if (t.claudeSessionId) rebinds.left(t.id, t.claudeSessionId)
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
      ...(servedCtx
        ? {
            sessionsRoot: path.join(servedCtx.sandbox, '.cookrew', 'pi-sessions'),
            agentDir: path.join(servedCtx.sandbox, '.pi', 'agent')
          }
        : {}),
      // An unbound node adopts an UNOWNED session from its own cwd scope
      // rather than booting fresh beside it. Ownership is checked here, not
      // in pi-bind, because only the store knows what every other node claims
      // — and that check is the whole reason this is not the most-recent
      // guess the exclusive-dir design exists to forbid.
      storedSessionId: t.piSessionId ?? (servedCtx ? null : adoptablePiSession(t.id, t.cwd))
    })
    effective = binding.command
    if (t.piSessionId !== binding.sessionId) {
      store.updateNodeUnsafe(t.id, { piSessionId: binding.sessionId })
    }
  }
  // The herdr pane wears the card's display info (no-op elsewhere). Resolved
  // from the store rather than threaded through every caller — the node is
  // always persisted before it spawns, so the store is the freshest source.
  // nodeAcrossWorkspaces, not store.node (focused-scoped): a served session's
  // terminal is in a non-focused workspace, so the focused lookup would drop its
  // card metadata (R30 boot-in-place nit).
  const cardNode = store.nodeAcrossWorkspaces(t.id)?.node
  const card = cardNode?.kind === 'terminal' ? paneCard(cardNode) : undefined
  // Before the spawn, because the spawn is what makes the pane exist.
  const timingBoot = beginBootTiming(t.id)
  // Tagged with its owning workspace so the PTY plane can answer per-session
  // questions (multi-instance step 2). ownerOf resolves across every
  // workspace; focus is only the fallback for a terminal no canvas claims yet.
  // A served session's terminal spawns confined and scrubbed; the owner's own
  // spawns exactly as before (servedCtx is undefined).
  const served = servedCtx
    ? servedConfinement({
        base: sessionsBase,
        serviceId: servedCtx.serviceId,
        sessionId: servedCtx.sessionId,
        sandbox: servedCtx.sandbox,
        // The owner's own environment PLUS whatever this service was lent by
        // name; `sessionEnv` still allowlists on top, so a value here reaches
        // nothing that grantedKeys does not name.
        ownerEnv: grants.ownerEnvFor(servedCtx.serviceId),
        grantedKeys: grants.envKeysFor(servedCtx.serviceId),
        // The canvas control plane is the owner's alone: pty.ts withholds the
        // env keys that name this socket, and the profile denies the connect.
        controlSocketPath: ptys.socketPath,
        // The owner's gateway is denied to a seat outright (sandbox-deny.ts).
        gatewayPorts: routeService.gatewayPorts()
      })
    : undefined
  // The card's route, as env and args the harness is spawned with. Decided
  // here, at the spawn, so what the process got is what the node records as
  // `routeEffective`; a served session gets none (the service refuses it).
  const route = cardNode?.kind === 'terminal' ? routeService.envFor(cardNode) : null
  // Magpie's one MCP hub, handed to every agent so the fleet shares one copy
  // of each MCP server (route/shared-mcp.ts). Appended AFTER the route's args:
  // claude's --mcp-config is variadic and must be last on the line.
  const mcpArgs = cardNode?.kind === 'terminal' && !served ? routeService.sharedMcpFor(cardNode) : []
  const spawnRoute = route && !served ? { env: route.env, args: [...route.args, ...mcpArgs] } : null
  // A routed card runs the route's model: a launch pick's model gives way to it.
  // A direct claude card's alias is spelled for the gateway its own settings name (claude-model-route.ts).
  const launched = spawnRoute && route && route.effective !== 'direct' ? withoutRoutedPick(effective, harnessFor(effective)?.id) : directClaudeLine(effective)
  const fresh = !ptys.get(t.id)
  let session: PtySession
  try {
    session = ptys.spawn(
      {
        terminalId: t.id,
        command: launched,
        cwd: t.cwd,
        card,
        served,
        ...(spawnRoute ? { route: spawnRoute } : {})
      },
      owner
    )
  } catch (error) {
    // A husk the check let by (it has a pane) refuses here: the card says why.
    const block = bootBlockOf(t)
    if (!block) throw error
    noteLaunchFailure(t.id, block, true)
    return false
  }
  // A new process owes nothing to an old death still on file.
  if (fresh && !session.reattached) takePaneExit(ptys.runtimeDir, sessionNameFor(t.id))
  // The route is RECORDED only when a process was created: a tmux reattach
  // rode a surviving session and ignored the boot command, so what this
  // spawn computed never reached it; the card then reads "applies on restart".
  if (route && !served && fresh && !session.reattached) routeService.recordEffective(t.id, route)
  // One producer per conversation: every owner keystroke consults the
  // tracker BEFORE the byte reaches the child; a dispatch in flight is
  // preempted durably or the write is refused (Sol r4 P0-1).
  session.beforeOwnerInput = (terminalId, data) => turns.guardOwnerInput(terminalId, data)
  session.beforeMenuKeys = (terminalId, data) => turns.guardMenuKeys(terminalId, data)
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
    // The process's own statement arrives once claude has booted and written
    // ~/.claude/sessions/<pid>.json — seconds after the pane exists. Ask on a
    // short schedule so a resume that minted a new id is bound before the
    // first turn, not at the next sweep.
    for (const delay of ORACLE_BOOT_DELAYS_MS) {
      setTimeout(() => void rebindRotatedClaudeSession(t.id, 'oracle'), delay).unref()
    }
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
            exclude: claimedPiSessions(t.id),
            // A SERVED pi writes its session under the SANDBOX roots (the
            // spawn passes them at line ~1145); scanning the owner's default
            // root here meant a served orch could answer forever and never
            // bind — no piSessionId, no file-backed turns, and every caller
            // ask died as "completed no file-backed agent turn" (the final
            // broken link of the paid-session line, 2026-08-27).
            ...(servedCtx
              ? {
                  sessionsRoot: path.join(servedCtx.sandbox, '.cookrew', 'pi-sessions'),
                  agentDir: path.join(servedCtx.sandbox, '.pi', 'agent')
                }
              : {})
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
  return ptys.get(t.id) !== undefined
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
/** Cross-wire refusals already logged: terminal → the live session refused. */
const claimedReported = new Map<string, string>()

/** Pane pids, one herdr lookup per pane lifetime (claude-session-oracle.ts). */
const panePids = new PanePidCache((terminalId) => ptys.panePid(terminalId))

/**
 * Bindings a card has recently walked away from (rebind-damper.ts). A move
 * BACK onto one of them inside REBIND_BACKOFF_MS is the 2026-09-06 ping-pong
 * and is refused here, at both places a binding can change automatically.
 */
const rebinds = new RebindDamper()
/** Flaps already logged: terminal → the id whose re-adoption was refused. */
const flapReported = new Map<string, string>()

/** Report a refused ping-pong once per (card, session) pair, never per tick. */
function reportFlap(terminalId: string, name: string, sessionId: string): void {
  if (flapReported.get(terminalId) === sessionId) return
  flapReported.set(terminalId, sessionId)
  console.error(
    `Claude card ${name} (${terminalId.slice(0, 8)}) tried to bind back to session ` +
      `${sessionId.slice(0, 8)} it left moments ago; refused — a card that ping-pongs ` +
      'is a bug report, not a state machine (see rebind-damper.ts)'
  )
}

/**
 * The session a spawn may actually adopt.
 *
 * The resolver answers from files and from the live processes; this is the one
 * thing it cannot know — that the card was bound to `resolved` a moment ago and
 * something moved it off. Re-adopting it now is the flap, so the incumbent
 * binding is kept and the refusal is logged once. A genuine rotation names a
 * session the card has never left and is never damped.
 */
function dampedSpawnSession(
  t: { id: string; claudeSessionId?: string | null },
  resolved: string
): string {
  const stored = t.claudeSessionId
  if (!stored || stored === resolved || rebinds.allows(t.id, resolved)) return resolved
  reportFlap(t.id, store.nodeAcrossWorkspaces(t.id)?.node.name ?? t.id.slice(0, 8), resolved)
  return stored
}

/**
 * THE CHECKPOINT ⇔ LIVE-TRANSCRIPT SWEEP. Every live Claude card is held to
 * the invariant in claude-session-oracle.ts on a slow clock: the binding the
 * rail reads from is the session the pane's process reports. Oracle only —
 * no directory scan — so a fleet of quiet cards costs one readdir and a few
 * tiny reads per sweep, and a card whose process has moved house is rebound
 * within ORACLE_SWEEP_MS instead of the 33 hours measured on 2026-09-05.
 */
/** A pane that went with nobody attached: tmux may have kept what happened (pane-exit.ts). */
function noteDetachedDeath(id: string): void {
  const record = takePaneExit(ptys.runtimeDir, sessionNameFor(id))
  const entry = agents.lookup(id)
  const failure =
    record && entry
      ? exitFailure({
          name: commandWord(entry.command) ?? entry.name,
          agent: entry.command.trim().length > 0,
          exitCode: record.exitCode,
          signal: record.signal,
          tail: record.tail,
          ranMs: Number.POSITIVE_INFINITY,
          reattached: true
        })
      : null
  if (failure) noteLaunchFailure(id, failure, false)
  else agents.deactivate(id)
}

/**
 * THE REGISTRY OUTLIVES NOTHING IT DESCRIBES (agent-reconcile.ts).
 *
 * `active` flips only on an explicit dismiss/kill/exit event, so a pane lost
 * without one — a herdr restart, a dead login session, a crash — leaves a
 * card claiming to be a resting agent with a prompt box. Measured 2026-10-31:
 * Beacon had eight such entries, the oldest sixteen weeks old.
 *
 * One multiplexer listing per sweep (a synchronous herdr child), and NOTHING
 * is marked when the multiplexer cannot be seen: blindness is not absence.
 */
function reconcileAgentLiveness(): void {
  void refreshLaunchBlocks(store.focusedId)
  try {
    const mux = multiplexer()
    if (!mux?.available()) return
    const sessions = new Set(mux.listSessions())
    const entries = agents.list()
    const live = new Set(
      entries
        .filter((e) => ptys.get(e.id) !== undefined || sessions.has(sessionNameFor(e.id)))
        .map((e) => e.id)
    )
    const exempt = new Set(entries.filter((e) => servedSpawnContexts.has(e.workspaceId)).map((e) => e.id))
    const stale = staleAgentIds({ entries, observable: true, live, exempt })
    for (const id of stale) noteDetachedDeath(id)
    if (stale.length > 0) {
      console.error(`Reconciled ${stale.length} stale agent entr${stale.length === 1 ? 'y' : 'ies'}`)
    }
  } catch (error) {
    console.error('Agent liveness reconcile failed:', error)
  }
}
const livenessSweep = setInterval(reconcileAgentLiveness, 5 * 60_000)
livenessSweep.unref()
setTimeout(reconcileAgentLiveness, 30_000).unref()

/**
 * IDLE SLEEP (agent-sleep.ts). Owner, 2026-10-31: keep the TUI, stop paying
 * for it while nobody uses it. A Claude agent with no turn, no viewer, no
 * input and no draft in its box for COOKREW_IDLE_SLEEP_MS (default an hour,
 * 0 = off) is NOMINATED; it sleeps only when Claude's own record agrees
 * (agent-sleep-evidence.ts — 2026-11-01, mid-turn agents were being ended).
 * Its conversation stays on disk and the next ask, dispatch, quick reply,
 * phone message or LIVE resumes it.
 *
 * Claude only, on purpose: its wake is proven (Harden, twice, 2026-10-31) and
 * resumes the exact session. Codex's wake depends on the herdr session being
 * able to start codex at all — until it can, a sleeping Codex card would be a
 * card nobody can wake.
 */
const IDLE_SLEEP_MS = idleSleepMsFrom(process.env.COOKREW_IDLE_SLEEP_MS)
const idleSleep = new IdleSleep(IDLE_SLEEP_MS)

/** One sweep old: the read is async and the sweep it steers is on a minute clock. */
let machinePressure: PressureLevel = 'normal'

async function readMachinePressure(): Promise<void> {
  const memory = await readMachineMemory()
  if (!memory) return
  const level = pressureOf(memory)
  if (level === machinePressure) return
  console.error(`[cookrew] machine pressure ${machinePressure} -> ${level}: swap ${Math.round(memory.swapUsedMb)} MB`)
  machinePressure = level
}

/** Anything that means a person or a turn is using this agent right now. */
function agentBusyWhy(id: string): string | null {
  if (lazyTerminals.viewerCount(id) > 0) return 'viewer'
  if (turns.inTurn(id)) return 'in a turn'
  if (turns.ownerComposing(id)) return 'owner composing'
  return agentStatus(sessionNameFor(id)) === 'working' ? 'herdr says working' : null
}

function agentBusy(id: string): boolean {
  return agentBusyWhy(id) !== null
}

/** What the evidence last said about a nominee it kept awake. */
const sleepHolds = new Map<string, string>()
const SLEEP_REPORT_FILE = path.join(homedir(), '.cookrew', 'sleep-sweep.json')

function reportSleepSweep(
  running: readonly TerminalNodeData[],
  facts: readonly SleepFacts[],
  nominated: ReadonlySet<string>,
  windowMs: number
): void {
  const cards = running.map((node, index) => ({
    id: node.id,
    name: node.name,
    why: reasonAwake(facts[index], agentBusyWhy(node.id), sleepHolds.get(node.id) ?? null, nominated.has(node.id))
  }))
  writeSleepReport(SLEEP_REPORT_FILE, sleepReport({ at: Date.now(), pressure: machinePressure, windowMs, cards }))
}

/** One multiplexer listing per sweep — the same price as the liveness sweep. */
function sleepSweep(): void {
  if (IDLE_SLEEP_MS <= 0) return
  void readMachinePressure()
  try {
    const windowMs = sleepWindowMs(machinePressure, IDLE_SLEEP_MS)
    const mux = multiplexer()
    if (!mux?.available()) return
    const sessions = new Set(mux.listSessions())
    // A pane focused in herdr itself (the owner's own client, Alma on the
    // phone) has a person at it that Cookrew's viewer count cannot see.
    const focused = new Set(mux.focusedSessions?.() ?? [])
    const running = store.terminalsAcross().filter((n) => sessions.has(sessionNameFor(n.id)))
    const facts = running.map((n) => ({
      id: n.id,
      // A session filed under another directory is resumable too: the spawn
      // moves the card there first (claudeCwdRepair), so it is not a lost one.
      resumable:
        isClaudeCommand(n.command) &&
        !!n.claudeSessionId &&
        (canRestoreExact(n) || claudeCwdRepair({ cwd: n.cwd, sessionId: n.claudeSessionId }) !== null),
      served: n.servedSession != null || ptys.isServed(n.id) || servedSpawnContexts.has(store.ownerOf(n.id) ?? ''),
      busy: agentBusy(n.id) || focused.has(sessionNameFor(n.id))
    }))
    const due = idleSleep.due(facts, Date.now(), windowMs)
    reportSleepSweep(running, facts, new Set(due), windowMs)
    if (due.length > 0) void confirmSleep(due, windowMs)
  } catch (error) {
    console.error('Idle sleep sweep failed:', error)
  }
}

let confirmingSleep = false

/**
 * The clock nominated these; the agent's own process decides. Claude must say
 * idle, nothing it started may still be running, and its newest sign of life
 * (status change, transcript or subagent write, a loop's next wakeup) must be
 * a whole window old. Otherwise the window restarts from that sign of life.
 */
async function confirmSleep(due: readonly string[], windowMs: number): Promise<void> {
  if (confirmingSleep) return
  confirmingSleep = true
  try {
    const procs = await readProcTable()
    let coldLookups = 0
    for (const id of due) {
      const node = store.nodeAcrossWorkspaces(id)?.node
      if (!node || node.kind !== 'terminal' || !node.claudeSessionId) continue
      // Left nominated: the next sweep warms it, a minute later.
      if (!panePids.isWarm(id) && coldLookups++ >= sleepColdLookups(machinePressure)) continue
      const holders = liveSessionHolders()
      const now = Date.now()
      const holder = paneHolder(panePids.pidOf(id), holders, node.cwd, realCwd, node.claudeSessionId)
      if (sessionMoved(holder, node.claudeSessionId)) {
        sleepHolds.set(id, 'pane runs another session')
        idleSleep.restart(id, now)
        continue
      }
      const transcript = locateClaudeSessionFile(node.cwd, node.claudeSessionId)
      const evidence = await gatherSleepEvidence({ holder, holders, procs, transcript, now })
      const quiet = quietSince(evidence, now)
      if (now - quiet.at < windowMs) {
        sleepHolds.set(id, quiet.why)
        idleSleep.restart(id, quiet.at)
        continue
      }
      if (await cronArmedIn(transcript, now)) {
        sleepHolds.set(id, 'a recurring cron is armed')
        idleSleep.restart(id, now)
        continue
      }
      sleepHolds.delete(id)
      putAgentToSleep(id, now - quiet.at)
    }
  } catch (error) {
    console.error('Idle sleep confirm failed:', error)
  } finally {
    confirmingSleep = false
  }
}
const sleepSweepTimer = setInterval(sleepSweep, 60_000)
sleepSweepTimer.unref()

/** Old enough to be a leak, and clientless for long enough to not be a pause. */
const HEADLESS_LEAK_AGE_MS = 2 * 60 * 60_000
const HEADLESS_LEAK_QUIET_MS = 60 * 60_000
const headlessReaper = new HeadlessReaper(HEADLESS_LEAK_AGE_MS, HEADLESS_LEAK_QUIET_MS)

async function headlessLeakSweep(): Promise<void> {
  const killed = await headlessReaper.sweep(Date.now())
  if (killed.length > 0) console.error(`[cookrew] stopped ${killed.length} headless browser(s) nobody was driving`)
}
const headlessLeakTimer = setInterval(() => void headlessLeakSweep(), 10 * 60_000)
headlessLeakTimer.unref()

/**
 * End an idle agent's process and nothing else: the node, its wires, its
 * session id and its turn history all stay, so the wake is a plain resume.
 * Asked once more at the moment of the act — a turn can start inside the
 * sweep's minute.
 */
function putAgentToSleep(id: string, quietMs: number): void {
  const node = store.nodeAcrossWorkspaces(id)?.node
  if (!node || node.kind !== 'terminal' || agentBusy(id)) return
  // Nomination read focus up to a pass ago, and a pass can run long.
  if (multiplexer()?.focusedSessions?.().includes(sessionNameFor(id))) return
  lazyTerminals.forget(id)
  herdrPhases.observe(id, null, true)
  sessionSync.unwatch(id)
  turns.untrack(id)
  ptys.kill(id)
  agents.deactivate(id)
  idleSleep.markAsleep(id)
  const minutes = Math.round(quietMs / 60_000)
  store.withOpContext({ actor: 'agent' }, () =>
    store.recordEvent(
      'terminal.asleep',
      id,
      node.name,
      `idle ${minutes} min${machinePressure === 'normal' ? '' : ` (memory pressure ${machinePressure})`}; wakes on the next ask, reply or LIVE`
    )
  )
}

/**
 * Wakes an agent that has no running mirror (agent-wake.ts): one the idle
 * sweep slept, and any other card shown offline — the app restarted since it
 * slept, its pane was closed, herdr restarted. A cold agent resumes its own
 * session; a pane herdr still holds is only re-attached.
 */
/** Does the multiplexer still hold this terminal's pane (whether or not a mirror is attached)? */
function paneAlive(id: string): boolean {
  const mux = multiplexer()
  const name = sessionNameFor(id)
  if (mux instanceof HerdrHostMultiplexer) return mux.sessionExistsCached(name)
  return mux?.sessionExists(name) === true
}

/** Words that reached no process: the box takes them back, and everyone else hears why. */
function noteInputLost(id: string): void {
  const hit = store.nodeAcrossWorkspaces(id)
  const failure = agents.lookup(id)?.failure
  store.withOpContext({ actor: 'agent' }, () =>
    store.recordEventIn(
      hit?.workspaceId ?? store.focusedId,
      'terminal.input-lost',
      id,
      hit?.node.name ?? id,
      failure ? `${failure.why} ${failure.fix}` : 'it is offline and would not start — the prompt was not delivered'
    )
  )
}

const waker = new AgentWaker<PtySession>({
  session: (id) => ptys.get(id),
  isTerminal: (id) => store.nodeAcrossWorkspaces(id)?.node.kind === 'terminal',
  paneAlive,
  boot: (id) => ensureTerminalMirror(id),
  // A respawned TUI paints its resumed transcript and swallows the CRs sent
  // meanwhile (ask-cold-start); Claude can also sit silent before drawing
  // anything, so a Claude session waits for its input box as well.
  ready: (session) =>
    waitForReady(session, {
      drawn: isClaudeCommand(session.command ?? '') ? () => claudeComposerDrawn(session.viewportText()) : undefined,
      gone: () => ptys.get(session.terminalId) !== session
    }),
  sleep: { take: (id) => idleSleep.takeAsleep(id), mark: (id) => idleSleep.markAsleep(id) },
  // Never a silent drop (Sol r8): the words went nowhere, so say so.
  lost: (id, chunks) => {
    if (chunks.length === 0) return
    if (chunks.some((chunk) => /[\r\n]/.test(chunk))) return noteInputLost(id)
    // Keys with no Enter are a draft on its way, and the box still has it. Only
    // its line has to hear (live-line.ts): it would count them as typed.
    const hit = store.nodeAcrossWorkspaces(id)
    if (hit) store.recordEventIn(hit.workspaceId, 'terminal.keys-lost', id, hit.node.name)
  },
  warn: (message) => console.warn(message)
})

/**
 * Bring back an agent that is not running, resolving with its session once it
 * takes input. Undefined when the id is no terminal card or it would not start.
 */
function wakeAgent(id: string): Promise<PtySession | undefined> {
  return waker.wake(id)
}

const oracleSweep = setInterval(() => {
  // A cold pane-pid lookup is a synchronous herdr child process, so at most
  // ONE per tick: a fleet that all boots at once warms up over a few sweeps
  // instead of stalling the main thread for the whole fleet in one go.
  let coldLookups = 0
  for (const node of store.terminalsAcross()) {
    if (!isClaudeCommand(node.command) || !node.claudeSessionId) continue
    if (!ptys.get(node.id)) continue
    if (!panePids.isWarm(node.id) && coldLookups++ > 0) continue
    void rebindRotatedClaudeSession(node.id, 'oracle')
  }
  // Then retract phases herdr no longer stands behind — the silences it
  // never sends as events (feed down, a retraction to unknown, a pane that
  // went away). LAST, so a listener that throws cannot cost the oracle its
  // sweep; the walk is the same memoized terminalsAcross() plus map reads.
  syncBackendPhases()
}, ORACLE_SWEEP_MS)
oracleSweep.unref()

/**
 * Bring a Claude card's binding back to the session its pane is writing.
 *
 * ORACLE FIRST: the pane's process says which session it holds
 * (~/.claude/sessions/<pid>.json). When it agrees with the binding there is
 * nothing to scan; when it names another session, that is the answer and it
 * lands synchronously — no head reads, no inference. Only when the process
 * has no statement (older claude, no pane yet, a pane that died) does the
 * directory scan run, and only in 'scan' mode: the sweep and the boot
 * retries never pay for a scan on a card that is merely quiet.
 */
async function rebindRotatedClaudeSession(
  terminalId: string,
  mode: 'scan' | 'oracle' = 'scan'
): Promise<void> {
  try {
    const hit = store.nodeAcrossWorkspaces(terminalId)
    if (!hit || hit.node.kind !== 'terminal') return
    const node = hit.node as TerminalNodeData
    if (!isClaudeCommand(node.command)) return
    const bound = node.claudeSessionId
    if (!bound) return
    // The oracle is NOT behind the single-flight guard: it answers in this
    // same JS turn, and an answer must be free to land while a slow scan for
    // the same card is still reading heads — the scan's own commit is then
    // refused as 'binding-moved', which is the right outcome.
    const live = liveSessionOfPane(panePids.pidOf(terminalId), liveSessionHolders(), node.cwd)
    const verdict = oracleVerdict(bound, live, claimedClaudeSessions(terminalId))
    if (verdict === 'agree') return
    if (verdict === 'claimed' && live) {
      // Once per (card, session) pair, not once per sweep tick.
      if (claimedReported.get(terminalId) !== live.sessionId) {
        claimedReported.set(terminalId, live.sessionId)
        console.error(
          `Claude card ${node.name} (${terminalId.slice(0, 8)}) writes session ${live.sessionId.slice(0, 8)} that another card owns; binding left on ${bound.slice(0, 8)}`
        )
      }
      return
    }
    if (verdict === 'rebind' && live) {
      // Bind only a file that exists: the record precedes the first write by
      // a moment, and a watch on a name with no file behind it is the bug the
      // fork path already fixed once. The next sweep lands it.
      if (!existsSync(claudeSessionFile(node.cwd, live.sessionId))) return
      commitRotatedClaudeSession(terminalId, bound, [live.sessionId])
      return
    }
    if (mode === 'oracle') return
    // Single-flight per terminal for the SCAN: never stack probes. The sync
    // reports once per stale window, but a window can close while the
    // previous probe's bytes are still in flight, and two probes racing to
    // commit the same chain is a race with nothing to win.
    if (rotationProbes.has(terminalId)) return
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
  // THE DAMPER (2026-09-06). Every automatic rebind lands here, so this is
  // where a return to an id the card just left is refused: a conversation only
  // moves forward, and a move back is two mechanisms disagreeing. The refusal
  // leaves the binding exactly where it is — the card keeps reading the session
  // it is on — and the window closes on its own.
  if (!rebinds.allows(terminalId, rotated)) {
    reportFlap(terminalId, node.name, rotated)
    return
  }
  // Every id the card passes through is one it LEFT — an intermediate hop is
  // as wrong a place to come back to as the id we started from.
  for (const left of [bound, ...chain.slice(0, -1)]) rebinds.left(terminalId, left)
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
  // The cable between the asking agent and this one lights at delivery and
  // at the answer; only CLI-minted dispatches carry the asker.
  signal: (moment) => void cableSignals.emit(moment),
  // The sweep must not spare a stuck-working agent whose durable final
  // answer already exists — status may hold, never outrank the row.
  hasFinalAnswer: (agentId, prompt, armedAt) => turns.hasFinalAnswer(agentId, prompt, armedAt),
  // The input box belongs to a composing owner: admission refuses and both
  // delivery legs stand down rather than pasting under their typing.
  ownerComposing: (agentId) => turns.ownerComposing(agentId),
  wake: async (agentId) => (await wakeAgent(agentId)) !== undefined,
  // Observer probation: a native-file acceptance must see its watch actually
  // reconcile; a path that never materializes interrupts at 60s, not 10min.
  // Asked by the probation before it interrupts: a null from the last poll is
  // not final — prove it once more on the file the spec names now
  // (session-sync.ts · verifyNow). Only a transcript that exists nowhere
  // still ends the dispatch.
  observerLive: (agentId) => {
    if (sessionSync.isVerified(agentId)) return true
    const spec = traces.watchSpec(agentId)
    if (spec === null) return false
    const live = sessionSync.verifyNow(agentId, spec.file, spec.parse)
    // A watch made here for a background agent owes its drain, exactly as
    // beginWork's does: held by the dispatch's pin, then the quiet clock.
    if (store.nodeAcrossWorkspaces(agentId)?.workspaceId !== store.focusedId) sessionSync.release(agentId)
    return live
  },
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

/**
 * The conductor's view of a card a recruit just made (recruit-delivery.ts):
 * the brief waits for the harness's own input prompt — the readiness a forked
 * agent waits for — and is called delivered only on a turn that started or
 * the text on the card's screen. Every read is the PTY mirror or the tracker,
 * never a backend fork: these are polled while the CLI waits.
 */
const recruitWitness: RecruitWitness = {
  readyForInput: (id) => {
    const session = ptys.get(id)
    if (!session) return false
    const node = store.nodeAcrossWorkspaces(id)?.node
    return harnessReadyForInput(session, node?.kind === 'terminal' ? node.command : session.command)
  },
  turnRunning: (id) => {
    const phase = turns.phaseOf(id)
    return phase === 'thinking' || phase === 'waiting'
  },
  turnCount: (id) => (turns.isTracked(id) ? turns.history(id).length : null),
  screen: (id) => ptys.get(id)?.viewportText() ?? null
}

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
function seedConductorIfEmpty(workspaceId: string = store.focusedId): void {
  const state = store.workspaceState(workspaceId)
  if (state.nodes.some((node) => node.kind === 'terminal')) return
  store.addNodeToWorkspace(workspaceId, {
    kind: 'terminal',
    id: randomUUID(),
    name: 'Conductor',
    preset: DEFAULT_ORCH_PRESET.name,
    command: DEFAULT_ORCH_PRESET.command,
    cwd: state.dir,
    orch: true,
    role: null,
    position: { x: 240, y: 200 },
    size: DEFAULT_TERMINAL_SIZE
  })
}

// ---- workspace operations (shared by IPC and the cookrew CLI) ----
// Switching changes focus. Resident mirrors survive; cold terminals stay
// detached until a transcript viewer asks for them.

function listWorkspaces(): ReturnType<WorkspaceStore['list']> {
  return store.list()
}

function createWorkspace(name: string, dir: string, options: { stay?: boolean } = {}): WorkspaceMeta {
  return openWorkspace(store, { name, dir, stay: options.stay === true, seed: seedConductorIfEmpty })
}

function switchWorkspace(nameOrId: string): WorkspaceMeta {
  const meta =
    store.list().workspaces.find((w) => w.id === nameOrId) ?? store.metaByName(nameOrId)
  if (!meta) throw new Error(`Workspace '${nameOrId}' not found`)
  return store.switchWorkspace(meta.id)
}

/**
 * END A SERVED SESSION, ALL OF IT. The instantiator forgets the record and
 * removes the sandbox; the WORKSPACE it minted — the terminals a stranger's
 * session was running on this machine — is destroyed with it. Whether the
 * owner ended it from the Sessions table or the caller ended it from their
 * card, nothing of the session is left running afterwards.
 */
function endServedSession(sessionId: string): { stopped: number } {
  const record = serving.instantiator.sessions().find((s) => s.identity.sessionId === sessionId)
  const stopped = serving.instantiator.end(sessionId)
  if (record && store.list().workspaces.some((w) => w.id === record.workspaceId)) {
    removeWorkspace(record.workspaceId).catch((error) =>
      console.error(`ending ${sessionId}: its workspace could not be removed: ${String(error)}`)
    )
  }
  // The face goes with the session. What we remember of a caller is about a
  // LIVE session, so a record that outlived one would draw somebody who left.
  if (record) doorCallers.forget(record.serviceId, record.accountId)
  publishServedCallers()
  return stopped
}

/** A fork's reach: where its worktrees live, and who else holds a folder. */
function forkScope(workspaceId: string): ForkScope {
  return {
    worktreeRoot: path.join(homedir(), '.cookrew', 'worktrees'),
    otherDirs: store.list().workspaces.filter((w) => w.id !== workspaceId).flatMap((w) => w.dirs)
  }
}

/** What removing this workspace would stop, delete and leave (the remove sheet). */
async function workspaceRemovePlan(nameOrId: string): Promise<WorkspaceRemovePlan> {
  const meta =
    store.list().workspaces.find((w) => w.id === nameOrId) ?? store.metaByName(nameOrId)
  if (!meta) throw new Error(`Workspace '${nameOrId}' not found`)
  const state = store.workspaceState(meta.id)
  const forks = await inspectForks(state.dirs, forkScope(meta.id))
  return planWorkspaceRemove({ id: meta.id, name: meta.name, state, forks })
}

/**
 * Remove a workspace and, when asked, the fork's worktree and branch. They go
 * LAST: its agents are stopped first, and each fork is checked again in
 * removeFork, so a change made since the offer keeps them. What could not go
 * comes back as a sentence, because by then the workspace itself has gone.
 */
async function removeWorkspaceWith(
  nameOrId: string,
  options: { worktree?: boolean } = {}
): Promise<ReturnType<WorkspaceStore['list']>> {
  const plan = options.worktree ? await workspaceRemovePlan(nameOrId) : null
  const scope = plan ? forkScope(plan.id) : null
  const list = await removeWorkspace(nameOrId)
  if (!plan || !scope) return list
  const results = await Promise.all(plan.forks.filter((f) => f.removable).map((fork) => removeFork(fork, scope)))
  const notice = results.flatMap((r) => (r.ok ? [] : [r.reason])).join(' ')
  return notice ? { ...list, notice } : list
}

const removingWorkspaces = new Map<string, Promise<ReturnType<WorkspaceStore['list']>>>()

/**
 * Delete a workspace, and every process it holds. Its terminals end FIRST, and
 * a survivor stops the delete: the workspace and its cards are the only way
 * anyone reaches that process again. One delete at a time per workspace, and the
 * last one left is counted with the ones already going.
 */
async function removeWorkspace(nameOrId: string): Promise<ReturnType<WorkspaceStore['list']>> {
  const meta =
    store.list().workspaces.find((w) => w.id === nameOrId) ?? store.metaByName(nameOrId)
  if (!meta) throw new Error(`Workspace '${nameOrId}' not found`)
  const underway = removingWorkspaces.get(meta.id)
  if (underway) return underway
  if (store.list().workspaces.length - removingWorkspaces.size <= 1) throw new Error('Cannot remove the last workspace')
  const run = endWorkspace(meta).finally(() => removingWorkspaces.delete(meta.id))
  removingWorkspaces.set(meta.id, run)
  return run
}

/** Passes over a workspace's terminals: one, and a card recruited during the wait gets the next. */
const WORKSPACE_END_PASSES = 3

async function endWorkspace(meta: WorkspaceMeta): Promise<ReturnType<WorkspaceStore['list']>> {
  const ended = new Set<string>()
  try {
    // Kill this workspace's terminals BEFORE deleting it — store.removeWorkspace
    // only switches away (detach) and rm's the state dir, so without this each
    // terminal's tmux session (a claude CLI, bypassPermissions) would leak
    // forever with no node left to reach it. Done before the switch-away so the
    // active workspace's terminals are killed, not merely detached. Kills are
    // by session name, so parked (detached) terminals are reached too.
    for (let pass = 0; ; pass += 1) {
      const ids = store.terminalIdsOf(meta.id).filter((id) => !ended.has(id))
      if (ids.length === 0) break
      if (pass === WORKSPACE_END_PASSES) throw new Error(`"${meta.name}" was not removed: cards kept arriving while it closed`)
      for (const id of ids) store.snapshotTerminal(id) // HIGH-1: capture recovery snapshot before the kill
      // An open dispatch dies WITH its workspace — interrupted (infrastructure),
      // never left submitted/busy until the sweep (Sol r1 P1).
      const survivors = await endTerminals(ids, 'workspace removed')
      const gone = new Set(survivors.map(({ id }) => id))
      for (const id of ids.filter((candidate) => !gone.has(candidate))) {
        ended.add(id)
        defaultProducerLease().forgetTerminal(id)
        turns.untrack(id)
        // Keep turn history as the recovery signal (see removeNode, R2 fix).
        agents.deactivate(id)
      }
      if (survivors.length > 0) {
        const names = survivors.map(({ id }) => store.nodeAcrossWorkspaces(id)?.node.name ?? id).join(', ')
        const stopped = ended.size > 0 ? ` ${ended.size} other agent(s) did stop.` : ''
        const why = `${names} did not stop (${survivors[0].error}).${stopped}`
        // The wall logs a rejection and no more, and some agents did end: this is what says so.
        store.recordEventIn(meta.id, 'workspace.remove-failed', meta.id, meta.name, why)
        throw new Error(`"${meta.name}" was not removed: ${why}`)
      }
    }
    // No await from the last look to the delete: nothing can arrive between them.
    const browserIds = store.browserIdsOf(meta.id)
    // A workspace that is gone should not keep a picture of itself (the screen
    // wall). Dropped here, where the removal is known, rather than left for the
    // sweep that runs when the wall next opens.
    workspaceShots.forget(meta.id)
    // A served session's workspace: the session ends WITH it. Otherwise the
    // record lingers open with no conductor and every caller read is a 503.
    const servedHere = serving.instantiator.sessionForWorkspace(meta.id)
    if (servedHere) serving.instantiator.end(servedHere.identity.sessionId)
    store.removeWorkspace(meta.id) // switches away first if active (fires 'switch')
    void Promise.all(browserIds.map((id) => browserManager.discard(id))).catch((error) =>
      console.error('Failed to discard removed workspace browser profiles:', error)
    )
    return store.list()
  } finally {
    for (const id of ended) closingTerminals.delete(id)
  }
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
/* ── LANES (lanes.ts) ────────────────────────────────────────────────────
 * One agent, one worktree, one branch; landing is the app's action, never a
 * prompt. The four operations below are what the card menu, the phone and
 * the auto-lander call; the rules live in lanes.ts and are tested there. */

function laneTerminal(nodeId: string): TerminalNodeData {
  const node = store.node(nodeId)
  if (!node || node.kind !== 'terminal') throw new Error('Not a terminal node')
  return node as TerminalNodeData
}

/** The lane directory is inside the repo; git must never see it. */
function ensureLaneDirIgnored(laneDir: string): void {
  mkdirSync(laneDir, { recursive: true })
  const ignore = path.join(laneDir, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
}

function laneList(dir: string): Promise<LaneInfo[]> {
  return listLanes(laneGit(), dir)
}

/** Cut a lane from the agent's repo and move the agent into it (respawn, conversation carried). */
async function laneOpen(nodeId: string, name: string): Promise<CanvasNode> {
  const terminal = laneTerminal(nodeId)
  const opened = await openLane(laneGit(), terminal.cwd, name, ensureLaneDirIgnored)
  if (!opened.ok) throw new Error(opened.error)
  gitCache.invalidate(terminal.cwd)
  const moved = await setTerminalCwd(nodeId, opened.path)
  return store.updateNode(nodeId, { laneLast: null } as Partial<CanvasNode>) ?? moved
}

/** Land the agent's lane; the answer is kept on the node for the card. */
async function laneLand(nodeId: string, opts: { close?: boolean; gate?: string[] | null; auto?: boolean } = {}): Promise<LandResult> {
  const terminal = laneTerminal(nodeId)
  const lanePath = terminal.cwd
  // Closing removes the worktree the agent sits in, so the agent leaves first.
  const repo = opts.close ? await repoOf(laneGit(), lanePath) : null
  const result = await landLane(laneGit(), { lanePath, gate: opts.gate ?? null, close: false })
  if (result.ok && opts.close && repo) {
    await setTerminalCwd(nodeId, repo.main)
    const closed = await closeLane(laneGit(), lanePath)
    store.updateNode(nodeId, { laneLast: { ...result, closed: closed.ok, at: Date.now(), auto: false } } as Partial<CanvasNode>)
    gitCache.invalidate(repo.main)
    return { ...result, closed: closed.ok }
  }
  store.updateNode(nodeId, { laneLast: { ...result, at: Date.now(), auto: opts.auto ?? false } } as Partial<CanvasNode>)
  if (repo) gitCache.invalidate(repo.main)
  gitCache.invalidate(lanePath)
  return result
}

/** Drop the agent's lane (back to the shared tree first). Refuses unlanded work unless forced. */
async function laneClose(nodeId: string, force = false): Promise<CanvasNode> {
  const terminal = laneTerminal(nodeId)
  const lanePath = terminal.cwd
  const repo = await repoOf(laneGit(), lanePath)
  if (!repo) throw new Error(`${lanePath} is not in a git repo`)
  if (repo.root === repo.main) throw new Error('This agent is in the shared tree, not a lane')
  // Check before moving the agent, so a refused close leaves it where it was.
  const lanes = await listLanes(laneGit(), lanePath)
  const mine = lanes.find((l) => l.path === repo.root)
  if (!force && mine && (mine.dirty || mine.ahead > 0)) {
    throw new Error(mine.dirty ? 'The lane has uncommitted changes' : `The lane has ${mine.ahead} unlanded commit${mine.ahead === 1 ? '' : 's'} — LAND first`)
  }
  const moved = await setTerminalCwd(nodeId, repo.main)
  const closed = await closeLane(laneGit(), lanePath, force)
  if (!closed.ok) throw new Error(closed.error)
  return store.updateNode(nodeId, { laneAutoLand: false, laneLast: null } as Partial<CanvasNode>) ?? moved
}

function laneAuto(nodeId: string, on: boolean): CanvasNode {
  laneTerminal(nodeId)
  const updated = store.updateNode(nodeId, { laneAutoLand: on } as Partial<CanvasNode>)
  if (!updated) throw new Error('Not a terminal node')
  return updated
}

/**
 * THE AUTO-LANDER. A finished turn is the one moment an agent's lane is
 * worth looking at: if the agent committed, the lane lands; if it did not,
 * nothing happens and nothing is said. Debounced per terminal so a burst of
 * turn records is one landing, and never concurrent for one lane.
 */
const autoLandTimers = new Map<string, NodeJS.Timeout>()
const autoLanding = new Set<string>()
const AUTO_LAND_SETTLE_MS = 4000
function scheduleAutoLand(terminalId: string): void {
  const node = store.nodeAcrossWorkspaces(terminalId)?.node
  if (!node || node.kind !== 'terminal' || !(node as TerminalNodeData).laneAutoLand) return
  const pending = autoLandTimers.get(terminalId)
  if (pending) clearTimeout(pending)
  autoLandTimers.set(
    terminalId,
    setTimeout(() => {
      autoLandTimers.delete(terminalId)
      if (autoLanding.has(terminalId)) return
      autoLanding.add(terminalId)
      laneLand(terminalId, { auto: true })
        .then((result) => {
          if (result.ok) console.log(`[cookrew] auto-landed ${terminalId}: ${result.commits} commit(s) → ${result.landed}`)
          else if (result.reason !== 'nothing' && result.reason !== 'dirty') console.error(`[cookrew] auto-land ${terminalId} stopped: ${result.reason}`)
        })
        .catch((error) => console.error('[cookrew] auto-land failed:', error))
        .finally(() => autoLanding.delete(terminalId))
    }, AUTO_LAND_SETTLE_MS)
  )
}

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
      // Only a process is at stake: a card with none may move onto an unmounted folder.
      cannotStart: (node, target) => {
        if (!ptys.get(node.id) && panePresence(node.id) === false) return null
        const block = bootBlockOf({ id: node.id, command: node.command, cwd: target })
        return block ? `${block.why} ${block.fix} ${node.name} was left running.` : null
      },
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
  // The one text a (re)spawn may type — a staged copy preamble; never the
  // card's brief or role (recruit-node.ts).
  const inject = spawnInjectionFor(t)
  if (inject === null) return
  const session = ptys.get(t.id)
  if (!session) return
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
const drain = createSessionDrain({
  store,
  // A phone or SSE reader watching any of this workspace's terminals.
  subscriberCount: (tid) => sessionSync.subscriberCount(tid),
  // Work in flight: a terminal mid-turn is work, whoever is looking.
  hasLiveWork,
  // Plus any remote call this workspace is currently serving, which the
  // inferred signals cannot see during a cold fork's boot.
  callsInFlight: (id) => callsInFlight.count(id),
  releaseTerminal: (tid) => {
    sessionSync.release(tid)
    turns.untrack(tid)
  },
  detachWorkspace: (id) => ptys.detachWorkspace(id)
})
const sessions = drain.sessions

const sessionDrain = setInterval(() => {
  loopHealth.timed('sessionDrain', () => drain.tick())
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
  detach: (terminalId) => detachTerminalMirror(terminalId),
  boot: (terminal) => bootTerminal(terminal),
  // The plan's list is a snapshot from before the boots; the set to keep is
  // read now (keptBrowserNodes), so nothing started meanwhile is stopped.
  syncBrowsers: () => {
    void browserManager.replaceNodes(keptBrowserNodes()).catch(() => undefined)
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

/** A running page outside the resident workspaces survives a switch while used this recently. */
const BROWSER_KEEP_IDLE_MS = 30 * 60_000

/**
 * What a switch keeps running (browser-reach.ts · keptBrowsers). Read when the
 * switch SYNCS, not when it is planned: the boots in between yield to the
 * loop, and a page an agent starts in that window must not be stopped by a
 * list made before it existed.
 */
function keptBrowserNodes(): BrowserNodeData[] {
  return keptBrowsers({
    resident: residentBrowsers(),
    recentlyUsed: browserManager.liveIds(Date.now() - BROWSER_KEEP_IDLE_MS),
    nodeOf: activeBrowserNode
  })
}

function bootTerminal(t: TerminalNodeData): void {
  spawnTracked(t)
  deliverPendingInject(t)
  void boardProbe.invalidate(t.id) // attached now: L1 owns it, the probe's row goes
}

/** Open the local mirror for a zoomed transcript, never for canvas startup. */
function ensureTerminalMirror(terminalId: string): boolean {
  if (ptys.get(terminalId)) return true
  const hit = store.nodeAcrossWorkspaces(terminalId)
  if (!hit || hit.node.kind !== 'terminal') return false
  bootTerminal(hit.node as TerminalNodeData)
  return ptys.get(terminalId) !== undefined
}

/** Detach the mirror without killing the multiplexer-owned agent process. */
function detachTerminalMirror(terminalId: string): void {
  sessionSync.release(terminalId)
  turns.untrack(terminalId)
  ptys.detach(terminalId)
  void boardProbe.invalidate(terminalId) // detached now: the probe's to watch
}

function addNode(node: CanvasNode, workspaceId?: string): CanvasNode {
  const added = store.addNode(node, workspaceId)
  adoptLiveNode(added)
  return added
}

/**
 * Every patch to a card. `by` names who renamed it when a rename came from
 * somewhere other than the owner's own hands (`cookrew rename`, Sous): the
 * rename is recorded either way (`<kind>.renamed`, old name in details).
 */
function updateNode(id: string, patch: Partial<CanvasNode>, by?: string): CanvasNode | undefined {
  const existing = store.node(id) ?? store.nodeAcrossWorkspaces(id)?.node
  if (existing?.kind === 'note' && typeof (patch as { content?: string }).content === 'string') {
    const { content, ...rest } = patch as { content: string } & Partial<CanvasNode>
    const written = store.writeNote(id, content)
    return Object.keys(rest).length > 0 ? store.updateNode(id, rest) : written
  }
  const updated = store.updateNode(id, patch)
  if (existing && updated && 'name' in patch && updated.name !== existing.name) {
    recordRename(updated, existing.name, by)
  }
  // A rename is metadata: syncing would START a cold card's browser just to
  // relabel it, and `cookrew rename` reaches every card of a workspace.
  if (updated?.kind === 'browser' && Object.keys(patch).some((key) => key !== 'name')) {
    void browserManager.syncNode(updated).catch(() => undefined)
  }
  // A renamed/re-roled terminal re-binds its pane chrome (herdr only — the
  // method is absent elsewhere): the pane title, and on a rename its tab and
  // its entry in the agent directory. The name the pane wears comes from the
  // store, so this runs AFTER the patch lands.
  // The live session keeps the new card too, or an in-place reattach (a
  // dropped herdr client) would put the old name back on the pane.
  if (updated?.kind === 'terminal' && ('name' in patch || 'role' in patch)) {
    const card = paneCard(updated)
    ptys.get(id)?.rebindCard(card)
    const mux = multiplexer()
    mux?.reportPaneCard?.(sessionNameFor(id), card)
    if ('name' in patch) {
      if (mux?.followRename) mux.followRename(sessionNameFor(id), updated.name, id)
      else mux?.renameTab?.(sessionNameFor(id), updated.name)
      agents.rename(id, updated.name)
    }
  }
  return updated
}

/** The audit line of a rename: who, from what, to what (event log + SSE). */
function recordRename(node: CanvasNode, was: string, by?: string): void {
  const owner = store.ownerOf(node.id)
  if (!owner) return
  try {
    store.recordEventIn(owner, `${node.kind}.renamed`, node.id, node.name, `was "${was}"${by ? ` · by ${by}` : ''}`)
  } catch (error) {
    console.error('Could not record a rename:', error)
  }
}

function workspaceName(id: string): string {
  return store.list().workspaces.find((w) => w.id === id)?.name ?? id
}

/**
 * The one rename path (agent-rename.ts) on this process's store: every
 * rename lands through updateNode, so an agent's herdr pane title, tab and
 * agent name follow and the rename is recorded.
 */
const renameDeps: RenameDeps = {
  find: (id) => store.nodeAcrossWorkspaces(id),
  siblings: (workspaceId) => store.workspaceState(workspaceId).nodes,
  update: (id, patch, by) => updateNode(id, patch, by),
  pin: (id) => store.updateNodeUnsafe(id, { nameByHand: true })
}

/**
 * Rename a card (agent-rename.ts · renameCardIn): checked against its
 * workspace's other cards; a note's new name is pinned against its content,
 * a chosen agent name against Sous. Shared by `cookrew rename`, the voice,
 * and the owner's hands (renameByHand: IPC node:rename, the phone's route).
 */
function renameCard(id: string, wanted: string, onClash: 'refuse' | 'suffix', by?: string): RenameOutcome {
  // A name refused on a clash is one somebody chose (`cookrew rename`, the voice): it is pinned.
  return renameCardIn(renameDeps, id, wanted, onClash, onClash === 'refuse', by)
}

/** renameCard for an agent only: `cookrew recruit`, Sous, and a name picked from a prompt. */
function renameTerminal(id: string, wanted: string, onClash: 'refuse' | 'suffix', by?: string): RenameOutcome {
  if (store.nodeAcrossWorkspaces(id)?.node.kind !== 'terminal') return { ok: false, error: 'That agent is not on any canvas.' }
  return renameCard(id, wanted, onClash, by)
}

/**
 * The name Sous picks for a card made from a prompt (agent-namer.ts), once it
 * answers. Null when it has nothing better, or when the card wears a choice
 * by then (renamed while it thought, or pinned by hand): a guess never
 * overwrites one.
 */
async function autoNameTerminal(id: string, standIn: string, prompt: string): Promise<RenameOutcome | null> {
  return autoNameIn({ ...renameDeps, pick: nameAgent }, id, standIn, prompt)
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
    const wanted = bootsTerminalsFor(hit.workspaceId) && !ptys.get(id) && exact
    const forked = wanted && heldSession(hit.node as TerminalNodeData)
    const didSpawn = wanted && spawnTracked(hit.node)
    return {
      ok: true, id, name: hit.node.name, workspaceId: hit.workspaceId,
      workspaceName: workspaceName(hit.workspaceId), spawned: didSpawn, legacy: false, exact, forked, ...notStarted(id, wanted, didSpawn)
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
    const wanted = plan.spawn && exact
    const forked = wanted && heldSession(added)
    const didSpawn = wanted && spawnTracked(added)
    recoverable.remove(id)
    return {
      ok: true, id, name: added.name, workspaceId: plan.targetWorkspaceId,
      workspaceName: workspaceName(plan.targetWorkspaceId), spawned: didSpawn, legacy: false, exact, forked, ...notStarted(id, wanted, didSpawn)
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
  const wanted = bootsTerminalsFor(targetWs) && exact
  const forked = wanted && heldSession(added)
  const didSpawn = wanted && spawnTracked(added)
  return {
    ok: true, id, name: added.name, workspaceId: targetWs,
    workspaceName: workspaceName(targetWs), spawned: didSpawn, legacy: true, exact, forked, ...notStarted(id, wanted, didSpawn)
  }
}

/** A recover that meant to boot and could not: the toast says why, not "resumes later". */
function notStarted(id: string, wanted: boolean, didSpawn: boolean): { blocked?: string } {
  if (!wanted || didSpawn) return {}
  return { blocked: agents.lookup(id)?.failure?.why ?? 'it would not start' }
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
  turns.forgetPane(id)
  paneFollower.forget(id)
  // A dead generation's lease holder becomes invisible and its late release
  // a no-op — a reborn id must never inherit a stranded submission window.
  defaultProducerLease().retire(id)
  // Same rule for the mirror's linger window: an armed one belongs to the
  // dead generation and would detach a reborn id's fresh mirror.
  lazyTerminals.forget(id)
  // A retired terminal has no phase; leaving one behind is a board row and a
  // drain reference that outlive the card.
  herdrPhases.observe(id, null, true)
  sessionSync.unwatch(id)
  turns.untrack(id)
  // Unsettled dial turns belong to the pane that was asked; a reborn id
  // must not inherit a pending ask nothing will ever confirm.
  tuneAsks.forget(id)
  tuningCache.forget(id)
  tuningAnnounced.delete(id)
}

/** How long a pane the boot sweep closed gets before it is looked at again. */
const SWEEP_CONFIRM_MS = 4000

/** The boot sweep closed these. Said once they are seen gone: one still there stays on the board. */
function noteSwept(sessions: readonly string[]): void {
  if (sessions.length === 0) return
  const confirm = async (): Promise<void> => {
    const live = await liveNow()
    for (const session of sessions.filter((name) => !live.has(name))) {
      const entry = agents.list().find((candidate) => sessionNameFor(candidate.id) === session)
      if (entry) agents.deactivate(entry.id)
      store.recordEvent('terminal.swept', entry?.id ?? session, entry?.name ?? session, 'it had no card, so it was closed at launch')
    }
  }
  setTimeout(() => void confirm().catch((error) => console.error('Confirming the boot sweep failed:', error)), SWEEP_CONFIRM_MS).unref()
}

/** Live panes no card reaches, for the board. Empty when the store cannot be read whole. */
async function listStrayPanes(): Promise<StrayPane[]> {
  const mux = multiplexer()
  if (!mux) return []
  try {
    return strayPanes([...(await liveNow())], store.allTerminalIdsStrict(), agents.list())
  } catch (error) {
    console.error('Listing panes with no card failed:', error)
    return []
  }
}

/** End a stray by hand: the same proof the sweep needs, asked again at the moment of the act. */
async function endStrayPane(session: string): Promise<CloseOutcome> {
  const stray = (await listStrayPanes()).find((pane) => pane.session === session)
  if (!stray) return { ok: false, error: 'That pane is not running without a card any more.' }
  if (!ptys.holdsHostClaim()) return { ok: false, error: 'This app does not own the terminal server, so it ends nothing.' }
  if (!stray.proved || stray.terminalId === null) {
    return { ok: false, error: 'Nothing proves this app started that pane, so it was left running.' }
  }
  const closed = await terminalCloser.close(stray.terminalId)
  if (!closed.ok) return closed
  agents.deactivate(stray.terminalId)
  store.recordEvent('terminal.killed', stray.terminalId, stray.name ?? session, 'a pane with no card')
  return closed
}

/** How often a card with no mirror re-reads its pane. */
const PANE_FOLLOW_MS = 2000

/** A terminal whose card has only its pane to go on: no session file behind it. */
const hasNoRecord = (command: string): boolean => harnessFor(command)?.turns !== 'file'

const paneFollower = new PaneFollower({
  candidates: () =>
    store.focusedState.nodes
      .filter((node) => node.kind === 'terminal' && !ptys.get(node.id) && !closingTerminals.has(node.id) && hasNoRecord(node.command) && !node.servedSession)
      .map((node) => node.id),
  live: async (ids) => {
    const sessions = await liveNow()
    return new Set(ids.filter((id) => sessions.has(sessionNameFor(id))))
  },
  capture: async (id) => {
    const mux = multiplexer()
    const name = sessionNameFor(id)
    return (mux?.captureAsync ? await mux.captureAsync(name) : mux?.capture(name)) ?? null
  },
  // Asked again: a capture takes a while, and the card may have gone or got a mirror.
  publish: (id, text) => {
    if (store.nodeAcrossWorkspaces(id) && !ptys.get(id) && !closingTerminals.has(id)) turns.observePane(id, text, isAgentTerminal(id))
  },
  gone: (id) => {
    turns.forgetPane(id)
    noteDetachedDeath(id)
  }
})
const paneFollowTimer = setInterval(() => void paneFollower.tick(), PANE_FOLLOW_MS)
paneFollowTimer.unref()

const terminalCloser = new TerminalCloser({
  kill: (id) => ptys.killAndWait(id),
  survived: (id, why) => {
    const hit = store.nodeAcrossWorkspaces(id)
    console.error(`Terminal ${id} survived its close: ${why}`)
    store.recordEventIn(hit?.workspaceId ?? store.focusedId, 'terminal.kill-failed', id, hit?.node.name ?? id, why)
  }
})

/**
 * Retire these terminals and end them, returning the ones that would not go.
 * The ended stay in closingTerminals until the caller's removal is done, or a
 * mirror or a wake could boot a pane under a card about to be deleted. A survivor
 * is taken back: its card is the only handle on it, so it must see and reach it.
 */
async function endTerminals(ids: readonly string[], why: string): Promise<Survivor[]> {
  for (const id of ids) {
    closingTerminals.add(id)
    retireTerminal(id, why)
  }
  const survivors = await terminalCloser.closeAll(ids)
  for (const { id } of survivors) {
    closingTerminals.delete(id)
    const hit = store.nodeAcrossWorkspaces(id)
    if (hit?.node.kind !== 'terminal' || panePresence(id) !== true) continue
    try {
      spawnTracked(hit.node as TerminalNodeData)
    } catch (error) {
      console.error(`Taking back terminal ${id} failed:`, error)
    }
  }
  return survivors
}

/**
 * The node store and the PTY table, as the two functions agent-tuning wants.
 *
 * Module scope because THREE callers need the identical object — the desktop's
 * two IPC handlers and the phone's three routes. A second copy built at the
 * mobile call site is how the two surfaces would come to disagree about which
 * cache they read and whose asks they remember.
 */
/**
 * In place, with exact context: the kill ends the pane, the spawn resumes the
 * same session under the card's current command and env (the recover path's
 * own guarantee). The route dial and the model/effort dials both restart here.
 *
 * killAndWait, not kill: kill returns before the pane is torn down, and a
 * spawn that lands first re-attaches to the dying pane, ignoring the new
 * command; and kill does nothing for a pane running with no mirror attached.
 * The node is read AFTER the wait, so the spawn takes the command as saved.
 */
async function respawnInPlace(id: string): Promise<boolean> {
  const current = store.nodeAcrossWorkspaces(id)?.node
  if (current?.kind !== 'terminal') return false
  // Before the kill: ending a running agent that cannot start again loses it.
  const cannot = bootBlockOf(current as TerminalNodeData)
  if (cannot) {
    console.error(`respawn ${id}: ${cannot.why} It was left running.`)
    return false
  }
  try {
    await ptys.killAndWait(id)
  } catch (error) {
    console.error(`respawn ${id}: the old pane would not end, so nothing was started`, error)
    return false
  }
  const node = store.nodeAcrossWorkspaces(id)?.node
  if (!node || node.kind !== 'terminal') return false
  return spawnTracked(node)
}

/**
 * Work a restart would cut that the turn phase cannot show (QA 2026-11-03): an
 * open dispatch, a held submission window, undelivered text in the box — and,
 * for a card the tracker does not follow (no mirror), herdr saying it works or
 * asks. herdr errs towards idle, so it only ever adds a refusal.
 */
function turnUnseen(id: string): boolean {
  if (dispatchService.hasOpenDispatch(id) || defaultProducerLease().holderOf(id) !== null || defaultProducerLease().isContaminated(id)) return true
  if (turns.phaseOf(id) !== undefined) return false
  const status = agentStatus(sessionNameFor(id))
  return status === 'working' || status === 'blocked'
}

/** Where a card's turns go, for a model pick: routed through the gateway (its catalog and levels), or direct. */
function cardRouteFor(node: TerminalNodeData): { routed: boolean; catalog: readonly string[]; levelsOf: (id: string) => readonly string[] } {
  const state = routeService.state()
  const levelsOf = (id: string): readonly string[] => state.models.find((m) => m.id === id)?.levels ?? []
  if (state.status !== 'online') return { routed: false, catalog: [], levelsOf }
  return { routed: routeService.routeOf(node) !== 'direct', catalog: state.models.map((m) => m.id), levelsOf }
}

/** The effort levels a claude card's model takes: its route's catalog row, else null (claude's own). */
function cardEffortChoices(id: string): readonly string[] | null {
  const node = store.nodeAcrossWorkspaces(id)?.node
  if (node?.kind !== 'terminal' || !isClaudeCommand(node.command)) return null
  const where = cardRouteFor(node)
  if (!where.routed) return null
  const levels = where.levelsOf(routeService.routeOf(node))
  return levels.length > 0 ? levels : null
}

/** A direct claude line, with an alias `--model` sent as the gateway's id when claude's settings route claude there. */
function directClaudeLine(command: string): string {
  if (!isClaudeCommand(command) || !/\s--model[=\s]/.test(command)) return command
  let settings: unknown = null
  try {
    settings = JSON.parse(readFileSync(path.join(homedir(), '.claude', 'settings.json'), 'utf8'))
  } catch {
    return command
  }
  if (!claudeSettingsGateway(settings)) return command
  const state = routeService.state()
  return state.status === 'online' ? withGatewayModel(command, state.models.map((m) => m.id)) : command
}

/**
 * A new claude agent's model pick on a card the default route will take: the
 * pick becomes its route, as a live pick on a routed card does, so the route
 * cannot outrank it (claude-model-route.ts).
 */
function routedNewAgent(node: TerminalNodeData): TerminalNodeData {
  const model = /\s--model(?:=|\s+)(\S+)/.exec(node.command)?.[1]
  if (model === undefined || !isClaudeCommand(node.command)) return node
  const where = cardRouteFor(node)
  if (!where.routed) return node
  const plan = launchPick({ command: node.command, knob: 'model', value: model, ...where })
  return 'route' in plan && plan.route !== undefined ? { ...node, command: plan.command, route: plan.route } : node
}

/** A new agent's launch from the prompt box's pick: claude reads the one list (claude-model-route.newAgentPlan). */
function newAgentLaunch(command: string, tune: unknown): { command: string; route?: string } {
  const offer = launchOfferFor(command)
  if (!isClaudeCommand(command)) return { command: launchCommand(command, tune, offer) }
  const state = routeService.state()
  const online = state.status === 'online'
  return newAgentPlan({
    command,
    tune,
    offer,
    catalog: online ? state.models.map((m) => m.id) : [],
    levelsOf: (id) => state.models.find((m) => m.id === id)?.levels ?? []
  })
}

/** A model or effort pick, as a launch flag: saved on the card, then a restart in place (agent-relaunch.ts). */
function relaunchDeps(): RelaunchDeps {
  return {
    node: (id) => {
      const node = store.nodeAcrossWorkspaces(id)?.node
      return node?.kind === 'terminal' ? node : null
    },
    phaseOf: (id) => turns.phaseOf(id),
    delivering: (id) => turnUnseen(id),
    save: (id, patch) => {
      store.updateNodeUnsafe(id, patch)
      if (patch.route !== undefined) routeService.cardChanged(id)
    },
    live: (id) => ptys.get(id) !== undefined || paneAlive(id),
    restorable: (node) => routeService.restorable(node),
    cannotStart: (node) => bootBlockOf(node)?.why ?? null,
    respawn: (id) => void respawnInPlace(id)
  }
}

function tuneDeps(): TuneDeps {
  return {
    // ACROSS WORKSPACES, not just the focused one. store.node() searches only
    // what the desktop is currently looking at, and the phone can be scoped to
    // a different workspace entirely — a card there would have answered "no
    // such terminal" and drawn a blank rail. The fleet readout already spans
    // every workspace (it is built from the durable registry), so the per-card
    // route has to reach as far or the two disagree about the same card.
    node: (id) => {
      const node = store.nodeAcrossWorkspaces(id)?.node
      return node?.kind === 'terminal' ? node : null
    },
    write: (id, data) => ptys.get(id)?.write(data),
    relaunch: (id, patch) => relaunchInPlace(relaunchDeps(), id, patch),
    routeFor: (node) => cardRouteFor(node),
    effortChoices: (id) => cardEffortChoices(id),
    asks: tuneAsks,
    cache: tuningCache,
    // The RTE dial: offered only when the gateway is online and the card's
    // harness can be routed; 'direct' first, then the catalog, groups first.
    routeChoices: (id) => {
      const state = routeService.state()
      if (state.status !== 'online') return null
      const node = store.nodeAcrossWorkspaces(id)?.node
      const harness = node?.kind === 'terminal' ? harnessFor(node.command)?.id : null
      if (!harness || harness === 'pi') return null
      return ['direct', ...state.models.map((m) => m.id)]
    }
  }
}

/**
 * EVERY agent the fleet knows, not only the open workspace: the roster spans
 * workspaces that are not loaded, and a card there wears the same tag. The
 * durable registry holds exactly what a readout needs (command, cwd, session
 * ref), so nothing has to be resident to be readable. Ids with nothing
 * recorded are ABSENT rather than null — a card with no reading draws no tag.
 */
function tuningFleet(): Record<string, AgentTuning> {
  const rows: Record<string, AgentTuning> = {}
  for (const entry of agents.list()) {
    const tuning = tuningCache.of({
      id: entry.id,
      command: entry.command,
      cwd: entry.cwd,
      sessionRef: entry.sessionRef
    })
    if (tuning !== null) rows[entry.id] = tuning
  }
  return rows
}

/**
 * Tell the renderer this card's dials CHANGED, and only then.
 *
 * Activity fires several times a second while a turn runs; the model an agent
 * answers on changes perhaps twice a day. The cache makes the question cheap
 * (one stat on an unchanged file) and this makes the answer quiet.
 */
function announceTuning(terminalId: string): void {
  const node = store.node(terminalId)
  if (node?.kind !== 'terminal') return
  const tuning = tuningCache.of(subjectOf(node))
  if (tuning === null) return
  const stamp = `${tuning.model ?? ''}|${tuning.effort ?? ''}`
  if (tuningAnnounced.get(terminalId) === stamp) return
  tuningAnnounced.set(terminalId, stamp)
  const row = { terminalId, tuning }
  mainWindow?.webContents.send('terminal:tuning', row)
  // The phone is the owner's own surface and gets the same frame, filtered to
  // its own canvas by the stream (mobile-api onTuning).
  tuningBus.emit('tuning', row)
}

/**
 * Close a card. A terminal's card goes only once its process has: see
 * terminal-close.ts. Its own workspace, not the one on screen: a phone can close
 * a card while the desktop looks elsewhere (focus is only focus, ruling 11-04).
 */
async function removeNode(id: string, opContext: { actor?: EventActor; via?: string | null } = {}): Promise<CloseOutcome> {
  const node = store.nodeAcrossWorkspaces(id)?.node
  // NOTE: turn history is deliberately NOT cleared on kill — it is the third
  // recovery net (resolveClaudeSessionId matches it to the real session when
  // no snapshot/registry ref exists). Disk-capped at 100/agent, negligible;
  // clearing it destroyed a recovery signal for nothing (R2 fix).
  // killAndWait clears the input-provenance fact, and only on a proven death:
  // a surviving pane's box is still real.
  if (node?.kind === 'terminal') {
    const [survivor] = await endTerminals([id], 'terminal removed')
    if (survivor) return { ok: false, error: survivor.error }
  }
  try {
    // Everything below only once the process is gone: a card that keeps a
    // survivor keeps its door, its route and its lease.
    // A removed remote card forgets its door; a re-import signs in afresh.
    doorTranscripts.delete(id)
    doorWatch.forget(id)
    // "END THIS SESSION" means at the door, too. The card is the caller's only
    // handle on a session running at someone else's app; closing it without
    // telling the door left that session — its workspace, its agents — running
    // there for nobody. Best effort and off the critical path: the card goes
    // whatever the door says, and a door that cannot be reached is logged.
    if (node?.kind === 'terminal' && node.servedSession) void endSessionAtDoor(node)
    defaultProducerLease().forgetTerminal(id)
    routeService.forget(id)
    browserThumbs.forget(id)
    const browserStopped = node?.kind === 'browser'
      ? browserManager.discard(id)
      : browserManager.remove(id)
    store.withOpContext(opContext, () => store.removeNodeAcross(id))
    agents.deactivate(id)
    await browserStopped
    return { ok: true }
  } finally {
    closingTerminals.delete(id)
  }
}

/** Fork an agent from one of its turns — shared by IPC, CLI and mobile. */
function forkTerminal(sourceId: string, turnIndex?: number): TerminalNodeData {
  return forkTerminalOp({ store, ptys, turns, spawnTerminal: spawnTracked }, sourceId, turnIndex)
}

interface CreateTerminalOpts {
  name: string
  preset: string
  position?: { x: number; y: number }
  orch?: boolean
  /** Work here instead of the focused canvas's directory (a chore card in ~/.cookrew/chores). */
  cwd?: string
  /** Boot a fresh agent from a saved role instead of a bare preset. */
  roleName?: string
  /**
   * Its first prompt, submitted once the agent's TUI is quiet (the global
   * prompt box makes an agent from a prompt; owner, 2026-11-01).
   */
  prompt?: string
  /**
   * `name` is a stand-in read off `prompt` (the global prompt box): Sous names
   * the card properly once it answers, unless it was renamed meanwhile.
   */
  autoName?: boolean
  /**
   * The model and effort a new agent starts on (the prompt box's tune chip,
   * owner 2026-11-01): launch flags, checked against the harness's offer
   * (shared/launch-tune). A role or a `command` keeps its own line. Unknown:
   * it arrives over IPC and HTTP, and launchCommand keeps only what it offers.
   */
  tune?: unknown
  /**
   * Run THIS instead of the preset's command. Used by a placed remote-orch
   * card, whose command is a line to someone else's orch, not a local harness.
   */
  command?: string
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
    // The catalogs are read only when a pick came with the ask: most terminals bring none.
    command:
      opts.command ??
      (role ? role.command : opts.tune === undefined ? preset.command : newAgentLaunch(preset.command, opts.tune).command),
    cwd: opts.cwd ?? store.focusedState.dir,
    orch: opts.orch ?? false,
    role: role ? role.name : null,
    ...(restoredSessionId ? { claudeSessionId: restoredSessionId } : {}),
    position: opts.position ?? { ...DEFAULT_CANVAS_POSITION },
    size: DEFAULT_TERMINAL_SIZE
  }
  // A pick from the one list carries its route (model-pick.ts); an older bare alias is routed as before.
  const pickedRoute = !role && opts.command === undefined && opts.tune !== undefined ? newAgentLaunch(preset.command, opts.tune).route : undefined
  const placed = pickedRoute !== undefined ? { ...terminal, route: pickedRoute } : opts.tune === undefined ? terminal : routedNewAgent(terminal)
  const added = store.addNode(placed)
  spawnTracked(added as TerminalNodeData)
  // A bare shell takes no first prompt: typed into zsh, the words would run as a command.
  const first = typeof opts.prompt === 'string' && terminal.command.trim() ? opts.prompt.trim() : ''
  const boot = [role ? buildRoleBootMessage(role.name, role.rolePrompt) : '', first].filter(Boolean).join('\n\n')
  if (boot) {
    const session = ptys.get(added.id)
    if (session) {
      injectWhenReady(session, boot).catch((error) => console.error('Boot prompt injection failed:', error))
    } else if (first) {
      noteInputLost(added.id)
    }
  }
  if (opts.autoName && first) {
    void autoNameTerminal(added.id, added.name, first).catch((error) => console.error('Naming the new agent failed:', error))
  }
  return added
}

// ---- team fork / save + roles (spec: team-fork-roles v1, Forge lane) ----

async function teamFork(spec: TeamForkSpec, options: { stay?: boolean } = {}): Promise<WorkspaceMeta> {
  const meta = await forkTeam(forkDepsFor(options), spec)
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
  // T4: the LEDGER copy is gone with the writer — a file-backed card's history
  // is derived from a transcript the paste does not move, so the new id reads
  // the same stream the old one did. What DOES have to move is the marks: they
  // are keyed by terminal id, and a title the owner wrote is not derivable from
  // anything. Without this a cut-and-paste silently strips every Sous title off
  // the card, which is exactly the loss this phase exists to prevent.
  const marks = copyMarks(from.id, to.id)
  if (marks.failed > 0) {
    console.error(`Pasted card ${to.id}: ${marks.failed} mark(s) could not be carried across`)
  }
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
  // A detached terminal reads as not-working — the paste carries
  // staleSource instead of blocking on a detector's guess.
  const activity = turns.listVerified().find((a) => a.terminalId === id)
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
  // (kill reaches sessions with no live PTY), not at the next
  // startup reap. Moved notes/browsers have nothing to tear down.
  // A cut MOVES the session, so the copy will resume the very file the source
  // is still appending to. An inactive workspace's agents are detached, not
  // dead, so they are ended here — before the paste, not after it. killAndWait
  // throws on a survivor rather than letting `new-session -A` reattach it.
  stopCut: async (nodeIds, fromWorkspaceId, intoWorkspaceId) => {
    const state = store.workspaceState(fromWorkspaceId)
    const targetDirs = store.list().workspaces.find((w) => w.id === intoWorkspaceId)?.dirs ?? []
    // All of them before any kill, and where the paste will boot them, which is
    // the target's folder unless it also lists theirs. A card with no process
    // has nothing to lose, so it goes and its new card says what it needs.
    for (const node of state.nodes) {
      if (node.kind !== 'terminal' || !nodeIds.includes(node.id)) continue
      if (!ptys.get(node.id) && panePresence(node.id) === false) continue
      const block = bootBlockOf({ id: node.id, command: node.command, cwd: resolveTargetDir(node.cwd, undefined, targetDirs) })
      if (block) throw new Error(`"${node.name}" was not moved: ${block.why} It was left running.`)
    }
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

/**
 * A fork a phone asked for boots where it stands: the phone takes its own seat
 * on the new workspace, and the desktop stays on what it was showing.
 */
function forkDepsFor(options: { stay?: boolean }): Parameters<typeof forkTeam>[0] {
  if (!options.stay) return teamForkDeps()
  return {
    ...teamForkDeps(),
    bootTerminals: (id) => {
      bootWorkspaceInPlace(
        {
          nodesOf: (wid) => callNodesOf(wid),
          boot: (node) => bootTerminal(node as TerminalNodeData),
          onError: (node, error) => console.error(`boot failed for ${node.id}:`, error)
        },
        id
      )
    }
  }
}

/**
 * FEATURE 1: workspace pre-populated from a saved team template. Routes
 * through the team-fork engine (native session restore included), so the
 * workspace.created event carries the 'team fork' detail.
 */
async function createWorkspaceFromTeam(
  name: string,
  dir: string,
  team: string,
  options: { stay?: boolean } = {}
): Promise<WorkspaceMeta> {
  const verdict = workspaceCheck(store, name, dir)
  if (!verdict.ok) throw new Error(verdict.reason)
  return workspaceFromTemplate(forkDepsFor(options), { name, dir: verdict.dir, team })
}

/**
 * IMPORT a template as a SESSION: a new workspace holding one terminal — the
 * entry orchestrator — that reaches the served crew over HTTP. The team runs on
 * the owner's side; the caller talks to the one door. See import-session.ts.
 *
 * `target` is the served origin+slug. With no target (a LOCAL import, the
 * fixture path) the orch still points at 127.0.0.1's own listener, so the flow
 * is exercisable end to end before any public relay exists.
 */
function orchMirrorScript(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'orch-mirror.mjs')
    : path.join(dirname, '../../resources/orch-mirror.mjs')
}

/** The remote-import card's transport, resolved for dev and packaged. */
/**
 * THE CALLER'S SIDE OF IMPORTING A SERVED TEAM — one set of operations,
 * reached from the desktop over IPC and from the phone over the mobile API.
 *
 * The phone used to be refused ("served teams can only be imported from the
 * desktop app") on the reasoning that a phone has no terminal to place. It
 * never needed one: the card is placed and spawned HERE, at the desktop, and
 * the phone is a remote view of this canvas — placing a preset from the phone
 * already works that way. The refusal was a missing route, not a rule.
 *
 * Every Bearer and every key stays in this process either way.
 */
const serveOps = {
  inspect: (link: string) => inspectServeAddress(link),
  browse: async (link: string) => {
    const account = parseAccountAddress(link)
    if (!account) return { ok: false as const, reason: 'bad-address' as const }
    try {
      const found = await fetch(new URL(`/v1/doors/@${account.handle}`, account.origin), {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000)
      })
      if (!found.ok) return { ok: false as const, reason: 'not-serving' as const }
      const body = (await found.json()) as { doors?: unknown }
      const doors = Array.isArray(body.doors) ? body.doors : []
      return {
        ok: true as const,
        handle: account.handle,
        teams: doors.map(publicTeam).filter((t): t is BrowsedTeam => t !== null)
      }
    } catch {
      return { ok: false as const, reason: 'unreachable' as const }
    }
  },
  /**
   * THE GATE — which walk, and what the door said (identity v3, G1/G3).
   *
   * One decision splits it, `gateDoorFor`: a LISTED team (a published name the
   * directory answers for) is entered as the ACCOUNT — cookrew.dev mints a
   * call token for this Mac's session and the door seats `acct-<username>`,
   * the same person the web seated, so a seat bought there admits here with
   * no second payment. With no account on this Mac the answer is the
   * `identify` phase and the sheet opens the account sheet in place. The
   * caller key is offered at UNLISTED doors only — the DIRECT walk — because
   * a key-holder sub can never be the person a seat names. The phone's gate
   * verb (mobile-api /api/serve/gate) runs this same function.
   */
  gate: async (link: string) => {
    const target = parseServeAddress(link)
    if (!target) return { ok: false as const, reason: 'bad-address' as const }
    try {
      const reached = await reachable(target)
      if (!reached) return { ok: false as const, reason: 'sign-in' as const, detail: 'not serving' }
      const at = reached.at
      const door = gateDoorFor(target, reached)
      if (door === 'direct') {
        const token = await signInToDoor(at)
        callerTokens.set(targetKey(target), token)
        const phase = await openAdmission(at, token)
        return { ok: true as const, door, phase, wallet: deviceWallet() }
      }
      const team = target.door as string
      const admitted = await admitWithAccount(at, team, accounts)
      if (admitted.token !== null) callerTokens.set(targetKey(target), admitted.token)
      return {
        ok: true as const,
        door,
        phase: admitted.phase,
        wallet: deviceWallet(),
        // The facts the sheet's sentences name: the team, who can say yes,
        // and who this Mac is (the usual cause of a no_seat is being signed
        // in as somebody else).
        team,
        owner: doorOwnerOf(team),
        account: admitted.account,
        seat: admitted.seat
      }
    } catch (error) {
      return {
        ok: false as const,
        reason: 'sign-in' as const,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  },
  checkout: async (link: string) => {
    const target = parseServeAddress(link)
    const token = target ? callerTokens.get(targetKey(target)) : undefined
    if (!target || !token) return { ok: false as const, reason: 'not-signed-in' as const }
    try {
      const reached = await reachable(target)
      if (!reached) return { ok: false as const, reason: 'unavailable' as const }
      const checkout = await startStripeCheckout(reached.at, token)
      // The URL comes back too: a hand-off that silently failed to raise a
      // browser would otherwise leave the person waiting on a page they never
      // saw, with no way to reach it. It is a capability — the sheet keeps it
      // to re-open, and never prints it.
      return { ok: true as const, session: checkout.session, url: checkout.url }
    } catch (error) {
      return {
        ok: false as const,
        reason: 'unavailable' as const,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  },
  settle: async (link: string, rail: 'x402' | 'stripe', session?: string) => {
      const target = parseServeAddress(link)
      const token = target ? callerTokens.get(targetKey(target)) : undefined
      if (!target || !token) return { ok: false as const, reason: 'not-signed-in' as const }
      try {
        const reached = await reachable(target)
        if (!reached) return { ok: false as const, reason: 'refused' as const }
        const at = reached.at
        let payment: string
        if (rail === 'stripe') {
          if (!session) return { ok: false as const, reason: 'no-session' as const }
          payment = stripePaymentHeader(session)
        } else {
          const quoted = await openAdmission(at, token)
          const terms =
            quoted.kind === 'pay'
              ? quoted.rails.find((entry) => entry.rail === 'x402')
              : undefined
          if (!terms || terms.rail !== 'x402') {
            // Already open, or this door stopped quoting USDC. Either way there
            // is nothing to sign, and signing a stale quote is money gone.
            return { ok: true as const, phase: quoted }
          }
          payment = await buildX402Payment(terms.requirements)
        }
        return { ok: true as const, phase: await openAdmission(at, token, payment) }
      } catch (error) {
        return {
          ok: false as const,
          reason: 'refused' as const,
          detail: error instanceof Error ? error.message : String(error)
        }
      }
  },
  import: async (
    link: string,
    position?: { x: number; y: number },
    paid?: { price: string; asset: string; rail: 'x402' | 'stripe' }
  ) => {
      const inspected = await inspectServeAddress(link)
      if (!inspected.ok) return inspected
      const node = orchTerminalNode(
        inspected.face,
        inspected.target,
        orchLineScript(),
        randomUUID(),
        store.focusedState.dir,
        position ?? { x: 160, y: 120 },
        // The receipt, taken at the moment of admission — not re-derived
        // later, when the door may be quoting a different price.
        { openedAt: Date.now(), ...(paid ? { paid } : {}) }
      )
      const placed = store.addNode(node)
      /**
       * PLACING IS THE COMMITMENT; booting the terminal is not.
       *
       * A throw here used to reject the whole call, so the sheet showed a raw
       * internal error — no herdr pane labelled … ensureSession first — while
       * the card sat on the canvas anyway. The person was told it failed and
       * given the thing at the same time, which is the worst of both.
       *
       * The card is placed. If its terminal could not start this second it
       * starts when the card is opened, like every other card that boots late.
       */
      try {
        spawnTracked(placed as TerminalNodeData)
      } catch (error) {
        console.error(`import: ${inspected.face.name} was placed but did not boot: ${String(error)}`)
      }
      store.recordEvent('session.imported', inspected.face.name, inspected.face.door, link.trim())
      return { ok: true as const, node: placed }
  }
}

function orchLineScript(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'orch-line.mjs')
    : path.join(dirname, '../../resources/orch-line.mjs')
}

/** A public face is small; anything larger is not a face we should parse. */
const MAX_FACE_BYTES = 64 * 1024

/**
 * Bearers held for doors this app has signed in to, while an import is being
 * decided. MAIN-ONLY BY CONSTRUCTION: the gate sheet drives the ceremony over
 * IPC by naming the door, never by holding its credential, so a renderer bug
 * cannot leak one. Keyed by origin+slug; a token outlives the sheet only until
 * the app quits (they expire on their own at the door).
 */
const callerTokens = new Map<string, string>()

/**
 * One key per door, and NOT its wire address.
 *
 * A relayed door is reached through a loopback port that changes with every
 * restart, so keying a token by where it was reached would lose it the moment
 * the app came back. A published name is the durable identity; a dialled
 * door's address is its own.
 */
function targetKey(target: ServeTarget): string {
  return target.door ?? `${target.origin}/${target.slug}`
}

/** One team, as a directory listing describes it. Validated, like any face. */
interface BrowsedTeam {
  title: string
  door: string
  agents: number
  access: 'account' | 'paid'
  priceUsd?: string
  live: boolean
  /** The address to import — built here so the sheet never assembles one. */
  link: string
}

/**
 * A directory entry, validated before anything renders it.
 *
 * This is a stranger's registry answering over the network, so it is treated
 * exactly like a door's face: a known shape, bounded, or nothing.
 */
function publicTeam(value: unknown): BrowsedTeam | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const title = safeFaceName(raw.title)
  const door = safeFaceName(raw.door)
  const handle = typeof raw.handle === 'string' ? raw.handle : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (title === null || door === null || !handle || !name) return null
  if (raw.access !== 'account' && raw.access !== 'paid') return null
  const priceUsd = typeof raw.priceUsd === 'string' ? raw.priceUsd.slice(0, 32) : undefined
  return {
    title,
    door,
    agents: Number.isFinite(raw.agents) ? (raw.agents as number) : 0,
    access: raw.access,
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    live: raw.live !== false,
    link: `@${handle}/${name}`
  }
}

/**
 * ONE PROXY for every relayed door this app is reaching.
 *
 * Started the first time one is needed rather than at boot: a caller who never
 * imports a relayed team never has a listener they did not ask for.
 */
let callerProxy: RelayProxy | null = null
/**
 * The one in-flight start, so two callers cannot each begin one.
 *
 * A boot-time start and a first import raced: both saw `callerProxy` null,
 * both started a listener, and both wrote the file a card reads its port from.
 * Whichever lost still held a socket, and the first call through the loser
 * failed with nothing in any log to say why. A promise is the whole fix —
 * everybody waits on the same start.
 */
let callerProxyStarting: Promise<RelayProxy> | null = null

function relayProxy(): Promise<RelayProxy> {
  if (callerProxy) return Promise.resolve(callerProxy)
  if (!callerProxyStarting) {
    callerProxyStarting = startRelayProxy({
      log: (message) => console.error(message),
      // A card placed months ago starts with nothing in memory. This is how it
      // finds its door again without being imported a second time.
      resolve: resolveDoor,
      /**
       * THE CARD'S OWN LINE, ON THE ACCOUNT (v3-04c). The third caller of a
       * listed door is `orch-line.mjs`, in the card's PTY — a separate process
       * that cannot mint a call token because minting needs this Mac's
       * cookrew.dev session. So it asks here, and the answer comes from the
       * SAME `doorBearer` the transcript and END use: one function, one rule
       * about listed versus direct, one caller at the door.
       *
       * The target is the proxy's own loopback end, which is where a listed
       * door is always reached — exactly as `doorTranscriptFor` addresses it.
       */
      bearer: async (name) => {
        const port = (await relayProxy()).port
        return doorBearer(doorPort, { origin: `http://127.0.0.1:${port}`, slug: name }, name)
      },
      account: () => accounts.account()?.username ?? null
    }).then((proxy) => {
      callerProxy = proxy
      return proxy
    })
  }
  return callerProxyStarting
}

/**
 * Where to actually send a request for this target.
 *
 * A dialled door is its own address. A RELAYED door is a name, so the door
 * record is fetched from the directory it names — for its seal key, which the
 * caller pins from this moment on — and the request goes to the loopback end
 * of the relay instead.
 */
async function reachable(
  target: ServeTarget
): Promise<{ at: ServeTarget; listed: boolean; live: boolean } | null> {
  if (!target.door) return { at: target, listed: false, live: true }
  try {
    const found = await fetch(new URL(`/v1/doors/${target.door}`, target.origin), {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000)
    })
    if (!found.ok) return null
    const record = (await found.json()) as {
      sealKey?: unknown
      transport?: unknown
      live?: unknown
    }
    // No key means nothing to pin, and an unpinned relayed door is one the
    // relay could stand in the middle of. Refused rather than reached.
    if (typeof record.sealKey !== 'string' || record.transport !== 'relay') return null
    const proxy = await relayProxy()
    // Which directory this door came from, kept — a name alone does not say,
    // and guessing would look a team up on a registry it was never on.
    rememberDoor(target.door, target.origin)
    proxy.serve({ name: target.door, key: record.sealKey, relayOrigin: target.origin })
    // The SAME shape as a dialled door, so everything downstream — the
    // sign-in, the 402, the settle — is unchanged and unaware.
    return {
      at: { origin: `http://127.0.0.1:${proxy.port}`, slug: target.door, door: target.door },
      listed: true,
      live: record.live !== false
    }
  } catch {
    return null
  }
}

/**
 * Read a served door's public face — what the owner chose to publish.
 *
 * Hostile until proven otherwise: this fetches an address a user pasted, from
 * the MAIN process, and what comes back becomes a card's command. So the
 * request does not follow redirects (a public-looking address must not bounce
 * the probe onto loopback), is time- and size-bounded, and the body is
 * validated into a known shape before any consumer sees it.
 */
async function inspectServeAddress(
  link: string
): Promise<
  | { ok: true; target: ServeTarget; face: ImportFace }
  | {
      ok: false
      reason: 'bad-address' | 'not-serving' | 'unreachable' | 'offline' | 'flaky'
    }
> {
  const target = parseServeAddress(link)
  if (!target) return { ok: false, reason: 'bad-address' }
  /**
   * WHAT WE ALREADY KNOW when the face fetch fails.
   *
   * A door we just read a record for is not an address that might not exist,
   * and it is certainly not evidence that the person's own app is down. Held
   * out here so the catch can say something true instead of the worst guess.
   */
  let known: { listed: boolean; live: boolean } = { listed: false, live: false }
  try {
    const reached = await reachable(target)
    if (!reached) return { ok: false, reason: 'not-serving' }
    const { at, listed, live } = reached
    known = { listed, live }
    // LISTED BUT NOT THERE is its own answer. A team whose record exists and
    // whose author's machine is simply shut is not a wrong address, and being
    // told "nobody is serving a team at that address" sends a person off to
    // check a link that was right all along.
    if (listed && !live) return { ok: false, reason: 'offline' }
    const res = await fetch(`${at.origin}/${at.slug}/crew`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return { ok: false, reason: failedButKnown(known) }
    const body = await res.arrayBuffer()
    if (body.byteLength > MAX_FACE_BYTES) return { ok: false, reason: 'not-serving' }
    const face = validateFace(JSON.parse(new TextDecoder().decode(body)))
    if (face === null) return { ok: false, reason: 'not-serving' }
    return { ok: true, target, face }
  } catch {
    // The SAME judgement as above. Thrown or refused, the question is what we
    // knew before we asked — not which line of ours noticed.
    return { ok: false, reason: known.listed ? failedButKnown(known) : 'unreachable' }
  }
}

/**
 * A door we know exists did not answer. Which is it?
 *
 * `flaky` matters because the alternative sentence blames the reader's own
 * machine for a team the app had just been told was live, which is the most
 * damaging thing this flow can say: a correct address, a working setup, and a
 * message sending them to check both.
 */
function failedButKnown(known: { listed: boolean; live: boolean }): 'offline' | 'flaky' | 'not-serving' {
  if (!known.listed) return 'not-serving'
  return known.live ? 'flaky' : 'offline'
}

async function importTemplateAsSession(
  team: string,
  position?: { x: number; y: number }
): Promise<WorkspaceMeta> {
  const snapshot = teams.load(team)
  if (!snapshot) throw new Error(`No saved template '${team}' to import`)
  const callerWs = store.focusedId

  // REQ 1 — a REAL session: a new workspace forked from the template, the team
  // booted from its saved sessions, WITH A GIT WORKTREE per repo dir.
  // workspaceFromTemplate hardcodes worktree:false (the "no worktree" bug), so
  // import forks directly with worktree enabled. forkTeam switches to it.
  const dir = snapshot.dir || store.focusedState.dir
  const meta = await forkTeam(teamForkDeps(), {
    name: `${snapshot.name} · session`,
    nodeIds: [],
    choices: [],
    fromSavedTeam: team,
    dirs: dir.length > 0 ? [dir] : undefined,
    worktree: true
  })
  // VERSION PIN — the rail says which template edition this session runs.
  const sessionNodes = store.workspaceState(meta.id).nodes
  cutTemplatePins(sessionNodes.filter((n) => n.kind === 'terminal').map((n) => n.id))

  // REQ 2 — the PROXY. Find the session's entry orchestrator and place a proxy
  // terminal back in the CALLER's workspace that mirrors it over the SAME mobile
  // API the phone uses (resources/orch-mirror.mjs: GET /turns, POST /input). So
  // the caller talks to the orch from their own canvas; the crew runs in the
  // session with its worktree.
  const entryName = entryAgentOf(snapshot)
  const orch = sessionNodes.find(
    (n): n is TerminalNodeData => n.kind === 'terminal' && n.name === entryName
  )
  store.switchWorkspace(callerWs)
  if (orch) {
    const proxy: TerminalNodeData = {
      kind: 'terminal',
      id: randomUUID(),
      name: `${snapshot.name} ▸ ${orch.name}`,
      preset: 'Shell',
      // No env-var prefix: a pane may exec argv without a shell, so the script
      // sets TLS trust itself and takes the origin as a flag.
      command:
        `node ${orchMirrorScript()} ${orch.id} ` +
        `--origin https://127.0.0.1:${MOBILE_HTTPS_PORT} --name ${JSON.stringify(orch.name)}`,
      cwd: store.focusedState.dir,
      orch: false,
      role: null,
      position: position ?? { x: 160, y: 120 },
      size: DEFAULT_TERMINAL_SIZE
    }
    const placed = store.addNode(proxy)
    spawnTracked(placed as TerminalNodeData)
    store.recordEvent('session.imported', meta.name, orch.name, `proxy → ${orch.id}`)
  }
  return meta
}

function teamSaveTracked(name?: string, nodeIds?: string[]): TeamMeta {
  const meta = teamSaveInner(name, nodeIds)
  store.recordEvent('team.saved', meta.name, meta.name, `${meta.terminalCount} agents`)
  // A saved template IS a version — so SAVE cuts a version pin on every agent
  // it snapshotted, at that agent's current checkpoint. Without this the save
  // was invisible: the template existed but no rail marker said "this is V1",
  // so nothing on the canvas changed and the author could not see what they
  // saved. The pin is per-terminal because the rail is per-terminal, and it is
  // the same cut call the fork/import paths use, so the marker is identical.
  cutTemplatePins(nodeIds)
  return meta
}

/**
 * Cut a version pin on each saved agent's rail at its latest checkpoint.
 * Silent per-terminal: an agent with no completed turn has nothing to pin, and
 * a failed cut on one agent must not sink the save of the rest.
 */
function cutTemplatePins(nodeIds?: string[]): void {
  const saved = store
    .terminals()
    .filter((t) => !nodeIds || nodeIds.includes(t.id))
  for (const term of saved) {
    try {
      const history = turns.history(term.id)
      if (history.length === 0) continue
      const atIndex = history[history.length - 1].index
      const pin = cutVersionPin(pinStore.list(term.id), {
        atIndex,
        // The latest record's uuid — identical in ledger and file space, so
        // the pin anchors compaction-proof (checkpoint-session-alignment).
        atUuid: history[history.length - 1].uuid,
        scrollLine: ptys.get(term.id)?.paneScrollState().historySize ?? 0,
        cutAt: Date.now()
      })
      pinStore.add(term.id, pin)
    } catch (error) {
      console.error(`template save: could not pin ${term.id}:`, error)
    }
  }
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
  return injectWindowInput(mainWindow.webContents, args)
}

/**
 * The canvas pictures the screen wall draws. Its capturer is the main window,
 * injected so the store itself never imports Electron and can be tested.
 */
const workspaceShots = new WorkspaceShots({
  capturer: {
    capture: async (rect) => {
      if (!mainWindow || mainWindow.webContents.isDestroyed()) throw new Error('no window')
      return mainWindow.webContents.capturePage(rect)
    }
  }
})

/**
 * Every workspace's picture, for the desktop wall (IPC) and the phone's
 * (GET /api/workspaces/shots) alike. Swept here rather than on a timer: a wall
 * opening is the only moment anything reads these, so it is the only moment
 * a stale one costs.
 */
function currentWorkspaceShots(): Record<string, { src: string; at: number }> {
  workspaceShots.sweep(store.list().workspaces.map((w) => w.id))
  return workspaceShots.all()
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
    interactiveBrowserEnabled() && !showsThisMachine(browserId)
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

/** Decided once per launch: on by default where a Chrome is installed (launch-defaults.ts). */
let interactiveBrowserDecision: boolean | null = null
const interactiveBrowserEnabled = (): boolean => {
  interactiveBrowserDecision ??= interactiveBrowserDefault(process.env, () => findChrome() !== null)
  return interactiveBrowserDecision
}
const desktopBrowserStreamToken = randomUUID()

/**
 * A browser card wherever it lives — the canvas on screen first (the cheap
 * common case), then every other workspace. The headless page of a card in a
 * workspace nobody is looking at keeps running (owner ruling 2026-11-04), so
 * its viewers, page state and opened tabs must still find their card.
 */
function activeBrowserNode(browserId: string): BrowserNodeData | null {
  const node = store.node(browserId) ?? store.nodeAcrossWorkspaces(browserId)?.node
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
  // Chrome's private failure document is an implementation detail, not the
  // address the user or agent requested. Persisting it makes a later sync try
  // to navigate to chrome-error:// explicitly.
  if (isChromiumErrorPage(state.url)) return
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

/** Application Support half of a headless browser profile. */
const browserProfileRoot = (): string =>
  path.join(app.getPath('userData'), 'interactive-browser')

/**
 * Caches half of the same profile — `~/Library/Caches/<app>/interactive-browser`
 * on macOS, where Chrome splits a user-data-dir in two.
 *
 * Derived as the sibling of appData (Electron's path list has no 'cache' key)
 * and keyed by userData's own basename, because the app NAME differs in case
 * from the directory on disk. Anywhere the profile is not split this resolves
 * to a path that does not exist, and every caller reads that as nothing to do.
 */
const browserCacheRoot = (): string =>
  path.join(
    path.dirname(app.getPath('appData')),
    'Caches',
    path.basename(app.getPath('userData')),
    'interactive-browser'
  )

// C-2 ownership: one headless process/profile per active browser node. Cast
// viewers and trusted agent commands both resolve through this manager.
// THE USES (use-instances.ts): a Mac display or window, an adb phone, a
// camera — each a browser card the cast streams and the agent drives.
// Driving THIS Mac from a viewer or an agent is a decision, never a default:
// the remote desk holds it, and everything below asks.
const sessionReader = createSessionReader({
  read: () => (process.platform === 'darwin' ? readMacSession() : linuxSession(process.env, commandRun))
})
// Fixed for the life of this process, and read once: it is a helper process.
let listedApp: string | null = null
if (process.platform === 'darwin') {
  void readMacListedApp().then((bundle) => {
    listedApp = bundle
  })
}
let heldUnlockKey: SealKeyPair | null = null
const unlockKey = (): SealKeyPair => (heldUnlockKey ??= loadUnlockKey(path.join(homedir(), '.cookrew', 'unlock-key.json')))
function currentBuild(): RemoteBuild {
  return remoteBuild({
    execPath: process.execPath,
    packaged: app.isPackaged,
    persists: multiplexer()?.capabilities.persistsAcrossRestart === true,
    servedLive: servedSpawnContexts.size > 0,
    listedApp
  })
}
let keepAwakeId: number | null = null
const remoteDesk = createRemoteDesk({
  platform: process.platform,
  build: currentBuild,
  linuxRefusal: () => linuxScreenRefusal(process.env),
  screenAccess: () => systemPreferences.getMediaAccessStatus('screen'),
  accessibility: () => process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false),
  session: () => sessionReader.read(),
  settings: remoteSettingsFile(path.join(homedir(), '.cookrew', 'remote-control.json')),
  servedWorkspace,
  workspaceOfCard: (card) => store.nodeAcrossWorkspaces(card)?.workspaceId ?? null,
  cardName: (card) => store.nodeAcrossWorkspaces(card)?.node.name ?? card,
  record: (type, card, name, details) => store.recordEvent(type, card, name, details),
  keepAwake: {
    start: () => {
      keepAwakeId ??= powerSaveBlocker.start('prevent-display-sleep')
    },
    stop: () => {
      if (keepAwakeId !== null) powerSaveBlocker.stop(keepAwakeId)
      keepAwakeId = null
    }
  },
  host: (view) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('use:remote-host', view)
    remoteTray.show(view)
  },
  refreshCards: () => useInstances.refresh(),
  dropViewers: (cards) => {
    for (const card of cards) browserCast.drop(card)
  },
  openSettings: async (pane) => useInstances.sources()?.openSettings(pane),
  relaunch: () => {
    app.relaunch()
    app.quit()
  },
  unlockWords: () => {
    const key = unlockKey().publicKey
    return fingerprintOfDigest(new Uint8Array(createHash('sha256').update(Buffer.from(key, 'base64url')).digest())).words
  },
  wakeDisplay: async () => {
    await (process.platform === 'darwin' ? commandRun('/usr/bin/caffeinate', ['-u', '-t', '2']) : commandRun('xset', ['dpms', 'force', 'on']))
  }
})
const unlockDoor = createUnlockDoor({
  keyPair: unlockKey,
  refusal: (who) => remoteDesk.unlockRefusal(who),
  locked: async () => {
    sessionReader.invalidate()
    return (await sessionReader.read()).locked
  },
  wake: async () => {
    await commandRun('/usr/bin/caffeinate', ['-u', '-t', '2']).catch(() => undefined)
  },
  type: (password) => useInstances.typeAtLock(password),
  record: (outcome, who) => store.recordEvent('remote.unlock', 'machine', 'this Mac', `${who.name}: ${outcome}`)
})
const remoteTray = createRemoteTray(() => remoteDesk.stopAll(), process.platform)
/** Who a paired credential is: an admitted phone by its own name, the global token by what it can only be. */
function viewerWho(credential: string | null): ViewerWho {
  const id = credential ? admittedDevices.deviceFor(credential) : null
  if (id === null) return { key: 'root', name: 'A paired device', here: false }
  return { key: `device:${id}`, name: admittedDevices.list().find((device) => device.deviceId === id)?.name ?? 'A paired phone', here: false }
}
const useInstances = createUseInstances({
  captureDir: path.join(app.getPath('userData'), 'use-capture'),
  remote: (card) => remoteGate(remoteDesk, card),
  blocked: () => remoteDesk.blocked(),
  onBlocked: (card) => browserThumbs.forget(card)
})
/**
 * A card showing this machine's own screen. Its picture is shown to a viewer
 * the host can see and nobody else: a thumbnail has no name, no banner and no
 * Stop, so neither the wall nor the phone's grid gets one, and a watch gets no frame.
 */
const showsThisMachine = (card: string): boolean => {
  const node = store.nodeAcrossWorkspaces(card)?.node
  return node?.kind === 'browser' && parseUseUrl(activeBrowserTab(node).url)?.use === 'computer'
}
const useSignals = new UseSignalBus()
useSignals.on((signal) => {
  mainWindow?.webContents.send('use:signal', signal)
  if (signal.use === 'computer') remoteDesk.noteAgent(signal.card, store.nodeAcrossWorkspaces(signal.agent)?.node.name ?? 'An agent', signal.verb)
})

const browserManager = new HeadlessBrowserManager({
  enabled: interactiveBrowserEnabled,
  chromePath: findChrome,
  profileRoot: browserProfileRoot,
  // Chromium's own layout keeps downloaded components at INSTALLATION scope,
  // beside the profiles rather than inside each one. Cookrew gives every card a
  // whole user-data-dir, so without this every card downloads its own copy.
  sharedInstallationRoot: () => path.join(app.getPath('userData'), 'browser-shared'),
  deleteProfile: (browserId) => {
    // BOTH halves. macOS Chrome splits a profile across Application Support and
    // Caches; removing one left 110 orphaned cache directories behind.
    removeBrowserProfile(browserProfileRoot(), browserId)
    removeBrowserProfile(browserCacheRoot(), browserId)
  },
  resolveNode: activeBrowserNode,
  onPageState: recordHeadlessPageState,
  onTabOpened: recordHeadlessTabOpened,
  onTabClosed: recordHeadlessTabClosed,
  // A `vphone://<machine>` card is a vphone-cli guest on this Mac, reached
  // through the machine's own socket under ~/.vphone/machines (or
  // VPHONE_LIBRARY). The VM is the user's: never launched or stopped here.
  vphone: {
    makeInstance: (machine) =>
      new VphoneInstance({ machine, guest: createSocketGuest(vphoneSocketPath(machine), { machine }) })
  },
  uses: { makeInstance: (target, node) => useInstances.makeInstance(target, node) },
  // Declared below; called only after boot, never during construction.
  onInstanceGone: (browserId) => {
    remoteDesk.cardGone(browserId)
    browserCast.drop(browserId)
    browserCastIpc.drop(browserId)
  }
})

/**
 * The desktop's own view of a card's Chrome: a MessagePort from main, raw
 * JPEG bytes, no socket and no token (browser-cast-ipc.ts). The phone keeps
 * the WebSocket below.
 */
const browserCastIpc = createBrowserCastIpc({
  getInstance: (browserId) => browserManager.get(browserId),
  enabled: interactiveBrowserEnabled
})

/** The wrist's credential (watch-pairing.ts): module scope, because rotating every session ends it too. */
const watchPairing = new WatchPairing()

const browserCast = createBrowserCast({
  getInstance: (browserId) => browserManager.get(browserId),
  enabled: interactiveBrowserEnabled,
  desktopToken: () => desktopBrowserStreamToken,
  // REACH v2.1 — the companion at cookrew.dev keeps its address while its data
  // plane moves onto this Mac's own name, so its Origin is the registry's.
  // Same-host alone would refuse it and the browser card would never stream
  // over the fast path. Exact origins only; see companion-cors.ts.
  allowedOrigins: () => allowedCompanionOrigins(registryOrigin()),
  // AND THE ORIGIN ONLY FILTERS — this is what authenticates the socket. The
  // global pairing token or an admitted phone's own companion token, compared
  // by the same code as every HTTP route (mobile-http.ts · tokenAccepted).
  // The TV wall's read-only token is deliberately NOT accepted: this socket
  // carries pointer and key INPUT, so admitting a read-only credential here
  // would hand it a write it does not have anywhere else.
  paired: (credential) => companionTokenAccepted(credential, (one) => admittedDevices.deviceFor(one)),
  who: viewerWho
})

const headlessBrowserCommands = new HeadlessBrowserCommandEngine({
  store,
  manager: browserManager,
  addNode: (node, workspaceId) => addNode(node, workspaceId),
  updateNode,
  connectNodes: (aId, bId) => void store.connectAcross(aId, bId),
  // The caller's own workspace, whatever the window shows (browser-reach.ts).
  resolveBrowser: (name, terminalId) =>
    browserForCaller(store, terminalId, name, ptys.isServed(terminalId) || servedSpawnContexts.has(store.ownerOf(terminalId) ?? ''))?.node,
  homeOf: (terminalId) => store.ownerOf(terminalId),
  onUse: (signal) => void useSignals.emit(signal),
  shotsDir: path.join(app.getPath('userData'), 'use-shots')
})

/** A caller's session runs here: the use surfaces are refused (use-source-service.ts). */
function servedWorkspace(workspaceId: string): boolean {
  if (servedSpawnContexts.has(workspaceId)) return true
  return store.workspaceState(workspaceId).nodes.some((node) => node.kind === 'terminal' && ptys.isServed(node.id))
}

// THE WINDOW PICKER: the sheet's one service, over IPC here and HTTP for the phone.
const useSources = createUseSourceService({
  provider: () => useInstances.sources(),
  servedWorkspace,
  desk: remoteDesk,
  unlock: unlockDoor,
  who: viewerWho,
  cardAt: (workspaceId, url) =>
    store.workspaceState(workspaceId).nodes.find((node): node is BrowserNodeData => node.kind === 'browser' && activeBrowserTab(node).url === url) ?? null,
  addCard: (workspaceId, card) => addNode(card, workspaceId) as BrowserNodeData,
  findCard: (id) => {
    const found = store.nodeAcrossWorkspaces(id)
    return found?.node.kind === 'browser' ? { workspaceId: found.workspaceId, node: found.node } : null
  },
  readdress: async (node, url, name) => {
    // updateNode syncs the card, and the manager swaps its device (backingOf).
    updateNode(node.id, { url, tabs: withActiveUrl(node, url).tabs })
    renameCardIn(renameDeps, node.id, name, 'suffix', false)
    const updated = store.nodeAcrossWorkspaces(node.id)?.node
    return updated?.kind === 'browser' ? updated : node
  }
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

/**
 * A browser card made in a workspace that is not on screen (an agent's own,
 * while the owner looks elsewhere). No engine is booted — the page runs when
 * that workspace is shown — and the card is wired to its caller the same way
 * the on-screen path wires it, so `cookrew list --workspace` sees it there.
 */
function createBrowserInWorkspace(card: { url: string; name: string; terminalId: string; workspaceId: string }): {
  name: string
  adopted: boolean
} {
  const state = store.workspaceState(card.workspaceId)
  const existing = state.nodes.find(
    (n): n is BrowserNodeData => n.kind === 'browser' && n.name.toLowerCase() === card.name.toLowerCase()
  )
  if (existing) {
    if (!store.connectedTo(card.terminalId).some((n) => n.id === existing.id)) store.connect(card.terminalId, existing.id)
    return { name: existing.name, adopted: true }
  }
  const anchor = store.node(card.terminalId)
  const tab: BrowserTab = { id: randomUUID(), url: card.url, title: '' }
  const node: BrowserNodeData = {
    kind: 'browser',
    id: randomUUID(),
    name: card.name,
    url: card.url,
    tabs: [tab],
    activeTabId: tab.id,
    position: { x: (anchor?.position.x ?? 0) + (anchor?.size.width ?? 640) + 80, y: anchor?.position.y ?? 0 },
    size: { width: 720, height: 560 }
  }
  const added = store.addNodeToWorkspace(card.workspaceId, node) as BrowserNodeData
  if (anchor) store.connect(card.terminalId, added.id)
  return { name: added.name, adopted: false }
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

  // Focus is presence, for the same reason a keystroke is. Without it, coming
  // back to a window left open for twenty minutes locks a second later.
  mainWindow.on('focus', () => ownerLock.focus())
  // And it is the moment the owner can actually answer a waiting device, so
  // the queue is re-read then rather than waiting out the poll (D6).
  mainWindow.on('focus', () => void requests.refresh())

  // The window holds the owner's bridge: a page only ever leaves it for the
  // browser. Followed in here it would inherit the preload (owner-grant.ts · isOwnerPage).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isOwnerPage(url, ownerPageUrl())) return
    event.preventDefault()
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(dirname, '../renderer/index.html'))
  }
  // A deep link waits for the renderer, not for the window: the subscriber
  // lives in App.tsx, which does not exist until the page has loaded.
  mainWindow.webContents.on('did-finish-load', () => deepLinks.ready())
  // The gateway's clock runs while the window lives: a card spawned after a
  // restart routes when the gateway is online and a default is set.
  const releaseRouteHold = routeService.hold()
  mainWindow.on('closed', () => {
    mainWindow = null
    // The capture host is a hidden window: left open, it would keep the app from quitting.
    useInstances.dispose()
    deepLinks.gone()
    releaseRouteHold()
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
} else {
  // Holding the lock, before `ready`: nothing has these caches open yet, and no
  // pane has been spawned that would name a gate not on disk.
  keepCachesOutOfIndex(app.getPath('userData'))
  if (!installTscGate()) console.error('[cookrew] could not write the tsc gate; panes run without it')
  // THE FIRST INSTANCE HEARS THE SECOND. On Windows and Linux a protocol link
  // launches a fresh process, which exits above — but not before the OS hands
  // its argv to the instance holding the lock, and that argv carries the link.
  app.on('second-instance', (_event, argv) => {
    focusMainWindow()
    if (argv.some((arg) => accounts.oauthReturn(arg))) return
    const link = deepLinkInArgv(argv)
    if (link) deepLinks.push(link)
  })
  // macOS hands a link to the running app as an event instead.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    acceptDeepLink(url)
    focusMainWindow()
  })
  registerDeepLinkScheme()
  // The link this very launch was started with, on the platforms that pass it
  // as an argument.
  const launchedWith = deepLinkInArgv(process.argv)
  if (launchedWith) deepLinks.push(launchedWith)
}

// See self-host-guard.ts. Same medicine as the single-instance lock above:
// launching from a Cookrew card hands this instance the identity of the session
// it is about to adopt, so it takes over its own launcher's pane and dies by
// SIGTERM a minute later with nothing in the log to explain it.
const selfHosted = selfHostedLaunch(process.env, HERDR_SESSION)
if (selfHosted) {
  console.error(selfHostRefusalMessage(selfHosted))
  app.exit(1)
}

/**
 * The CLI socket this process serves, if it owns the shared path at all
 * (socket-claim.ts). Released on quit, and only while the path is still ours.
 */
let cliSocket: SocketServerHandle | null = null

app.whenReady().then(() => {
  // Before anything reads a secret: a value still in the clear goes under the key.
  try {
    const moved = secrets.migrate()
    if (moved.sealed.length > 0) console.error(`[cookrew] secrets sealed: ${moved.sealed.join(', ')}`)
    if (moved.failed.length > 0) console.error(`[cookrew] secrets left as they were: ${moved.failed.join(', ')}`)
  } catch (error) {
    console.error('[cookrew] secrets could not be moved', error)
  }
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
  if (freshInstall) emit('installed')
  // The cards routed before this restart are still routed (their node data
  // says so); seed them, then one probe before the first card spawns.
  routeService.seedRouted()
  void routeService.refresh()
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

  // ANY SEAT SOMEBODY PAID FOR THAT cookrew.dev NEVER HEARD ABOUT. Deferred
  // rather than awaited: it is a network round trip per receipt and there is
  // almost never one, so it must not sit between the owner and a window.
  setTimeout(() => {
    void seatSettles
      .drain()
      .then((settled) => {
        if (settled > 0) console.error(`[cookrew] recorded ${settled} seat(s) at cookrew.dev`)
      })
      .catch(() => undefined)
    // Whatever the last run left queued for the funnel; off, it stays home.
    void resumeTelemetry()
  }, 5_000)

  // Reclaim what the stores leaked. Deferred rather than awaited: it walks
  // ~/.cookrew and must never sit between the user and a window. It is also
  // deliberately quiet on the happy path — a sweep that frees nothing is the
  // normal case and does not deserve a line in the log.
  setTimeout(() => {
    // Which served sessions are OPEN is a fact only the instantiator holds;
    // a sweep not told it plans nothing for that class. At boot the answer
    // is the empty list — served sessions die with the app — and saying so
    // is what lets the sandboxes a crash left behind be reclaimed. A throw
    // here is "not told", never an uncaught error in a timer.
    let openServedSessions: string[] | null = null
    try {
      openServedSessions = serving.instantiator
        .sessions()
        .map((s) => servedSessionKey(s.serviceId, s.identity.sessionId))
    } catch (error) {
      console.error('storage sweep: could not read open served sessions:', error)
    }
    void sweepStorageInWorker(path.join(dirname, 'storage-gc-worker.js'), {
      apply: true,
      openServedSessions
    })
      .then((swept) => {
        if (swept.skipped.length > 0) {
          // A store it could not read: nothing was freed, and this is why.
          console.error(`storage sweep: skipped ${swept.skipped.join(', ')} — a store was unreadable`)
        }
        if (swept.remove.length > 0) {
          // "up to": sidecars are APFS clones, so file length bounds what the
          // disk actually gives back.
          const mb = (swept.bytes / 1024 / 1024).toFixed(1)
          console.error(`storage sweep: reclaimed ${swept.remove.length} files (up to ${mb}MB)`)
        }
        if (swept.failed.length > 0) {
          console.error(`storage sweep: ${swept.failed.length} file(s) could not be removed`)
        }
        // Hand-made backup copies are the owner's to remove, so this is the
        // one line that stops them being invisible.
        if (swept.residue.length > 0) {
          const mb = (swept.residueBytes / 1024 / 1024).toFixed(1)
          const names = swept.residue.map((r) => path.basename(r.path)).join(', ')
          console.error(`storage sweep: ${swept.residue.length} hand-made backup(s) (${mb}MB) left in place: ${names}`)
        }
      })
      .catch((error) => {
        // Reclaiming disk is never worth freezing or failing the app.
        console.error('storage sweep worker failed:', error)
      })
  }, 30_000)

  // Re-key legacy version pins by checkpoint uuid (pin-rekey.ts — the re-key
  // refuseRenumber demanded before T4 deleted it). A pin cut before atUuid existed
  // is anchored by index alone, and a /compact renumbers that index out from
  // under it; the durable ledger still holds the uuid for the turn the pin
  // was cut at, so backfill it once per boot. Deferred like the storage sweep
  // above — a maintenance walk over ~/.cookrew must never sit between the
  // user and a window — and quiet unless a file actually changed.
  setTimeout(() => {
    try {
      for (const terminalId of pinStore.listIds()) {
        const { pins: rekeyed, changed } = rekeyPinsByUuid(
          pinStore.list(terminalId),
          turns.history(terminalId)
        )
        if (changed > 0) {
          pinStore.replace(terminalId, rekeyed)
          console.error(`pin re-key: ${changed} pin(s) on ${terminalId} gained checkpoint uuids`)
        }
      }
    } catch (error) {
      // A failed re-key leaves legacy pins on their index anchoring — worse
      // than keyed, never worse than yesterday.
      console.error('pin re-key failed:', error)
    }
  }, 30_000)

  // Endpoint restore handlers: rewind a live agent to a checkpoint + undo.
  const { restoreCheckpoint, undoRestore } = createRestoreHandlers({
    store,
    ptys,
    traces,
    spawnTracked,
    cannotStart: (node) => {
      const block = bootBlockOf(node)
      return block ? `${block.why} ${block.fix} The agent was left running.` : null
    },
    // Restore/undo kill the CLI; refuse while a turn is in flight so the
    // session file is never truncated out from under a writing process.
    phaseOf: (id) => turns.listVerified().find((a) => a.terminalId === id)?.phase ?? null,
    // A detached/background target has no tracked phase but may carry an
    // armed dispatch or an open-turn fact — restore must not kill and rebind
    // a session mid-commissioned-work (Sol r4).
    hasArmedDispatch: (id) => turns.hasArmedDispatch(id),
    hasOpenWork: (id) => turns.hasOpenTurnFact(id)
  })

  // SOUS AT THE WHEEL. One controller behind four doors (⌘-hold, phone 🎙️,
  // voice-gateway's POST, `cookrew sous`); it decides and does, the doors
  // speak. The `ui` bus carries zoom/zoom-back to every surface: the desktop
  // over IPC, the phone and the TV over /api/events.
  const uiBus = new EventEmitter()
  const sousRoster = (): IntentRoster => {
    const aliases = readSousVoiceConfig().aliases
    const workspaces = store.list().workspaces
    const nameOf = (id: string | undefined): string => workspaces.find((w) => w.id === id)?.name ?? ''
    return {
      agents: store.terminalsAcross().map((t) => {
        const workspaceId = store.ownerOf(t.id) ?? ''
        return {
          id: t.id,
          name: t.name,
          workspaceId,
          workspaceName: nameOf(workspaceId),
          aliases: aliases[t.name],
          role: t.role,
          orch: t.orch === true
        }
      }),
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
      presets: PRESETS.map((p) => p.name)
    }
  }
  // THE SOUS LEDGER (HP): every decision, the owner's answer, the delivery's end — 0600, scrubbed, 30 d.
  const sousLedger = new SousLedger(undefined, undefined, scrub)
  const sousBus = new EventEmitter()
  const sous = new SousController({
    roster: sousRoster,
    activeWorkspaceId: () => store.focusedId,
    switchWorkspace: (id) => void switchWorkspace(id),
    createTerminal: ({ preset, name, workspaceId }) => {
      const make = (): { id: string; name: string } => {
        // To the right of everything on the canvas, so a spoken "create" never
        // lands under an existing card.
        const nodes = store.focusedState.nodes
        const right = nodes.reduce((max, n) => Math.max(max, n.position.x + n.size.width), 0)
        const node = createTerminal({ name, preset, position: { x: right + 60, y: nodes[0]?.position.y ?? 120 } })
        return { id: node.id, name: node.name }
      }
      return workspaceId ? store.inSeat(workspaceId, make) : make()
    },
    seats: () => store.isMultiInstance,
    createBrowser: async (anchorId, name) => {
      await browserCommand(['create', 'about:blank', name], anchorId)
    },
    connect: (a, b) => store.connectAcross(a, b),
    rename: (id, name) => {
      const renamed = renameTerminal(id, name, 'refuse', 'Sous (voice)')
      if (!renamed.ok) throw new Error(renamed.error)
    },
    // Short by nature (one spoken sentence), so the owner-submit primitive is
    // the right sink: it holds the producer lease and answers at submission,
    // and a refusal (busy input box, armed dispatch) is a sentence, not a
    // silently dropped prompt.
    submit: async (agentId, text, { enter }) => {
      const node = store.terminalsAcross().find((t) => t.id === agentId)
      if (!node) throw new Error('that agent is not on any canvas')
      let session = ptys.get(agentId)
      if (!session) {
        spawnTracked(node)
        session = ptys.get(agentId)
      }
      if (!session) throw new Error(`${node.name} has no running terminal`)
      // Typed-and-left goes in as one bracketed paste so a line break inside
      // the cleaned text is a line break in the box, not an Enter.
      const bytes = enter ? `${text}\r` : `\x1b[200~${text}\x1b[201~`
      const verdict = await ownerSubmit(session, bytes)
      if (!verdict.ok) throw new Error(verdict.reason)
    },
    polish: (text) => polishTranscript(text),
    ui: (command, workspaceId) => {
      const event: UiCommandEvent = { workspaceId, command }
      // The desktop zooms for what it is showing: a phone on another workspace
      // zooming its own card must not pull this window after it.
      if (workspaceId === store.deskId) mainWindow?.webContents.send('ui:command', event)
      uiBus.emit('command', event)
    },
    note: (kind, subjectId, detail) => store.recordEvent(`sous.${kind}`, subjectId ?? '', detail, 'voice'),
    // THE DECIDE STEP (R3): who takes a brief the intent core did not match.
    // Candidates are the cards as the Board sees them; a context-full card is
    // read off its pane the way the pre-dispatch probe reads it, for the idle
    // same-repo cards only (one capture each, never the whole fleet).
    decide: {
      workdir: () => store.focusedState.dir,
      candidates: async () => {
        // NO PANE CAPTURES HERE (HP budget): context-full is read off the
        // tracker's mirror; the capture is wired so the builder's test can
        // prove it is never called (decide-candidates.ts).
        const rows = new Map(buildBoard(boardSources()).rows.map((r) => [r.terminalId, r]))
        return buildCandidates({
          terminals: () => store.terminalsAcross(),
          rowOf: (id) => rows.get(id),
          ownerOf: (id) => store.ownerOf(id),
          contextFull: (id) => turns.contextFullCached(id),
          capture: (id) => multiplexer()?.capture(sessionNameFor(id)) ?? null
        })
      },
      status: () => ({ openDispatches: dispatchService.openDispatchIds().length }),
      recruit: ({ preset, name, brief, besideId, cwd }) => {
        const nodes = store.focusedState.nodes
        const anchor = besideId ? (nodes.find((n) => n.id === besideId) ?? null) : null
        const position = placeBeside(anchor, nodes, DEFAULT_TERMINAL_SIZE)
        // A chore works outside the repo: ~/.cookrew/chores, 0700, never the tree.
        const choresDir = path.join(app.getPath('home'), '.cookrew', 'chores')
        // Created 0700 and pre-trusted in ~/.claude.json: a fresh chore card must not stop at Claude's trust dialog.
        if (cwd === 'chores') prepareChoresDir(choresDir, path.join(app.getPath('home'), '.claude.json'))
        const node = createTerminal({ name, preset, position, ...(cwd === 'chores' ? { cwd: choresDir } : {}) })
        // The sentence is the card's BRIEF, not its role: a role is a saved
        // role's name, worn by the pane chrome and typed by role boot; a brief
        // is display only and nothing types it on a respawn (recruit-node.ts).
        updateNode(node.id, recruitPatch(scrub(brief)))
        return { id: node.id, name: node.name }
      },
      // The same door `cookrew ask --no-wait` uses: admitted by the dispatch
      // engine (retrying the boot-time 503s of a card made a moment ago),
      // delivered by herdr once the harness is at its prompt, on the ledger.
      deliver: async (input) => {
        const { dispatchId } = await deliverToRecruit(dispatchService, input, { witness: recruitWitness })
        // The ledger learns how the delivery ended once the engine settles it.
        if (input.token) {
          const token = input.token
          void dispatchService.settled(dispatchId).then(() => {
            const record = dispatchService.get(dispatchId)
            if (record?.state === 'failed' || record?.state === 'interrupted') sousLedger.write({ token, dispatchId, outcome: record.state })
          })
        }
        return { dispatchId }
      },
      ledger: sousLedger,
      // THE FIVE-QUESTION JEV (E2E lane jev), only when COOKREW_SOUS_JEV=1:
      // one budgeted POST to the gateway's /v1/systemone through its own
      // breaker; with the flag off this dep is absent and nothing changes.
      ...(jevEnabled()
        ? {
            jev: createJevDecider({
              gateway: () => {
                const g = routeService.state().gateway
                return g ? { v1: g.v1 } : null
              },
              key: () => sousGatewayKey(),
              breaker: createSousBreaker({ probeTimeoutMs: JEV_DEADLINE_MS }),
              recent: () => sousLedger.rows().slice(-3).map((r) => `${r.ownerResponse ?? 'pending'}: ${r.sentence.slice(0, 60)} → ${r.target?.name ?? '—'}`)
            })
          }
        : {}),
      decisionUpdated: (update) => {
        mainWindow?.webContents.send('sous:decision-updated', update)
        sousBus.emit('sous', { kind: 'decision-updated', ...update })
      },
      // The target's route, when Forge's routeOfCard exists on this build; a
      // card whose new route applies on restart will respawn to take the brief.
      routeOf: ({ cardId }) => {
        // A recruit has no card yet: its intended route is the fleet default
        // (pinned at start), or direct when none is set.
        if (!cardId) return { route: routeService.defaultModel() ?? 'direct', effective: null, respawn: false }
        const svc = routeService as unknown as { routeOfCard?: (id: string) => { route: string; effective: string | null; appliesOn?: string } | null }
        if (typeof svc.routeOfCard !== 'function') return null
        const r = svc.routeOfCard(cardId)
        return r ? { route: r.route, effective: r.effective, respawn: r.appliesOn === 'restart' } : null
      },
      // Routability, read from the route service: a default route set means
      // a recruit should land on a harness the gateway can carry. `routable`
      // comes from HarnessRow when the service reports it (round 2 contract);
      // until then the one harness route-env refuses is pi.
      routing: () => {
        const state = routeService.state()
        const names: Record<string, Harness> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' }
        const routable: Partial<Record<Harness, boolean>> = { Pi: false }
        for (const row of state.harnesses) {
          const flag = (row as { routable?: boolean }).routable
          if (flag !== undefined) routable[names[row.id]] = flag
        }
        return { defaultSet: state.defaultModel !== null, routable }
      }
    }
  })
  // The desktop's box: one caller, on the surface it says. A token minted on
  // the canvas is the canvas box's to commit or cancel, and nobody else's.
  const desktopCaller = (surface: unknown): { surface: SousSurface; callerId: string } => ({ surface: surface === 'phone' ? 'phone' : 'canvas', callerId: 'desktop' })
  // THE DOOR EVERY SURFACE GETS — the desktop box, the phone, the CLI: the
  // same controller, its spoken sentence and its choices scrubbed on the way
  // out (scrub-surfaces.ts). Commit and cancel pass through untouched.
  const sousDoor: SousDoor = {
    handle: async (input) => scrubSousResult(await sous.handle(input), scrub),
    // A commit answers a result too — the same scrub; cancel answers a boolean.
    commit: async (token, choice, caller) => scrubSousResult(await sous.commit(token, choice ?? {}, caller), scrub),
    cancel: (token, caller) => sous.cancel(token, caller)
  }
  ipcMain.handle('sous:commit', (_e, token: string, choice?: { target?: string; ack?: 'send-anyway' }, surface?: unknown) => sous.commit(String(token), choice ?? {}, desktopCaller(surface)))
  ipcMain.handle(
    'sous:command',
    (_e, text: string, ctx: { surface: SousSurface; focusedAgentId?: string | null; alternates?: string[]; box?: boolean }) =>
      sousDoor.handle({
        text,
        alternates: ctx.alternates,
        surface: ctx.surface,
        // Only the box decides; push-to-talk sends no flag and keeps the regex core.
        box: ctx.box === true,
        callerId: 'desktop',
        focusedAgentId: ctx.focusedAgentId ?? null
      })
  )

  // THE INBOX (R3): one ranked list of what only a person can move. Built
  // only while a client holds it, on a trailing debounce over the store, the
  // event log and the probe — never on Sous's own lines (inbox-wiring.ts).
  // The rows come from the probe's CURRENT phases, not from a touch that
  // would announce back into this very builder.
  const readDispatches = cachedDispatchReader(defaultDispatchRegistry())
  const inbox = wireInbox({
    build: () => {
      const workspaces = store.list().workspaces
      const nameOf = (id: string): string => workspaces.find((w) => w.id === id)?.name ?? id
      const nodes: InboxNode[] = []
      const connections: { a: string; b: string }[] = []
      for (const meta of workspaces) {
        const state = store.workspaceState(meta.id)
        for (const n of state.nodes) {
          nodes.push({
            id: n.id,
            name: n.name,
            kind: n.kind,
            workspaceId: meta.id,
            workspaceName: nameOf(meta.id),
            served: n.kind === 'terminal' && n.servedSession != null
          })
        }
        for (const c of state.connections) connections.push({ a: c.a, b: c.b })
      }
      const sources = { ...boardSources(), probe: () => boardProbe.phases() }
      return buildInbox({
        rows: () => buildBoard(sources).rows,
        nodes: () => nodes,
        connections: () => connections,
        dispatches: readDispatches,
        events: (type, since) => events.query({ type, since }),
        // Sous's own stuck deliveries, from the ledger (already scrubbed on write; scrubbed again on the way out).
        sous: () => sousLedger.stuck().map((r) => ({ token: r.token, deliveredTo: r.deliveredTo as string, proposalText: r.proposalText as string, outcome: r.outcome, updatedAt: r.updatedAt }))
      }).map((row) => scrubInboxRow(row, scrub))
    },
    // The op itself rides along: Sous's notes are store ops too.
    onStoreOp: (cb) => {
      const listener = (op: { type: string }): void => cb(op)
      store.on('op', listener)
      return () => void store.off('op', listener)
    },
    onEvent: (cb) => {
      events.on('event', cb)
      return () => void events.off('event', cb)
    },
    onProbeChange: (cb) => boardProbe.onChange(cb),
    onLedgerChange: (cb) => {
      sousLedger.on('change', cb)
      return () => void sousLedger.off('change', cb)
    },
    announce: (rows) => mainWindow?.webContents.send('inbox:changed', rows)
  })
  // The window holds the list while its box is subscribed; a one-shot read
  // builds on demand. The hold goes with the page that took it: a reload or a
  // closed window never sends the unsubscribe (inbox-window-hold.ts).
  const windowHold = createWindowHold(() => inbox.hold())
  ipcMain.handle('inbox:subscribe', (event) => {
    windowHold.subscribe(event.sender)
    return inbox.read()
  })
  ipcMain.handle('inbox:unsubscribe', () => windowHold.release())
  ipcMain.handle('inbox:list', () => inbox.read())
  // RETRY re-sends the proposal the owner saw, from the ledger, through the
  // engine, to the same card; DISMISS hides the row and the ledger remembers.
  const inboxAct = async (token: string): Promise<{ ok: boolean; error?: string; dispatchId?: string }> => {
    // Only a brief that never landed, and only into a card that can take it
    // right now (sous-retry.ts) — never a second copy of a delivered one.
    const verdict = retryVerdict(sousLedger.get(token), (nodeId) => {
      const hit = store.nodeAcrossWorkspaces(nodeId)
      if (!hit || hit.node.kind !== 'terminal') return null
      return { served: hit.node.servedSession != null, phase: turns.phaseOf(nodeId), ownerComposing: turns.ownerComposing(nodeId) }
    })
    if (!verdict.ok) return { ok: false, error: verdict.error }
    try {
      const { dispatchId } = await deliverToRecruit(
        dispatchService,
        { nodeId: verdict.nodeId, sentence: verdict.text, originId: null },
        { witness: recruitWitness }
      )
      sousLedger.write({ token, dispatchId, outcome: 'delivered', dismissed: false })
      void dispatchService.settled(dispatchId).then(() => {
        const record = dispatchService.get(dispatchId)
        if (record?.state === 'failed' || record?.state === 'interrupted') sousLedger.write({ token, dispatchId, outcome: record.state })
      })
      return { ok: true, dispatchId }
    } catch (error) {
      const what = error instanceof Error ? error.message : String(error)
      return { ok: false, error: what }
    }
  }
  const inboxDismiss = (token: string): boolean => sousLedger.dismiss(token)
  ipcMain.handle('inbox:act', (_e, token: unknown) => inboxAct(String(token)))
  ipcMain.handle('inbox:dismiss', (_e, token: unknown) => ({ ok: inboxDismiss(String(token)) }))
  ipcMain.handle('sous:revise', (_e, token: unknown, alternates: unknown) => sous.revise(String(token), Array.isArray(alternates) ? (alternates as Alternate[]) : []))
  ipcMain.handle('sous:cancel', (_e, token: string, surface?: unknown) => sous.cancel(String(token), desktopCaller(surface)))

  // THE MAC'S EAR. One recognizer child per hold of ⌘; the roster's names go
  // in as hints so "cookrew dev" is not heard as "cooker Dev".
  const earOptions = {
    binary: app.isPackaged
      ? path.join(process.resourcesPath, 'cr-listen')
      : path.join(dirname, '../../resources/cr-listen/cr-listen'),
    // Two ears: the owner's locale first (its partials are what the pill
    // shows), en-US alongside because that is the ear that spells the
    // roster's English names right. Same audio, one microphone.
    locales: (): string[] => {
      const primary = readSousVoiceConfig().locale
      return primary === 'en-US' ? [primary] : [primary, 'en-US']
    },
    hints: (): string[] => {
      const roster = sousRoster()
      return [
        'Sous',
        'Cookrew',
        ...roster.agents.map((a) => a.name),
        ...roster.workspaces.map((w) => w.name),
        ...roster.presets
      ]
    }
  }
  const listener = new MacListener(earOptions)
  // The same ears for a recording the phone made (hear-file.ts, POST /api/listen).
  const phoneEar = {
    available: () => hearAvailable(earOptions),
    locale: () => earOptions.locales()[0] ?? null,
    recording: (bytes: Uint8Array) => hearRecording(earOptions, bytes)
  }
  ipcMain.handle('listen:available', () => listener.available())
  // Spoken replies in the free local voice (local-voice.ts): the box asks per
  // chunk. Not installed, and the box uses the browser's voice.
  const replyVoice = createLocalVoice()
  // Asked as a turn starts: the answer, and a warm voice by the time the reply lands.
  ipcMain.handle('speak:available', () => {
    replyVoice.warm()
    return replyVoice.available()
  })
  // Each chunk carries an id so a stopped reading can cancel it upstream.
  const speaking = new Map<string, AbortController>()
  ipcMain.handle('speak:audio', async (_e, id: unknown, text: unknown, lang: unknown) => {
    const key = typeof id === 'string' && id.length <= 64 ? id : null
    const controller = new AbortController()
    if (key) speaking.set(key, controller)
    try {
      return await replyVoice.speak(text as string, controller.signal, lang === 'en' ? 'en' : 'zh')
    } finally {
      if (key) speaking.delete(key)
    }
  })
  app.on('before-quit', () => replyVoice.stop())
  ipcMain.on('speak:cancel', (_e, id: unknown) => {
    if (typeof id === 'string') speaking.get(id)?.abort()
  })
  ipcMain.handle('listen:start', () =>
    listener.start((event) => mainWindow?.webContents.send('listen:event', event))
  )
  ipcMain.handle('listen:stop', () => listener.stop())

  cliSocket = startSocketServer({
    store,
    ptys,
    spawnTerminal: spawnTracked,
    dismissTerminal: (id) => removeNode(id, { actor: 'orch', via: 'dismiss' }),
    agents,
    turns,
    sous: sousDoor,
    // `cookrew secret read/list` (secret-cli.ts): the store, and the line
    // each read leaves in the event log.
    secrets,
    audit: auditSecret,
    // `cookrew login`, `logout`, `whoami`: the account's own functions, and the
    // line each attempt leaves. The door is registered further down, so this
    // reads it when asked.
    account: () => accountDoor,
    auditLogin,
    // THE SERVED FACT for the secret verbs: a pane spawned for a stranger's
    // seat (pty.ts), or any pane on a workspace this app serves out
    // (servedSpawnContexts). `servedSession` on the node is the OTHER thing —
    // the owner's receipt of a session served elsewhere — and must not be
    // read for this.
    isServed: (terminalId) =>
      ptys.isServed(terminalId) || servedSpawnContexts.has(store.ownerOf(terminalId) ?? ''),
    // `ask --no-wait` and `cookrew dispatch <id>`: the SAME engine the HTTP
    // route uses, so a CLI-minted dispatch and an API-minted one are one
    // record with one lifecycle.
    dispatch: dispatchService,
    // `cookrew recruit --prompt`: the brief waits for the harness and needs
    // evidence it landed before the command says "delivered".
    recruitWitness,
    // `cookrew rename` and `cookrew recruit --prompt`: the same rename the
    // prompt box's model-picked name goes through, herdr's chrome included.
    renameCard,
    autoNameTerminal,
    adoptPictures: (text) => adoptPictures(text, defaultAttachmentsDir()),
    // The cable between the asking pane and the agent it asks lights twice.
    signal: (moment) => void cableSignals.emit(moment),
    forkTerminal,
    routines,
    browserCommand,
    createBrowserInWorkspace,
    browserAnyWorkspace: interactiveBrowserEnabled,
    notify: showNotification,
    captureWindow,
    injectInput,
    voice,
    mobileUrls,
    mobileEndpoints: mobileEndpointList,
    uncoveredCertHosts,
    // Ending every session ends the watch's too.
    rotatePairingToken: () => {
      watchPairing.unpair()
      // Whoever came in on the old token: a socket outlives the token that opened it.
      remoteDesk.forgetDevice('root')
      return rotateActivePairingToken()
    },
    pairingHandout: currentPairingHandout,
    listWorkspaces,
    createWorkspace,
    checkWorkspace: (name, dir) => workspaceCheck(store, name, dir),
    workspaceRemovePlan,
    createWorkspaceFromTeam,
    switchWorkspace,
    removeWorkspace: removeWorkspaceWith,
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

  // THE CALLER'S END OF THE RELAY, up before any card can ask for it.
  //
  // Started whenever this app has ever imported a relayed team, because those
  // cards start with the app and go looking for a loopback port. Left lazy,
  // they would find the PREVIOUS run's port number in a file and dial a socket
  // nobody is holding — which reads as the team having gone away.
  if (importedDoors()) void relayProxy()

  // THE OWNER'S END OF THE RELAY, for every team still being served. The
  // templates came back from disk; their doors have to be dialled again.
  for (const template of serving.served.list()) void joinRelayFor(template)
  // After the boot dials, not with them: a claim filed before the relay
  // answered would name doors this Mac may turn out not to be holding.
  setTimeout(publishDoorClaims, 5_000).unref?.()

  startMobileServer({
    appVersion: () => app.getVersion(),
    /**
     * v3 (V3-21 · H2): an OVERRIDE for QA, never the switch.
     *
     * The default lives with the build (shared/lan-token-mode.ts) because it
     * is a fact about the companion bundle this Mac serves, and because the
     * revoke sentence has to read the same fact. Setting this to 1 gives the
     * strict world early — the root opens the admission route and nothing
     * else — for QA against a companion that already sends the admission.
     * Unset, the build decides, which is what "shipping" means.
     */
    perDeviceOnly: () =>
      process.env.COOKREW_LAN_TOKEN_STRICT === '1' ? true : COMPANION_BOOTSTRAPS,
    servedSlug: handleServedSlug,
    store,
    // Sous's door for the phone and for voice-gateway; `ui` events for both.
    sous: sousDoor,
    uiBus,
    // The phone's mic, heard by the Mac's ears.
    hear: phoneEar,
    // The inbox (R3): the same rows the desktop box lists; a stream holds it open.
    inbox: () => inbox.read(),
    inboxAct,
    inboxDismiss,
    sousBus,
    inboxHold: () => inbox.hold(),
    inboxBus: inbox,
    // THE DIALS on the phone — the same reads and the same write the desktop
    // does, through the same deps, so the two surfaces cannot drift.
    tuning: {
      state: (terminalId) => tuningStateOf(tuneDeps(), terminalId),
      fleet: tuningFleet,
      turn: (terminalId, knob, value) =>
        applyTuning(tuneDeps(), terminalId, knob as TuneKnob, value)
    },
    tuningBus,
    // The same cable signals the desktop gets, filtered to the stream's canvas.
    signalBus: cableSignals,
    useBus: useSignals,
    reachBus,
    // Serves the CA-issued chain by SNI for this Mac's names, keeps the
    // self-signed one as the default, and spells the printed URLs.
    nameCert: nameCertificate,
    // Importing a served team from the phone: the same operations the desktop
    // sheet drives, over the mobile API.
    serve: serveOps,
    // §10: the same pin store the desktop rail reads — the phone's rail must
    // not drift from what the canvas shows.
    listPins: (terminalId) => pinsFor(terminalId),
    // The sealed slots, for the phone's note editor: names out, values in.
    secrets: withSecretActivity(secrets, 'Phone', recordSecretChange),
    // The direct link over WebRTC (rtc-peer.ts), answered on the published addresses.
    rtc: rtcHost,
    // The browser card's socket over plain HTTP, for a phone on the relay.
    socketBridge: createSocketBridge(),
    build: { id: () => buildId, bus: buildBus },
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
    traces: {
      index: traceIndexFor,
      boundaryMarkers: traceMarkersFor,
      page: tracePageFor,
      latestCheckpoint: latestCheckpointFor
    },
    turnHistory: turnHistoryFor,
    // One stream (T2): the three new routes, and the five old ones as
    // adapters over the same reader while COOKREW_STREAM_ADAPTERS is on.
    stream: streamService,
    // Activity Board data plane. Without this /api/board answers 503 —
    // deliberately, so a missing wire-up is loud instead of an empty board.
    // probe (L2) is absent until the tmux sampler lands; rows then degrade to
    // their last known task rather than claiming a phase nobody observed.
    board: boardSources(),
    // The main thread's pulse (loop-health.ts) for GET /api/health.
    health: () => loopHealth.snapshot(),
    // The route program's four endpoints, the stream's two frames, and the
    // `route` field on /api/health (mobile-api.ts).
    route: {
      state: () => routeService.state(),
      setDefault: (model) => routeService.setDefault(model),
      setSharedMcp: (on) => routeService.setSharedMcp(on),
      cardState: (id) => routeService.cardState(id),
      setCardRoute: (id, route) => routeService.setCardRoute(id, route),
      health: () => routeService.health(),
      hold: () => routeService.hold()
    },
    routeBus,
    // The screen wall's pictures, for the phone (GET /api/workspaces/shots).
    workspaceShots: currentWorkspaceShots,
    // Terminals from an earlier login, for the phone (GET /api/terminal-session).
    terminalSession: () => readTerminalSession(),
    // Attach-free dispatch (v4 §3): the two /api routes answer 503 without it.
    dispatch: dispatchService,
    // While a dispatch is armed, the HTTP input/ask producers refuse 409 —
    // two writers racing one agent is two answers to one reservation.
    hasArmedDispatch: (terminalId) => turns.hasArmedDispatch(terminalId),
    acquireTerminalView: (terminalId) => lazyTerminals.acquire(terminalId),
    releaseTerminalView: (terminalId) => lazyTerminals.release(terminalId),
    // A live stream is a watcher (A4): open holds/starts the file watch,
    // close hands the terminal back to the drain clock.
    subscribeTerminal: (terminalId) => sessionSync.subscribe(terminalId),
    unsubscribeTerminal: (terminalId) => sessionSync.unsubscribe(terminalId),
    wallToken,
    pairingToken,
    // Identity v2.1: `/api/hello`, the phones this Mac has let in, and the
    // owner's public face. `/api/hello` answers above the pairing-token gate
    // because it exists for a phone that has not got the token yet — it is how
    // the phone checks it found the right Mac before it sends a credential.
    // Where the reach publisher stands with the registry, so /api/reach can
    // withhold names the zone no longer answers and say why (reach.ts).
    reachPublish: () => reachPublisher?.state() ?? { acceptedAt: null, refused: null },
    identity: {
      account: () => accounts.account(),
      registryOrigin: () => registryOrigin(),
      admitted: admittedDevices,
      // Whatever the last successful profile read left behind. Never fetched
      // on the request path: the avatar must draw a letter immediately, and a
      // phone waiting on cookrew.dev to learn the owner's initials is a phone
      // showing "?" every time the WAN is slow.
      profileFace: () => profileFace,
      log: (message: string) => console.error(`[cookrew] ${message}`)
    },
    recoverAgent,
    restoreCheckpoint,
    undoRestore,
    ptys,
    wakeAgent,
    holdInput: (terminalId: string, data: string) => waker.hold(terminalId, data),
    voice,
    turns,
    // Each preset's `launch` offer is read per request (launch-offers.ts).
    presets: withLaunchOffers(PRESETS),
    ops: {
      useSources,
      checkLaunch,
      listStrayPanes,
      endStrayPane,
      addNode,
      updateNode,
      renameNode: (id, name) => renameByHand(renameDeps, id, name),
      removeNode,
      createTerminal,
      forkTerminal,
      listWorkspaces,
      createWorkspace: (name, dir, team, options) =>
        team ? createWorkspaceFromTeam(name, dir, team, options) : createWorkspace(name, dir, options),
      checkWorkspace: (name, dir) => workspaceCheck(store, name, dir),
      switchWorkspace,
      renameWorkspace: (id, name) => {
        store.renameWorkspace(id, name)
        return store.list()
      },
      setWorkspaceIcon: (id, icon) => {
        store.setWorkspaceIcon(id, icon)
        return store.list()
      },
      workspaceRemovePlan,
      setWorkspaceBrief: (id, brief) => {
        store.setWorkspaceBrief(id, brief)
        return store.list()
      },
      removeWorkspace: removeWorkspaceWith,
      addWorkspaceDir,
      removeWorkspaceDir,
      setPrimaryDir,
      setTerminalCwd,
      gitInfo: (dir: string) => gitCache.info(dir),
      laneList,
      laneOpen,
      laneLand,
      laneClose,
      laneAuto,
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
    promptImage: promptImages,
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
  // Profiles outlive crashes, but not their browser nodes. Enumerate every
  // workspace strictly so corrupt parked state makes this fail closed.
  try {
    // Processes BEFORE directories: a Chromium from an instance that died
    // hard holds its profile open, so deleting the directory under it frees
    // nothing. Orphaned by definition (ppid 1), so no live card is touched.
    const stray = reapOrphanChrome(browserProfileRoot())
    if (stray.length > 0) console.error(`Killed ${stray.length} orphaned browser process(es)`)
    const owned = store.allBrowserIdsStrict()
    const reaped = reapOrphanBrowserProfiles(browserProfileRoot(), owned)
    if (reaped.length > 0) console.error(`Reaped ${reaped.length} orphaned browser profile(s)`)
    // The two halves the profile reaper never knew about: the canvas webview's
    // own partition, and — on macOS — the Caches side of a Chrome profile.
    // Deleting only userData left every retired card half-resident.
    const partitions = reapOrphanPartitions(
      path.join(app.getPath('userData'), 'Partitions'),
      owned
    )
    const cached = reapOrphanBrowserProfiles(browserCacheRoot(), owned)
    if (partitions.length + cached.length > 0) {
      console.error(
        `Reaped ${partitions.length} orphaned partition(s), ${cached.length} orphaned cache dir(s)`
      )
    }
    // Chrome downloads its component and model stores per profile however many
    // flags say otherwise, so they are deleted rather than argued with. Safe
    // here specifically because startup has not spawned a browser yet: nothing
    // holds these files open. Site state is never touched.
    let freed = 0
    for (const id of owned) {
      freed += purgeRegenerableProfileData(path.join(browserProfileRoot(), id))
    }
    if (freed > 0) {
      console.error(`Browser caches: reclaimed ${(freed / 1024 ** 3).toFixed(2)}GB`)
    }
  } catch (error) {
    console.error('Skipping browser profile reap: could not enumerate all workspace browsers', error)
  }
  // Restore browser cards as cold metadata. replaceNodes preserves any live
  // node-owned instances, but startup does not spend one Chromium process (and
  // profile) per saved reference card; a stream or agent command starts it.
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
  // The single-instance lock is held by now, so a live claim under our own
  // userData can only be a predecessor still exiting: take it over.
  ptys.confirmHostClaim()
  try {
    const reaped = ptys.reapOrphanSessions(store.allTerminalIdsStrict(), provedSessions(agents.list()))
    if (reaped.length > 0) console.error(`Reaped ${reaped.length} orphaned agent session(s)`)
    noteSwept(reaped)
  } catch (error) {
    console.error('Skipping orphan reap: could not enumerate all workspace terminals', error)
  }
  void refreshLaunchBlocks(store.focusedId)
  void listStrayPanes().then((strays) => {
    if (strays.length === 0) return
    const line = strays.length === 1 ? '1 pane' : `${strays.length} panes`
    store.recordEvent('terminal.strays', 'strays', line, 'running with no card; see the search board')
  })

  // Terminals stay detached on cold start. Herdr keeps their processes alive;
  // a settled semantic zoom acquires the local PTY mirror on demand. Working
  // agents are observed through their session files without opening mirrors.
  reportWorkspaceBinding()
  // ...and the pane half, for EVERY workspace's terminals rather than the
  // resident ones ensureSession will reattach. A herdr server replaced under
  // the fleet keeps the panes and forgets what they were called.
  reportPaneBindings()
  keepAgentNames()

  // File this Mac's workspaces under the account, by NAME AND ID only (P1).
  // Best effort and never awaited: a registry that is down must not delay a
  // boot, and a desktop with no account has nothing to file.
  // The reach card rides with them: the addresses this Mac answers on, the
  // fingerprint of the certificate it serves, and whether the relay is up —
  // signed by the device key, so cookrew.dev is a repeater and not an
  // authority about where to find this machine.
  reachPublisher = createReachPublisher({
    account: () => accounts.account(),
    endpoints: () => mobileEndpointList(),
    certFp: () => activeCertFingerprint(),
    // TRUE ONLY WHILE THE LINE IS ACTUALLY HELD. `held()` is ready-received
    // and neither aborted nor closed — a card claiming a relay that is not
    // carrying sends a phone down a path that receives every request and
    // answers none. (The door relay is a different thing entirely: it carries
    // a served team, not this Mac's canvas.)
    relay: () => canvasLink.held(),
    workspaces: () => store.list().workspaces.map((w) => ({ id: w.id, name: w.name })),
    // The origins a browser will trust for this Mac right now — empty until a
    // chain is actually held, because the phone reads this list as "these load
    // without a warning".
    trusted: () => trustedOrigins(),
    register: (workspaces, reach, trusted) =>
      accounts.registerDesktop(workspaces, reach, trusted),
    // ONLY ONCE THE ZONE ANSWERS. A phone told before the registry took the
    // card would resolve the new name to NXDOMAIN and cache that answer for
    // minutes (path/name-oracle.ts, 2026-10-04); told after, it finds a Mac.
    onChanged: () => {
      reachBus.emit('changed')
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('reach:changed')
      }
    },
    log: (message) => console.error(`[cookrew] ${message}`)
  })
  // The line's state IS half the card, so a line that comes up or goes down
  // republishes: without this a Mac that dialled out after boot would sit
  // advertising `relay: false` until the next network change.
  canvasLink.onChange(() => void reachPublisher?.republish('relay link').catch(() => undefined))
  canvasLink.start()
  void reachPublisher.republish('boot').catch(() => undefined)
  // The addresses move without anyone asking: a laptop lid, a new Wi-Fi, a
  // Tailscale that finally came up. Polling is the only honest way to notice.
  reachPublisher.watch()
  // AND NOTICE IN SECONDS, NOT A MINUTE. The publisher's clock is the floor;
  // this diff of the interfaces is one syscall and forks nothing (it reads
  // the tailnet from the cache the minute clocks fill), so it runs every few
  // seconds, and the two moments macOS can name — waking and unlocking — are
  // checked at once. On a change the self-signed certificate is re-issued
  // for the new bare address FIRST, then the card goes to the registry, and
  // the registry's acceptance (onChanged above) is what tells the phone.
  const networkWatch = createNetworkWatch({
    read: advertisedHostsNow,
    onChange: ({ reason, added, removed }) => {
      console.error(
        `[cookrew] addresses changed (${reason}): +[${added.join(' ')}] -[${removed.join(' ')}]`
      )
      void refreshMobileCert()
        .catch((error) => console.error('Mobile cert refresh after a network change failed:', error))
        .then(() => reachPublisher?.republish('addresses changed'))
        .catch(() => undefined)
    }
  })
  networkWatch.check('boot')
  networkWatch.start()
  powerMonitor.on('resume', () => void networkWatch.check('wake'))
  powerMonitor.on('unlock-screen', () => void networkWatch.check('unlock'))
  // The lock is heard here first: the card should not wait out a cache or a backoff.
  for (const event of ['lock-screen', 'unlock-screen', 'resume', 'suspend'] as const) {
    powerMonitor.on(event as 'resume', () => {
      sessionReader.invalidate()
      remoteDesk.sessionChanged()
      useInstances.wake()
    })
  }
  remoteDesk.start()

  // The certificate, once the account and the addresses are known. Best
  // effort and never awaited: an order is seconds of polling at the registry
  // and a boot must not wait on cookrew.dev for any of them.
  void nameCertificate.ensure('boot').catch(() => undefined)
  nameCertificate.watch()

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
  // The sizes panes last had, so their mirrors start at them next launch (pane-sizes.ts).
  paneSizes().flush()
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
  loopHealth.stop()
  routeService.dispose()
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
  browserCastIpc.shutdown()
  // The line goes down BEFORE the app does, so the registry stops handing the
  // owner's phone a name whose Mac is quitting — a downlink the process drops
  // silently is a relay that claims this desktop for as long as it takes the
  // pulse to notice.
  canvasLink.stop()
  store.flush()
  events.flush()
  sessionSync.dispose()
  lazyTerminals.dispose()
  latestWatch.dispose()
  doorWatch.dispose()
  turns.flushHistories()
  turns.disposeAll()
  ptys.disposeAll()
  // The shared CLI path goes only if it still holds the socket we bound: a
  // live app's socket is never ours to remove (2026-09-18).
  void cliSocket?.claim.then((claim) => claim.release()).catch(() => undefined)
  // The bounded drain: asks, then every tracked herdr child. The fold drain
  // that used to close this list went with the fold (T4) — nothing writes the
  // turn ledger any more, so there is no unproven rename left to outlive us.
  void cancelAllAsks()
    .catch(() => undefined)
    .then(() => {
      const mux = multiplexer()
      return mux instanceof HerdrHostMultiplexer
        ? mux.cancelAllHerdrOperations(4000)
        : undefined
    })
    .catch(() => undefined)
    .then(() => browserManager.shutdown())
    .then(() => useInstances.dispose())
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

/** The address the owner's page is served from, as the window was told to load it. */
function ownerPageUrl(): string | null {
  return process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(path.join(dirname, '../renderer/index.html')).href
}

/** The owner's window, its top frame, showing the owner's page. */
function publishUpdateStatus(status: UpdateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status)
}

function ownerFrame(event: { sender: unknown; senderFrame: { parent: unknown; url?: string } | null }): boolean {
  return isOwnerSender(event.sender, event.senderFrame, mainWindow?.webContents) && isOwnerPage(event.senderFrame?.url, ownerPageUrl())
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
  store.on('switch', () => {
    void refreshLaunchBlocks(store.focusedId)
    // The cards just came on screen: they should not wait out the interval.
    void paneFollower.tick()
  })
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
      if (!ownerFrame(event)) {
        console.error('[cookrew] grant refused: sender is not the owner window top frame')
        return { ok: false, reason: 'not_owner' }
      }
      return op(...args)
    }

  // ---- the owner's account (identity v2) ----
  //
  // Registered through the SAME ownerOnly wrapper, by construction: the module
  // hands over a table and this is the only place a guard could be forgotten.
  accountDoor = registerAccountIpc((channel, handler) => ipcMain.handle(channel, ownerOnly(handler)), {
    accounts,
    lock: ownerLock,
    requests,
    factors,
    envUsername: ENV_HANDLE || null,
    // Phase 6: a Mac that already serves under a handle opens the claim sheet
    // on a password, not on a name. Read at boot, and null once it has crossed.
    legacy: legacyHandleNow() === null ? null : { handle: legacyHandleNow() as string },
    workspaces: () => store.list().workspaces.map((w) => ({ id: w.id, name: w.name })),
    pairingHandout: currentPairingHandout,
    admitted: {
      list: () => admittedDevices.list(),
      forget: (deviceId) => {
        const forgotten = admittedDevices.forget(deviceId)
        remoteDesk.forgetDevice(`device:${deviceId}`)
        return forgotten
      }
    },
    publishReach: (reason) => {
      // The reachability toggle and a fresh claim both land here, and both
      // change whether there is a line to hold at all.
      canvasLink.refresh()
      void reachPublisher?.republish(reason).catch(() => undefined)
    },
    // SIGN OUT ON THIS MAC (v3, D12): the doors this Mac serves come down —
    // each one stopped here and delisted at the registry, exactly as the
    // SERVING panel's own STOP does — and the relay line is let go. The
    // canvas link re-reads the account and finds none to hold a line for.
    // Workspaces, cards and terminals are not touched.
    signedOut: async () => {
      for (const template of serving.served.list()) {
        serving.stop(template.serviceId)
        await relayServing?.withdraw(template.slug).catch(() => undefined)
      }
      relayServing?.closeAll()
      canvasLink.refresh()
    },
    // SAVE AS FILE. The dialog lives here because account-ipc.ts must stay
    // free of Electron; the CODES come from main's own memory, never from the
    // call, so the renderer chooses the file and nothing else. 0600, because
    // eight of these open the account.
    // The OS draws this prompt, and it is macOS only. Elsewhere there is none.
    touchId: {
      available: () => process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
      prompt: (reason) =>
        systemPreferences.promptTouchID(reason).then(
          () => true,
          () => false
        )
    },
    saveCodes: async (codes) => {
      if (!mainWindow) return { ok: false, reason: 'no_window' }
      const picked = await dialog.showSaveDialog(mainWindow, {
        title: 'Save your recovery codes',
        defaultPath: path.join(app.getPath('downloads'), 'cookrew-recovery-codes.txt'),
        filters: [{ name: 'Text', extensions: ['txt'] }]
      })
      if (picked.canceled || !picked.filePath) return { ok: false, reason: 'cancelled' }
      try {
        writeFileSync(picked.filePath, `${codes.join('\n')}\n`, {
          encoding: 'utf8',
          mode: 0o600
        })
        chmodSync(picked.filePath, 0o600)
        return { ok: true }
      } catch (error) {
        // The path, never the codes — an error line is the one place a secret
        // reaches a log by accident.
        console.error('Could not save the recovery codes:', error)
        return { ok: false, reason: 'write_failed' }
      }
    },
    // Seats & Teams (phase 5). The door is wired even with no account on this
    // Mac — `Accounts.authed` answers `no_account` and the tab says so.
    seats: { door: doorSeats, serving: servedTeamRefs, origin: registryOrigin() }
  })

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

  /**
   * Translate a checkpoint body with Sous. The renderer holds the text already
   * (it rendered it), so it sends the text rather than a checkpoint id — this
   * handler never reads a session file and cannot translate a checkpoint the
   * caller is not already looking at.
   *
   * Never throws at the boundary: a rejected invoke gives the renderer an
   * Error whose message it would have to parse to say anything useful. The
   * failure reasons are a closed set, so they come back as data.
   */
  // Which Sous is configured — the renderer says "sent to <host>" with it, so
  // "this text left the machine" is on screen rather than in a config file.
  ipcMain.handle('sous:host', () => remoteSousHost())
  ipcMain.handle('sous:translate', async (_e, text: unknown, language: unknown) => {
    if (typeof text !== 'string' || typeof language !== 'string') {
      return { ok: false, failure: 'unusable-output' }
    }
    if (text.length > TRANSLATE_MAX_CHARS) return { ok: false, failure: 'too-long' }
    try {
      return await translateBody(text, language)
    } catch (error) {
      console.error('sous:translate failed:', error)
      return { ok: false, failure: 'unreachable' }
    }
  })

  // ---- the author journey (Door A), reachable at last -------------------
  //
  ipcMain.handle('workspace:list', () => store.list())
  ipcMain.handle('workspace:create', (_e, name: string, dir: string, team?: string) =>
    team ? createWorkspaceFromTeam(name, dir, team) : createWorkspace(name, dir)
  )
  ipcMain.handle('workspace:check', (_e, name: string, dir: string) => workspaceCheck(store, name, dir))
  // Import a template as a session: one workspace, one orch terminal over HTTP.
  ipcMain.handle('template:import', (_e, team: string, position?: { x: number; y: number }) =>
    importTemplateAsSession(team, position)
  )

  // R30 serving — owner IPC ONLY, never on the listener (the grant-surface rule:
  // this decides what is callable, so it is strictly above the gate it feeds).
  ipcMain.handle(
    'serving:serve',
    async (
      _e,
      input: {
        templateId: string
        access: ServeAccess
        priceUsd?: string
        summary?: string
        tags?: readonly string[]
      }
    ) => {
      if (!teams.load(input.templateId)) return { ok: false, reason: 'no-template' as const }
      if (input.access === 'paid' && servedPayments.rails().length === 0) {
        return { ok: false, reason: 'no-payment-rail' as const }
      }
      // The owner's words, bounded — refused, never trimmed (served-face.ts).
      const words = faceWords({ summary: input.summary, tags: input.tags })
      if (!words.ok) return { ok: false as const, reason: words.reason }
      // The slug is derived from the team's own name and made unique against
      // the workspace namespace it shares — a service must not shadow a
      // workspace the owner named, and a live workspace wins the slug anyway.
      const taken = [
        ...store.list().workspaces.map((w) => w.slug),
        ...serving.served.list().map((s) => s.slug)
      ].filter((s): s is string => typeof s === 'string')
      const slug = uniqueSlug(deriveSlug(input.templateId), taken)
      // One service per template: re-serving replaces its own entry rather
      // than minting a second identity for the same crew.
      const serviceId = `svc-${deriveSlug(input.templateId)}`
      // ONE refusal path. The price shape used to be re-checked here beside the
      // registry's own copy; now every reason — including the orch — comes back
      // from serve() itself, so the owner surface and the gate can never
      // disagree about what is servable.
      const template: ServedTemplate = {
        serviceId,
        templateId: input.templateId,
        slug,
        access: input.access,
        ...(input.access === 'paid' ? { priceUsd: input.priceUsd } : {}),
        ...words.words
      }
      try {
        await serving.serve(template)
      } catch (error) {
        if (error instanceof ServeRefused) return { ok: false as const, reason: error.reason }
        throw error
      }
      // THE RELAY, when it is configured. Its refusal is not the serve's:
      // the team IS being served on this network either way, so a relay that
      // could not be joined narrows the reach rather than undoing the act.
      await joinRelayFor(template)
      // Serving this slug again is the answer to "it moved" — drop the notice
      // rather than leaving a sentence on screen about a door that is back.
      doorsMovedHere = doorsMovedHere.filter((held) => held.slug !== slug)
      publishDoorClaims()
      return { ok: true as const, serviceId, slug, address: servedAddress(slug) }
    }
  )
  ipcMain.handle('serving:stop', async (_e, serviceId: string) => {
    const stopping = serving.served.list().find((t) => t.serviceId === serviceId)
    serving.stop(serviceId)
    if (stopping) {
      await relayServing?.withdraw(stopping.slug)
      doorsMovedHere = doorsMovedHere.filter((held) => held.slug !== stopping.slug)
    }
    publishDoorClaims()
    return { ok: true as const }
  })
  /** The doors this Mac lost to another of the account's, still unanswered. */
  ipcMain.handle('serving:moved', () => doorsMovedHere)
  /**
   * TAKE IT BACK — the second half of the D14 moved card.
   *
   * It dials the same door with the same face, which supersedes the Mac that
   * took it exactly as that Mac superseded this one. Deliberately symmetric:
   * the rule is one holder, not first-come, and an owner pressing this on the
   * machine in front of them is the most explicit statement of which one they
   * mean there is.
   */
  ipcMain.handle('serving:take-back', async (_e, slug: unknown) => {
    if (typeof slug !== 'string' || !relayServing) return { ok: false as const, reason: 'never-served' as const }
    const back = await relayServing.takeBack(slug)
    if (!back.ok) return back
    doorsMovedHere = doorsMovedHere.filter((held) => held.slug !== slug)
    publishDoorClaims()
    return back
  })
  /** Dismiss the notice without taking the door back — KEEP THEIRS, after the fact. */
  ipcMain.handle('serving:moved-clear', (_e, slug: unknown) => {
    doorsMovedHere = doorsMovedHere.filter((held) => held.slug !== slug)
    return { ok: true as const }
  })
  ipcMain.handle('serving:payment-status', () => configuredServedPaymentStatus())
  ipcMain.handle('serving:payment-pay-to', (_e, value: unknown) => {
    const result = servedPayments.setPayTo(typeof value === 'string' ? value : '')
    return result.ok ? { ...result, status: configuredServedPaymentStatus() } : result
  })
  ipcMain.handle('serving:payment-stripe', (_e, value: unknown) => {
    const result = servedPayments.setStripeSecret(typeof value === 'string' ? value : '')
    return result.ok ? { ...result, status: configuredServedPaymentStatus() } : result
  })
  ipcMain.handle('serving:list', () =>
    serving.served.list().map((t) => ({
      ...t,
      ...servedReach(t.slug),
      paymentRails: t.access === 'paid' ? servedPaymentRails(servedPaymentTerms(t)) : []
    }))
  )
  /** The owner's Sessions table: who is on, on which version. */
  ipcMain.handle('serving:sessions', () =>
    serving.instantiator.sessions().map((s) => ({
      sessionId: s.identity.sessionId,
      serviceId: s.serviceId,
      caller: s.accountId,
      workspaceName: s.identity.workspaceName,
      version: s.version,
      // The door's own card for this session — what a caller's imported card
      // is a line into. Owner-only; the twin-census gate diffs the two.
      conductorId: serving.instantiator.conductorFor(s.identity.sessionId)
    }))
  )
  /**
   * D7: who is at each served door, for the avatars on the door's card.
   *
   * OWNER-ONLY, unlike its older neighbours on this seam, because this is the
   * one that carries USERNAMES. A page the owner merely browsed to must not be
   * able to enumerate the people at their doors, and a channel that names
   * strangers is exactly the kind the account IPC's guard exists for.
   */
  ipcMain.handle('serving:callers', ownerOnly(() => servedCallerRows()))
  /** END destroys someone else's workspace, so it is the owner's act alone. */
  ipcMain.handle('serving:end', (_e, sessionId: string) => endServedSession(sessionId))

  // ---- import a served team (caller side): one address, one orch card ----
  ipcMain.handle('serve:inspect', (_e, link: string) => serveOps.inspect(link))

  /**
   * BROWSE AN OWNER — what one account is serving.
   *
   * The import sheet takes a team's address, which assumes the person already
   * has one. An owner hands out their own name at least as often, and until
   * now that was a dead end: you could read their page in a browser and then
   * had to copy a second address out of it by hand.
   *
   * Free and commits nothing, like inspect: it reads a directory, and the door
   * still decides everything when you actually knock.
   */
  ipcMain.handle('serve:browse', (_e, link: string) => serveOps.browse(link))

  /**
   * THE GATE, asked. Sign in as the account the card will use, then open the
   * line once to hear what the door wants. Free doors answer `open` and the
   * import proceeds; a paid one answers `pay` with the terms it quoted, which
   * is what the gate sheet paints.
   *
   * The Bearer never leaves the main process — the renderer drives the sheet,
   * it does not hold the credential.
   */
  ipcMain.handle('serve:gate', (_e, link: string) => serveOps.gate(link))

  /**
   * Start a card payment: the door mints a hosted Checkout session and we open
   * it in the user's REAL browser. It cannot be paid inside the app — an
   * embedded page has no wallet and no autofill — and a hosted page is where
   * Stripe wants the card, so the hand-off is the honest move.
   */
  ipcMain.handle('serve:checkout', async (_e, link: string) => {
    const checkout = await serveOps.checkout(link)
    // The desktop opens the hosted page in the user's REAL browser itself; a
    // phone opens the URL it is handed, in its own.
    if (checkout.ok) await shell.openExternal(checkout.url)
    return checkout
  })

  /**
   * Present a payment and be admitted. For a card that is the Checkout session
   * id; for x402 it is a transfer authorization signed HERE, by the wallet the
   * owner of this device provisioned — the key never reaches the renderer.
   *
   * On success the session is open at the author's app, so the card placed
   * next opens its line into it and never meets the money.
   */
  ipcMain.handle('serve:settle', (_e, link: string, rail: 'x402' | 'stripe', session?: string) =>
    serveOps.settle(link, rail, session)
  )
  /**
   * Place the imported team's interface: ONE orch card on the caller's own
   * canvas, running the line script. The card is the door — the team behind it
   * runs in the session workspace the author's app mints for this caller.
   */
  ipcMain.handle(
    'serve:import',
    (_e, link: string, position?: { x: number; y: number }, paid?: { price: string; asset: string; rail: 'x402' | 'stripe' }) =>
      serveOps.import(link, position, paid)
  )

  /**
   * THE SCREEN WALL'S PICTURES.
   *
   * Taken when the wall OPENS, which is the moment a workspace stops being
   * looked at — the canvas is still on screen and still current, and the
   * person is by definition on their way somewhere else. Never on a timer.
   *
   * The rect comes from the renderer because only it knows where the canvas
   * sits; `capturePage` takes CSS pixels, which is what a DOMRect already is.
   */
  ipcMain.handle('workspace:snap', async (_e, rect: { x: number; y: number; width: number; height: number }) => {
    const id = store.focusedId
    if (!id) return false
    return workspaceShots.capture(id, rect)
  })
  ipcMain.handle('workspace:shots', () => currentWorkspaceShots())
  /** Whether the terminals' herdr server predates this macOS login (terminal-session.ts). */
  ipcMain.handle('terminals:session', () => readTerminalSession())

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
  ipcMain.handle('workspace:brief', (_e, id: string, brief: unknown) => {
    store.setWorkspaceBrief(id, brief)
    return store.list()
  })
  ipcMain.handle('workspace:icon', (_e, id: string, icon: unknown) => {
    store.setWorkspaceIcon(id, icon)
    return store.list()
  })
  // Workspace v2: remove + multi-directory + per-terminal cwd + git.
  ipcMain.handle('workspace:removePlan', (_e, id: string) => workspaceRemovePlan(id))
  ipcMain.handle('workspace:remove', (_e, id: string, options?: { worktree?: boolean }) =>
    removeWorkspaceWith(id, options)
  )
  ipcMain.handle('workspace:dir:add', (_e, id: string, dir: string) => addWorkspaceDir(id, dir))
  ipcMain.handle('workspace:dir:remove', (_e, id: string, dir: string) =>
    removeWorkspaceDir(id, dir)
  )
  ipcMain.handle('workspace:dir:setPrimary', (_e, id: string, dir: string) =>
    setPrimaryDir(id, dir)
  )
  ipcMain.handle('terminal:setCwd', (_e, nodeId: string, dir: string) => setTerminalCwd(nodeId, dir))
  // THE DIALS (agent-tuning) — the zoomed card's left rail. Reading and
  // turning share one deps object so the rail can never show a value the
  // record did not state: the readout comes off the harness's own session
  // file, and turning a dial is one line typed through the ordinary input
  // gate, not a privileged side channel.
  ipcMain.handle('terminal:tuning', (_e, terminalId: string) =>
    tuningStateOf(tuneDeps(), terminalId)
  )
  ipcMain.handle('terminal:tune', (_e, terminalId: string, knob: TuneKnob, value: string) =>
    applyTuning(tuneDeps(), terminalId, knob, value)
  )
  // EVERY agent the fleet knows, not only the open workspace: the roster spans
  // workspaces that are not loaded, and a card there wears the same tag. The
  // durable registry holds exactly what a readout needs (command, cwd, session
  // ref), so nothing has to be resident to be readable.
  ipcMain.handle('tuning:list', () => tuningFleet())
  // The route (route program): read on demand, pushed on change (routeService).
  ipcMain.handle('route:state', () => routeService.refresh())
  ipcMain.handle('route:set-default', (_e, model: string | null) => routeService.setDefault(model))
  ipcMain.handle('route:set-shared-mcp', (_e, on: boolean) => routeService.setSharedMcp(on === true))
  ipcMain.handle('terminal:route', (_e, terminalId: string) => routeService.cardState(terminalId))
  ipcMain.handle('terminal:route-set', (_e, terminalId: string, route: string) =>
    routeService.setCardRoute(terminalId, route)
  )
  ipcMain.handle('git:info', (_e, dir: string) => gitCache.info(dir))
  // Lanes: worktree per agent, landing as a product action (lanes.ts).
  // The sealed slots (R4): the zoom editor's SEAL button and its listing.
  // The value crosses IPC once, into the store, and is never sent back.
  const desktopSecrets = withSecretActivity(secrets, 'This Mac', recordSecretChange)
  ipcMain.handle('secret:put', (_e, name: string, value: string, served?: boolean) =>
    desktopSecrets.put(name, value, { served: served === true })
  )
  ipcMain.handle('secret:list', () => secrets.list())
  ipcMain.handle('secret:remove', (_e, name: string) => desktopSecrets.remove(name))
  ipcMain.handle('lane:list', (_e, dir: string) => laneList(dir))
  ipcMain.handle('lane:open', (_e, nodeId: string, name: string) => laneOpen(nodeId, name))
  ipcMain.handle('lane:land', (_e, nodeId: string, opts?: { close?: boolean; gate?: string[] | null }) =>
    laneLand(nodeId, opts ?? {})
  )
  ipcMain.handle('lane:close', (_e, nodeId: string, force?: boolean) => laneClose(nodeId, force ?? false))
  ipcMain.handle('lane:auto', (_e, nodeId: string, on: boolean) => laneAuto(nodeId, on))
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
    lazyTerminals.reconsider(activity.terminalId)
    // A routed card in flight is followed at the gateway; at rest, it is not.
    routeService.onActivity(activity.terminalId, activity.phase)
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('terminal:activity', activity)
      announceTuning(activity.terminalId)
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
  ipcMain.handle('turn:history', (_e, terminalId: string) => turnHistoryFor(terminalId))
  // Checkpoint search: scan the whole ledger in MAIN and return matches with a
  // capped snippet. Turn bodies never cross the wire.
  ipcMain.handle('turn:search', (_e, query: string, limit?: number) =>
    searchTurns({ ledger: turnStore.loadAll(), query, limit })
  )
  // Context-view v2: paged transcript windows with full prompt+reply bodies.
  ipcMain.handle('turn:page', (_e, terminalId: string, request?: TurnPageRequest) =>
    turnPageFor(terminalId, request ?? {})
  )
  // Trace-sourced context: identity-keyed windows straight from agent files.
  ipcMain.handle('trace:index', (_e, terminalId: string, request?: unknown) =>
    traceIndexFor(terminalId, (request ?? {}) as Parameters<TraceReader['index']>[1])
  )
  ipcMain.handle('trace:markers', (_e, terminalId: string) => traceMarkersFor(terminalId))
  ipcMain.handle('trace:lineage', (_e, terminalId: string) => lineageSegmentsFor(terminalId))
  ipcMain.handle('trace:page', (_e, terminalId: string, request?: unknown) =>
    tracePageFor(terminalId, (request ?? {}) as Parameters<TraceReader['page']>[1])
  )
  // T1 card preview (trace-perf-architecture): the LATEST checkpoint only, from
  // a bounded tail read — no PTY, O(tail). A visible-but-unzoomed card asks this.
  ipcMain.handle('trace:latest', (_e, terminalId: string) => latestCheckpointFor(terminalId))
  // T4 push: a card subscribes while it shows a checkpoint; the file watch then
  // nudges it (`trace:latest-changed`) on every append, no poll wait.
  ipcMain.handle('trace:latest-watch', (_e, terminalId: string) => {
    if (isDoorCard(terminalId)) doorWatch.subscribe(terminalId)
    else latestWatch.subscribe(terminalId)
  })
  ipcMain.handle('trace:latest-unwatch', (_e, terminalId: string) => {
    // Both, unconditionally: by the time a removed card's view unmounts the
    // node no longer resolves, and routing by source here would strand the
    // door poll forever. Each is a no-op when it holds nothing.
    doorWatch.unsubscribe(terminalId)
    latestWatch.unsubscribe(terminalId)
  })
  // A remote card's rail says WHY it is empty or stale, in a sentence (P10).
  ipcMain.handle('trace:status', (_e, terminalId: string) => transcriptStatusFor(terminalId))

  // ONE STREAM, THE DESKTOP'S DOOR (one-stream T3). T2 put the stream behind
  // HTTP, which is the wire the COMPANION has; this renderer has no origin to
  // fetch, so without these five reads "the renderer reads one stream" would
  // be true of the phone and false of the Mac. Same StreamService, same
  // projections (stream-ipc.ts) — nothing is re-derived for this door.
  //
  // There is no live channel here on purpose: the file watch behind
  // trace:latest-watch already says "this card's record changed", and the
  // bridge transport rides it to re-read the tail and the marks. One watcher,
  // not two.
  ipcMain.handle('stream:open', (_e, terminalId: string) => streamOpen(terminalId, streamIpcDeps))
  ipcMain.handle('stream:index', (_e, terminalId: string, request?: unknown) =>
    streamIndex(terminalId, (request ?? {}) as StreamCursorRequest, streamIpcDeps)
  )
  ipcMain.handle('stream:blocks', (_e, terminalId: string, request?: unknown) =>
    streamBlocks(terminalId, (request ?? {}) as StreamCursorRequest, streamIpcDeps)
  )
  ipcMain.handle('stream:tail', (_e, terminalId: string) => streamTail(terminalId, streamIpcDeps))
  ipcMain.handle('stream:marks', (_e, terminalId: string) => streamMarks(terminalId, streamIpcDeps))
  // THE ONLY WRITE IN THIS DESIGN. marks.ts owns the refusal (a patch carrying
  // conversation text, or a key outside the mark's own five, throws) and the
  // result is handed back as data rather than as a rejected invoke, so the
  // renderer can say WHICH key was refused.
  ipcMain.handle('stream:mark', (_e, terminalId: string, patch: unknown) => {
    try {
      return streamService.writeMark(terminalId, patch as MarkPatch)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  // Observability event log: filtered history + counts + agent roster.
  ipcMain.handle('events:query', (_e, query) => events.query(query ?? {}))
  ipcMain.handle('events:count', (_e, query) => events.count(query ?? {}))
  ipcMain.handle('agents:list', () => agents.list())
  ipcMain.handle('agents:launch-check', (_e, id: string) => checkLaunch(id))
  ipcMain.handle('strays:list', () => listStrayPanes())
  ipcMain.handle('strays:end', (_e, session: string) => endStrayPane(session))
  // Activity Board snapshot for the desktop panel — same builder the HTTP
  // route and the SSE push use, so the three can never drift apart.
  ipcMain.handle('board:list', (_e, window?: unknown) =>
    buildBoard(
      boardSources(),
      boardWindowMs(typeof window === 'string' ? window : null)
    )
  )
  // A desktop board panel that stays open: hold the probe, push on change,
  // release on the last unsubscribe, the page going, or the renderer going
  // (src/main/board-hold.ts owns the rules and has the units).
  const boardHolds = createBoardHolds({ sources: boardSources, turns, store })
  ipcMain.handle('board:subscribe', (event) => boardHolds.subscribe(event.sender))
  ipcMain.handle('board:unsubscribe', (event) => boardHolds.unsubscribe(event.sender))
  // The header's device step: this desktop by the name its account record
  // gives it (the name /me and the phone show), else the renderer's fallback.
  ipcMain.handle('machine:name', () => accounts.account()?.name ?? null)
  // The ⋯ row's two questions (TelemetryRow.tsx).
  ipcMain.handle('telemetry:status', () => telemetryStatus())
  ipcMain.handle('telemetry:set', (_e, on: unknown) => (typeof on === 'boolean' ? setTelemetryOn(on) : telemetryStatus()))
  // And the update check's (UpdateRow.tsx). Packaged only, so a source build answers null and shows no row.
  const updateCheck = app.isPackaged
    ? createUpdateCheck({
        version: app.getVersion(),
        file: path.join(homedir(), '.cookrew', 'update-check.json'),
        // Electron's own stack, not Node's: it honours the system proxy.
        fetch: (url, init) => net.fetch(url, init),
        publish: publishUpdateStatus,
        installer: electronUpdateInstaller()
      })
    : null
  ipcMain.handle('update:status', () => updateCheck?.status() ?? null)
  ipcMain.handle('update:set', (event, on: unknown) => {
    if (updateCheck === null) return null
    if (typeof on !== 'boolean' || !ownerFrame(event)) return updateCheck.status()
    const status = updateCheck.setOn(on)
    publishUpdateStatus(status)
    return status
  })
  // A restart ends the app, so the owner reads what it does to agents first.
  ipcMain.handle('update:restart', async (event) => {
    if (updateCheck === null || !ownerFrame(event) || !mainWindow) return false
    const { title, sentence, yes } = restartConfirm(currentBuild(), 'here')
    const { response } = await dialog.showMessageBox(mainWindow, { type: 'question', message: title, detail: sentence, buttons: [yes, 'Later'], defaultId: 0, cancelId: 1 })
    return response === 0 && updateCheck.restart()
  })
  updateCheck?.start()
  // THE ZOOM NAVIGATOR'S DEVICES (zoom-fleet.ts): this desktop's fleet feed,
  // pushed per window like the board, and the account's desktops from the
  // registry, cut to directory facts before they reach the renderer.
  registerZoomFleetIpc(ipcMain.handle.bind(ipcMain), {
    service: localFleetService,
    authed: (pathname) => accounts.authed<unknown>(pathname),
    deviceId: () => accounts.account()?.deviceId ?? null
  })
  ipcMain.handle('agent:recover', (_e, id: string) => recoverAgent(id))
  // Endpoint restore channels live alongside the executor (M10).
  registerRestoreIpc(ipcMain.handle.bind(ipcMain), handlers)
  ipcMain.handle('terminal:fork', (_e, sourceId: string, turnIndex?: number) =>
    forkTerminal(sourceId, turnIndex)
  )

  ipcMain.handle('workspace:get', () => store.focusedState)
  ipcMain.handle('browser:interactive-enabled', () => interactiveBrowserEnabled())
  // ownerOnly: this token makes a socket the Mac's own viewer, unseen by the host and past Stop.
  ipcMain.handle('browser:stream-token', ownerOnly(() => desktopBrowserStreamToken))
  // A card's live view, straight from main: the owner window's top frame
  // asks, main answers with one end of a fresh MessageChannel (the nonce
  // pairs the answer with the ask). Anything else asking gets nothing — a
  // browser card's page has no ipcRenderer, and a frame below the top is not
  // the owner (owner-grant.ts · isOwnerSender).
  ipcMain.on('browser-stream:open', (event, browserId: unknown, nonce: unknown) => {
    if (!ownerFrame(event)) return
    if (typeof browserId !== 'string' || browserId.length === 0 || browserId.length > 200) return
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 100) return
    const { port1, port2 } = new MessageChannelMain()
    browserCastIpc.open(browserId, port1)
    event.sender.postMessage('browser-stream:port', { nonce }, [port2])
  })

  ipcMain.handle('node:add', (_e, node: CanvasNode) => addNode(node))
  ipcMain.handle('node:update', (_e, id: string, patch: Partial<CanvasNode>) =>
    updateNode(id, patch)
  )
  // The owner's rename by hand (zoom card, full view head): the same path as
  // `cookrew rename`, so a clash is answered in the same words, and pinned.
  ipcMain.handle('node:rename', (_e, id: unknown, name: unknown) => renameByHand(renameDeps, id, name))
  ipcMain.handle('node:remove', (_e, id: string) => removeNode(id))
  // The window picker, for the window on this desktop: the workspace it shows.
  ipcMain.handle('use:sources', async () => {
    const answer = await useSources.list(store.focusedId, MAC_VIEWER)
    return answer.ok ? answer.value : emptySourceList('unavailable', answer.error)
  })
  ipcMain.handle('use:open-source', async (_e, pick: unknown) => {
    const answer = await useSources.open(store.focusedId, pick, MAC_VIEWER)
    return answer.ok ? { ok: true, card: answer.value.card } : { ok: false, error: answer.error }
  })
  ipcMain.handle('use:screen-settings', ownerOnly(async (pane: unknown) => {
    const answer = await useSources.openSettings(store.focusedId, pane, 'here')
    return answer.ok ? { ok: true } : { ok: false, error: answer.error }
  }))
  // THE REMOTE DESK, from the Mac's own window. The switch and Stop exist only
  // here: there is no route to either, so nothing away from the Mac can reach them.
  // Straight to the desk: the Mac must reach its own switch from any workspace, a served one above all.
  ipcMain.handle('use:remote-access', ownerOnly(() => remoteDesk.access('here')))
  ipcMain.handle('use:remote-control', ownerOnly(async (ask: unknown) => {
    const answer = await useSources.control(store.focusedId, ask, MAC_VIEWER)
    return answer.ok ? { ok: true } : { ok: false, error: answer.error, ...(answer.state ? { state: answer.state } : {}) }
  }))
  ipcMain.handle('use:remote-restart', ownerOnly(async () => {
    const answer = await useSources.restart(store.focusedId, MAC_VIEWER)
    return answer.ok ? { ok: true } : { ok: false, error: answer.error }
  }))
  ipcMain.handle('use:remote-switch', ownerOnly((on: unknown) => (typeof on === 'boolean' ? remoteDesk.setSwitch(on) : { ok: false, error: 'On or off' })))
  ipcMain.handle('use:remote-stop', ownerOnly(() => {
    remoteDesk.stopAll()
    return { ok: true }
  }))
  ipcMain.handle('use:remote-host', ownerOnly(() => remoteDesk.hostView()))

  // connectAcross, not connect: it VALIDATES both ids exist (in any workspace)
  // and mirrors a legitimate cross-workspace edge. store.connect writes an edge
  // for any pair of strings, which is how a renderer caller could leave one
  // pointing at a node the active workspace does not hold.
  ipcMain.handle('node:connect', (_e, aId: string, bId: string) => store.connectAcross(aId, bId))
  ipcMain.handle('node:disconnect', (_e, connId: string) => store.disconnect(connId))

  // Harness presets PLUS saved templates: a template is a terminal preset, so
  // placing it imports the crew as one orch terminal. Templates last, so a
  // built-in always wins a name clash (and createTerminal checks them last too).
  // Each harness preset carries what a new agent of it can start on (the
  // prompt box's tune chip, read off the harness's own catalog).
  ipcMain.handle('preset:list', () => [
    ...PRESETS.map((p) => ({ ...p, launch: launchOfferFor(p.command) })),
    ...teams.list().map((t) => ({ name: t.name, command: `cookrew call · ${t.name}` }))
  ])

  ipcMain.handle('terminal:create', (_e, opts: CreateTerminalOpts) => createTerminal(opts))
  ipcMain.handle('pins:list', (_e, terminalId: string) => pinsFor(terminalId))

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
  // A prompt's picture, as a view scrolls to it: the owner's own renderer reads any picture a prompt names.
  ipcMain.handle('image:read', async (_e, raw: unknown) => {
    const ref = imageRefOf(raw)
    return ref ? promptImages.read(ref, { trusted: true }) : null
  })

  // Terminal stream bridging renderer xterm <-> PTY
  const inputRefusalAnnounced = new Map<string, number>()
  // An answer to a waiting agent's menu, checked against the screen (menu-answer.ts).
  const answerMenu = createMenuAnswerer({
    screen: async (terminalId) => {
      const session = ptys.get(terminalId)
      const shown = session ? await session.settledViewport() : null
      if (shown !== null && waitChoiceOfScreen(shown)) return shown
      return paneRows(terminalId)
    },
    send: (terminalId, keys, inMenu) => {
      idleSleep.touch(terminalId, Date.now())
      const session = ptys.get(terminalId)
      // No mirror under an armed dispatch: a wake flushes through the box's
      // guards, where this Enter would read as a new prompt and preempt it.
      if (!session && turns.hasArmedDispatch(terminalId)) return false
      turns.noteMenuAnswer(terminalId)
      // A card with no mirror wakes one, as for any key.
      if (waker.hold(terminalId, keys)) return true
      return session?.writeMenuKeys(keys, inMenu) === 'allow'
    },
    whole: withPaneBox,
    moved: (terminalId) => {
      turns.refreshBox(terminalId)
      void readPaneMenu(terminalId).catch(() => undefined)
    }
  })
  setMenuAnswerer(answerMenu)
  // The wrist's routes (watch-routes.ts): a token of its own, a short list of routes.
  const watchHost = createWatchHost({
      pairing: watchPairing,
      deviceName: () => localDeviceName(),
      endpoints: mobileEndpointList,
      httpPort: MOBILE_PORT,
      canvas: (workspaceId) => store.workspaceState(workspaceId),
      node: (id) => store.nodeAcrossWorkspaces(id)?.node,
      thumbViewed: noteBrowserViewed,
      thumb: (id) => browserThumbs.frame(id),
      browser: (id) => browserManager.get(id),
      // The last agent's harness; a bare shell takes no first prompt, so it is no harness to start one on.
      lastPreset: () =>
        [...agents.list()].filter((entry) => entry.active && entry.command.trim().length > 0).sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.preset ?? 'Claude Code',
      screen: (id) => ptys.get(id)?.viewportText() ?? null,
      createTerminal,
      stop: async (terminalId) => {
        const session = ptys.get(terminalId)
        if (!session) return false
        return (await ownerSubmit(session, '\u001b', { keyboard: true })).ok
      },
      accountKind: () => (accounts.account() === null ? 'none' : accounts.isPasswordless() ? 'passwordless' : 'password'),
      invite: (current, here) => mintWatchInvite({ accounts, lock: ownerLock }, current, here)
    })
  setWatchHost(watchHost)
  ipcMain.handle(
    'watch:code',
    ownerOnly(() => ({ ...watchPairing.mintCode(), bases: watchHost.bases(), claims: watchPairing.claims }))
  )
  ipcMain.handle(
    'watch:state',
    ownerOnly(() => ({
      paired: watchPairing.paired,
      pending: watchPairing.pending(),
      account: watchHost.accountKind(),
      sealed: true,
      claims: watchPairing.claims
    }))
  )
  ipcMain.handle(
    'watch:invite',
    ownerOnly((current: unknown) => inviteWatch(watchHost, typeof current === 'string' ? current : '', true))
  )
  ipcMain.handle(
    'watch:forget',
    ownerOnly(() => watchPairing.unpair())
  )
  ipcMain.handle('menu:answer', (_e, terminalId: string, body: unknown) => {
    const request = parseMenuRequest(body)
    return request ? answerMenu(terminalId, request) : { ok: false, reason: 'refused' }
  })
  const typeInto = createPacedInput((terminalId, typed) => {
    const data = isAgentTerminal(terminalId) ? blockAsPaste(typed) : typed
    // Keys for an offline agent wake it; they wait for it, then go in in order.
    if (waker.hold(terminalId, data)) return
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
  ipcMain.on('pty:input', (_e, terminalId: string, data: string) => {
    paneInputs.noteWindowKey(terminalId, data)
    idleSleep.touch(terminalId, Date.now())
    typeInto(terminalId, data)
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
  // every byte of output in the renderer. The binding owns the viewer lease so
  // a renderer reload/crash releases it even when React cannot send pty:detach.
  interface PtyForwarder {
    session: PtySession
    sender: Electron.WebContents
    onData: (data: string) => void
    onReplay: (frame: string) => void
    onDestroyed: () => void
  }
  const forwarders = new Map<string, PtyForwarder>()
  const dropForwarder = (
    terminalId: string,
    expected?: PtyForwarder,
    releaseViewer = true
  ): void => {
    const binding = forwarders.get(terminalId)
    if (!binding || (expected && binding !== expected)) return
    binding.session.removeListener('data', binding.onData)
    binding.session.removeListener('replay', binding.onReplay)
    binding.sender.removeListener('destroyed', binding.onDestroyed)
    forwarders.delete(terminalId)
    if (releaseViewer) {
      sessionSync.unsubscribe(terminalId)
      lazyTerminals.release(terminalId)
    }
  }
  ipcMain.handle('pty:attach', (event, terminalId: string) => {
    const previous = forwarders.get(terminalId)
    try {
      const ready = previous
        ? lazyTerminals.ensure(terminalId)
        : lazyTerminals.acquire(terminalId)
      if (!ready) return false
    } catch (error) {
      console.error(`Lazy terminal attach failed for '${terminalId}':`, error)
      return false
    }
    const session = ptys.get(terminalId)
    if (!session) {
      if (!previous) lazyTerminals.release(terminalId)
      return false
    }
    // Replacement keeps the existing viewer + transcript subscription while
    // dropping both listeners and the old sender's destruction hook.
    if (previous) dropForwarder(terminalId, previous, false)
    let binding: PtyForwarder
    const onData = (data: string): void => {
      // The window can be closed or reloaded while the PTY keeps emitting;
      // sending to a destroyed webContents throws "Object has been destroyed".
      if (event.sender.isDestroyed()) {
        dropForwarder(terminalId, binding)
        return
      }
      event.sender.send(`pty:data:${terminalId}`, data)
    }
    // A geometry change re-serializes the mirror; forward that frame to the
    // popout so it never keeps applying herdr's absolute-addressed deltas onto
    // a screen laid out at the previous size. Same listener lifetime as the
    // data forwarder — pty:detach drops both.
    const onReplay = (frame: string): void => {
      if (event.sender.isDestroyed()) {
        dropForwarder(terminalId, binding)
        return
      }
      // The NEW size first, as an attach sends it: a viewer that kept its old
      // grid applied herdr's deltas for another size to it — the phone's
      // garbled screen and doubled lines when the desktop resized the pane.
      event.sender.send(`pty:hello:${terminalId}`, { ...session.geometry(), resized: true })
      event.sender.send(`pty:data:${terminalId}`, frame)
    }
    const onDestroyed = (): void => dropForwarder(terminalId, binding)
    binding = { session, sender: event.sender, onData, onReplay, onDestroyed }
    forwarders.set(terminalId, binding)
    session.on('data', onData)
    session.on('replay', onReplay)
    event.sender.once('destroyed', onDestroyed)
    if (!previous) sessionSync.subscribe(terminalId)
    // Geometry BEFORE bytes: the frame's wrapping is baked in at the mirror's
    // columns, so a popout that paints it at its own width re-wraps every long
    // line. The renderer sizes its xterm from this, then sends the resize kick.
    try {
      event.sender.send(`pty:hello:${terminalId}`, session.geometry())
      // A faithful ANSI frame, not plain text — see PtySession.replayFrame.
      event.sender.send(`pty:data:${terminalId}`, session.replayFrame())
    } catch (error) {
      dropForwarder(terminalId, binding)
      console.error(`Terminal replay failed for '${terminalId}':`, error)
      return false
    }
    return true
  })
  // The popout detaches on close; without this the forwarder would keep
  // serializing every output chunk to a channel nobody listens on.
  // History for this window's live terminal (PtySession.seedFrame): sent down
  // ITS OWN data channel, so it lands in order with the deltas around it and
  // goes to no other viewer.
  ipcMain.handle('pty:seed', async (event, terminalId: string, nonce: string, lines: number) => {
    const session = ptys.get(terminalId)
    if (!session || typeof nonce !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(nonce)) return false
    const frame = await session.seedFrame(Number(lines) || 0, nonce)
    if (frame === null || event.sender.isDestroyed()) return false
    event.sender.send(`pty:data:${terminalId}`, frame)
    return true
  })
  ipcMain.on('pty:detach', (event, terminalId: string) => {
    const binding = forwarders.get(terminalId)
    // A stale/destroyed renderer must not release a replacement window's view.
    if (!binding || binding.sender !== event.sender) return
    dropForwarder(terminalId, binding)
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
  ipcMain.handle('browser:snapshot', async (event, browserId: unknown) => {
    if (typeof browserId !== 'string' || !interactiveBrowserEnabled()) return null
    // The Mac looking at its own screen, in its own window: the one place that
    // picture needs no banner. It skips the cache that serves everyone else.
    if (showsThisMachine(browserId)) {
      const jpeg = ownerFrame(event) ? await browserManager.peek(browserId)?.snapshot().catch(() => null) : null
      return jpeg ? `data:image/jpeg;base64,${jpeg}` : null
    }
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
