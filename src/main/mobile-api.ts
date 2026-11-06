import { blockAsPaste, createEnterPacing } from "./enter-pacing";
import { answerMenuRequest, parseMenuRequest } from "./menu-answer";
import type http from "node:http";
import type { TerminalSession } from "./terminal-session";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceStore } from "./store";
import type { PtyManager } from "./pty";
import type { CloseOutcome } from "./terminal-close";
import type { StrayPane } from "../shared/stray-pane";
import type { LaunchFailure } from "../shared/launch-failure";
import type { TurnTracker } from "./turn-tracker";
import type { DispatchService } from "./dispatch";
import type { CableSignalBus } from "./cable-signal";
import type { CableSignal } from "../shared/cable-signal";
import type { UseSignalBus } from "./use-signal-bus";
import type { UseSignal } from "../shared/use-signal";
import type { EventLog, CookrewEvent, EventQuery } from "./event-log";
import { pageTurns, type TurnRecord } from "../shared/turn";
import type { VersionPinRecord } from "../shared/version-pin";
import type { AgentTuning, AgentTuningState } from "../shared/agent-tuning";
import { TRANSLATE_MAX_CHARS } from "../shared/translate";
import { translateBody } from "./sous-translate";
import { remoteSousHost } from "./sous-remote-config";
import type { AgentRegistry } from "./agent-registry";
import type { RenameOutcome } from "../shared/rename-plan";
import type { TraceReader } from "./trace";
import {
  boardWindowMs,
  buildBoard,
  createBoardNotifier,
  type BoardSources,
} from "./board-index";

import type {
  AgentRole,
  CanvasNode,
  GitInfo,
  LaneInfo,
  LandResult,
  TeamForkSpec,
  TeamClipStatus,
  TeamCopyResult,
  TeamMeta,
  TerminalNodeData,
  WorkspaceList,
  WorkspaceMeta,
  WorkspaceState,
  RecoverResult,
  RestoreResult,
} from "../shared/model";
import { lightenCanvas } from "../shared/wire-canvas";
import { machineCopy } from "../shared/machine-words";
import { SEAT_GONE, type WorkspaceCheck, type WorkspaceRemovePlan } from "../shared/workspace-door";
import { readBytes, readJson, respondJson, startSse, pairingAuthorized, presentedToken } from "./mobile-http";
import { cardCheckpoint, handleWatchClaim, handleWatchHello, handleWatchRoutes, watchRouteAllowed, watchTokenAccepted, watchWriteRefusal } from "./watch-routes";
import { bridgeablePath, SOCKET_BRIDGE_MESSAGE_MAX, SOCKET_BRIDGE_PATH, SOCKET_BRIDGE_POST_MESSAGES, type SocketBridge } from "./socket-bridge";
import { dynamicCompressionStats } from "./http-compress";
import type { SetupLines } from "./setup-line";
import type { StreamService } from "./stream-service";
import { handleStreamRoutes } from "./stream-routes";
import { handleStreamAdapters } from "./stream-adapters";
import type { LoopHealthSnapshot } from "./loop-health";
import { ROUTE_ID_RE, type CardRouteState, type RouteState } from "../shared/route";
import { ownerSubmit } from "./ask";
import { handleUseSourceRoutes, isUseSourceRoute } from "./use-source-routes";
import type { UseSourceService } from "./use-source-service";
import { BATCH_ID, createOnceByKey } from "./once-by-key";
import { MAX_ATTACHMENT_BYTES } from "./attachments";
import type { PromptImageReader } from "./prompt-image";
import type { ImageRef } from "../shared/prompt-images";
import type { SousDoor } from "./socket-server";
import { wallProjection, type InboxRow } from "../shared/inbox-rank";
import type { Surface as SousSurface } from "../shared/sous-intent";
import type { UiCommandEvent } from "../shared/sous-ui";
import { HEAR_MAX_BYTES, type Heard } from "./hear-file";
import { SpeakError, type LocalVoice } from "./local-voice";
import type { EventEmitter } from "node:events";
import type { SecretsStore } from "./secrets-store";
import { isSecretName } from "../shared/secret-slot";
import { RELAY_MARKER, isLoopbackPeer } from "./relay-base";
import { emit } from "./telemetry";

/**
 * THE TRANSPORTS A SECRET VALUE MAY RIDE, each named for why:
 *
 *   TLS       the phone on the LAN or the tailnet, under a trusted name.
 *   relay     a request the canvas bridge carried in (RELAY_MARKER, which
 *             only the bridge on loopback may set — host-gate.ts). It is
 *             accepted BECAUSE the relay leg is TLS hop by hop — phone to
 *             cookrew.dev, cookrew.dev to this Mac's uplink — and not
 *             because it happens to arrive from 127.0.0.1.
 *   loopback  this Mac's own renderer and CLI.
 *
 * A plain-HTTP request from the LAN is none of these and is refused.
 */

/** Open terminal streams by the id their hello announced (POST …/seed). */
const seedStreams = new Map<string, { terminalId: string; send: (event: string, data: unknown) => void }>();

export const sealedTransport = (request: {
  socket: { encrypted?: boolean; remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}): boolean => {
  if (request.socket.encrypted === true) return true;
  const loopback = isLoopbackPeer(request.socket.remoteAddress);
  if (request.headers?.[RELAY_MARKER] === "1") return loopback;
  return loopback;
};

/**
 * A request from another device, not this Mac talking to itself. The relay's
 * bridge arrives on loopback, so there the marker is what says a phone is on
 * the far end; off the loopback the marker proves nothing and the peer does.
 */
export const fromAnotherDevice = (request: {
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}): boolean => {
  const peer = request.socket?.remoteAddress;
  if (peer === undefined) return false;
  return !isLoopbackPeer(peer) || request.headers?.[RELAY_MARKER] === "1";
};

/** A `secret.*` event with its details — the name — withheld. */
export const redactSecretDetails = <T extends { type: string; details?: string }>(event: T): T => {
  if (!event.type.startsWith("secret.")) return event;
  const { details: _details, ...rest } = event;
  return rest as T;
};

const SOUS_SURFACES: ReadonlySet<string> = new Set(["canvas", "zoom", "phone", "home", "cli"]);

/**
 * WHO is on the other end of a decision: the caller's own id when it sends
 * one (the phone's install), and no one when it does not. A caller-less
 * request is NOT bound to its socket address — a dual-stack phone roams
 * between v4 and v6 and between Wi-Fi and the tailnet mid-hold, and the
 * token it minted on one address must still commit from the next. Never the
 * token. The surface defaults to the phone's, the only network surface with a
 * box.
 */
function sousCaller(body: { surface?: string; callerId?: string }): { surface: SousSurface; callerId: string } | undefined {
  if (typeof body.callerId !== "string" || body.callerId.trim() === "") return undefined;
  const surface = SOUS_SURFACES.has(body.surface ?? "") ? (body.surface as SousSurface) : "phone";
  return { surface, callerId: body.callerId.trim().slice(0, 64) };
}
/** A spoken sentence; anything longer is a document and has other routes. */
const SOUS_MAX_TEXT = 2000;

/**
 * Workspace operations shared with the renderer IPC handlers — the mobile
 * HTTP API and ipcMain both delegate to the same functions in index.ts so
 * phone edits behave exactly like desktop edits.
 */
export interface MobileOps {
  /** The window picker's routes (use-source-routes.ts); absent answers 503. */
  useSources?: UseSourceService;
  /** Could this offline card start now? Null when nothing stands in its way. */
  checkLaunch: (id: string) => LaunchFailure | null;
  /** Live panes no card reaches (orphan-reap.ts). */
  listStrayPanes: () => Promise<StrayPane[]>;
  endStrayPane: (session: string) => Promise<CloseOutcome>;
  addNode: (node: CanvasNode) => CanvasNode;
  updateNode: (
    id: string,
    patch: Partial<CanvasNode>,
  ) => CanvasNode | undefined;
  /**
   * The owner's rename by hand (main/agent-rename.ts · renameByHand): the
   * same path as IPC node:rename and `cookrew rename`. Checks its arguments.
   */
  renameNode: (id: string, name: unknown) => RenameOutcome;
  removeNode: (id: string) => CloseOutcome | Promise<CloseOutcome>;
  createTerminal: (opts: {
    name: string;
    preset: string;
    position?: { x: number; y: number };
    orch?: boolean;
    roleName?: string;
    prompt?: string;
    autoName?: boolean;
    /** A new agent's model and effort (shared/launch-tune); main checks it. */
    tune?: unknown;
  }) => CanvasNode;
  forkTerminal: (sourceId: string, turnIndex?: number) => TerminalNodeData;
  listWorkspaces: () => WorkspaceList;
  /** `stay`: make it without moving the desktop (every phone route asks this). */
  createWorkspace: (
    name: string,
    dir: string,
    team: string | undefined,
    options: { stay: boolean },
  ) => WorkspaceMeta | Promise<WorkspaceMeta>;
  /** What a new workspace would be told before it exists; makes nothing. */
  checkWorkspace: (name: string, dir: string) => WorkspaceCheck;
  switchWorkspace: (id: string) => WorkspaceMeta;
  renameWorkspace: (id: string, name: string) => WorkspaceList;
  /** Throws on an unknown workspace or anything but one short mark. */
  setWorkspaceIcon: (id: string, icon: unknown) => WorkspaceList;
  /** What removing it stops, deletes and leaves, said before it is done. */
  workspaceRemovePlan: (id: string) => Promise<WorkspaceRemovePlan>;
  /** Throws on an unknown workspace or a brief that fails shared/workspace-brief.ts. */
  setWorkspaceBrief: (id: string, brief: unknown) => WorkspaceList;
  /** Workspace v2: remove workspace + multi-dir + per-terminal cwd + git. */
  removeWorkspace: (
    id: string,
    options?: { worktree?: boolean },
  ) => Promise<WorkspaceList>;
  addWorkspaceDir: (id: string, dir: string) => WorkspaceList;
  removeWorkspaceDir: (id: string, dir: string) => WorkspaceList;
  setPrimaryDir: (id: string, dir: string) => WorkspaceList;
  /** Async: the respawn waits for the old session to actually be gone. */
  setTerminalCwd: (nodeId: string, dir: string) => Promise<CanvasNode>;
  gitInfo: (dir: string) => Promise<GitInfo>;
  /** Lanes (lanes.ts): worktree per agent, landing as a product action. */
  laneList: (dir: string) => Promise<LaneInfo[]>;
  laneOpen: (nodeId: string, name: string) => Promise<CanvasNode>;
  laneLand: (nodeId: string, opts: { close?: boolean; gate?: string[] | null }) => Promise<LandResult>;
  laneClose: (nodeId: string, force: boolean) => Promise<CanvasNode>;
  laneAuto: (nodeId: string, on: boolean) => CanvasNode;
  /** Team fork/save + roles (spec note team-fork-roles-v1). */
  /** `stay`: boot the fork where it stands; the desktop does not move for it. */
  teamFork: (spec: TeamForkSpec, options?: { stay: boolean }) => Promise<WorkspaceMeta>;
  teamSave: (name?: string, nodeIds?: string[]) => TeamMeta;
  teamClipSet: (nodeIds: string[], cut: boolean, worktree?: { name: string }) => TeamClipStatus;
  teamClipGet: () => TeamClipStatus | null;
  teamPaste: () => Promise<TeamCopyResult>;
  teamList: () => TeamMeta[];
  roleSave: (input: {
    nodeId: string;
    name: string;
    rolePrompt: string;
    sourceTurnUuid?: string;
    sourceTurnPrompt?: string;
    sessionCopyRef?: string;
  }) => AgentRole;
  roleList: () => AgentRole[];
  roleDelete: (name: string) => boolean;
}

/** The caller's side of importing a served team; index.ts builds it once. */
export interface ServeOps {
  inspect(link: string): Promise<unknown>;
  browse(link: string): Promise<unknown>;
  gate(link: string): Promise<unknown>;
  checkout(link: string): Promise<unknown>;
  settle(link: string, rail: "x402" | "stripe", session?: string): Promise<unknown>;
  import(
    link: string,
    position?: { x: number; y: number },
    paid?: { price: string; asset: string; rail: "x402" | "stripe" },
  ): Promise<unknown>;
}

export interface MobileApiDeps {
  store: WorkspaceStore;
  /**
   * The workspace this request is FOR — a resolved slug, or null at the
   * unslugged root where the focused session answers as it always has.
   */
  scope?: string | null;
  ptys: PtyManager;
  turns: TurnTracker;
  /** Capability-routed history for local terminals and placed crews. */
  turnHistory?: (terminalId: string) => Promise<TurnRecord[]>;
  /**
   * The LATEST checkpoint for a card, from a bounded tail read of the session
   * file — no PTY (trace-perf-architecture T1). Lets the phone canvas show an
   * idle agent's last turn without opening a mirror, matching the desktop card.
   * Optional so this module serves before it is wired.
   */
  latestCheckpoint?: (
    terminalId: string,
  ) => Promise<{ prompt: string; reply: string; title?: string } | null>;
  /**
   * Version pins (§10) — the rail's third marker class. Optional so this
   * module serves before it is wired; absent answers [], same as a terminal
   * that has never been exported.
   */
  listPins?: (terminalId: string) => readonly VersionPinRecord[];
  /**
   * The sealed slots (secrets-store.ts). Names and dates travel; values
   * travel in exactly one direction — INTO the store, on an owner-token PUT
   * from the note slot. Nothing on this API ever answers a value.
   */
  secrets?: SecretsStore;
  /**
   * The Mac's WebRTC end (rtc-peer.ts): answers a phone's offer with
   * candidates on this Mac's published addresses. Owner token only — the
   * write gate above refuses a POST without pairing.
   */
  rtc?: { answer: (offerSdp: string) => Promise<string | null> };
  /** The browser card's socket over plain HTTP, for the relay (socket-bridge.ts). */
  socketBridge?: SocketBridge;
  /** The build this Mac serves (build-id.ts): sent on every stream, and again when it changes. */
  build?: { id: () => string; bus: EventEmitter };
  /**
   * Cold-boot wait window for a stream open (acquireViewWhenReady). Omitted in
   * production (defaults ~2s in 50ms steps); tests shrink it for determinism.
   */
  viewReady?: { attempts?: number; stepMs?: number };
  /** Observability event log (query/count) — spec observability-event-log-spec. */
  events: EventLog;
  /** Durable agent roster cache (~/.cookrew/agents.json). */
  agents: AgentRegistry;
  /**
   * Sous's door for the phone and for voice-gateway (POST /api/sous/command),
   * and the bus its zoom/zoom-back commands ride to every /api/events
   * subscriber as `ui`. Optional so a test server without a voice has none.
   */
  sous?: SousDoor;
  uiBus?: EventEmitter;
  /**
   * The Mac's ear for a phone's recording (hear-file.ts): GET /api/listen says
   * whether this Mac has one and the language it hears in (a browser's own
   * ear uses it too), POST /api/listen hears the raw audio body.
   */
  hear?: { available: () => boolean; locale: () => string | null; recording: (bytes: Uint8Array) => Promise<Heard> };
  /**
   * The Mac's voice for the phone's spoken replies (local-voice.ts): GET
   * /api/speak says whether the local voice is installed, POST /api/speak
   * answers one chunk of text as audio.
   */
  speak?: LocalVoice;
  /** The HITL inbox (R3): a one-shot read, a hold while a stream is open, and the announcements. */
  inbox?: () => InboxRow[];
  inboxHold?: () => () => void;
  inboxBus?: { on: (event: "inbox", cb: (rows: InboxRow[]) => void) => void; removeListener: (event: "inbox", cb: (rows: InboxRow[]) => void) => void };
  /** HP: RETRY a Sous proposal from the ledger; DISMISS a row. Owner (pairing) scope only. */
  inboxAct?: (id: string) => Promise<{ ok: boolean; error?: string; dispatchId?: string }>;
  inboxDismiss?: (id: string) => boolean;
  /** Late decision revisions (`sous:decision-updated`) for the phone's box, as SSE `sous` frames. */
  sousBus?: EventEmitter;
  /**
   * THE DIALS (shared/agent-tuning) — model and effort, read and turned.
   *
   * The phone gets BOTH halves, not just the readout. This surface is the
   * owner's own canvas reached from their own hand; the case where a card is
   * a line into somebody else's app is a different thing entirely and is
   * already refused by the rail itself (TerminalNodeData.servedSession).
   * Withholding the control here would mean the companion could show you an
   * agent burning max effort and not let you turn it down.
   *
   * Optional so a test server that wires no dials still serves everything
   * else; `tuningBus` carries the same change-gated announcement the desktop
   * renderer gets, so a phone never polls for it.
   */
  tuning?: {
    state: (terminalId: string) => AgentTuningState;
    fleet: () => Record<string, AgentTuning>;
    turn: (terminalId: string, knob: string, value: string) => { ok: boolean; reason?: string };
  };
  tuningBus?: EventEmitter;
  /**
   * Signals on the cables ("A asked B", "B answered A" — cable-signal.ts),
   * one small frame each, so the phone's harness lights the same way the
   * desktop's does. Optional: a test server without agents has none.
   */
  signalBus?: CableSignalBus;
  /** An agent acting on a card (use-signal-bus.ts): the cursor a phone viewer of that card draws. */
  useBus?: UseSignalBus;
  /** The Setup card's lines (setup-line.ts). */
  setupLines?: Pick<SetupLines, "start" | "now" | "current">;
  /**
   * The route program (shared/route.ts): the gateway state, the owner's one
   * default, each card's route. `routeBus` carries 'route' (the whole state,
   * at most once a second) and 'card-route' (one card) for the stream.
   */
  route?: {
    state: () => RouteState;
    setDefault: (model: string | null) => RouteState;
    setSharedMcp: (on: boolean) => RouteState;
    cardState: (terminalId: string) => CardRouteState;
    setCardRoute: (terminalId: string, route: string) => Promise<CardRouteState | { error: string }>;
    health: () => { status: string; source: string | null; providers: number; live: number };
    /** Held while a stream is open, so the gateway's clock runs only while someone looks. */
    hold: () => () => void;
  };
  routeBus?: EventEmitter;
  /**
   * 'changed' once the registry has taken a reach card that differs from the
   * last one it took (reach.ts · onChanged). The stream relays it as `reach`
   * so a phone on the relay plane races the Mac's new names at once instead
   * of on its own minute clock.
   */
  reachBus?: EventEmitter;
  /** Recover an inactive teammate as it was (agent-recover feature). */
  recoverAgent: (id: string) => RecoverResult;
  /** Endpoint restore: rewind an agent to a checkpoint (+ undo). The optional
   *  target names an EARLIER lineage segment the index is counted in. */
  restoreCheckpoint: (
    id: string,
    checkpointIndex: number,
    targetSessionId?: string,
  ) => Promise<RestoreResult>;
  undoRestore: (id: string) => Promise<RestoreResult>;
  /** Trace-sourced context reader (identity-keyed windows over agent files). */
  traces: Pick<TraceReader, 'index' | 'boundaryMarkers' | 'page'>;
  /**
   * THE ONE READER (one-stream T2, docs/site/one-stream-2026-09-07.html).
   *
   * Serves /stream, /stream/index, /stream/live and PUT /stream/marks, and —
   * behind COOKREW_STREAM_ADAPTERS, on by default in this release — answers
   * /turns, /latest and the three /trace routes off the same read. Optional
   * so this module serves before it is wired: absent means the three new
   * routes answer 503 (loud, not an invented empty history) and the five old
   * ones keep answering exactly as they did.
   */
  stream?: StreamService;
  /**
   * Activity Board data plane (cross-workspace task view). Optional so this
   * module compiles and serves before the collectors are wired in index.ts;
   * absent = /api/board answers 503 rather than pretending the board is empty.
   */
  board?: BoardSources;
  /**
   * The main thread's own pulse (loop-health.ts): event-loop delay, ELU and
   * per-loop tick durations. Read-only; absent = /api/health answers 503 so
   * a missing wire-up is loud rather than a fabricated all-clear.
   */
  health?: () => LoopHealthSnapshot;
  /**
   * The Mac's pictures of its canvases (workspace-shots.ts), for the phone's
   * screen wall. A picture of every workspace is a picture of every task the
   * owner has going, so it answers behind the /api GET gate like the board.
   * Absent = 503, so a missing wire-up is loud rather than a wall that quietly
   * says NO SNAPSHOT YET for everything.
   */
  workspaceShots?: () => Record<string, { src: string; at: number }>;
  /** Whether the terminals' herdr server predates this macOS login (terminal-session.ts). */
  terminalSession?: () => Promise<TerminalSession>;
  /**
   * Importing a served team FROM THE PHONE — the desktop's own operations,
   * reached over this API. Absent = the six /api/serve routes answer 503
   * rather than pretending; the phone bridge then reports the refusal.
   */
  serve?: ServeOps;
  /**
   * READ-ONLY scope token (persisted as ~/.cookrew/wall-token). Authorizes the
   * SAME routes as pairingToken but for GET only — there is no separate
   * read-only interface any more. Kept distinct from pairingToken because this
   * URL lives in a Home Assistant script on an always-on screen and must never
   * carry write authority. Field name matches MobileServerDeps.
   */
  wallToken?: string;
  ops: MobileOps;
  presets: readonly { name: string; command: string }[];
  /** Persist a phone-uploaded attachment; returns its absolute path. */
  saveAttachment: (name: string, data: Buffer) => string;
  /** A prompt's pictures (prompt-image.ts), read for a view once they come into view. */
  promptImage?: PromptImageReader;
  /**
   * Pairing token required on every MUTATING route (C1) as
   * `Authorization: Bearer <token>` (or `?token=`). Undefined =
   * unauthenticated (loopback-only embedders, tests).
   */
  pairingToken?: string;
  /** Does this bearer belong to a phone this Mac still admits? */
  companionToken?: (candidate: string) => boolean;
  /**
   * v3 (V3-21): THE decision about a presented credential, when the server
   * supplies one. It supersedes the pairingToken/companionToken comparison
   * below for the pairing scope, so that "the root token opens the admission
   * route and nothing else" is decided in companion-gate.ts and nowhere
   * here. Absent (an embedder, a test), the old comparison stands.
   */
  companionGate?: (presented: string | null) => boolean;
  /**
   * Attach-free dispatch engine (v4 §3). Optional so this module compiles and
   * serves before it is wired; absent = the two dispatch routes answer 503
   * rather than a silent 404 on a route the catalog advertises.
   */
  dispatch?: DispatchService;
  /**
   * Does this terminal carry an armed dispatch stamp (TurnTracker)? The HTTP
   * producers (/input, /ask) refuse 409 while one is armed — a second
   * producer typing into an agent mid-dispatch interleaves two principals'
   * work in one input box and poisons the prompt-identity correlation for
   * both. Absent = no serialization (embedders/tests without a tracker).
   */
  hasArmedDispatch?: (terminalId: string) => boolean;
  /**
   * Keys for an agent that is offline or still waking: true when they were
   * taken (its wake started, they are typed once it is up), false when the
   * running session takes them as usual (agent-wake.ts · hold).
   */
  holdInput?: (terminalId: string, data: string) => boolean;
  /** Acquire/release the local PTY mirror for a zoomed phone transcript. */
  acquireTerminalView?: (terminalId: string) => boolean;
  releaseTerminalView?: (terminalId: string) => void;
  /**
   * A4 subscriber facts: a live terminal stream is a watcher, so its open
   * must hold (and may start) the session-file observation, and its close
   * must hand the terminal back to the drain clock. Optional so this module
   * serves before the sync is wired.
   */
  subscribeTerminal?: (terminalId: string) => void;
  unsubscribeTerminal?: (terminalId: string) => void;
}

/** Base64 inflates ~4/3, so this admits attachments up to the 20MB save cap. */
const ATTACH_BODY_LIMIT = 30_000_000;

/** Raw uploads carry no inflation, so the byte cap is the save cap itself. */
const ATTACH_RAW_LIMIT = MAX_ATTACHMENT_BYTES;

/**
 * Enrich a workspace state with git info for the phone: every terminal node
 * gains `git` (its cwd's GitInfo) and the payload gains `dirsGit` (per
 * workspace dir). All dirs are looked up once through the cache, so the
 * added round-trips are coalesced and cheap.
 */
export async function enrichStateWithGit(
  state: WorkspaceState,
  gitInfo: (dir: string) => Promise<GitInfo>,
): Promise<WorkspaceState & { dirsGit: Record<string, GitInfo> }> {
  const dirs = new Set<string>(state.dirs);
  for (const n of state.nodes) if (n.kind === "terminal") dirs.add(n.cwd);
  const entries = await Promise.all(
    [...dirs].map(async (dir) => [dir, await gitInfo(dir)] as const),
  );
  const byDir = new Map(entries);
  const nodes = state.nodes.map((n) =>
    n.kind === "terminal" ? { ...n, git: byDir.get(n.cwd) ?? null } : n,
  );
  const dirsGit = Object.fromEntries(
    state.dirs.map((d) => [d, byDir.get(d) as GitInfo] as const),
  );
  return { ...state, nodes, dirsGit };
}

/**
 * HTTP/SSE analogue of the renderer's IPC bridge, consumed by the desktop
 * renderer bundle running in a phone browser (remote-api.ts). Returns true
 * when the request was handled.
 */
/**
 * Boot the mirror and hold a viewer once its PTY is resident, tolerating the
 * cold-boot window. `acquireTerminalView` kicks off the on-demand boot; when a
 * cold agent's PTY is not registered on the same tick, poll for it (bounded)
 * rather than 404 immediately — the boot IS in flight, it just needs a beat.
 * Returns false only when the terminal truly cannot come up (no such node,
 * spawn failed) within the window, at which point the poll backstop / retry
 * owns recovery.
 */
export async function acquireViewWhenReady(
  deps: MobileApiDeps,
  ptys: { get: (id: string) => unknown },
  terminalId: string,
  opts: { attempts?: number; stepMs?: number } = {},
): Promise<boolean> {
  // No gating hook (embedders/tests): the terminal is whatever ptys says.
  if (!deps.acquireTerminalView) return true;
  if (deps.acquireTerminalView(terminalId)) return true;
  // Booted but not yet resident — wait (default ~2s in 50ms steps). The boot
  // was kicked off by the acquire above; poll for its PTY without re-booting.
  const attempts = opts.attempts ?? 40;
  const stepMs = opts.stepMs ?? 50;
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, stepMs));
    if (ptys.get(terminalId)) return deps.acquireTerminalView(terminalId);
  }
  return false;
}

/** How long a board read waits for the probe's in-flight pass. */
const PROBE_WARM_MS = 1500;

/** The probe's pass, or the timer, whichever lands first. Never throws. */
async function probeWarmed(board: BoardSources): Promise<void> {
  if (!board.probeWarm) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PROBE_WARM_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([board.probeWarm().catch(() => undefined), bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A /raw batch's outcome; null = no running terminal, and nothing to wake. */
type RawVerdict = Awaited<ReturnType<typeof ownerSubmit>> | null;
/** Keystroke batches already typed, by terminal and the phone's batch id. */
const rawInputOnce = createOnceByKey<RawVerdict>();

/**
 * Boot nonces already honoured, so a stream that reconnects on its own with
 * the same URL is answered with the snapshot it now needs. Forgotten by AGE
 * first — a small count would let the 257th page load un-spend the first
 * one's nonce while its stream is still alive, and a day is longer than any
 * stream a phone holds open — with a large ceiling under it so nobody can
 * make this grow without bound.
 */
const spentBootNonces = new Map<string, number>();
const BOOT_NONCE_TTL_MS = 24 * 60 * 60 * 1000;
/** And a ceiling under the TTL, so a caller minting nonces cannot grow this without bound. */
const BOOT_NONCES_MAX = 4096;

/** True the FIRST time this nonce is seen — the one connect that skips the snapshot. */
export function spendBootNonce(nonce: string | null, now = Date.now()): boolean {
  if (nonce === null || nonce.length === 0 || nonce.length > 64) return false;
  for (const [spent, at] of spentBootNonces) {
    if (now - at > BOOT_NONCE_TTL_MS) spentBootNonces.delete(spent);
  }
  if (spentBootNonces.has(nonce)) return false;
  spentBootNonces.set(nonce, now);
  while (spentBootNonces.size > BOOT_NONCES_MAX) {
    const oldest = spentBootNonces.keys().next().value;
    if (oldest === undefined) break;
    spentBootNonces.delete(oldest);
  }
  return true;
}

/** The owner's Esc, alone; the raw queue batches a double tap into one request. */
const BARE_ESC = /^\x1b+$/;
const paceEnter = createEnterPacing();

const DISPATCH_IN_FLIGHT = "agent has a dispatch in flight";

/** Answer `work`'s result, or a 400 in the words it refused with. */
async function respondRefusable(
  response: http.ServerResponse,
  work: () => unknown,
): Promise<void> {
  try {
    respondJson(response, 200, await work());
  } catch (error) {
    respondJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function dispatchInFlight(response: http.ServerResponse): true {
  respondJson(response, 409, { error: DISPATCH_IN_FLIGHT });
  return true;
}

/** A workspace a phone just made, with the seat that puts the phone on it. */
function seatOn(store: MobileApiDeps["store"], meta: WorkspaceMeta): WorkspaceMeta & { seat?: string } {
  return store.isMultiInstance ? { ...meta, seat: meta.id } : meta;
}

/** The workspace this request's device is on, when it says and it exists. */
function deviceSeat(url: URL, store: MobileApiDeps["store"]): string | null {
  const seat = url.searchParams.get("seat");
  if (!seat || !store.isMultiInstance) return null;
  return store.list().workspaces.some((w) => w.id === seat) ? seat : null;
}

export async function handleMobileApi(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: MobileApiDeps,
): Promise<boolean> {
  const { store, ptys, turns, ops, presets } = deps;
  const method = request.method ?? "GET";
  const p = url.pathname;
  /**
   * THE DEVICE'S SEAT (ruling 11-04: switching is focus only). A phone names
   * the workspace it is on with `?seat=`, so choosing one moves that phone and
   * nothing else. Taken here, before the first await, so everything this
   * request reaches — the ops in index.ts and the routes mobile-server keeps
   * below this one — reads that workspace as focus. A seat that has gone is no
   * seat: the phone is answered for the desktop's workspace and heals itself.
   */
  const seat = deps.scope == null ? deviceSeat(url, store) : null;
  if (seat !== null) store.enterSeat(seat);
  /** It named a workspace that has gone. A read heals; a write must not land elsewhere. */
  const seatGone = deps.scope == null && seat === null && url.searchParams.has("seat") && store.isMultiInstance;
  /** Null at the root; a workspace id under a slug or a device's seat. */
  const scope = deps.scope ?? seat;
  /** The canvas this request answers for. */
  const scopedState = (): WorkspaceState =>
    scope === null ? store.focusedState : store.workspaceState(scope);

  // C1 gate: every state-changing route requires the pairing token. This
  // choke point runs BEFORE any route match (and before the mobile server's
  // own POST routes, which delegate here first), so restore/undo/recover,
  // terminal input, workspace edits, and uploads are all covered. Read-only
  // GETs stay open: EventSource cannot set headers, and with the C2 wildcard
  // gone only same-origin pages can read them cross-site anyway.
  // Two SCOPES over one set of routes (there is no second, degraded API):
  //   pairing   → read + write
  //   read-only → GET only; any other method is refused even with a valid token
  // The global pairing token, OR this phone's own companion token. Both are
  // "pairing" scope: an admitted phone is a paired phone, and the per-device
  // credential exists so forgetting one device ends that device's access
  // rather than nobody's.
  const ownerPairing =
    !!deps.pairingToken &&
    (deps.companionGate
      ? deps.companionGate(presentedToken(request, url))
      : pairingAuthorized(request, url, deps.pairingToken, deps.companionToken));
  // A watch's token clears this gate for its own short list of routes and no
  // other (watch-routes.ts): past here it is what a pairing is for those routes.
  const watchCleared =
    !ownerPairing && watchRouteAllowed(method, p) && watchTokenAccepted(presentedToken(request, url));
  const hasPairing = ownerPairing || watchCleared;
  const hasReadOnly =
    !!deps.wallToken && pairingAuthorized(request, url, deps.wallToken);
  /** Cleared for a read: either scope. */
  const canRead = hasPairing || hasReadOnly;
  // The one place every pairing shows, whichever way it happened: the root
  // token on the LAN, a phone's own token, the relay. Free after the first.
  if (ownerPairing && fromAnotherDevice(request)) emit("phone_paired");

  // What the presented credential is worth. The phone asks BEFORE it acts, so
  // an unpaired device can say "you are unpaired" instead of letting every
  // write fail silently; it is also how a pasted token gets verified during
  // re-pairing. Deliberately open: it discloses whether the caller's OWN token
  // works, never the token itself, and the tokens are 192-bit secrets.
  if (method === "GET" && p === "/api/auth/status") {
    respondJson(response, 200, {
      scope: hasPairing ? "pairing" : hasReadOnly ? "read-only" : "none",
      // False only for an in-process embedder that constructed deps without a
      // token; on the 0.0.0.0 listener it is always true.
      required: !!deps.pairingToken,
      canWrite: !deps.pairingToken || hasPairing,
    });
    return true;
  }

  // Six digits for a watch's token: open, as this route must be, and bounded.
  if (await handleWatchClaim(request, response, method, p)) return true;
  if (handleWatchHello(response, url, method, p)) return true;
  const watchRefusal = watchCleared ? watchWriteRefusal(p) : null;
  if (watchRefusal) {
    respondJson(response, watchRefusal.status, { error: watchRefusal.error });
    return true;
  }

  if (method !== "GET" && deps.pairingToken && !hasPairing) {
    respondJson(response, 401, {
      error: hasReadOnly
        ? "Unauthorized — this token is read-only."
        : "Unauthorized — open the pairing URL shown on the desktop (it carries ?token=).",
    });
    return true;
  }

  // READS ARE CREDENTIALS TOO.
  //
  // The gate above challenged only WRITES, on the reasoning quoted there:
  // "EventSource cannot set headers, and with the C2 wildcard gone only
  // same-origin pages can read them cross-site anyway." Both halves are true
  // and neither defends this listener. Same-origin policy protects a VICTIM'S
  // BROWSER from a page it did not ask for; it does nothing about a direct
  // client, and curl has no origin. This process binds 0.0.0.0, so every GET
  // was answerable by anyone who could reach the port — no token, no pairing,
  // no browser.
  //
  // What that gave away, measured against the routes below rather than
  // imagined: the workspace roster INCLUDING every slug (the first half of an
  // exported agent's call address, and an inventory of what the owner is
  // working on), the full canvas, live pane content, agent transcripts, the
  // event log, the board, saved teams and roles, and git state for the owner's
  // directories. /api/board alone was gated — it had noticed the problem and
  // fixed its own instance of it.
  //
  // The EventSource constraint is REAL, and it is why this uses `canRead`
  // rather than a header check: pairingAuthorized already accepts `?token=`
  // for clients that cannot set headers, which is exactly what /api/board's
  // own gate relies on and what the two SSE routes now send.
  //
  // Scoped to /api/ deliberately. The renderer bundle and its assets are
  // served AROUND this delegation, and an unpaired phone has to be able to
  // load the app in order to be told it is unpaired — a gate that 401s the
  // JavaScript is a gate that removes the pairing screen.
  //
  // /api/auth/status is above this on purpose: it is how an unpaired device
  // learns it is unpaired, it discloses only whether the caller's OWN token
  // works, and it never echoes one back.
  if (method === "GET" && p.startsWith("/api/") && deps.pairingToken && !canRead) {
    respondJson(response, 401, {
      error:
        "Unauthorized — open the pairing URL shown on the desktop (it carries ?token=).",
    });
    return true;
  }

  // Choosing another workspace is how a phone gets out of a seat that has gone.
  if (seatGone && method !== "GET" && p !== "/api/workspaces/switch") {
    respondJson(response, 409, { error: SEAT_GONE });
    return true;
  }

  // What is on the owner's screen: the pairing credential, reads included.
  if (isUseSourceRoute(p)) {
    await handleUseSourceRoutes(request, response, p, {
      service: ops?.useSources,
      workspaceId: scope ?? store.focusedId,
      paired: hasPairing,
      credential: presentedToken(request, url),
    });
    return true;
  }

  if (method === "GET" && p === "/api/workspace") {
    // Embed git per terminal (node.git) and per workspace dir (dirsGit) so
    // phone cards show branch/dirty without a round-trip (Fresco GitChip).
    respondJson(
      response,
      200,
      await enrichStateWithGit(scopedState(), ops.gitInfo),
    );
    return true;
  }
  // The main process reading its own event loop. Behind the /api GET gate
  // above like every other read; the payload is timings and counts, never a
  // token or a path.
  if (method === "GET" && p === "/api/health") {
    if (!deps.health) {
      respondJson(response, 503, { error: "health not wired" });
      return true;
    }
    // The compressor's own ledger rides along: how often a poll was answered
    // from the cache or with a 304 is the number behind the API tails.
    respondJson(response, 200, {
      ...deps.health(),
      compression: dynamicCompressionStats(),
      ...(deps.route ? { route: deps.route.health() } : {})
    });
    return true;
  }
  // A Setup line: the same door the desktop's is. The start is a POST, so it needs
  // pairing, and main types only an allowlisted line at the Setup card's prompt.
  if (p === "/api/setup-line" && deps.setupLines) {
    if (method === "POST") {
      respondJson(response, 200, await deps.setupLines.start(await readJson<unknown>(request)));
      return true;
    }
    if (method === "GET") {
      const terminalId = url.searchParams.get("terminal") ?? "";
      const runId = url.searchParams.get("run");
      respondJson(response, 200, runId === null ? deps.setupLines.current(terminalId) : await deps.setupLines.now(terminalId, runId));
      return true;
    }
  }
  // THE ROUTE. One fleet-wide read for the panel, one write for the owner's
  // default, one read and one write per card. The blanket gates above cover
  // them: GETs need `canRead`, the PUTs need pairing.
  if (p === "/api/route" && method === "GET" && deps.route) {
    respondJson(response, 200, deps.route.state());
    return true;
  }
  if (p === "/api/route/default" && method === "PUT" && deps.route) {
    const body = await readJson<{ model?: unknown }>(request);
    if (body.model !== null && typeof body.model !== "string") {
      respondJson(response, 400, { ok: false, reason: "model must be a string or null" });
      return true;
    }
    respondJson(response, 200, deps.route.setDefault(body.model === "" ? null : body.model));
    return true;
  }
  if (p === "/api/route/shared-mcp" && method === "PUT" && deps.route) {
    const body = await readJson<{ on?: unknown }>(request);
    if (typeof body.on !== "boolean") {
      respondJson(response, 400, { ok: false, reason: "on must be a boolean" });
      return true;
    }
    respondJson(response, 200, deps.route.setSharedMcp(body.on));
    return true;
  }
  const routeMatch = p.match(/^\/api\/terminal\/([^/]+)\/route$/);
  if (routeMatch && deps.route && (method === "GET" || method === "PUT")) {
    const terminalId = decodeURIComponent(routeMatch[1]);
    if (method === "GET") {
      respondJson(response, 200, deps.route.cardState(terminalId));
      return true;
    }
    const body = await readJson<{ route?: unknown }>(request);
    if (typeof body.route !== "string" || !ROUTE_ID_RE.test(body.route)) {
      respondJson(response, 400, { ok: false, reason: "route must be 'direct' or a model id" });
      return true;
    }
    const result = await deps.route.setCardRoute(terminalId, body.route);
    respondJson(response, "error" in result ? 404 : 200, result);
    return true;
  }
  if (method === "GET" && p === "/api/presets") {
    respondJson(response, 200, presets);
    return true;
  }
  if (method === "GET" && p === "/api/activity") {
    respondJson(response, 200, turns.list());
    return true;
  }
  if (
    deps.board &&
    (await handleWatchRoutes({
      request,
      response,
      url,
      method,
      path: p,
      owner: ownerPairing,
      cleared: hasPairing,
      sealed: () => sealedTransport(request),
      board: async () => {
        const board = deps.board as BoardSources;
        await probeWarmed(board);
        return buildBoard(board, boardWindowMs(null));
      },
      activities: () => turns.list(),
      checkpoint: (terminalId) => cardCheckpoint(terminalId, deps.stream, deps.latestCheckpoint),
      active: (() => {
        let closed: Set<string> | null = null;
        return (agentId: string): boolean => {
          closed ??= new Set(deps.agents.list().filter((entry) => !entry.active).map((entry) => entry.id));
          return !closed.has(agentId);
        };
      })(),
    }))
  ) {
    return true;
  }
  // THE DIALS. One fleet-wide read for every card's tag, one per-card read for
  // the zoomed rail, one write to turn a knob. The blanket gates above already
  // cover these: the GETs need `canRead`, the POST needs pairing.
  if (method === "GET" && p === "/api/tuning" && deps.tuning) {
    respondJson(response, 200, deps.tuning.fleet());
    return true;
  }
  const tuningMatch = p.match(/^\/api\/terminal\/([^/]+)\/tuning$/);
  if (tuningMatch && method === "GET" && deps.tuning) {
    respondJson(response, 200, deps.tuning.state(tuningMatch[1]));
    return true;
  }
  // THE SEALED SLOTS — owner token only, GET included: the read-only wall
  // token must not even learn the names. The write gate above already
  // refused a read-only PUT/DELETE; this refuses its GET too.
  // A WEBRTC OFFER, over whatever plane the phone is already on (the relay,
  // at home): the answer carries this Mac's LAN and tailnet candidates and
  // the DTLS fingerprint the direct link is checked against (rtc-peer.ts).
  if (method === "POST" && p === "/api/rtc/offer" && deps.rtc) {
    const body = await readJson<{ sdp?: unknown }>(request);
    if (typeof body.sdp !== "string" || body.sdp.length === 0 || body.sdp.length > 64_000) {
      respondJson(response, 400, { error: "sdp is required" });
      return true;
    }
    try {
      const sdp = await deps.rtc.answer(body.sdp);
      respondJson(response, sdp === null ? 503 : 200, sdp === null ? { error: "no direct link offered" } : { sdp });
    } catch {
      respondJson(response, 400, { error: "offer not accepted" });
    }
    return true;
  }
  // THE BROWSER CARD'S SOCKET OVER PLAIN HTTP (socket-bridge.ts): down as an
  // event stream, up as POSTs — the two things the relay carries.
  if (deps.socketBridge && p === SOCKET_BRIDGE_PATH && method === "GET") {
    const target = url.searchParams.get("path") ?? "";
    if (!deps.socketBridge.open(target, response, presentedToken(request, url)))
      respondJson(response, bridgeablePath(target) ? 503 : 400, { error: "that socket cannot be bridged now" });
    return true;
  }
  const bridgePost = p.match(/^\/api\/socket-bridge\/([0-9a-f-]{36})$/);
  if (deps.socketBridge && bridgePost && method === "POST") {
    const body = await readJson<{ m?: unknown }>(request);
    const messages = Array.isArray(body.m) ? body.m : [];
    if (
      messages.length === 0 ||
      messages.length > SOCKET_BRIDGE_POST_MESSAGES ||
      !messages.every((m): m is string => typeof m === "string" && m.length <= SOCKET_BRIDGE_MESSAGE_MAX)
    ) {
      respondJson(response, 400, { error: "m must be a short list of strings" });
      return true;
    }
    if (!deps.socketBridge.post(bridgePost[1], messages)) {
      respondJson(response, 404, { error: "no such bridged socket" });
      return true;
    }
    response.writeHead(204).end();
    return true;
  }
  const secretMatch = p.match(/^\/api\/secrets(?:\/([^/]+))?$/);
  if (secretMatch && deps.secrets) {
    // No pairing token configured means no owner to answer to: refused, not open.
    if (!deps.pairingToken) {
      respondJson(response, 403, { error: "secrets need a paired companion" });
      return true;
    }
    if (!hasPairing) {
      respondJson(response, 401, { error: "Unauthorized — secrets are the owner's." });
      return true;
    }
    let name: string | null;
    try {
      name = secretMatch[1] === undefined ? null : decodeURIComponent(secretMatch[1]);
    } catch {
      respondJson(response, 400, { error: "not a secret name" });
      return true;
    }
    if (method === "GET" && name === null) {
      respondJson(response, 200, deps.secrets.list());
      return true;
    }
    if (name !== null && !isSecretName(name)) {
      respondJson(response, 400, { error: "not a secret name" });
      return true;
    }
    if (method === "PUT" && name !== null) {
      // THE VALUE CROSSES THE NETWORK HERE, once: over TLS, through the relay
      // (TLS hop by hop), or from this Mac itself — see sealedTransport. A
      // cleartext LAN PUT would hand the value to the Wi-Fi.
      if (!sealedTransport(request)) {
        respondJson(response, 403, { error: "seal from the desktop or over TLS" });
        return true;
      }
      const body = await readJson<{ value?: unknown; served?: unknown }>(request);
      if (typeof body.value !== "string" || body.value.length === 0) {
        respondJson(response, 400, { error: "value is required" });
        return true;
      }
      respondJson(response, 200, deps.secrets.put(name, body.value, { served: body.served === true }));
      return true;
    }
    if (method === "DELETE" && name !== null) {
      respondJson(response, 200, { removed: deps.secrets.remove(name) });
      return true;
    }
  }
  const tuneMatch = p.match(/^\/api\/terminal\/([^/]+)\/tune$/);
  if (tuneMatch && method === "POST" && deps.tuning) {
    const body = await readJson<{ knob?: string; value?: string }>(request);
    if (typeof body.knob !== "string" || typeof body.value !== "string") {
      respondJson(response, 400, { ok: false, reason: "knob and value are required" });
      return true;
    }
    // Every validation that matters lives in applyTuning — the knob name and
    // the value both end up inside a line typed into a live pane, and a second
    // copy of those checks here is a second thing to keep in step.
    respondJson(response, 200, deps.tuning.turn(tuneMatch[1], body.knob, body.value));
    return true;
  }
  // The phone's BLACK BOX (phone-beacon.ts): self-reported page vitals,
  // appended to a file because no Apple inspection channel works against
  // iOS 26.6 and the kernel autopsy gives a weight with no allocator. The
  // last line before a crash is the only profile of the dying page anyone
  // can take. Bounded body, fire-and-forget append, never throws.
  if (method === "POST" && p === "/api/beacon") {
    void readJson(request, 16 * 1024)
      .then((body) => {
        const line = `${new Date().toISOString()} ${JSON.stringify(body)}\n`;
        appendFile(join(tmpdir(), "cookrew-phone-beacon.log"), line, () => undefined);
        // A render crash on a phone (crash-report.ts): said in the dev log
        // too, where the desktop's own crashes already land.
        const report = body as { crash?: unknown; message?: unknown; component?: unknown };
        if (report && report.crash === true && typeof report.message === "string") {
          const where = typeof report.component === "string" ? report.component.split("\n").slice(0, 4).join(" ") : "";
          console.error(`[companion] render crash: ${report.message.slice(0, 300)} — ${where.slice(0, 400)}`);
        }
      })
      .catch(() => undefined);
    respondJson(response, 204, {});
    return true;
  }
  // Activity Board: the cross-workspace, task-first view. Strictly ADDITIVE —
  // /api/activity above still serves the canvas cards byte-for-byte.
  if (method === "GET" && p === "/api/board") {
    // The board turned "know a terminalId to fetch one agent" into "one GET
    // returns every workspace's task text" — a real exposure upgrade on an
    // 0.0.0.0 listener, so this read is gated even though other GETs are not.
    // EventSource cannot set headers, hence ?token= is accepted too.
    if (deps.pairingToken && !canRead) {
      respondJson(response, 401, {
        error: "Unauthorized — the board requires a pairing or read-only token.",
      });
      return true;
    }
    if (!deps.board) {
      respondJson(response, 503, { error: "board index not wired" });
      return true;
    }
    // The probe samples off the main thread now, so the first read after it
    // parked would otherwise paint the map from before the park. Wait for
    // the pass it just kicked — bounded, so a slow backend costs a moment,
    // never the request.
    await probeWarmed(deps.board);
    respondJson(
      response,
      200,
      buildBoard(deps.board, boardWindowMs(url.searchParams.get("window"))),
    );
    return true;
  }

  if (method === "GET" && p === "/api/workspaces") {
    respondJson(response, 200, ops.listWorkspaces());
    return true;
  }
  // The screen wall's pictures. Read when the wall opens, never streamed:
  // each is a JPEG of a whole canvas, and a phone looks at them for seconds.
  if (method === "GET" && p === "/api/workspaces/shots") {
    if (!deps.workspaceShots) {
      respondJson(response, 503, { error: "workspace shots not wired" });
      return true;
    }
    respondJson(response, 200, deps.workspaceShots());
    return true;
  }
  // Terminals from an earlier macOS login: the phone says so too (TerminalSessionNotice).
  if (method === "GET" && p === "/api/terminal-session") {
    if (!deps.terminalSession) {
      respondJson(response, 503, { error: "terminal session not wired" });
      return true;
    }
    respondJson(response, 200, await deps.terminalSession());
    return true;
  }
  if (method === "POST" && p === "/api/workspaces") {
    const body = await readJson<{ name?: string; dir?: string; team?: string }>(
      request,
    );
    // Refused in the check's own sentence (workspace-door.ts); the phone shows it.
    await respondRefusable(response, async () =>
      seatOn(
        store,
        await ops.createWorkspace(body.name ?? "workspace", body.dir ?? "", body.team, {
          stay: store.isMultiInstance,
        }),
      ),
    );
    return true;
  }
  if (method === "POST" && p === "/api/workspaces/check") {
    const body = await readJson<{ name?: string; dir?: string }>(request);
    respondJson(
      response,
      200,
      ops.checkWorkspace(body.name ?? "", body.dir ?? ""),
    );
    return true;
  }
  if (method === "POST" && p === "/api/workspaces/switch") {
    const body = await readJson<{ id?: string }>(request);
    const id = body.id ?? "";
    // One workspace held at a time (the flag off): focus is all there is.
    if (!store.isMultiInstance) {
      ops.switchWorkspace(id);
      respondJson(response, 200, ops.listWorkspaces());
      return true;
    }
    const list = ops.listWorkspaces();
    if (!list.workspaces.some((w) => w.id === id)) {
      respondJson(response, 404, { error: `Workspace '${id}' not found` });
      return true;
    }
    // Nothing moves here. The answer gives the phone its seat, and the phone
    // carries it from now on: the desktop never hears about this.
    respondJson(response, 200, { ...list, activeId: id, seat: id });
    return true;
  }
  if (method === "POST" && p === "/api/workspaces/rename") {
    const body = await readJson<{ id?: string; name?: string }>(request);
    await respondRefusable(response, () =>
      ops.renameWorkspace(body.id ?? "", body.name ?? ""),
    );
    return true;
  }
  if (method === "POST" && p === "/api/workspaces/icon") {
    const body = await readJson<{ id?: string; icon?: unknown }>(request);
    await respondRefusable(response, () =>
      ops.setWorkspaceIcon(body.id ?? "", body.icon),
    );
    return true;
  }
  if (method === "POST" && p === "/api/workspaces/brief") {
    const body = await readJson<{ id?: string; brief?: unknown }>(request);
    try {
      respondJson(
        response,
        200,
        ops.setWorkspaceBrief(body.id ?? "", body.brief),
      );
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  // Workspace v2: remove + directory management + git (mobile = text input).
  const wsMatch = p.match(/^\/api\/workspaces\/([^/]+)$/);
  if (wsMatch && method === "DELETE") {
    const worktree = url.searchParams.get("worktree") === "1";
    await respondRefusable(response, () =>
      ops.removeWorkspace(wsMatch[1], { worktree }),
    );
    return true;
  }
  const wsPlanMatch = p.match(/^\/api\/workspaces\/([^/]+)\/plan$/);
  if (wsPlanMatch && method === "GET") {
    await respondRefusable(response, () =>
      ops.workspaceRemovePlan(wsPlanMatch[1]),
    );
    return true;
  }
  const wsDirMatch = p.match(/^\/api\/workspaces\/([^/]+)\/dirs$/);
  if (wsDirMatch && (method === "POST" || method === "DELETE")) {
    const body = await readJson<{ path?: string }>(request);
    try {
      const list =
        method === "POST"
          ? ops.addWorkspaceDir(wsDirMatch[1], body.path ?? "")
          : ops.removeWorkspaceDir(wsDirMatch[1], body.path ?? "");
      respondJson(response, 200, list);
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  const wsPrimaryMatch = p.match(/^\/api\/workspaces\/([^/]+)\/primary$/);
  if (wsPrimaryMatch && method === "POST") {
    const body = await readJson<{ path?: string }>(request);
    try {
      respondJson(
        response,
        200,
        ops.setPrimaryDir(wsPrimaryMatch[1], body.path ?? ""),
      );
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  if (method === "GET" && p === "/api/git") {
    respondJson(
      response,
      200,
      await ops.gitInfo(url.searchParams.get("dir") ?? ""),
    );
    return true;
  }

  // ---- importing a served team, from the phone ----
  // Six verbs, one shape: POST with a JSON body, the link in it. Positions and
  // payment receipts are validated to their shape here; everything about the
  // door — the sign-in, the 402, the placement — is the same code the desktop
  // sheet drives, and it runs at the desktop. That includes WHICH WALK: the
  // gate verb is serveOps.gate, whose listed/unlisted decision (gateDoorFor)
  // enters a listed team as the account and an unlisted door with the key, so
  // the phone cannot be seated as a different person than the desktop.
  if (method === "POST" && p.startsWith("/api/serve/")) {
    const verb = p.slice("/api/serve/".length);
    if (!["inspect", "browse", "gate", "checkout", "settle", "import"].includes(verb)) {
      return false;
    }
    if (!deps.serve) {
      respondJson(response, 503, { ok: false, reason: "not-wired" });
      return true;
    }
    const body = await readJson<{
      link?: unknown;
      position?: unknown;
      paid?: unknown;
      rail?: unknown;
      session?: unknown;
    }>(request);
    if (typeof body.link !== "string" || body.link.length === 0 || body.link.length > 2048) {
      respondJson(response, 400, { ok: false, reason: "bad-address" });
      return true;
    }
    const link = body.link;
    const position = servePosition(body.position);
    const paid = servePaid(body.paid);
    const rail = body.rail === "x402" || body.rail === "stripe" ? body.rail : null;
    const session = typeof body.session === "string" ? body.session : undefined;
    let answer: unknown;
    if (verb === "inspect") answer = await deps.serve.inspect(link);
    else if (verb === "browse") answer = await deps.serve.browse(link);
    else if (verb === "gate") answer = await deps.serve.gate(link);
    else if (verb === "checkout") answer = await deps.serve.checkout(link);
    else if (verb === "settle") {
      if (rail === null) {
        respondJson(response, 400, { ok: false, reason: "bad-rail" });
        return true;
      }
      answer = await deps.serve.settle(link, rail, session);
    } else answer = await deps.serve.import(link, position, paid);
    respondJson(response, 200, answer);
    return true;
  }

  if (method === "POST" && p === "/api/nodes") {
    const node = await readJson<CanvasNode>(request);
    respondJson(response, 200, ops.addNode(node));
    return true;
  }
  // A rename from the phone's bar: the desktop's own path, its refusal (a
  // clash, an empty name) a 400 in the same words.
  const renameMatch = p.match(/^\/api\/nodes\/([^/]+)\/rename$/);
  if (renameMatch && method === "POST") {
    const body = await readJson<{ name?: unknown } | null>(request);
    const name = body !== null && typeof body === "object" ? body.name : undefined;
    const outcome = ops.renameNode(renameMatch[1], name);
    respondJson(response, outcome.ok ? 200 : 400, outcome);
    return true;
  }
  const nodeMatch = p.match(/^\/api\/nodes\/([^/]+)$/);
  if (nodeMatch && method === "POST") {
    const patch = await readJson<Partial<CanvasNode>>(request);
    respondJson(response, 200, ops.updateNode(nodeMatch[1], patch));
    return true;
  }
  if (nodeMatch && method === "DELETE") {
    // 200 either way: a survivor keeps its card, and the event stream says why.
    respondJson(response, 200, await ops.removeNode(nodeMatch[1]));
    return true;
  }

  if (method === "POST" && p === "/api/connections") {
    const body = await readJson<{ a?: string; b?: string }>(request);
    // connectAcross VALIDATES both ids (this endpoint is unauthenticated and
    // defaulted missing fields to "", persisting an edge between two nodes
    // that do not exist).
    respondJson(response, 200, store.connectAcross(body.a ?? "", body.b ?? ""));
    return true;
  }
  const connMatch = p.match(/^\/api\/connections\/([^/]+)$/);
  if (connMatch && method === "DELETE") {
    store.disconnect(connMatch[1]);
    respondJson(response, 200, { ok: true });
    return true;
  }

  if (method === "POST" && p === "/api/terminals") {
    const opts = await readJson<{
      name: string;
      preset: string;
      position?: { x: number; y: number };
      orch?: boolean;
      roleName?: string;
      prompt?: string;
      autoName?: boolean;
      tune?: unknown;
    }>(request);
    try {
      respondJson(response, 200, ops.createTerminal(opts));
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  // Team fork / save + roles (contract in note team-fork-roles-spec-v1).
  if (method === "POST" && p === "/api/team/fork") {
    const body = await readJson<{ spec?: TeamForkSpec }>(request);
    try {
      if (!body.spec) throw new Error("Missing spec");
      respondJson(response, 200, seatOn(store, await ops.teamFork(body.spec, { stay: store.isMultiInstance })));
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  if (method === "POST" && p === "/api/team/save") {
    const body = await readJson<{ name?: string; nodeIds?: string[] }>(request);
    try {
      if (body.nodeIds !== undefined && !Array.isArray(body.nodeIds)) {
        throw new Error("nodeIds must be an array when present");
      }
      respondJson(response, 200, ops.teamSave(body.name, body.nodeIds));
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  // SELECT-mode clipboard (copy/cut → paste), phone parity with the bar.
  if (method === "POST" && p === "/api/team/clip") {
    const body = await readJson<{
      nodeIds?: string[];
      cut?: boolean;
      worktree?: { name?: string };
    }>(request);
    try {
      if (!Array.isArray(body.nodeIds)) throw new Error("Missing nodeIds");
      const worktree =
        body.worktree && typeof body.worktree.name === "string"
          ? { name: body.worktree.name }
          : undefined;
      respondJson(response, 200, ops.teamClipSet(body.nodeIds, body.cut === true, worktree));
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  if (method === "GET" && p === "/api/team/clip") {
    respondJson(response, 200, ops.teamClipGet());
    return true;
  }
  if (method === "POST" && p === "/api/team/paste") {
    try {
      respondJson(response, 200, await ops.teamPaste());
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  if (method === "GET" && p === "/api/teams") {
    respondJson(response, 200, ops.teamList());
    return true;
  }
  if (method === "GET" && p === "/api/roles") {
    respondJson(response, 200, ops.roleList());
    return true;
  }
  if (method === "POST" && p === "/api/role/save") {
    const body = await readJson<{
      nodeId?: string;
      name?: string;
      rolePrompt?: string;
      sourceTurnUuid?: string;
      sourceTurnPrompt?: string;
    }>(request);
    try {
      if (!body.nodeId || !body.name || !body.rolePrompt) {
        throw new Error("Missing nodeId/name/rolePrompt");
      }
      respondJson(
        response,
        200,
        ops.roleSave({
          nodeId: body.nodeId,
          name: body.name,
          rolePrompt: body.rolePrompt,
          sourceTurnUuid: body.sourceTurnUuid,
          sourceTurnPrompt: body.sourceTurnPrompt,
        }),
      );
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  if (method === "POST" && p === "/api/role/delete") {
    const body = await readJson<{ name?: string }>(request);
    respondJson(response, 200, { deleted: ops.roleDelete(body.name ?? "") });
    return true;
  }

  if (method === "POST" && p === "/api/attachments") {
    // TWO shapes, and the raw one is the fast path.
    //
    // Base64-in-JSON cost 33% more bytes over a link where bytes are the
    // scarce thing, and cost the MAIN process a 27 MB string concat plus a
    // JSON.parse of it — the app froze for the length of every upload. Raw
    // bytes with the name in the query have neither problem.
    //
    // The JSON shape stays for a phone still running a cached older bundle;
    // dropping it would break uploads until every device reloaded.
    const json = (request.headers["content-type"] ?? "").includes(
      "application/json",
    );
    try {
      const name = json ? undefined : url.searchParams.get("name");
      const data = json
        ? null
        : await readBytes(request, ATTACH_RAW_LIMIT);
      const body = json
        ? await readJson<{ name?: string; data?: string }>(
            request,
            ATTACH_BODY_LIMIT,
          )
        : null;
      const bytes =
        data ??
        (typeof body?.data === "string" && body.data.length > 0
          ? Buffer.from(body.data, "base64")
          : null);
      if (!bytes || bytes.length === 0) {
        respondJson(response, 400, { error: "Missing data" });
        return true;
      }
      respondJson(response, 200, {
        path: deps.saveAttachment(name || body?.name || "file", bytes),
      });
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  // A PROMPT'S PICTURES (prompt-image.ts), one at a time, as a view scrolls
  // to them. Below the GET gate like every read; the reader itself keeps a
  // path inside the attach store and an image block inside the card's own
  // session files.
  const imageMatch = p.match(/^\/api\/terminal\/([^/]+)\/image$/);
  if (method === "GET" && (p === "/api/image" || imageMatch)) {
    const q = url.searchParams;
    const ref: ImageRef | null = imageMatch
      ? /^[A-Za-z0-9-]{1,64}$/.test(q.get("uuid") ?? "") && /^\d{1,4}$/.test(q.get("i") ?? "") && q.get("file")
        ? { terminalId: decodeURIComponent(imageMatch[1]), file: q.get("file") as string, uuid: q.get("uuid") as string, i: Number(q.get("i")) }
        : null
      : q.get("path")?.startsWith("/")
        ? { path: q.get("path") as string }
        : null;
    const image = ref && deps.promptImage ? await deps.promptImage.read(ref, { trusted: false }) : null;
    if (!image) {
      respondJson(response, 404, { error: "No such picture" });
      return true;
    }
    response.writeHead(200, {
      "content-type": image.mime,
      "content-length": String(image.bytes.length),
      // A picture at an address never changes: a pasted image is part of an
      // append-only record, an attachment is never overwritten (attachments.ts).
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    });
    response.end(Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.length));
    return true;
  }

  // ---- ONE STREAM (T2) ----
  //
  // THE NEW ROUTES, beside the old ones rather than instead of them:
  // /stream/open (T2.5 — the rail's first page, the tail and the backwards
  // cursor in ONE read), /stream/index (the rail, paged), /stream (a window
  // of blocks by identity), /stream/live (the open tail over SSE) and PUT
  // /stream/marks (the only write). They sit below the auth gates above and
  // are covered by them — the GET gate reaches every new leaf by path, so
  // adding one never adds a hole — the C1 pairing gate covers the PUT,
  // because a second, differently-worded gate is how one ends up weaker.
  if (await handleStreamRoutes(request, response, url, deps)) return true;
  // THE FIVE OLD ROUTES, AS ADAPTERS over that same reader. Returns false —
  // and the original handlers below run untouched — when the flag is off,
  // when the reader is not wired, or for a card whose record is not a
  // transcript this process can walk (a door's lives at the author's app, a
  // scrape card's is the PTY). "A regression is a flag flip, not a restore"
  // is only true because the fallback is the ORIGINAL code, not a rewrite.
  if (await handleStreamAdapters(request, response, url, deps)) return true;

  const traceIndexMatch = p.match(/^\/api\/terminal\/([^/]+)\/trace\/index$/);
  if (traceIndexMatch && method === "GET") {
    const raw = url.searchParams.get("afterIndex");
    const parsed = raw === null ? undefined : Number(raw);
    respondJson(
      response,
      200,
      await deps.traces.index(traceIndexMatch[1], {
        afterIndex: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
      }),
    );
    return true;
  }

  // Boundary markers for the rail: ◆ compact (in-file) + ⇥ clear (lineage).
  const traceMarkersMatch = p.match(/^\/api\/terminal\/([^/]+)\/trace\/markers$/);
  if (traceMarkersMatch && method === "GET") {
    respondJson(response, 200, await deps.traces.boundaryMarkers(traceMarkersMatch[1]));
    return true;
  }

  const traceMatch = p.match(/^\/api\/terminal\/([^/]+)\/trace$/);
  if (traceMatch && method === "GET") {
    const num = (key: string): number | undefined => {
      const raw = url.searchParams.get(key);
      const parsed = raw === null ? NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    respondJson(
      response,
      200,
      await deps.traces.page(traceMatch[1], {
        beforeIndex: num("beforeIndex"),
        afterIndex: num("afterIndex"),
        aroundIndex: num("aroundIndex"),
        limit: num("limit"),
      }),
    );
    return true;
  }

  // Version pins for the rail — the phone drew the rail without its third
  // marker class until this existed (remote-api.ts stubbed listPins to []).
  const pinsMatch = p.match(/^\/api\/terminal\/([^/]+)\/pins$/);
  if (pinsMatch && method === "GET") {
    respondJson(response, 200, deps.listPins ? deps.listPins(pinsMatch[1]) : []);
    return true;
  }

  const turnsMatch = p.match(/^\/api\/terminal\/([^/]+)\/turns$/);
  if (turnsMatch && method === "GET") {
    // Context-view v2: any page param present → TurnPage window; bare call
    // keeps returning the legacy full array (lite client unaffected).
    const num = (key: string): number | undefined => {
      const raw = url.searchParams.get(key);
      const parsed = raw === null ? NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const request = {
      offset: num("offset"),
      limit: num("limit"),
      aroundIndex: num("aroundIndex"),
      beforeIndex: num("beforeIndex"),
    };
    const paged =
      request.offset !== undefined ||
      request.limit !== undefined ||
      request.aroundIndex !== undefined ||
      request.beforeIndex !== undefined;
    const history = deps.turnHistory
      ? await deps.turnHistory(turnsMatch[1])
      : turns.history(turnsMatch[1]);
    respondJson(
      response,
      200,
      paged
        ? pageTurns(history, request)
        : history,
    );
    return true;
  }
  // Trace-perf T1: the latest checkpoint only, tail-read, no PTY. The phone
  // canvas asks this for a visible-but-unzoomed agent card.
  const latestMatch = p.match(/^\/api\/terminal\/([^/]+)\/latest$/);
  if (latestMatch && method === "GET") {
    const cp = deps.latestCheckpoint
      ? await deps.latestCheckpoint(latestMatch[1])
      : null;
    respondJson(response, 200, cp);
    return true;
  }
  // Workspace v2: repoint a terminal's cwd (respawns the pty).
  const cwdMatch = p.match(/^\/api\/terminal\/([^/]+)\/cwd$/);
  if (cwdMatch && method === "POST") {
    const body = await readJson<{ dir?: string }>(request);
    try {
      respondJson(
        response,
        200,
        await ops.setTerminalCwd(cwdMatch[1], body.dir ?? ""),
      );
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  // Lanes: the same four operations the desktop menu calls, so LAND from the
  // phone is the same code path. Errors are the operation's own words.
  if (method === "GET" && p === "/api/lanes") {
    respondJson(response, 200, await ops.laneList(url.searchParams.get("dir") ?? ""));
    return true;
  }
  const laneMatch = p.match(/^\/api\/lanes\/(open|land|close|auto)$/);
  if (laneMatch && method === "POST") {
    const body = await readJson<{ nodeId?: string; name?: string; close?: boolean; gate?: string[] | null; force?: boolean; on?: boolean }>(request);
    const nodeId = body.nodeId ?? "";
    try {
      const answer =
        laneMatch[1] === "open"
          ? await ops.laneOpen(nodeId, body.name ?? "")
          : laneMatch[1] === "land"
            ? await ops.laneLand(nodeId, { close: body.close, gate: body.gate })
            : laneMatch[1] === "close"
              ? await ops.laneClose(nodeId, body.force ?? false)
              : ops.laneAuto(nodeId, body.on ?? false);
      respondJson(response, 200, answer);
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  // Translate a checkpoint body with Sous. The phone posts the text it is
  // already showing — same contract as the desktop's IPC handler, so a
  // translation on the phone is the same code path, not a second one.
  if (p === "/api/translate/host" && method === "GET") {
    respondJson(response, 200, remoteSousHost());
    return true;
  }
  if (p === "/api/translate" && method === "POST") {
    const body = await readJson<{ text?: string; language?: string }>(request);
    if (typeof body.text !== "string" || typeof body.language !== "string") {
      respondJson(response, 200, { ok: false, failure: "unusable-output" });
      return true;
    }
    if (body.text.length > TRANSLATE_MAX_CHARS) {
      respondJson(response, 200, { ok: false, failure: "too-long" });
      return true;
    }
    try {
      respondJson(response, 200, await translateBody(body.text, body.language));
    } catch (error) {
      console.error("mobile translate failed:", error);
      respondJson(response, 200, { ok: false, failure: "unreachable" });
    }
    return true;
  }
  // Acknowledge-on-view: the phone popout counts as viewing the result.
  const seenMatch = p.match(/^\/api\/terminal\/([^/]+)\/seen$/);
  if (seenMatch && method === "POST") {
    turns.seen(seenMatch[1]);
    respondJson(response, 200, { ok: true });
    return true;
  }
  const forkMatch = p.match(/^\/api\/terminal\/([^/]+)\/fork$/);
  if (forkMatch && method === "POST") {
    const body = await readJson<{ turnIndex?: number }>(request);
    try {
      respondJson(
        response,
        200,
        ops.forkTerminal(forkMatch[1], body.turnIndex),
      );
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  // Producer serialization, not a router: /input and /ask are ANSWERED by the
  // mobile server (this returns false so its handlers run), but the refusal
  // lives here with the API deps so every embedder gets it. While a dispatch
  // stamp is armed on a terminal, a second HTTP producer typing into it would
  // interleave two principals' work in one input box AND break the
  // prompt-identity correlation that closes the dispatch — refuse 409 and let
  // the dispatch close first. /raw is a producer too — it writes arbitrary
  // bytes (a prompt plus Enter included) straight into the same input box, so
  // leaving it outside the choke point was a reservation with a side door.
  // Local canvas typing (IPC) is deliberately NOT serialized: the owner at
  // the keyboard outranks the machinery.
  // /menu stays outside: a menu answer feeds the turn already running (a
  // dispatched turn waits on exactly that) and never enters the input box.
  // /raw answers below, once its bytes are read: the owner's Esc goes through.
  const httpProducerMatch = p.match(/^\/api\/terminal\/([^/]+)\/(input|ask)$/);
  if (
    httpProducerMatch &&
    method === "POST" &&
    deps.hasArmedDispatch?.(httpProducerMatch[1]) === true
  ) {
    return dispatchInFlight(response);
  }

  // An answer to a waiting agent's menu: checked against its screen, so a
  // card with no mirror takes one too (menu-answer.ts).
  const menuMatch = p.match(/^\/api\/terminal\/([^/]+)\/menu$/);
  if (menuMatch && method === "POST") {
    const parsed = parseMenuRequest(await readJson<unknown>(request));
    if (!parsed) {
      respondJson(response, 400, { error: "Not a menu answer" });
      return true;
    }
    respondJson(response, 200, await answerMenuRequest(menuMatch[1], parsed));
    return true;
  }

  const ptyMatch = p.match(
    /^\/api\/terminal\/([^/]+)\/(raw|resize|stream|jump|seed)$/,
  );
  if (ptyMatch) {
    const terminalId = ptyMatch[1];
    const openingStream = method === "GET" && ptyMatch[2] === "stream";
    // Opening a stream BOOTS the mirror on demand (lazy attach), and a cold
    // agent's PTY is not resident on the same tick the boot is kicked off — so
    // an immediate 404 makes a just-opened viewer (the desktop popout, the
    // phone, the orch-mirror proxy) spam "retrying" through the whole boot
    // window. Wait briefly for residency instead. This is also what makes a
    // CROSS-WORKSPACE target work: the boot resolves the node across every
    // workspace, but that resolution + spawn takes a beat the first time.
    const acquired = openingStream
      ? await acquireViewWhenReady(deps, ptys, terminalId, deps.viewReady)
      : true;
    if (!acquired) {
      respondJson(response, 404, { error: "Terminal not running" });
      return true;
    }
    const session = ptys.get(terminalId);
    if (method === "POST" && ptyMatch[2] === "raw") {
      const body = await readJson<{ data?: string; id?: string }>(request);
      // A dispatch holds /raw back, all but Esc (owner, 2026-11-04: a phone
      // interrupts a dispatched turn as the keyboard does). It types nothing
      // into the box, and the guard below still stops it mid-delivery.
      const held = (): boolean => deps.hasArmedDispatch?.(terminalId) === true && !BARE_ESC.test(body.data ?? "");
      if (typeof body.data !== "string" && held()) return dispatchInFlight(response);
      if (typeof body.data === "string") {
        const data = body.data;
        // /raw is a producer (Sol r7 P0-2): its bytes can be a prompt plus
        // Enter, so they go through THE submit primitive — classified,
        // leased across paste+CR when submit-capable, ordinarily guarded
        // when not. A refusal is a 409 the caller can act on, never a
        // silently dropped write followed by an ok:true.
        //
        // An agent that is offline (or still waking) takes the keys too:
        // the first wakes it, and they are typed once it is up. Answered at
        // once, so the phone's deadline never runs out on a boot.
        //
        // A batch the phone sent again after getting no answer carries the
        // same id, and is typed once (once-by-key.ts).
        const submit = async (): Promise<RawVerdict> => {
          // Inside the once: a batch already typed that comes again under a new
          // dispatch answers as typed, or its words read as never sent.
          if (held()) return { ok: false, reason: DISPATCH_IN_FLIGHT };
          await paceEnter(terminalId, data);
          const node = store?.nodeAcrossWorkspaces(terminalId)?.node;
          const agent = node?.kind === "terminal" && node.command.trim().length > 0;
          const keys = agent ? blockAsPaste(data) : data;
          if (deps.holdInput?.(terminalId, keys) === true) return { ok: true, submitted: false };
          return session ? ownerSubmit(session, keys, { keyboard: true }) : null;
        };
        const verdict =
          typeof body.id === "string" && BATCH_ID.test(body.id)
            ? await rawInputOnce(`${terminalId}:${body.id}`, submit)
            : await submit();
        if (verdict === null) {
          respondJson(response, 404, { error: "Terminal not running" });
          return true;
        }
        if (!verdict.ok) {
          respondJson(response, 409, { error: verdict.reason });
          return true;
        }
      } else if (!session) {
        respondJson(response, 404, { error: "Terminal not running" });
        return true;
      }
      respondJson(response, 200, { ok: true });
      return true;
    }
    if (!session) {
      if (openingStream) deps.releaseTerminalView?.(terminalId);
      respondJson(response, 404, { error: "Terminal not running" });
      return true;
    }
    if (method === "POST" && ptyMatch[2] === "resize") {
      const body = await readJson<{ cols?: number; rows?: number }>(request);
      if (body.cols && body.rows) session.resize(body.cols, body.rows);
      respondJson(response, 200, { ok: true });
      return true;
    }
    // History for ONE viewer's live terminal (PtySession.seedFrame): sent down
    // that viewer's own stream, named by the id its hello carried, so it lands
    // in order with the deltas and costs no other viewer a byte.
    if (method === "POST" && ptyMatch[2] === "seed") {
      const body = await readJson<{ nonce?: unknown; lines?: unknown; stream?: unknown }>(request, 4096);
      const nonce = typeof body.nonce === "string" && /^[A-Za-z0-9-]{1,64}$/.test(body.nonce) ? body.nonce : null;
      const target = typeof body.stream === "string" ? seedStreams.get(body.stream) : undefined;
      if (!nonce || !target || target.terminalId !== terminalId) {
        respondJson(response, 200, { ok: false });
        return true;
      }
      const frame = await session.seedFrame(Number(body.lines) || 0, nonce);
      if (frame === null) {
        respondJson(response, 200, { ok: false });
        return true;
      }
      target.send("data", frame);
      respondJson(response, 200, { ok: true });
      return true;
    }
    if (method === "POST" && ptyMatch[2] === "jump") {
      const body = await readJson<{ text?: string | null }>(request);
      if (typeof body.text === "string" && body.text.length > 0)
        session.jumpToText(body.text);
      else session.exitCopyMode();
      respondJson(response, 200, { ok: true });
      return true;
    }
    if (method === "GET" && ptyMatch[2] === "stream") {
      const send = startSse(response);
      // The viewer is a tracking fact from the first byte (A4).
      deps.subscribeTerminal?.(terminalId);
      // GEOMETRY FIRST, then the frame. The phone opens its xterm at its own
      // size (measured: 45x24 while the pane was still 100x30) and the resize
      // kick only arrives AFTER the first paint — so a frame applied before
      // the client knows the mirror's size gets re-wrapped, and herdr's
      // absolute-addressed deltas then land in the wrong cells. Announcing the
      // size first lets the client size its grid BEFORE any byte arrives.
      // The stream's own name, for a seed meant for this viewer alone.
      const streamId = randomUUID();
      seedStreams.set(streamId, { terminalId, send });
      send("hello", { ...session.geometry(), stream: streamId });
      // A faithful ANSI frame, not plain text — see PtySession.replayFrame.
      send("data", session.replayFrame());
      const onData = (data: string): void => send("data", data);
      // Geometry changed: the server re-serialized at the new size. Applying
      // it verbatim is what keeps this viewer's addressing valid.
      // The NEW size before the new frame, as on attach: another viewer resized
      // the shared pane, and this one must not keep painting at the old size.
      const onReplay = (frame: string): void => {
        send("hello", { ...session.geometry(), stream: streamId, resized: true });
        send("data", frame);
      };
      const onExit = (): void => send("exit", {});
      session.on("data", onData);
      session.on("replay", onReplay);
      session.on("exit", onExit);
      // Keepalive is startSse's job — see mobile-http.ts. Writing to the
      // response here would land plaintext inside the gzip stream.
      request.on("close", () => {
        seedStreams.delete(streamId);
        session.removeListener("data", onData);
        session.removeListener("replay", onReplay);
        session.removeListener("exit", onExit);
        // Abrupt closes included — unsubscribe is double-call safe.
        deps.unsubscribeTerminal?.(terminalId);
        deps.releaseTerminalView?.(terminalId);
      });
      return true;
    }
  }

  // The phone's mic, heard by the Mac (hear-file.ts). The body is the raw
  // recording; the answer is the words, never sent anywhere: the box lands them.
  if (p === "/api/listen" && method === "GET") {
    respondJson(response, 200, { available: deps.hear?.available() ?? false, locale: deps.hear?.locale() ?? null });
    return true;
  }
  if (p === "/api/listen" && method === "POST") {
    if (!deps.hear?.available()) {
      respondJson(response, 503, { error: `${machineCopy('This Mac', process.platform)} has no ear to hear with` });
      return true;
    }
    try {
      const bytes = await readBytes(request, HEAR_MAX_BYTES);
      respondJson(response, 200, await deps.hear.recording(bytes));
    } catch (error) {
      respondJson(response, 422, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  // The phone's spoken replies in the Mac's local voice (local-voice.ts).
  // POST, so the read-only wall token is refused; the body is one chunk of
  // text, the answer its audio.
  if (p === "/api/speak" && method === "GET") {
    deps.speak?.warm();
    respondJson(response, 200, { available: deps.speak?.available() ?? false });
    return true;
  }
  if (p === "/api/speak" && method === "POST") {
    if (!deps.speak) {
      respondJson(response, 503, { error: `${machineCopy('This Mac', process.platform)} has no voice to speak with` });
      return true;
    }
    // The phone stopped reading (or left): stop the upstream request with it.
    const hangup = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) hangup.abort();
    });
    try {
      const body = await readJson<{ text?: unknown; lang?: unknown }>(request);
      const spoken = await deps.speak.speak(body?.text as string, hangup.signal, body?.lang === "en" ? "en" : "zh");
      if (hangup.signal.aborted) return true;
      response.writeHead(200, { "content-type": spoken.type, "content-length": String(spoken.audio.byteLength), "cache-control": "no-store" });
      response.end(Buffer.from(spoken.audio));
    } catch (error) {
      if (hangup.signal.aborted) return true;
      const status = error instanceof SpeakError ? error.status : 400;
      respondJson(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  // Sous, spoken to from a phone or a speaker. POST, so the read-only wall
  // token is refused exactly as for every other mutating route; the sentence
  // is the whole request, the controller's answer is the whole response —
  // `spoken` is what the surface says back, `needs: 'prompt'` means Sous
  // asked a question and the next sentence from the same surface answers it.
  if (method === "POST" && p === "/api/sous/command") {
    if (!deps.sous) {
      respondJson(response, 503, { error: "Sous is not listening on this desktop" });
      return true;
    }
    const body = await readJson<{ text?: string; surface?: string; callerId?: string; box?: boolean }>(request);
    const text = (body.text ?? "").trim();
    if (!text) {
      respondJson(response, 400, { error: "Missing text" });
      return true;
    }
    if (text.length > SOUS_MAX_TEXT) {
      respondJson(response, 400, { error: `Text longer than ${SOUS_MAX_TEXT} characters is not a sentence` });
      return true;
    }
    // A wrong or missing surface is refused, not folded into the phone's
    // bucket: a gateway that forgot to say 'home' would otherwise share the
    // phone's pending question.
    if (!SOUS_SURFACES.has(body.surface ?? "")) {
      respondJson(response, 400, { error: `surface must be one of ${[...SOUS_SURFACES].join(", ")}` });
      return true;
    }
    // WHO is speaking: the caller's own id when it sends one (the speaker's
    // room, the phone's install), else the address it came from. Never the
    // token — one token is every phone. And no focusedAgentId from the body:
    // a network door may not name an agent by id, only by name.
    const callerId =
      typeof body.callerId === "string" && body.callerId.trim() !== ""
        ? body.callerId.trim().slice(0, 64)
        : (request.socket.remoteAddress ?? "unknown");
    // `box: true` is the phone's bar; voice-gateway and anything else keep the regex core.
    const result = await deps.sous.handle({ text, surface: body.surface as SousSurface, callerId, box: body.box === true });
    respondJson(response, 200, result);
    return true;
  }

  if (method === "GET" && p === "/api/inbox") {
    // Task text for every workspace, like the board: gated the same way.
    if (deps.pairingToken && !canRead) {
      respondJson(response, 401, { error: "Unauthorized — the inbox requires a pairing or read-only token." });
      return true;
    }
    // The WALL reads only kind, card and waited-for: no reasons, no question
    // text, no brief, no proposal (HP contract).
    const rows = deps.inbox?.() ?? [];
    respondJson(response, 200, { rows: hasPairing || !deps.pairingToken ? rows : wallProjection(rows) });
    return true;
  }

  if (method === "POST" && /^\/api\/inbox\/[^/]+\/(?:act|dismiss)$/.test(p)) {
    const [, , , id, verb] = p.split("/");
    if (verb === "act") {
      if (!deps.inboxAct) {
        respondJson(response, 503, { error: "this desktop cannot retry from the inbox" });
        return true;
      }
      const out = await deps.inboxAct(decodeURIComponent(id));
      respondJson(response, out.ok ? 200 : 409, out);
      return true;
    }
    if (!deps.inboxDismiss) {
      respondJson(response, 503, { error: "this desktop cannot dismiss inbox rows" });
      return true;
    }
    const dismissed = deps.inboxDismiss(decodeURIComponent(id));
    respondJson(response, dismissed ? 200 : 404, { ok: dismissed, dismissed });
    return true;
  }

  if (method === "POST" && p === "/api/sous/commit") {
    if (!deps.sous?.commit) {
      respondJson(response, 503, { error: "Sous does not decide on this desktop" });
      return true;
    }
    const body = await readJson<{ token?: string; target?: string; surface?: string; callerId?: string; ack?: string }>(request);
    if (typeof body.token !== "string" || body.token.length === 0 || body.token.length > 64) {
      respondJson(response, 400, { error: "Missing token" });
      return true;
    }
    const choice = {
      ...(typeof body.target === "string" && body.target.length <= 128 ? { target: body.target } : {}),
      ...(body.ack === "send-anyway" ? { ack: "send-anyway" as const } : {}),
    };
    const result = await deps.sous.commit(body.token, choice, sousCaller(body));
    // A choice that was never shown is a bad request; another caller's token
    // is not theirs; a commit already landing is a conflict; a spent or stale
    // token is gone.
    const status =
      result.error === "bad-target" ? 400 : result.error === "not-yours" ? 403 : result.error === "in-flight" ? 409 : result.error === "expired" ? 410 : result.error === "needs-ack" ? 428 : 200;
    respondJson(response, status, result);
    return true;
  }

  if (method === "POST" && p === "/api/sous/cancel") {
    if (!deps.sous?.cancel) {
      respondJson(response, 503, { error: "Sous does not decide on this desktop" });
      return true;
    }
    const body = await readJson<{ token?: string; surface?: string; callerId?: string }>(request);
    if (typeof body.token !== "string" || body.token.length === 0 || body.token.length > 64) {
      respondJson(response, 400, { error: "Missing token" });
      return true;
    }
    respondJson(response, 200, { cancelled: deps.sous.cancel(body.token, sousCaller(body)) });
    return true;
  }

  if (method === "GET" && p === "/api/events") {
    const send = startSse(response);
    // ONE close listener for the whole stream. Every source below hands its
    // teardown here; eleven `request.on("close")` calls on one request were
    // what Node kept reporting as a MaxListeners leak.
    const teardown: Array<() => void> = [];
    const onClose = (off: () => void): void => void teardown.push(off);
    request.on("close", () => {
      for (const off of teardown) off();
    });
    // The opening workspace snapshot is skipped ONCE per boot: the client
    // says `?boot=<nonce>` (remote-api sharedEvents) because it is fetching
    // /api/workspace at this very moment, and the same document twice is the
    // largest thing a relayed boot carries. The nonce is spent on first
    // sight — EventSource re-dials the SAME URL when the browser reconnects
    // by itself, and that reconnect must get the snapshot, which is how a
    // dropped stream heals. The workspace LIST still opens every stream: a
    // kilobyte, and the switcher's source of truth (perf lane L7).
    if (!spendBootNonce(url.searchParams.get("boot"))) send("workspace", scopedState());
    send("workspaces", ops.listWorkspaces());
    // WHICH BUILD THIS IS: the page reloads itself when it changes (build-watch.ts).
    if (deps.build) {
      send("build", { id: deps.build.id() });
      const onBuild = (id: string): void => send("build", { id });
      deps.build.bus.on("build", onBuild);
      onClose(() => deps.build?.bus.removeListener("build", onBuild));
    }
    // Sous's zoom / zoom-back, so the phone and the TV follow the owner's
    // voice. A scoped stream only hears about its own canvas.
    const onUi = (event: UiCommandEvent): void => {
      if (scope === null || event.workspaceId === scope) send("ui", event);
    };
    deps.uiBus?.on("command", onUi);
    onClose(() => deps.uiBus?.removeListener("command", onUi));
    // Activities are keyed by terminal id across every workspace, so a scoped
    // stream filters them or it leaks other canvases' agents into this one.
    const inScopedCanvas = (terminalId: string): boolean =>
      scope === null || scopedState().nodes.some((node) => node.id === terminalId);
    // A card's dials changed. Already change-gated by the announcer, so this
    // is one small frame per actual change rather than one per tracker tick.
    const onTuning = (row: { terminalId: string; tuning: unknown }): void => {
      if (inScopedCanvas(row.terminalId)) send("tuning", row);
    };
    deps.tuningBus?.on("tuning", onTuning);
    onClose(() => deps.tuningBus?.removeListener("tuning", onTuning));
    // The inbox rides the same stream, under the board's read gate; the
    // opening frame is the list as it stands, so a phone never polls for it.
    // The roster rides it too, one changed entry per frame, as /api/agents
    // serves it (agent-registry onChange). A page refetches the list only when
    // this stream comes back (remote-api onStreamBack): frames sent into the gap are lost.
    // Optional-called: a server embedding a bare roster (tests, older hosts) just has no frames.
    const offAgent = deps.agents?.onChange?.((entry) => send("agent", entry));
    if (offAgent) onClose(offAgent);
    if (deps.inbox && (!deps.pairingToken || canRead)) {
      // A read-only (wall) token sees the projection only (HP contract).
      const project = (rows: InboxRow[]): unknown => (hasPairing || !deps.pairingToken ? rows : wallProjection(rows));
      const onInbox = (rows: InboxRow[]): void => send("inbox", { rows: project(rows) });
      // The stream HOLDS the list open; the opening frame is built on demand.
      const release = deps.inboxHold?.() ?? null;
      send("inbox", { rows: project(deps.inbox()) });
      deps.inboxBus?.on("inbox", onInbox);
      onClose(() => {
        deps.inboxBus?.removeListener("inbox", onInbox);
        release?.();
      });
    }
    // A cable lit on this canvas. Either end on it is enough: the other end
    // may be a tab naming an agent elsewhere, and the tab is the lamp.
    if (hasPairing || !deps.pairingToken) {
      const onSous = (frame: unknown): void => send("sous", frame);
      deps.sousBus?.on("sous", onSous);
      onClose(() => deps.sousBus?.removeListener("sous", onSous));
    }
    const onSignal = (signal: CableSignal): void => {
      if (inScopedCanvas(signal.from) || inScopedCanvas(signal.to)) send("signal", signal);
    };
    const offSignal = deps.signalBus?.on(onSignal) ?? null;
    onClose(() => offSignal?.());
    const onUse = (signal: UseSignal): void => {
      if (inScopedCanvas(signal.agent) || inScopedCanvas(signal.card)) send("use", signal);
    };
    const offUse = deps.useBus?.on(onUse) ?? null;
    onClose(() => offUse?.());
    // The route: the whole state on change (debounced by the service), one
    // card's state when its decision or turn facts land. The stream holds the
    // gateway's clock open while it is, so a phone watching sees a probe.
    const onRoute = (state: RouteState): void => send("route", state);
    const onCardRoute = (row: { terminalId: string }): void => {
      if (inScopedCanvas(row.terminalId)) send("card-route", row);
    };
    deps.routeBus?.on("route", onRoute);
    deps.routeBus?.on("card-route", onCardRoute);
    const releaseRoute = deps.route?.hold() ?? null;
    onClose(() => {
      deps.routeBus?.removeListener("route", onRoute);
      deps.routeBus?.removeListener("card-route", onCardRoute);
      releaseRoute?.();
    });
    // The Mac's addresses moved and the zone knows the new names: look now.
    const onReach = (): void => send("reach", { at: Date.now() });
    deps.reachBus?.on("changed", onReach);
    onClose(() => deps.reachBus?.removeListener("changed", onReach));
    for (const activity of turns.list()) {
      if (inScopedCanvas((activity as { terminalId: string }).terminalId)) {
        send("activity", activity);
      }
    }
    // THE focus-flip channel. Unscoped it stays exactly as it was — 'change'
    // means "the canvas on screen changed". Scoped, it listens to the tagged
    // per-workspace signal instead, so a desktop switching workspaces no
    // longer re-points a phone that arrived by slug, and a background
    // workspace's own edits still reach it (marketplace §11).
    /**
     * A SWITCH IS THE ONE CHANGE THAT REPLACES THE WHOLE CANVAS, and over the
     * relay it is the one the reader waits on: measured at 280 KB gzipped,
     * 82% of it note bodies that nothing draws until a note is zoomed to a
     * readable size. So a switch sends the canvas LIGHT first — what the
     * canvas is drawn from, about five times smaller — and WHOLE a beat
     * later. The client reconciles repeated workspace frames already, so the
     * second frame is a no-op but for the bodies it fills in.
     *
     * Every other change sends one frame exactly as before. Two-framing a
     * card drag would double the traffic of moving a card.
     */
    let switched = false;
    const onSwitch = (): void => void (switched = true);
    const onChange = (state: WorkspaceState): void => {
      const wasSwitch = switched;
      switched = false;
      const light = wasSwitch ? lightenCanvas(state) : null;
      if (light === null) {
        send("workspace", state);
        return;
      }
      send("workspace", light);
      // Next tick, not this one: the point is that the light frame reaches
      // the wire on its own. A subscriber that left in between is checked
      // for, because writing into a destroyed gzip stream throws.
      setImmediate(() => {
        if (response.writableEnded || response.destroyed) return;
        send("workspace", state);
      });
    };
    const onScopedChange = (payload: {
      workspaceId: string;
      state: WorkspaceState;
    }): void => {
      if (payload.workspaceId === scope) send("workspace", payload.state);
    };
    // The store speaks for the desktop; a seated stream hears its own seat as
    // active for as long as that workspace is there.
    const onWorkspaces = (list: WorkspaceList): void =>
      send(
        "workspaces",
        seat !== null && list.workspaces.some((w) => w.id === seat)
          ? { ...list, activeId: seat }
          : list,
      );
    const onActivity = (activity: unknown): void => {
      if (inScopedCanvas((activity as { terminalId: string }).terminalId)) {
        send("activity", activity);
      }
    };
    // Observability stream: every store mutation, cross-workspace (toasts).
    const onOp = (event: CookrewEvent): void => send("event", event);
    // A secret's activity is no store op, so it reaches the owner's phone by its
    // own listener (main/secret-activity.ts). This stream also serves the wall
    // and a subscriber with no token: a name is the owner's, so only a paired
    // page hears it, and nobody else learns a secret was touched at all.
    const onSecret = (event: CookrewEvent): void => {
      if (event.type.startsWith("secret.")) send("event", event);
    };
    if (hasPairing || !deps.pairingToken) {
      // Optional-called: a server embedding a bare log (tests) just has no frames.
      deps.events?.on?.("event", onSecret);
      onClose(() => deps.events?.removeListener?.("event", onSecret));
    }
    // Activity Board stream. A SEPARATE listener on the same signals — the
    // 'activity' event above is left exactly as it was (canvas cards eat it).
    // Board recompute spans the whole fleet, so bursts coalesce instead of
    // pushing per tracker tick.
    // Same data as /api/board, so the same gate: an unauthenticated
    // subscriber still gets workspace/activity/event (existing behaviour,
    // untouched) but never the board stream.
    // The board stream is OPT-IN (?board=1): a stream that takes it is a
    // board CONSUMER, holds the probe open for its lifetime, and is pushed
    // on every change. Nothing renders the frame today, so the default
    // stream no longer carries a whole-fleet recompute per signal per phone.
    const wantsBoard = url.searchParams.get("board") === "1";
    const board = wantsBoard && (!deps.pairingToken || canRead) ? deps.board : undefined;
    const boardNotifier = board
      ? createBoardNotifier(() => send("board", buildBoard(board)))
      : null;
    const onBoardSignal = (): void => boardNotifier?.schedule();
    const releaseProbe = board?.probeSubscribe?.() ?? null;
    const offProbeChange = board?.probeOnChange?.(onBoardSignal) ?? null;
    if (board) {
      const sentProbe = board.probe?.();
      send("board", buildBoard(board));
      // A first frame before the probe's FIRST pass has landed carries no
      // L2 phases; when that pass lands the map object changes, and the
      // board is pushed again. Once any pass has completed probeWarm answers
      // at once with the same map, and nothing extra is pushed.
      void board.probeWarm?.().then((fresh) => {
        if (fresh !== sentProbe) onBoardSignal();
      }, () => undefined);
    }
    if (scope === null) {
      store.on("switch", onSwitch);
      store.on("change", onChange);
    } else store.on("workspace-change", onScopedChange);
    store.on("workspaces", onWorkspaces);
    turns.on("activity", onActivity);
    store.on("op", onOp);
    if (boardNotifier) {
      turns.on("activity", onBoardSignal);
      store.on("change", onBoardSignal);
      store.on("workspaces", onBoardSignal);
    }
    onClose(() => {
      // Symmetric with the attach above — an unremoved scoped listener is a
      // leak per disconnected phone, and phones disconnect constantly.
      if (scope === null) {
        store.removeListener("switch", onSwitch);
        store.removeListener("change", onChange);
      } else store.removeListener("workspace-change", onScopedChange);
      store.removeListener("workspaces", onWorkspaces);
      turns.removeListener("activity", onActivity);
      store.removeListener("op", onOp);
      if (boardNotifier) {
        boardNotifier.cancel();
        turns.removeListener("activity", onBoardSignal);
        store.removeListener("change", onBoardSignal);
        store.removeListener("workspaces", onBoardSignal);
      }
      offProbeChange?.();
      releaseProbe?.(); // the last board consumer leaving stops the probe
    });
    return true;
  }

  // Observability queries (metrics/history panel) + global agent roster.
  if (method === "GET" && p === "/api/events/query") {
    const q = parseEventQuery(url.searchParams);
    // The wall (read-only token) sees that a secret was read, never which:
    // the names are the owner's.
    const events = deps.events.query(q);
    respondJson(response, 200, {
      events: hasPairing ? events : events.map(redactSecretDetails),
      counts: deps.events.count(q),
    });
    return true;
  }
  if (method === "GET" && p === "/api/agents") {
    respondJson(response, 200, { agents: deps.agents.list() });
    return true;
  }
  const launchMatch = p.match(/^\/api\/terminal\/([^/]+)\/launch-check$/);
  if (launchMatch && method === "GET") {
    respondJson(response, 200, { failure: deps.ops.checkLaunch(launchMatch[1]) });
    return true;
  }
  if (method === "GET" && p === "/api/strays") {
    respondJson(response, 200, { strays: await deps.ops.listStrayPanes() });
    return true;
  }
  const strayMatch = p.match(/^\/api\/strays\/([^/]+)\/end$/);
  if (strayMatch && method === "POST") {
    respondJson(response, 200, await deps.ops.endStrayPane(strayMatch[1]));
    return true;
  }
  // ENDPOINT RESTORE: rewind an agent in place to any checkpoint (+ undo).
  const restoreMatch = p.match(/^\/api\/agents\/([^/]+)\/restore$/);
  if (restoreMatch && method === "POST") {
    const body = await readJson<{ checkpointIndex?: number; targetSessionId?: string }>(request);
    const index = Number(body.checkpointIndex);
    if (!Number.isInteger(index) || index < 1) {
      respondJson(response, 400, { error: "checkpointIndex must be a positive integer" });
      return true;
    }
    // Lineage reach: the segment the index is counted in. Accepted here from
    // day one so a phone client sending it can never be silently rewound in
    // the WRONG segment by a server that dropped the field; the executor
    // validates the shape and refuses malformed ids.
    const target = typeof body.targetSessionId === "string" ? body.targetSessionId : undefined;
    try {
      respondJson(response, 200, await deps.restoreCheckpoint(restoreMatch[1], index, target));
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  const undoRestoreMatch = p.match(/^\/api\/agents\/([^/]+)\/restore\/undo$/);
  if (undoRestoreMatch && method === "POST") {
    try {
      respondJson(response, 200, await deps.undoRestore(undoRestoreMatch[1]));
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  // V4 §3: attach-free dispatch. The one route the protocol lacked — give an
  // agent work without a terminal open on it. 202 + a dispatch id; the answer
  // arrives at GET /api/dispatches/:id, correlated through the turn that
  // answered it. Absent dep = the engine is not wired, which is a 503 rather
  // than a silent 404 on a route the catalog advertises. Writing, so the C1
  // choke point above has already demanded the pairing token — the same
  // admission every other mutating route here gets, nothing extra.
  const dispatchMatch = p.match(/^\/api\/agents\/([^/]+)\/dispatch$/);
  if (dispatchMatch && method === "POST") {
    if (!deps.dispatch) {
      respondJson(response, 503, { error: "dispatch is not available" });
      return true;
    }
    const body = await readJson<{
      brief?: string;
      text?: string;
      idempotencyKey?: string;
    }>(request);
    // The consumer principal comes from the AUTH that admitted this request,
    // never from the body — a body field would let any admitted caller wear
    // any tenant's identity, and the principal scopes idempotency and record
    // visibility. Today the only write credential is the pairing token (the
    // C1 choke point already refused everything else), so every admitted
    // producer is the owner; S4 swaps this derivation for per-consumer
    // credentials, and inherits the seam — inject, never parse.
    const principal = "owner";
    const result = await deps.dispatch.dispatch(dispatchMatch[1], {
      brief: body.brief,
      text: body.text,
      idempotencyKey: body.idempotencyKey,
      consumer: principal,
    });
    respondJson(response, result.status, result.body);
    return true;
  }
  const dispatchGetMatch = p.match(/^\/api\/dispatches\/([^/]+)$/);
  if (dispatchGetMatch && method === "GET") {
    // The choke point fires on non-GET only, so without this the read would be
    // open on the 0.0.0.0 listener: any id, from anyone on the LAN, described
    // commissioned work at a named agent. Same exposure argument as
    // /api/board, but scoped to the PAIRING token: following a dispatch is
    // part of commissioning work, and the wall's read-only token covers the
    // curated projections, not this. 403 rather than 401 when the read-only
    // token is presented — the credential is known, its scope is not enough.
    if (deps.pairingToken && !hasPairing) {
      respondJson(response, hasReadOnly ? 403 : 401, {
        error: hasReadOnly
          ? "Forbidden — dispatches require the pairing token."
          : "Unauthorized — dispatches require the pairing token.",
      });
      return true;
    }
    if (!deps.dispatch) {
      respondJson(response, 503, { error: "dispatch is not available" });
      return true;
    }
    // Same derivation as the POST: the requester principal is what the auth
    // says, and the pairing token is the owner. lookup() 404s a foreign
    // principal's id — never 403 — so the read cannot confirm that somebody
    // else's dispatch exists.
    const result = deps.dispatch.lookup(dispatchGetMatch[1], "owner");
    respondJson(response, result.status, result.body);
    return true;
  }
  const recoverMatch = p.match(/^\/api\/agents\/([^/]+)\/recover$/);
  if (recoverMatch && method === "POST") {
    try {
      respondJson(response, 200, deps.recoverAgent(recoverMatch[1]));
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  return false;
}

/** ?workspaceId=&type=&since=&until=&limit= — all optional. */
function parseEventQuery(params: URLSearchParams): EventQuery {
  const num = (key: string): number | undefined => {
    const raw = params.get(key);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    workspaceId: params.get("workspaceId") ?? undefined,
    type: params.get("type") ?? undefined,
    since: num("since"),
    until: num("until"),
    limit: num("limit"),
  };
}

/** A canvas position off the wire, or nothing — never a NaN the canvas cannot place. */
function servePosition(value: unknown): { x: number; y: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const at = value as { x?: unknown; y?: unknown };
  return Number.isFinite(at.x) && Number.isFinite(at.y)
    ? { x: at.x as number, y: at.y as number }
    : undefined;
}

/** The receipt the gate sheet took, in its exact shape, or nothing. */
function servePaid(
  value: unknown,
): { price: string; asset: string; rail: "x402" | "stripe" } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const paid = value as { price?: unknown; asset?: unknown; rail?: unknown };
  if (typeof paid.price !== "string" || typeof paid.asset !== "string") return undefined;
  if (paid.rail !== "x402" && paid.rail !== "stripe") return undefined;
  return { price: paid.price.slice(0, 32), asset: paid.asset.slice(0, 16), rail: paid.rail };
}
