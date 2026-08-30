import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  // The owner's grant surface. Main refuses any sender that is not the owner
  // window's TOP frame, so exposing it here does not hand it to a browser card
  // or an install page — see owner-grant.ts and grant-surface-shape.test.ts.
  grantEnrol: (workspaceId: string, sub: string, jwk: unknown) =>
    ipcRenderer.invoke('grant:enrol', workspaceId, sub, jwk),
  // REVOKE STOPS CALLS ALREADY RUNNING. Both of these take access away, and
  // both resolve with `stopped` — how many in-flight calls the decision cut —
  // so the surface can tell the owner what actually happened rather than only
  // that the record changed. See owner-grant.ts and call-run.ts.
  grantRevoke: (workspaceId: string, sub: string) =>
    ipcRenderer.invoke('grant:revoke', workspaceId, sub),
  grantExport: (workspaceId: string, nodeId: string, callers: string[]) =>
    ipcRenderer.invoke('grant:export', workspaceId, nodeId, callers),
  grantUnexport: (workspaceId: string, nodeId: string) =>
    ipcRenderer.invoke('grant:unexport', workspaceId, nodeId),
  // The ROSTER, not the raw record: enrolled callers with what each may call,
  // exported agents with how many calls are running against them, and the live
  // calls themselves — see grant-roster.ts.
  // The deck's 10-second UNDO. Exact by construction: revoking never touched a
  // grant, so the prior grant set comes back because it never left.
  grantRestore: (workspaceId: string, sub: string) =>
    ipcRenderer.invoke('grant:restore', workspaceId, sub),
  grantList: (workspaceId: string) => ipcRenderer.invoke('grant:list', workspaceId),
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
  // NOT `preset:list` — that is the HARNESS preset list, a different shape.
  // Aliasing them made listInstalledPresets return {name, command}[], which
  // the chip model reads as `members.length` and crashes the dock on.
  listInstalledPresets: () => ipcRenderer.invoke('preset:installed:list'),
  placeInstalledPreset: (id: string, position: unknown, orch: boolean) =>
    ipcRenderer.invoke('preset:installed:place', id, position, orch),
  uninstallPreset: (id: string) => ipcRenderer.invoke('preset:installed:uninstall', id),
  // R20: dismissing the rotation sheet and accepting the new key are two
  // different decisions, so they are two channels. Collapsing them would make
  // "I have read this" mean "I trust this".
  markPresetRotationSeen: (id: string) => ipcRenderer.invoke('preset:installed:rotation:seen', id),
  trustPresetAuthorKey: (id: string, newKeyId: string) =>
    ipcRenderer.invoke('preset:installed:rotation:trust', id, newKeyId),
  listPins: (terminalId: string) => ipcRenderer.invoke('pins:list', terminalId),

  /** Translate a checkpoint body with Sous. Never rejects; see main. */
  /** Host of the remote translator, or null when Sous is local. */
  translateHost: () => ipcRenderer.invoke('sous:host'),
  translateCheckpoint: (text: string, language: string) =>
    ipcRenderer.invoke('sous:translate', text, language),
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  createWorkspace: (name: string, dir: string, team?: string) =>
    ipcRenderer.invoke('workspace:create', name, dir, team),
  templateImport: (team: string, position?: { x: number; y: number }) =>
    ipcRenderer.invoke('template:import', team, position),

  // ── R30 share-on-save (export side) ──
  servingServe: (input: { templateId: string; access: 'account' | 'paid'; priceUsd?: string }) =>
    ipcRenderer.invoke('serving:serve', input),
  servingStop: (serviceId: string) => ipcRenderer.invoke('serving:stop', serviceId),
  servingPaymentStatus: () => ipcRenderer.invoke('serving:payment-status'),
  servingSetPayTo: (payTo: string) => ipcRenderer.invoke('serving:payment-pay-to', payTo),
  // Write-only by construction: the bridge exposes a setter and sanitized
  // status, never a method capable of reading STRIPE_SECRET_KEY back.
  servingSetStripeSecret: (secret: string) =>
    ipcRenderer.invoke('serving:payment-stripe', secret),
  servingList: () => ipcRenderer.invoke('serving:list'),
  servingSessions: () => ipcRenderer.invoke('serving:sessions'),
  servingEnd: (sessionId: string) => ipcRenderer.invoke('serving:end', sessionId),

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
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  browserSnapshot: (browserId: string) => ipcRenderer.invoke('browser:snapshot', browserId),
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
  ptyAttach: (
    terminalId: string,
    onData: (data: string) => void,
    onHello?: (geometry: { cols: number; rows: number }) => void
  ) => {
    const channel = `pty:data:${terminalId}`
    const helloChannel = `pty:hello:${terminalId}`
    const listener = (_e: unknown, data: string): void => onData(data)
    const helloListener = (_e: unknown, geometry: { cols: number; rows: number }): void =>
      onHello?.(geometry)
    // Subscribed BEFORE the invoke: main sends the hello and the first frame
    // synchronously inside that handler, so a listener added after it would
    // miss both.
    ipcRenderer.on(helloChannel, helloListener)
    ipcRenderer.on(channel, listener)
    // The lazy mirror may not be resident the instant a transcript opens — a
    // just-booted pane, a herdr ensureSession race, a transient EAGAIN — and
    // pty:attach then answers FALSE, sending no frame. Ignoring that left the
    // live pane BLACK forever. So retry with backoff until it attaches (the
    // listeners stay up, so the eventual frame paints). Cancelled on detach.
    let detached = false
    const tryAttach = (attempt: number): void => {
      if (detached) return
      void ipcRenderer.invoke('pty:attach', terminalId).then((ok: unknown) => {
        if (ok === false && !detached && attempt < 8) {
          setTimeout(() => tryAttach(attempt + 1), Math.min(300 * (attempt + 1), 1500))
        }
      })
    }
    tryAttach(0)
    return () => {
      detached = true
      ipcRenderer.removeListener(channel, listener)
      ipcRenderer.removeListener(helloChannel, helloListener)
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
  searchTurns: (query: string, limit?: number) =>
    ipcRenderer.invoke('turn:search', query, limit),
  listTurnsPage: (terminalId: string, request?: unknown) =>
    ipcRenderer.invoke('turn:page', terminalId, request),
  listTrace: (terminalId: string, request?: unknown) =>
    ipcRenderer.invoke('trace:page', terminalId, request),
  listTraceIndex: (terminalId: string, request?: unknown) =>
    ipcRenderer.invoke('trace:index', terminalId, request),
  listTraceMarkers: (terminalId: string) => ipcRenderer.invoke('trace:markers', terminalId),
  listLineageSegments: (terminalId: string) => ipcRenderer.invoke('trace:lineage', terminalId),
  // T1: the latest checkpoint for a visible card, no PTY. Returns
  // {prompt, reply, title?} | null.
  latestCheckpoint: (terminalId: string) =>
    ipcRenderer.invoke('trace:latest', terminalId) as Promise<{
      prompt: string
      reply: string
      title?: string
    } | null>,
  // T4 push: subscribe/unsubscribe a card's file watch, and listen for the
  // "your checkpoint changed" nudge (payload = terminalId).
  watchLatest: (terminalId: string) => ipcRenderer.invoke('trace:latest-watch', terminalId),
  unwatchLatest: (terminalId: string) => ipcRenderer.invoke('trace:latest-unwatch', terminalId),
  onLatestChanged: (cb: (terminalId: string) => void) => {
    const listener = (_e: unknown, terminalId: string): void => cb(terminalId)
    ipcRenderer.on('trace:latest-changed', listener)
    return () => ipcRenderer.removeListener('trace:latest-changed', listener)
  },
  forkTerminal: (sourceId: string, turnIndex?: number) =>
    ipcRenderer.invoke('terminal:fork', sourceId, turnIndex),
  teamFork: (spec: unknown) => ipcRenderer.invoke('team:fork', spec),
  teamSave: (name?: string, nodeIds?: string[]) => ipcRenderer.invoke('team:save', name, nodeIds),
  teamClipSet: (nodeIds: string[], cut: boolean, worktree?: { name: string }) =>
    ipcRenderer.invoke('team:clip:set', nodeIds, cut, worktree),
  teamClipGet: () => ipcRenderer.invoke('team:clip:get'),
  teamPaste: () => ipcRenderer.invoke('team:clip:paste'),
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
  listBoard: (window?: string) => ipcRenderer.invoke('board:list', window),
  recoverAgent: (id: string) => ipcRenderer.invoke('agent:recover', id),
  restoreCheckpoint: (id: string, checkpointIndex: number, targetSessionId?: string) =>
    ipcRenderer.invoke('agent:restore-checkpoint', id, checkpointIndex, targetSessionId),
  undoRestore: (id: string) => ipcRenderer.invoke('agent:undo-restore', id),
  saveRole: (input: unknown) => ipcRenderer.invoke('role:save', input),
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
  interactiveBrowserEnabled: () => ipcRenderer.invoke('browser:interactive-enabled'),
  browserStreamToken: () => ipcRenderer.invoke('browser:stream-token'),
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
  },
  onBrowserPhoneViewing: (cb: (browserId: string) => void) => {
    const listener = (_e: unknown, browserId: string): void => cb(browserId)
    ipcRenderer.on('browser:phone-viewing', listener)
    return () => ipcRenderer.removeListener('browser:phone-viewing', listener)
  }
}

contextBridge.exposeInMainWorld('cookrew', api)

export type CookrewApi = typeof api
