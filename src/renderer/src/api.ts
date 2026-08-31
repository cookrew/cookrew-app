import type { TranslateResult } from '../../shared/translate'
import type {
  AgentRole,
  CanvasNode,
  Connection,
  GitInfo,
  TeamForkSpec,
  TeamClipStatus,
  TeamCopyResult,
  TeamMeta,
  WorkspaceList,
  WorkspaceMeta,
  WorkspaceState,
  RecoverResult,
  RestoreResult,
} from "../../shared/model";
import type { TerminalActivity, TurnRecord } from "../../shared/turn";
import type { TurnMatch } from "../../shared/turn-search";
import type { TraceBoundaryMarker } from "../../shared/trace-blocks";
import type { BoardRow, BoardSummary } from "../../shared/board";
import type { VersionPinRecord } from "../../shared/version-pin";
import type { ServedPaymentRail } from "../../shared/served-payment-rails";
import type { ServeTransport } from "../../shared/serve-transport";
import type {
  PaymentConfigReply,
  ServedPaymentStatus,
} from "../../shared/served-payment-config";

/**
 * GET /api/board's payload, mirrored here rather than imported from main —
 * the renderer must not reach into src/main. Structurally identical to
 * BoardSnapshot in main/board-index.ts.
 */
export interface BoardSnapshotLike {
  rows: BoardRow[];
  summary: BoardSummary;
  activeWorkspaceId: string;
}

/** A served door's public face, as the import sheet previews it. */
export interface ServeFacePreview {
  name: string;
  serviceId: string;
  slug: string;
  door: string;
  access: 'account' | 'paid';
  priceUsd?: string;
  version: number;
  agents: number;
  /** Which rails this door takes money on. Empty means it cannot sell today. */
  paymentRails: readonly ('x402' | 'stripe')[];
}

/** One way a door will take money, with the terms it quoted for that rail. */
export type ServeRail =
  | {
      rail: 'x402';
      price: string;
      asset: string;
      chain: string;
      payTo: string;
      expiry: number;
    }
  | { rail: 'stripe'; price: string; asset: 'USD'; chain: 'Stripe'; expiry: number };

/** What a door is saying, in the gate sheet's vocabulary. */
export type ServePhase =
  | { kind: 'open' }
  | { kind: 'pay'; rails: ServeRail[] }
  | { kind: 'denied'; reason: string; retryable: boolean }
  | { kind: 'gone' }
  | { kind: 'error'; status: number };

export interface CookrewApi {
  getWorkspace: () => Promise<WorkspaceState>;
  onWorkspaceState: (cb: (state: WorkspaceState) => void) => () => void;
  translateHost: () => Promise<string | null>;
  translateCheckpoint: (text: string, language: string) => Promise<TranslateResult>;
  listWorkspaces: () => Promise<WorkspaceList>;
  /** team: create pre-populated from a saved team template (FEATURE 1). */
  createWorkspace: (
    name: string,
    dir: string,
    team?: string,
  ) => Promise<WorkspaceMeta>;
  /**
   * Import a template as a SESSION: one workspace, one orch terminal that
   * reaches the served crew over HTTP. Replaces "paste the whole team" — a
   * caller enters through the orchestrator. `target` omitted = local import
   * (the orch points at this app's own listener).
   */
  templateImport: (
    team: string,
    position?: { x: number; y: number },
  ) => Promise<WorkspaceMeta>;
  /**
   * R30 share-on-save. `serve` publishes the saved team under a derived slug
   * and answers the address to hand out; the owner-only surface, never HTTP.
   */
  servingServe: (input: {
    templateId: string;
    access: 'account' | 'paid';
    priceUsd?: string;
  }) => Promise<
    | { ok: true; serviceId: string; slug: string; address: string }
    | { ok: false; reason: string }
  >;
  servingStop: (serviceId: string) => Promise<{ ok: boolean }>;
  servingPaymentStatus: () => Promise<ServedPaymentStatus>;
  servingSetPayTo: (payTo: string) => Promise<PaymentConfigReply>;
  servingSetStripeSecret: (secret: string) => Promise<PaymentConfigReply>;
  servingList: () => Promise<
    readonly {
      serviceId: string;
      templateId: string;
      slug: string;
      access: 'account' | 'paid';
      priceUsd?: string;
      address: string;
      /** How far that address carries — see shared/serve-transport. */
      transport: ServeTransport;
      paymentRails: readonly ServedPaymentRail[];
    }[]
  >;
  servingSessions: () => Promise<
    readonly {
      sessionId: string;
      serviceId: string;
      caller: string;
      workspaceName: string;
      version: number;
    }[]
  >;
  servingEnd: (sessionId: string) => Promise<{ stopped: number }>;
  /** Read a served door's public face — free, commits nothing. */
  serveInspect: (
    link: string,
  ) => Promise<
    | { ok: true; target: { origin: string; slug: string }; face: ServeFacePreview }
    | { ok: false; reason: string }
  >;
  /** Import: place ONE orch interface card for the served team. */
  serveImport: (
    link: string,
    position?: { x: number; y: number },
    /** What was paid at the gate, so the card can say so and the close
     *  prompt can quote it back. Absent on a free door. */
    paid?: { price: string; asset: string; rail: 'x402' | 'stripe' },
  ) => Promise<{ ok: true; node: unknown } | { ok: false; reason: string }>;
  /** Sign in to the door and ask what it wants. The Bearer stays in main. */
  serveGate: (
    link: string,
  ) => Promise<
    | { ok: true; phase: ServePhase; wallet: { address: string } | null }
    | { ok: false; reason: string; detail?: string }
  >;
  /** Start a card payment: opens hosted Checkout in the real browser. */
  serveCheckout: (
    link: string,
  ) => Promise<
    { ok: true; session: string; url: string } | { ok: false; reason: string; detail?: string }
  >;
  /** Present a payment on one rail and be admitted. */
  serveSettle: (
    link: string,
    rail: 'x402' | 'stripe',
    session?: string,
  ) => Promise<
    { ok: true; phase: ServePhase } | { ok: false; reason: string; detail?: string }
  >;
  switchWorkspace: (id: string) => Promise<WorkspaceList>;
  renameWorkspace: (id: string, name: string) => Promise<WorkspaceList>;
  /** Workspace v2: remove workspace, multi-directory, per-terminal cwd, git. */
  removeWorkspace: (id: string) => Promise<WorkspaceList>;
  addWorkspaceDir: (id: string, dir: string) => Promise<WorkspaceList>;
  removeWorkspaceDir: (id: string, dir: string) => Promise<WorkspaceList>;
  setPrimaryDir: (id: string, dir: string) => Promise<WorkspaceList>;
  setTerminalCwd: (nodeId: string, dir: string) => Promise<CanvasNode>;
  /** Native directory picker (desktop only; null elsewhere/cancelled). */
  pickDir: () => Promise<string | null>;
  /** Git state of a directory; null when unavailable (demo). */
  gitInfo: (dir: string) => Promise<GitInfo | null>;
  onWorkspaceList: (cb: (list: WorkspaceList) => void) => () => void;
  addNode: (node: CanvasNode) => Promise<CanvasNode>;
  updateNode: (
    id: string,
    patch: Partial<CanvasNode>,
  ) => Promise<CanvasNode | undefined>;
  removeNode: (id: string) => Promise<void>;
  connectNodes: (a: string, b: string) => Promise<Connection>;
  disconnect: (connId: string) => Promise<void>;
  listPresets: () => Promise<{ name: string; command: string }[]>;
  /**
   * Version pins for a terminal (§10) — the rail's third marker class. Asked
   * per terminal because a pin belongs to a transcript, not to a workspace.
   */
  listPins: (terminalId: string) => Promise<VersionPinRecord[]>;
  createTerminal: (opts: {
    name: string;
    preset: string;
    position: { x: number; y: number };
    orch: boolean;
    /** Boot from a saved role (rolePrompt injected once the TUI is quiet). */
    roleName?: string;
  }) => Promise<CanvasNode>;
  /**
   * Resolve dropped/picked File objects to absolute paths on the machine
   * running the agents: the Electron bridge reads the local path, the remote
   * (phone) api uploads the bytes first. Callers paste the returned paths.
   */
  attachFiles: (files: File[]) => Promise<string[]>;
  saveAttachmentBytes: (name: string, bytes: Uint8Array) => Promise<string>;
  /** Native multi-file picker (desktop only; returns [] elsewhere). */
  pickFiles: () => Promise<string[]>;
  ptyInput: (terminalId: string, data: string) => void;
  ptyResize: (terminalId: string, cols: number, rows: number) => void;
  /** Scroll the terminal view to a past ask's line; null returns to live. */
  ptyJump: (terminalId: string, text: string | null) => void;
  /** Acknowledge-on-view: user is looking at this terminal's result. */
  turnSeen: (terminalId: string) => void;
  /**
   * Stream a terminal's output. `onHello` (optional) fires ONCE, before the
   * first byte, with the mirror's geometry: the replay frame's wrapping is
   * baked in at those columns, and herdr's deltas address the cursor
   * absolutely against them, so a viewer must adopt that size before applying
   * anything. Transports that cannot report it simply never call it.
   */
  ptyAttach: (
    terminalId: string,
    onData: (data: string) => void,
    onHello?: (geometry: { cols: number; rows: number }) => void
  ) => () => void;
  listActivity: () => Promise<TerminalActivity[]>;
  onTerminalActivity: (cb: (activity: TerminalActivity) => void) => () => void;
  /**
   * Observability event log (observability-event-log-spec): global mutation
   * stream, filtered history/count queries, and the durable agent roster.
   * Optional — the demo api lacks them; consumers feature-detect (EventToast).
   */
  onEvent?: (cb: (event: unknown) => void) => () => void;
  queryEvents?: (query?: unknown) => Promise<unknown[]>;
  countEvents?: (query?: unknown) => Promise<Record<string, number>>;
  listAgents?: () => Promise<unknown[]>;
  /**
   * Activity Board snapshot (cross-workspace task view). Optional and
   * feature-detected like listAgents — an older bridge shows the roster
   * instead of a fabricated empty board.
   */
  listBoard?: (window?: string) => Promise<BoardSnapshotLike>;
  /**
   * Recover an inactive teammate as it was (agent-recover feature): re-add
   * the node bound to its session and resume. Optional — feature-detect.
   */
  recoverAgent?: (id: string) => Promise<RecoverResult>;
  /**
   * ENDPOINT RESTORE: rewind this agent in place to one of its checkpoints.
   * `targetSessionId` names an EARLIER lineage segment when the index is
   * counted in one (each segment numbers its own T1..Tn); absent = current.
   */
  restoreCheckpoint?: (
    id: string,
    checkpointIndex: number,
    targetSessionId?: string
  ) => Promise<RestoreResult>;
  /** Undo the last endpoint restore (rebind to the pre-restore session). */
  undoRestore?: (id: string) => Promise<RestoreResult>;
  /** Completed turns of a terminal (oldest first) for the card pager. */
  listTurns: (terminalId: string) => Promise<TurnRecord[]>;
  /**
   * Checkpoint search across EVERY agent's turn ledger, run in main. Returns
   * matches with a capped snippet — never turn bodies. Optional: feature-detect,
   * older bridges lack it.
   */
  searchTurns?: (query: string, limit?: number) => Promise<TurnMatch[]>;
  /**
   * Context-view v2 transcript windows: paged turns with FULL prompt+reply
   * bodies. Optional — demo lacks it; the transcript feature-detects.
   * blockIndex of turns[i] = response.offset + i (see the contract note).
   */
  listTurnsPage?: (
    terminalId: string,
    request?: {
      offset?: number;
      limit?: number;
      aroundIndex?: number;
      beforeIndex?: number;
    },
  ) => Promise<{ turns: TurnRecord[]; total: number; offset: number }>;
  /**
   * Trace-sourced context (trace-sourced-context-final): identity-keyed
   * TraceBlock windows read directly from the agent's own session file
   * (Claude/Pi jsonl or Codex rollout). Optional — feature-detect.
   */
  listTrace?: (
    terminalId: string,
    request?: {
      beforeIndex?: number;
      afterIndex?: number;
      aroundIndex?: number;
      limit?: number;
    },
  ) => Promise<{
    blocks: unknown[];
    total: number;
    source: "claude" | "codex" | "pi" | null;
  }>;
  /**
   * Cheap identity+title listing of the FULL trace (unified-scroll item 3): one
   * lightweight entry per traced checkpoint (identity + a short title/prompt
   * snippet), so the checkpoint timeline can span every traced checkpoint —
   * including identities below the capped record store (e.g. T1..T7 when the
   * record store starts at T8). Optional — feature-detected via
   * hasTraceIndexApi(); the timeline falls back to records alone when absent.
   */
  listTraceIndex?: (
    terminalId: string,
    request?: { afterIndex?: number },
  ) => Promise<{ index: number; title: string }[]>;
  /**
   * Boundary markers for the checkpoint rail: ◆ compact (in-file) and ⇥ clear
   * (lineage segment boundary). Optional — feature-detect; the rail simply
   * renders no markers when absent.
   */
  listTraceMarkers?: (
    terminalId: string,
  ) => Promise<TraceBoundaryMarker[]>;
  /**
   * EARLIER lineage segments of this agent's session chain (the checkpoints
   * an auto-compact rotation or /clear moved out of the current file), oldest
   * first, each in its own T1..Tn space. Optional — feature-detect; the
   * boundary expander hides when absent.
   */
  listLineageSegments?: (
    terminalId: string,
  ) => Promise<{ sessionId: string; count: number; entries: { index: number; title: string; id?: string }[] }[]>;
  /**
   * The LATEST checkpoint for a card, from a bounded tail read of the session
   * file — no PTY, O(tail) (trace-perf-architecture T1). Lets a visible-but-
   * unzoomed agent card show its last turn without spawning a mirror. Optional
   * — feature-detect; the card falls back to "Ready" when absent.
   */
  latestCheckpoint?: (
    terminalId: string,
  ) => Promise<{ prompt: string; reply: string; title?: string } | null>;
  /**
   * Trace-perf T4 push: subscribe a card's session-file watch and listen for
   * the change nudge, so the checkpoint refreshes the instant the file grows
   * instead of on the poll. Electron-only; the phone card feature-detects and
   * stays on the poll. `onLatestChanged` returns an unsubscribe.
   */
  watchLatest?: (terminalId: string) => Promise<void>;
  unwatchLatest?: (terminalId: string) => Promise<void>;
  onLatestChanged?: (cb: (terminalId: string) => void) => () => void;
  /** Fork a NEW agent card from a past turn; omit turnIndex for the latest. */
  forkTerminal: (sourceId: string, turnIndex?: number) => Promise<CanvasNode>;
  /** Fork a team into a NEW workspace per the spec (switches to it). */
  teamFork: (spec: TeamForkSpec) => Promise<WorkspaceMeta>;
  /**
   * Snapshot the live canvas + turn histories to ~/.cookrew/teams. With
   * nodeIds: only that selection and the cables between (Figma model).
   */
  teamSave: (name?: string, nodeIds?: string[]) => Promise<TeamMeta>;
  /**
   * SELECT-mode clipboard: stage a copy/cut of the picked nodes, inspect
   * what's staged, paste into the ACTIVE workspace (a cut removes the
   * sources after a successful paste). Optional — demo mode lacks them.
   */
  teamClipSet?: (
    nodeIds: string[],
    cut: boolean,
    worktree?: { name: string },
  ) => Promise<TeamClipStatus>;
  teamClipGet?: () => Promise<TeamClipStatus | null>;
  teamPaste?: () => Promise<TeamCopyResult>;
  teamList: () => Promise<TeamMeta[]>;
  roleList: () => Promise<AgentRole[]>;
  /**
   * Save a reusable role, optionally with checkpoint provenance
   * (checkpoint-program-spec). Optional — demo mode lacks it; the roles UI
   * feature-detects via role-checkpoint.ts.
   */
  saveRole?: (input: {
    nodeId: string;
    name: string;
    rolePrompt: string;
    sourceTurnUuid?: string;
    sourceTurnPrompt?: string;
    sessionCopyRef?: string;
  }) => Promise<AgentRole>;
  onBrowserCommand: (
    cb: (req: { id: string; args: string[]; terminalId: string }) => void,
  ) => () => void;
  browserResult: (id: string, ok: boolean, output: string) => void;
  /** Forward a legacy webview thumbnail to main for flag-off mobile clients. */
  browserThumb: (browserId: string, dataUrl: string) => void;
  /** True when browser nodes are owned by the shared headless runtime. */
  interactiveBrowserEnabled: () => Promise<boolean>;
  /** Desktop-only token authorizing its cross-origin localhost WS connection. */
  browserStreamToken: () => Promise<string | null>;
  onBrowserOpenTab: (
    cb: (req: { webContentsId: number; url: string }) => void,
  ) => () => void;
  /**
   * In flag-off mode, main signals each phone /thumb poll so the legacy desktop
   * capture loop keeps that browser fresh while the window is hidden/occluded.
   */
  onBrowserPhoneViewing: (cb: (browserId: string) => void) => () => void;
  /** Main routes ⌘W here so the renderer can close the topmost layer first. */
  onCmdW: (cb: () => void) => () => void;
  /**
   * Open a WEB URL in the system's default browser. Desktop bridge only —
   * the phone/demo fallbacks render a real anchor instead (see OpenExternal:
   * on the phone a genuine tap is what makes OS deep links fire).
   */
  openExternal?: (url: string) => Promise<void>;
  /** Still of a headless browser page for its card thumbnail; null when the
   *  flag is off or the page cannot be captured right now. */
  browserSnapshot?: (browserId: string) => Promise<string | null>;
  /**
   * Re-establish the push channel if it has died. Remote clients only: a
   * desktop renderer talks to main over IPC, which cannot go down while the
   * window it belongs to is still on screen.
   */
  reconnect?: () => void;
  quitApp: () => void;
}

import { createDemoApi } from "./demo-api";
import { createRemoteApi } from "./remote-api";

let demoApi: CookrewApi | null = null;
let remoteApi: CookrewApi | null = null;

function bridge(): CookrewApi | undefined {
  return (window as unknown as { cookrew?: CookrewApi }).cookrew;
}

/**
 * Returns the Electron preload bridge when present. Outside Electron there
 * are two fallbacks: the remote HTTP/SSE api when served by the mobile
 * server (window.COOKREW_MOBILE marker), else the in-memory demo (plain
 * browser tab, embedded browser node).
 */
export function cookrew(): CookrewApi {
  const ipc = bridge();
  if (ipc) return ipc;
  if (isRemoteMode()) {
    if (!remoteApi) remoteApi = createRemoteApi();
    return remoteApi;
  }
  if (!demoApi) demoApi = createDemoApi();
  return demoApi;
}

/** Phone browser talking to the desktop app through the mobile server. */
export function isRemoteMode(): boolean {
  return (
    !bridge() &&
    (window as unknown as { COOKREW_MOBILE?: number }).COOKREW_MOBILE === 1
  );
}

export function isDemoMode(): boolean {
  return !bridge() && !isRemoteMode();
}

/** Only the Electron renderer has real Chromium <webview>s for browsers. */
export function hasNativeWebview(): boolean {
  return bridge() !== undefined;
}
