import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  onWorkspaceState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown): void => cb(state)
    ipcRenderer.on('workspace:state', listener)
    return () => ipcRenderer.removeListener('workspace:state', listener)
  },
  addNode: (node: unknown) => ipcRenderer.invoke('node:add', node),
  updateNode: (id: string, patch: unknown) => ipcRenderer.invoke('node:update', id, patch),
  removeNode: (id: string) => ipcRenderer.invoke('node:remove', id),
  connectNodes: (a: string, b: string) => ipcRenderer.invoke('node:connect', a, b),
  disconnect: (connId: string) => ipcRenderer.invoke('node:disconnect', connId),
  listPresets: () => ipcRenderer.invoke('preset:list'),
  createTerminal: (opts: unknown) => ipcRenderer.invoke('terminal:create', opts),

  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  createWorkspace: (name: string, dir: string) =>
    ipcRenderer.invoke('workspace:create', name, dir),
  switchWorkspace: (id: string) => ipcRenderer.invoke('workspace:switch', id),
  renameWorkspace: (id: string, name: string) =>
    ipcRenderer.invoke('workspace:rename', id, name),
  removeWorkspace: (id: string) => ipcRenderer.invoke('workspace:remove', id),
  addWorkspaceDir: (id: string, dir: string) => ipcRenderer.invoke('workspace:dir:add', id, dir),
  removeWorkspaceDir: (id: string, dir: string) =>
    ipcRenderer.invoke('workspace:dir:remove', id, dir),
  setPrimaryDir: (id: string, dir: string) =>
    ipcRenderer.invoke('workspace:dir:setPrimary', id, dir),
  setTerminalCwd: (nodeId: string, dir: string) =>
    ipcRenderer.invoke('terminal:setCwd', nodeId, dir),
  pickDir: () => ipcRenderer.invoke('dir:pick'),
  gitInfo: (dir: string) => ipcRenderer.invoke('git:info', dir),
  onWorkspaceList: (cb: (list: unknown) => void) => {
    const listener = (_e: unknown, list: unknown): void => cb(list)
    ipcRenderer.on('workspace:list', listener)
    return () => ipcRenderer.removeListener('workspace:list', listener)
  },

  ptyInput: (terminalId: string, data: string) => ipcRenderer.send('pty:input', terminalId, data),
  ptyResize: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', terminalId, cols, rows),
  ptyJump: (terminalId: string, text: string | null) =>
    ipcRenderer.send('pty:jump', terminalId, text),
  turnSeen: (terminalId: string) => ipcRenderer.send('turn:seen', terminalId),
  ptyAttach: (terminalId: string, onData: (data: string) => void) => {
    const channel = `pty:data:${terminalId}`
    const listener = (_e: unknown, data: string): void => onData(data)
    ipcRenderer.on(channel, listener)
    void ipcRenderer.invoke('pty:attach', terminalId)
    return () => {
      ipcRenderer.removeListener(channel, listener)
      ipcRenderer.send('pty:detach', terminalId)
    }
  },

  // 📎 attach: dropped File objects resolve to their on-disk paths right in
  // the preload (File.path is gone since Electron 32); no upload involved.
  attachFiles: (files: File[]) => Promise.resolve(files.map((f) => webUtils.getPathForFile(f))),
  pickFiles: () => ipcRenderer.invoke('attach:pick'),
  // Pasted clipboard images have no on-disk path — ship their bytes to main,
  // which saves them via the same saveAttachment flow as phone uploads and
  // returns the absolute path to paste into the terminal.
  saveAttachmentBytes: (name: string, bytes: Uint8Array) =>
    ipcRenderer.invoke('attach:save', name, bytes),

  listActivity: () => ipcRenderer.invoke('activity:list'),
  listTurns: (terminalId: string) => ipcRenderer.invoke('turn:history', terminalId),
  forkTerminal: (sourceId: string, turnIndex?: number) =>
    ipcRenderer.invoke('terminal:fork', sourceId, turnIndex),
  teamFork: (spec: unknown) => ipcRenderer.invoke('team:fork', spec),
  teamSave: (name?: string) => ipcRenderer.invoke('team:save', name),
  teamList: () => ipcRenderer.invoke('team:list'),
  roleList: () => ipcRenderer.invoke('role:list'),
  // Observability event log (observability-event-log-spec): global stream +
  // filtered queries + the durable agent roster.
  onEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown): void => cb(event)
    ipcRenderer.on('event:new', listener)
    return () => ipcRenderer.removeListener('event:new', listener)
  },
  queryEvents: (query: unknown) => ipcRenderer.invoke('events:query', query),
  countEvents: (query: unknown) => ipcRenderer.invoke('events:count', query),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  onTerminalActivity: (cb: (activity: unknown) => void) => {
    const listener = (_e: unknown, activity: unknown): void => cb(activity)
    ipcRenderer.on('terminal:activity', listener)
    return () => ipcRenderer.removeListener('terminal:activity', listener)
  },

  onBrowserCommand: (cb: (req: { id: string; args: string[]; terminalId: string }) => void) => {
    const listener = (_e: unknown, req: { id: string; args: string[]; terminalId: string }): void =>
      cb(req)
    ipcRenderer.on('browser:command', listener)
    return () => ipcRenderer.removeListener('browser:command', listener)
  },
  browserResult: (id: string, ok: boolean, output: string) =>
    ipcRenderer.send('browser:result', id, ok, output),
  browserThumb: (browserId: string, dataUrl: string) =>
    ipcRenderer.send('browser:thumb', browserId, dataUrl),
  onCmdW: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:cmd-w', listener)
    return () => ipcRenderer.removeListener('app:cmd-w', listener)
  },
  quitApp: () => ipcRenderer.send('app:quit'),
  onBrowserOpenTab: (cb: (req: { webContentsId: number; url: string }) => void) => {
    const listener = (_e: unknown, req: { webContentsId: number; url: string }): void => cb(req)
    ipcRenderer.on('browser:open-tab', listener)
    return () => ipcRenderer.removeListener('browser:open-tab', listener)
  }
}

contextBridge.exposeInMainWorld('cookrew', api)

export type CookrewApi = typeof api
