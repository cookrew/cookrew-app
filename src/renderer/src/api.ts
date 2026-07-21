import type {
  AgentRole,
  CanvasNode,
  Connection,
  GitInfo,
  TeamForkSpec,
  TeamMeta,
  WorkspaceList,
  WorkspaceMeta,
  WorkspaceState
} from '../../shared/model'
import type { TerminalActivity, TurnRecord } from '../../shared/turn'

export interface CookrewApi {
  getWorkspace: () => Promise<WorkspaceState>
  onWorkspaceState: (cb: (state: WorkspaceState) => void) => () => void
  listWorkspaces: () => Promise<WorkspaceList>
  /** team: create pre-populated from a saved team template (FEATURE 1). */
  createWorkspace: (name: string, dir: string, team?: string) => Promise<WorkspaceMeta>
  switchWorkspace: (id: string) => Promise<WorkspaceList>
  renameWorkspace: (id: string, name: string) => Promise<WorkspaceList>
  /** Workspace v2: remove workspace, multi-directory, per-terminal cwd, git. */
  removeWorkspace: (id: string) => Promise<WorkspaceList>
  addWorkspaceDir: (id: string, dir: string) => Promise<WorkspaceList>
  removeWorkspaceDir: (id: string, dir: string) => Promise<WorkspaceList>
  setPrimaryDir: (id: string, dir: string) => Promise<WorkspaceList>
  setTerminalCwd: (nodeId: string, dir: string) => Promise<CanvasNode>
  /** Native directory picker (desktop only; null elsewhere/cancelled). */
  pickDir: () => Promise<string | null>
  /** Git state of a directory; null when unavailable (demo). */
  gitInfo: (dir: string) => Promise<GitInfo | null>
  onWorkspaceList: (cb: (list: WorkspaceList) => void) => () => void
  addNode: (node: CanvasNode) => Promise<CanvasNode>
  updateNode: (id: string, patch: Partial<CanvasNode>) => Promise<CanvasNode | undefined>
  removeNode: (id: string) => Promise<void>
  connectNodes: (a: string, b: string) => Promise<Connection>
  disconnect: (connId: string) => Promise<void>
  listPresets: () => Promise<{ name: string; command: string }[]>
  createTerminal: (opts: {
    name: string
    preset: string
    position: { x: number; y: number }
    orch: boolean
    /** Boot from a saved role (rolePrompt injected once the TUI is quiet). */
    roleName?: string
  }) => Promise<CanvasNode>
  /**
   * Resolve dropped/picked File objects to absolute paths on the machine
   * running the agents: the Electron bridge reads the local path, the remote
   * (phone) api uploads the bytes first. Callers paste the returned paths.
   */
  attachFiles: (files: File[]) => Promise<string[]>
  saveAttachmentBytes: (name: string, bytes: Uint8Array) => Promise<string>
  /** Native multi-file picker (desktop only; returns [] elsewhere). */
  pickFiles: () => Promise<string[]>
  ptyInput: (terminalId: string, data: string) => void
  ptyResize: (terminalId: string, cols: number, rows: number) => void
  /** Scroll the terminal view to a past ask's line; null returns to live. */
  ptyJump: (terminalId: string, text: string | null) => void
  /** Acknowledge-on-view: user is looking at this terminal's result. */
  turnSeen: (terminalId: string) => void
  ptyAttach: (terminalId: string, onData: (data: string) => void) => () => void
  listActivity: () => Promise<TerminalActivity[]>
  onTerminalActivity: (cb: (activity: TerminalActivity) => void) => () => void
  /**
   * Observability event log (observability-event-log-spec): global mutation
   * stream, filtered history/count queries, and the durable agent roster.
   * Optional — the demo api lacks them; consumers feature-detect (EventToast).
   */
  onEvent?: (cb: (event: unknown) => void) => () => void
  queryEvents?: (query?: unknown) => Promise<unknown[]>
  countEvents?: (query?: unknown) => Promise<Record<string, number>>
  listAgents?: () => Promise<unknown[]>
  /** Completed turns of a terminal (oldest first) for the card pager. */
  listTurns: (terminalId: string) => Promise<TurnRecord[]>
  /** Fork a NEW agent card from a past turn; omit turnIndex for the latest. */
  forkTerminal: (sourceId: string, turnIndex?: number) => Promise<CanvasNode>
  /** Fork a team into a NEW workspace per the spec (switches to it). */
  teamFork: (spec: TeamForkSpec) => Promise<WorkspaceMeta>
  /** Snapshot the live canvas + turn histories to ~/.cookrew/teams. */
  teamSave: (name?: string) => Promise<TeamMeta>
  teamList: () => Promise<TeamMeta[]>
  roleList: () => Promise<AgentRole[]>
  /**
   * Save a reusable role, optionally with checkpoint provenance
   * (checkpoint-program-spec). Optional — demo mode lacks it; the roles UI
   * feature-detects via role-checkpoint.ts.
   */
  saveRole?: (input: {
    nodeId: string
    name: string
    rolePrompt: string
    sourceTurnUuid?: string
    sourceTurnPrompt?: string
    sessionCopyRef?: string
  }) => Promise<AgentRole>
  onBrowserCommand: (cb: (req: { id: string; args: string[]; terminalId: string }) => void) => () => void
  browserResult: (id: string, ok: boolean, output: string) => void
  /** Forward a browser thumbnail frame to main (served to the mobile client). */
  browserThumb: (browserId: string, dataUrl: string) => void
  onBrowserOpenTab: (cb: (req: { webContentsId: number; url: string }) => void) => () => void
  /** Main routes ⌘W here so the renderer can close the topmost layer first. */
  onCmdW: (cb: () => void) => () => void
  quitApp: () => void
}

import { createDemoApi } from './demo-api'
import { createRemoteApi } from './remote-api'

let demoApi: CookrewApi | null = null
let remoteApi: CookrewApi | null = null

function bridge(): CookrewApi | undefined {
  return (window as unknown as { cookrew?: CookrewApi }).cookrew
}

/**
 * Returns the Electron preload bridge when present. Outside Electron there
 * are two fallbacks: the remote HTTP/SSE api when served by the mobile
 * server (window.COOKREW_MOBILE marker), else the in-memory demo (plain
 * browser tab, embedded browser node).
 */
export function cookrew(): CookrewApi {
  const ipc = bridge()
  if (ipc) return ipc
  if (isRemoteMode()) {
    if (!remoteApi) remoteApi = createRemoteApi()
    return remoteApi
  }
  if (!demoApi) demoApi = createDemoApi()
  return demoApi
}

/** Phone browser talking to the desktop app through the mobile server. */
export function isRemoteMode(): boolean {
  return !bridge() && (window as unknown as { COOKREW_MOBILE?: number }).COOKREW_MOBILE === 1
}

export function isDemoMode(): boolean {
  return !bridge() && !isRemoteMode()
}

/** Only the Electron renderer has real Chromium <webview>s for browsers. */
export function hasNativeWebview(): boolean {
  return bridge() !== undefined
}
