import type { CanvasNode, Connection, WorkspaceList, WorkspaceMeta, WorkspaceState } from '../../shared/model'
import type { TerminalActivity } from '../../shared/turn'

export interface CookrewApi {
  getWorkspace: () => Promise<WorkspaceState>
  onWorkspaceState: (cb: (state: WorkspaceState) => void) => () => void
  listWorkspaces: () => Promise<WorkspaceList>
  createWorkspace: (name: string, dir: string) => Promise<WorkspaceMeta>
  switchWorkspace: (id: string) => Promise<WorkspaceList>
  renameWorkspace: (id: string, name: string) => Promise<WorkspaceList>
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
  }) => Promise<CanvasNode>
  ptyInput: (terminalId: string, data: string) => void
  ptyResize: (terminalId: string, cols: number, rows: number) => void
  ptyAttach: (terminalId: string, onData: (data: string) => void) => () => void
  listActivity: () => Promise<TerminalActivity[]>
  onTerminalActivity: (cb: (activity: TerminalActivity) => void) => () => void
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
 * browser tab, Maestri browser).
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
