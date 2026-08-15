import type http from "node:http";
import type { WorkspaceStore } from "./store";
import { HotCapacityError } from "./store";
import type { PtyManager } from "./pty";
import type { TurnTracker } from "./turn-tracker";
import type { EventLog, CookrewEvent, EventQuery } from "./event-log";
import { pageTurns } from "../shared/turn";
import type { AgentRegistry } from "./agent-registry";
import type { TraceReader } from "./trace";
import type { DispatchService } from "./dispatch";
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
  TeamForkSpec,
  TeamClipStatus,
  TeamCopyResult,
  TeamMeta,
  TerminalNodeData,
  WorkspaceList,
  WorkspaceMeta,
  WorkspaceServiceState,
  WorkspaceState,
  RecoverResult,
  RestoreResult,
} from "../shared/model";
import { readJson, respondJson, startSse, pairingAuthorized } from "./mobile-http";
import { gateMessage, gateRequest, gatedPath } from "./auth-gate";
import type { GateConsumer } from "../shared/gate";

/**
 * Workspace operations shared with the renderer IPC handlers — the mobile
 * HTTP API and ipcMain both delegate to the same functions in index.ts so
 * phone edits behave exactly like desktop edits.
 */
export interface MobileOps {
  addNode: (node: CanvasNode) => CanvasNode;
  updateNode: (
    id: string,
    patch: Partial<CanvasNode>,
  ) => CanvasNode | undefined;
  removeNode: (id: string) => void | Promise<void>;
  createTerminal: (opts: {
    name: string;
    preset: string;
    position: { x: number; y: number };
    orch: boolean;
    roleName?: string;
  }) => CanvasNode;
  forkTerminal: (sourceId: string, turnIndex?: number) => TerminalNodeData;
  listWorkspaces: () => WorkspaceList;
  createWorkspace: (
    name: string,
    dir: string,
    team?: string,
  ) => WorkspaceMeta | Promise<WorkspaceMeta>;
  switchWorkspace: (id: string) => WorkspaceMeta;
  renameWorkspace: (id: string, name: string) => WorkspaceList;
  setWorkspaceServiceState: (
    id: string,
    state: WorkspaceServiceState,
  ) => WorkspaceMeta;
  /** Workspace v2: remove workspace + multi-dir + per-terminal cwd + git. */
  removeWorkspace: (id: string) => WorkspaceList;
  addWorkspaceDir: (id: string, dir: string) => WorkspaceList;
  removeWorkspaceDir: (id: string, dir: string) => WorkspaceList;
  setPrimaryDir: (id: string, dir: string) => WorkspaceList;
  /** Async: the respawn waits for the old session to actually be gone. */
  setTerminalCwd: (nodeId: string, dir: string) => Promise<CanvasNode>;
  gitInfo: (dir: string) => Promise<GitInfo>;
  /** Team fork/save + roles (spec note team-fork-roles-v1). */
  teamFork: (spec: TeamForkSpec) => Promise<WorkspaceMeta>;
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

export interface MobileApiDeps {
  store: WorkspaceStore;
  ptys: PtyManager;
  turns: TurnTracker;
  /** Observability event log (query/count) — spec observability-event-log-spec. */
  events: EventLog;
  /** Durable agent roster cache (~/.cookrew/agents.json). */
  agents: AgentRegistry;
  /** Recover an inactive teammate as it was (agent-recover feature). */
  recoverAgent: (id: string) => RecoverResult;
  /**
   * Attach-free dispatch engine (v4 §3). Optional so this module compiles and
   * serves before it is wired; absent = the two dispatch routes answer 503
   * rather than 404, because a missing wire-up must not look like a missing
   * feature to a consumer holding a catalog entry for it.
   */
  dispatch?: DispatchService;
  /** Endpoint restore: rewind an agent to a checkpoint (+ undo). */
  restoreCheckpoint: (id: string, checkpointIndex: number) => Promise<RestoreResult>;
  undoRestore: (id: string) => Promise<RestoreResult>;
  /** Trace-sourced context reader (identity-keyed windows over agent files). */
  traces: TraceReader;
  /**
   * Activity Board data plane (cross-workspace task view). Optional so this
   * module compiles and serves before the collectors are wired in index.ts;
   * absent = /api/board answers 503 rather than pretending the board is empty.
   */
  board?: BoardSources;
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
  /**
   * Pairing token required on every /api/* route (v4 §4) as
   * `Authorization: Bearer <token>` (or `?token=` for header-less clients).
   * Undefined = unauthenticated (loopback-only embedders, tests).
   */
  pairingToken?: string;
  /**
   * ~/.cookrew/consumers.json rows, keyed by consumer name. Absent = the two
   * generated rows (phone + wall), which is exactly today's behaviour.
   */
  consumers?: Readonly<Record<string, GateConsumer>>;
}

/** Base64 inflates ~4/3, so this admits attachments up to the 20MB save cap. */
const ATTACH_BODY_LIMIT = 30_000_000;

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
export async function handleMobileApi(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: MobileApiDeps,
): Promise<boolean> {
  const { store, ptys, turns, ops, presets } = deps;
  const method = request.method ?? "GET";
  const p = url.pathname;

  // The v4 §4 gate (see auth-gate.ts). This choke point runs BEFORE any route
  // match — and before the mobile server's own routes, which delegate here
  // first — so every /api/* path on this 0.0.0.0 listener passes through it.
  //
  // WHAT CHANGED FROM C1: the old gate fired on non-GET only, which meant every
  // read (workspace state, board, activity, transcripts) was open to anyone on
  // the LAN. §4 is deny-by-default: a known credential is required for reads
  // too, and only /api/auth/status plus the static bootstrap stay public.
  //
  // The two tokens are now the first two consumer ROWS rather than two special
  // cases (a strict generalization, §4's words):
  //   pairing (phone) → observe, dispatch, orchestrate, terminal-io, admin
  //   read-only (wall) → observe; anything else is 403, not 401 — the token is
  //                      KNOWN, so re-pairing is not the caller's fix (Sol F9)
  const hasPairing =
    !!deps.pairingToken && pairingAuthorized(request, url, deps.pairingToken);
  const hasReadOnly =
    !!deps.wallToken && pairingAuthorized(request, url, deps.wallToken);

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

  // `pairingToken` absent = the in-process embedder escape, unchanged: a
  // caller that constructed these deps without a credential is not on the
  // network. startMobileServer always injects one, so the LAN never selects it.
  if (deps.pairingToken && gatedPath(p)) {
    const verdict = gateRequest({
      method,
      url,
      request,
      tokens: {
        pairingToken: deps.pairingToken,
        wallToken: deps.wallToken,
        consumers: deps.consumers,
      },
    });
    if (verdict.status !== 200) {
      respondJson(response, verdict.status, { error: gateMessage(verdict) });
      return true;
    }
  }

  if (method === "GET" && p === "/api/workspace") {
    // Embed git per terminal (node.git) and per workspace dir (dirsGit) so
    // phone cards show branch/dirty without a round-trip (Fresco GitChip).
    respondJson(
      response,
      200,
      await enrichStateWithGit(store.state, ops.gitInfo),
    );
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
  // Activity Board: the cross-workspace, task-first view. Strictly ADDITIVE —
  // /api/activity above still serves the canvas cards byte-for-byte.
  if (method === "GET" && p === "/api/board") {
    // The board's own 401 lived here while other GETs were open — it is now
    // one `observe` route among many, gated at the choke point like the rest.
    if (!deps.board) {
      respondJson(response, 503, { error: "board index not wired" });
      return true;
    }
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
  if (method === "POST" && p === "/api/workspaces") {
    const body = await readJson<{ name?: string; dir?: string; team?: string }>(
      request,
    );
    respondJson(
      response,
      200,
      await ops.createWorkspace(
        body.name ?? "workspace",
        body.dir ?? "",
        body.team,
      ),
    );
    return true;
  }
  if (method === "POST" && p === "/api/workspaces/switch") {
    const body = await readJson<{ id?: string }>(request);
    ops.switchWorkspace(body.id ?? "");
    respondJson(response, 200, ops.listWorkspaces());
    return true;
  }
  if (method === "POST" && p === "/api/workspaces/rename") {
    const body = await readJson<{ id?: string; name?: string }>(request);
    respondJson(
      response,
      200,
      ops.renameWorkspace(body.id ?? "", body.name ?? ""),
    );
    return true;
  }
  // Workspace v2: remove + directory management + git (mobile = text input).
  const wsMatch = p.match(/^\/api\/workspaces\/([^/]+)$/);
  if (wsMatch && method === "DELETE") {
    try {
      respondJson(response, 200, ops.removeWorkspace(wsMatch[1]));
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  const wsServiceMatch = p.match(/^\/api\/workspaces\/([^/]+)\/service$/);
  if (wsServiceMatch && method === "POST") {
    const body = await readJson<{ state?: unknown }>(request);
    if (
      body.state !== "hot" &&
      body.state !== "dormant" &&
      body.state !== "parked"
    ) {
      respondJson(response, 400, {
        error: "state must be hot, dormant, or parked",
      });
      return true;
    }
    const workspaceId = wsServiceMatch[1];
    if (!ops.listWorkspaces().workspaces.some((workspace) => workspace.id === workspaceId)) {
      respondJson(response, 404, { error: `Workspace '${workspaceId}' not found` });
      return true;
    }
    try {
      respondJson(
        response,
        200,
        ops.setWorkspaceServiceState(workspaceId, body.state),
      );
    } catch (error) {
      // A full HOT fleet is a CAPACITY answer, not a fault: 409 is the same
      // thing /dispatch says when an agent is busy, and it tells the caller to
      // park something and retry. Without this the throw reached the
      // catch-all and reported 500 — "the server broke" — for a refusal the
      // server made on purpose. Anything else still surfaces as a fault.
      if (!(error instanceof HotCapacityError)) throw error;
      respondJson(response, 409, {
        error: error.message,
        limit: error.limit,
        state: body.state,
      });
    }
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

  if (method === "POST" && p === "/api/nodes") {
    const node = await readJson<CanvasNode>(request);
    respondJson(response, 200, ops.addNode(node));
    return true;
  }
  const nodeMatch = p.match(/^\/api\/nodes\/([^/]+)$/);
  if (nodeMatch && method === "POST") {
    const patch = await readJson<Partial<CanvasNode>>(request);
    respondJson(response, 200, ops.updateNode(nodeMatch[1], patch));
    return true;
  }
  if (nodeMatch && method === "DELETE") {
    await ops.removeNode(nodeMatch[1]);
    respondJson(response, 200, { ok: true });
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
      position: { x: number; y: number };
      orch: boolean;
      roleName?: string;
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
      respondJson(response, 200, await ops.teamFork(body.spec));
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
    const body = await readJson<{ name?: string; data?: string }>(
      request,
      ATTACH_BODY_LIMIT,
    );
    if (typeof body.data !== "string" || body.data.length === 0) {
      respondJson(response, 400, { error: "Missing data" });
      return true;
    }
    try {
      const saved = deps.saveAttachment(
        body.name ?? "file",
        Buffer.from(body.data, "base64"),
      );
      respondJson(response, 200, { path: saved });
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const traceIndexMatch = p.match(/^\/api\/terminal\/([^/]+)\/trace\/index$/);
  if (traceIndexMatch && method === "GET") {
    respondJson(response, 200, await deps.traces.index(traceIndexMatch[1]));
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
    };
    const paged =
      request.offset !== undefined ||
      request.limit !== undefined ||
      request.aroundIndex !== undefined;
    respondJson(
      response,
      200,
      paged
        ? pageTurns(turns.history(turnsMatch[1]), request)
        : turns.history(turnsMatch[1]),
    );
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

  const ptyMatch = p.match(
    /^\/api\/terminal\/([^/]+)\/(raw|resize|stream|jump)$/,
  );
  if (ptyMatch) {
    const session = ptys.get(ptyMatch[1]);
    if (!session) {
      respondJson(response, 404, { error: "Terminal not running" });
      return true;
    }
    if (method === "POST" && ptyMatch[2] === "raw") {
      const body = await readJson<{ data?: string }>(request);
      if (typeof body.data === "string") session.write(body.data);
      respondJson(response, 200, { ok: true });
      return true;
    }
    if (method === "POST" && ptyMatch[2] === "resize") {
      const body = await readJson<{ cols?: number; rows?: number }>(request);
      if (body.cols && body.rows) session.resize(body.cols, body.rows);
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
      // GEOMETRY FIRST, then the frame. The phone opens its xterm at its own
      // size (measured: 45x24 while the pane was still 100x30) and the resize
      // kick only arrives AFTER the first paint — so a frame applied before
      // the client knows the mirror's size gets re-wrapped, and herdr's
      // absolute-addressed deltas then land in the wrong cells. Announcing the
      // size first lets the client size its grid BEFORE any byte arrives.
      send("hello", session.geometry());
      // A faithful ANSI frame, not plain text — see PtySession.replayFrame.
      send("data", session.replayFrame());
      const onData = (data: string): void => send("data", data);
      // Geometry changed: the server re-serialized at the new size. Applying
      // it verbatim is what keeps this viewer's addressing valid.
      const onReplay = (frame: string): void => send("data", frame);
      const onExit = (): void => send("exit", {});
      session.on("data", onData);
      session.on("replay", onReplay);
      session.on("exit", onExit);
      const heartbeat = setInterval(() => response.write(":hb\n\n"), 25000);
      request.on("close", () => {
        clearInterval(heartbeat);
        session.removeListener("data", onData);
        session.removeListener("replay", onReplay);
        session.removeListener("exit", onExit);
      });
      return true;
    }
  }

  if (method === "GET" && p === "/api/events") {
    const send = startSse(response);
    send("workspace", store.state);
    send("workspaces", ops.listWorkspaces());
    for (const activity of turns.list()) send("activity", activity);
    const onChange = (state: WorkspaceState): void => send("workspace", state);
    const onWorkspaces = (list: WorkspaceList): void =>
      send("workspaces", list);
    const onActivity = (activity: unknown): void => send("activity", activity);
    // Observability stream: every store mutation, cross-workspace (toasts).
    const onOp = (event: CookrewEvent): void => send("event", event);
    // Activity Board stream. A SEPARATE listener on the same signals — the
    // 'activity' event above is left exactly as it was (canvas cards eat it).
    // Board recompute spans the whole fleet, so bursts coalesce instead of
    // pushing per tracker tick.
    // The board sub-stream's own gate, from when this SSE route was open to
    // anyone: reaching here at all now means the choke point cleared an
    // `observe` credential, which is exactly what the board needs.
    const board = deps.board;
    const boardNotifier = board
      ? createBoardNotifier(() => send("board", buildBoard(board)))
      : null;
    const onBoardSignal = (): void => boardNotifier?.schedule();
    if (board) send("board", buildBoard(board));
    store.on("change", onChange);
    store.on("workspaces", onWorkspaces);
    turns.on("activity", onActivity);
    store.on("op", onOp);
    if (boardNotifier) {
      turns.on("activity", onBoardSignal);
      store.on("change", onBoardSignal);
      store.on("workspaces", onBoardSignal);
    }
    const heartbeat = setInterval(() => response.write(":hb\n\n"), 25000);
    request.on("close", () => {
      clearInterval(heartbeat);
      store.removeListener("change", onChange);
      store.removeListener("workspaces", onWorkspaces);
      turns.removeListener("activity", onActivity);
      store.removeListener("op", onOp);
      if (boardNotifier) {
        boardNotifier.cancel();
        turns.removeListener("activity", onBoardSignal);
        store.removeListener("change", onBoardSignal);
        store.removeListener("workspaces", onBoardSignal);
      }
    });
    return true;
  }

  // Observability queries (metrics/history panel) + global agent roster.
  if (method === "GET" && p === "/api/events/query") {
    const q = parseEventQuery(url.searchParams);
    respondJson(response, 200, {
      events: deps.events.query(q),
      counts: deps.events.count(q),
    });
    return true;
  }
  if (method === "GET" && p === "/api/agents") {
    respondJson(response, 200, { agents: deps.agents.list() });
    return true;
  }
  // ENDPOINT RESTORE: rewind an agent in place to any checkpoint (+ undo).
  const restoreMatch = p.match(/^\/api\/agents\/([^/]+)\/restore$/);
  if (restoreMatch && method === "POST") {
    const body = await readJson<{ checkpointIndex?: number }>(request);
    const index = Number(body.checkpointIndex);
    if (!Number.isInteger(index) || index < 1) {
      respondJson(response, 400, { error: "checkpointIndex must be a positive integer" });
      return true;
    }
    try {
      respondJson(response, 200, await deps.restoreCheckpoint(restoreMatch[1], index));
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
  // than a silent 404 on a route the catalog advertises.
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
    const result = await deps.dispatch.dispatch(dispatchMatch[1], body);
    respondJson(response, result.status, result.body);
    return true;
  }
  const dispatchGetMatch = p.match(/^\/api\/dispatches\/([^/]+)$/);
  if (dispatchGetMatch && method === "GET") {
    // Gated at the choke point as `dispatch` (the manifest's group for it), so
    // a wall token is refused here even though it may read the board.
    if (!deps.dispatch) {
      respondJson(response, 503, { error: "dispatch is not available" });
      return true;
    }
    const result = deps.dispatch.lookup(dispatchGetMatch[1]);
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
