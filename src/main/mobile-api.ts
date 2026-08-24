import type http from "node:http";
import type { WorkspaceStore } from "./store";
import type { PtyManager } from "./pty";
import type { TurnTracker } from "./turn-tracker";
import type { DispatchService } from "./dispatch";
import type { EventLog, CookrewEvent, EventQuery } from "./event-log";
import { pageTurns } from "../shared/turn";
import type { AgentRegistry } from "./agent-registry";
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
import { readBytes, readJson, respondJson, startSse, pairingAuthorized } from "./mobile-http";
import { ownerSubmit } from "./ask";
import { MAX_ATTACHMENT_BYTES } from "./attachments";

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
    position?: { x: number; y: number };
    orch?: boolean;
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
  /**
   * The workspace this request is FOR — a resolved slug, or null at the
   * unslugged root where the focused session answers as it always has.
   */
  scope?: string | null;
  ptys: PtyManager;
  turns: TurnTracker;
  /**
   * The LATEST checkpoint for a card, from a bounded tail read of the session
   * file — no PTY (trace-perf-architecture T1). Lets the phone canvas show an
   * idle agent's last turn without opening a mirror, matching the desktop card.
   * Optional so this module serves before it is wired.
   */
  latestCheckpoint?: (
    terminalId: string,
  ) => Promise<{ prompt: string; reply: string; title?: string } | null>;
  /** Observability event log (query/count) — spec observability-event-log-spec. */
  events: EventLog;
  /** Durable agent roster cache (~/.cookrew/agents.json). */
  agents: AgentRegistry;
  /** Recover an inactive teammate as it was (agent-recover feature). */
  recoverAgent: (id: string) => RecoverResult;
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
   * Pairing token required on every MUTATING route (C1) as
   * `Authorization: Bearer <token>` (or `?token=`). Undefined =
   * unauthenticated (loopback-only embedders, tests).
   */
  pairingToken?: string;
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
export async function handleMobileApi(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: MobileApiDeps,
): Promise<boolean> {
  const { store, ptys, turns, ops, presets } = deps;
  const method = request.method ?? "GET";
  const p = url.pathname;
  /** Null at the root; a workspace id under a slug. */
  const scope = deps.scope ?? null;
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
  const hasPairing =
    !!deps.pairingToken && pairingAuthorized(request, url, deps.pairingToken);
  const hasReadOnly =
    !!deps.wallToken && pairingAuthorized(request, url, deps.wallToken);
  /** Cleared for a read: either scope. */
  const canRead = hasPairing || hasReadOnly;

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
      position?: { x: number; y: number };
      orch?: boolean;
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
  const httpProducerMatch = p.match(/^\/api\/terminal\/([^/]+)\/(input|ask|raw)$/);
  if (
    httpProducerMatch &&
    method === "POST" &&
    deps.hasArmedDispatch?.(httpProducerMatch[1]) === true
  ) {
    respondJson(response, 409, { error: "agent has a dispatch in flight" });
    return true;
  }

  const ptyMatch = p.match(
    /^\/api\/terminal\/([^/]+)\/(raw|resize|stream|jump)$/,
  );
  if (ptyMatch) {
    const terminalId = ptyMatch[1];
    const openingStream = method === "GET" && ptyMatch[2] === "stream";
    const acquired = openingStream
      ? (deps.acquireTerminalView?.(terminalId) ?? true)
      : true;
    if (!acquired) {
      respondJson(response, 404, { error: "Terminal not running" });
      return true;
    }
    const session = ptys.get(terminalId);
    if (!session) {
      if (openingStream) deps.releaseTerminalView?.(terminalId);
      respondJson(response, 404, { error: "Terminal not running" });
      return true;
    }
    if (method === "POST" && ptyMatch[2] === "raw") {
      const body = await readJson<{ data?: string }>(request);
      if (typeof body.data === "string") {
        // /raw is a producer (Sol r7 P0-2): its bytes can be a prompt plus
        // Enter, so they go through THE submit primitive — classified,
        // leased across paste+CR when submit-capable, ordinarily guarded
        // when not. A refusal is a 409 the caller can act on, never a
        // silently dropped write followed by an ok:true.
        const verdict = await ownerSubmit(session, body.data);
        if (!verdict.ok) {
          respondJson(response, 409, { error: verdict.reason });
          return true;
        }
      }
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
      // The viewer is a tracking fact from the first byte (A4).
      deps.subscribeTerminal?.(terminalId);
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
      // Keepalive is startSse's job — see mobile-http.ts. Writing to the
      // response here would land plaintext inside the gzip stream.
      request.on("close", () => {
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

  if (method === "GET" && p === "/api/events") {
    const send = startSse(response);
    send("workspace", scopedState());
    send("workspaces", ops.listWorkspaces());
    // Activities are keyed by terminal id across every workspace, so a scoped
    // stream filters them or it leaks other canvases' agents into this one.
    const inScopedCanvas = (terminalId: string): boolean =>
      scope === null || scopedState().nodes.some((node) => node.id === terminalId);
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
    const onChange = (state: WorkspaceState): void => send("workspace", state);
    const onScopedChange = (payload: {
      workspaceId: string;
      state: WorkspaceState;
    }): void => {
      if (payload.workspaceId === scope) send("workspace", payload.state);
    };
    const onWorkspaces = (list: WorkspaceList): void =>
      send("workspaces", list);
    const onActivity = (activity: unknown): void => {
      if (inScopedCanvas((activity as { terminalId: string }).terminalId)) {
        send("activity", activity);
      }
    };
    // Observability stream: every store mutation, cross-workspace (toasts).
    const onOp = (event: CookrewEvent): void => send("event", event);
    // Activity Board stream. A SEPARATE listener on the same signals — the
    // 'activity' event above is left exactly as it was (canvas cards eat it).
    // Board recompute spans the whole fleet, so bursts coalesce instead of
    // pushing per tracker tick.
    // Same data as /api/board, so the same gate: an unauthenticated
    // subscriber still gets workspace/activity/event (existing behaviour,
    // untouched) but never the board stream.
    const board = !deps.pairingToken || canRead ? deps.board : undefined;
    const boardNotifier = board
      ? createBoardNotifier(() => send("board", buildBoard(board)))
      : null;
    const onBoardSignal = (): void => boardNotifier?.schedule();
    if (board) send("board", buildBoard(board));
    if (scope === null) store.on("change", onChange);
    else store.on("workspace-change", onScopedChange);
    store.on("workspaces", onWorkspaces);
    turns.on("activity", onActivity);
    store.on("op", onOp);
    if (boardNotifier) {
      turns.on("activity", onBoardSignal);
      store.on("change", onBoardSignal);
      store.on("workspaces", onBoardSignal);
    }
    request.on("close", () => {
      // Symmetric with the attach above — an unremoved scoped listener is a
      // leak per disconnected phone, and phones disconnect constantly.
      if (scope === null) store.removeListener("change", onChange);
      else store.removeListener("workspace-change", onScopedChange);
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
