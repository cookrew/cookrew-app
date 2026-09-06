import { contextBridge, ipcRenderer, webUtils } from 'electron'

let deepLinkSubscriber: ((link: unknown) => void) | null = null
let heldDeepLinks: readonly unknown[] = []
ipcRenderer.on('app:deep-link', (_e, link: unknown) => {
  if (deepLinkSubscriber) deepLinkSubscriber(link)
  else heldDeepLinks = [...heldDeepLinks, link]
})

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

  // ── the owner's account (identity v2, phase 1) ──
  //
  // Every one of these is refused by main unless the sender IS the owner
  // window's top frame (account-ipc.ts, isOwnerSender), so exposing them here
  // does not hand a claim or a recovery code to a browser card. The renderer
  // FEATURE-DETECTS them: the phone bridge and the demo api have none of this,
  // and the avatar simply does not appear there in this phase.
  accountStatus: () => ipcRenderer.invoke('account:status'),
  /** Presence ping for the idle lock. Throttled by the renderer, not here. */
  accountActivity: () => ipcRenderer.invoke('account:activity'),
  accountCheck: (username: string) => ipcRenderer.invoke('account:check', username),
  accountClaim: (input: { username: string; password: string; name?: string }) =>
    ipcRenderer.invoke('account:claim', input),
  /** Phase 6: a password for the name this Mac already holds a key for. The
   *  name is main's to know, so this takes only the password. */
  accountMigrate: (input: { password: string; name?: string }) =>
    ipcRenderer.invoke('account:migrate', input),
  accountLock: () => ipcRenderer.invoke('account:lock'),
  /** Also renews a session that died, since the password is in hand once. */
  accountUnlock: (password: string) => ipcRenderer.invoke('account:unlock', password),
  /**
   * The session ended: trade the password for a new one.
   *
   * It may answer a LADDER instead — `{reason:'second_factor', step}` — and
   * the three calls under it climb it. They carry a pending id and a typed
   * code, never the password: main holds that for the length of the ladder, so
   * the renderer is not the custodian of a secret across a ten-minute poll.
   */
  accountResume: (password: string) => ipcRenderer.invoke('account:resume', password),
  accountResumeCode: (input: { pending: string; factor: 'totp' | 'recovery'; code: string }) =>
    ipcRenderer.invoke('account:resumeCode', input),
  /** Ask the account's other devices to approve this sign-in (D6). */
  accountResumeAsk: (pending: string) => ipcRenderer.invoke('account:resumeAsk', pending),
  /** And wait for the nod. One long call; the card drops it if it closes. */
  accountResumeWait: (pending: string) => ipcRenderer.invoke('account:resumeWait', pending),
  accountProfile: () => ipcRenderer.invoke('account:profile'),
  accountDevices: () => ipcRenderer.invoke('account:devices'),
  accountRevoke: (deviceId: string) => ipcRenderer.invoke('account:revoke', deviceId),
  accountRecoveryCodes: () => ipcRenderer.invoke('account:recoveryCodes'),
  /** SAVE AS FILE. Takes nothing: main writes the batch IT minted, never the
   *  renderer's copy, so this cannot be talked into writing chosen bytes. */
  accountSaveRecoveryCodes: () => ipcRenderer.invoke('account:saveRecoveryCodes'),
  /** I SAVED THEM — recorded locally so the RESCUE row stops saying NOT SAVED. */
  accountCodesSaved: () => ipcRenderer.invoke('account:codesSaved'),
  accountSetLock: (ms: number) => ipcRenderer.invoke('account:setLock', ms),
  accountSetProfile: (patch: { displayName?: string; avatar?: string | null }) =>
    ipcRenderer.invoke('account:setProfile', patch),
  accountWorkspacesReachable: (on: boolean) =>
    ipcRenderer.invoke('account:workspacesReachable', on),
  // ── pairing a phone through cookrew.dev (identity v2, phase 2) ──
  //
  // The key is a live credential for two minutes, which is exactly why it goes
  // through the same owner-only gate as a recovery code: a page that could
  // read it could pair itself to this Mac.
  accountPairingUrl: () => ipcRenderer.invoke('account:pairingUrl'),
  accountAdmittedDevices: () => ipcRenderer.invoke('account:admittedDevices'),
  accountForgetAdmitted: (deviceId: string) =>
    ipcRenderer.invoke('account:forgetAdmitted', deviceId),

  // ── phase 4: the approval prompt (D6) and the factor ladder (D3) ──
  //
  // Same guard, same reasoning: these can approve a device onto the account,
  // sign every other device out, and add a way in. Owner window's top frame
  // or nothing.
  accountApprovals: () => ipcRenderer.invoke('account:approvals'),
  accountDecide: (input: { id: string; decision: 'approve' | 'deny' | 'not-me' }) =>
    ipcRenderer.invoke('account:decide', input),
  accountSetPassword: (input: { current: string; next: string }) =>
    ipcRenderer.invoke('account:setPassword', input),
  accountFactors: () => ipcRenderer.invoke('account:factors'),
  /** The secret and its QR, for the moment the sheet draws them. */
  accountTotpEnrol: () => ipcRenderer.invoke('account:totpEnrol'),
  accountTotpConfirm: (code: string) => ipcRenderer.invoke('account:totpConfirm', code),
  /** Both removals carry the password: the registry gates them on it. */
  accountTotpRemove: (current: string) => ipcRenderer.invoke('account:totpRemove', current),
  accountPasskeys: () => ipcRenderer.invoke('account:passkeys'),
  accountPasskeyOptions: () => ipcRenderer.invoke('account:passkeyOptions'),
  accountPasskeyAdd: (input: { name: string; credential: Record<string, unknown> }) =>
    ipcRenderer.invoke('account:passkeyAdd', input),
  accountPasskeyRemove: (id: string, current: string) =>
    ipcRenderer.invoke('account:passkeyRemove', id, current),
  /**
   * The queue changed, or a notification was clicked (then with the request's
   * id, so the sheet opens on the one the owner was told about).
   */
  onAccountRequests: (cb: (requestId: string | null) => void) => {
    const listener = (_e: unknown, requestId: string | null): void => cb(requestId)
    ipcRenderer.on('account:requests', listener)
    return () => ipcRenderer.removeListener('account:requests', listener)
  },
  // ── seats & teams (identity v2, phase 5) ──
  accountSeats: () => ipcRenderer.invoke('account:seats'),
  accountTeamSeats: (slug: string) => ipcRenderer.invoke('account:teamSeats', slug),
  accountGrantSeat: (input: { slug: string; username: string }) =>
    ipcRenderer.invoke('account:grantSeat', input),
  accountEndSeat: (input: { slug: string; id: string }) =>
    ipcRenderer.invoke('account:endSeat', input),
  /** Who is at this desktop's served doors right now (D7's avatars). */
  onServingCallers: (cb: (rows: unknown) => void) => {
    const listener = (_e: unknown, rows: unknown): void => cb(rows)
    ipcRenderer.on('serving:callers', listener)
    return () => ipcRenderer.removeListener('serving:callers', listener)
  },
  servingCallers: () => ipcRenderer.invoke('serving:callers'),
  /** Main locked or unlocked the owner's view; the overlay follows this. */
  /**
   * The account file changed in main — most importantly, a session cookrew.dev
   * refused. The surface re-reads the status and opens its password prompt.
   */
  onAccountChanged: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('account:changed', listener)
    return () => ipcRenderer.removeListener('account:changed', listener)
  },
  onAccountLocked: (cb: (locked: boolean) => void) => {
    const listener = (_e: unknown, locked: boolean): void => cb(locked)
    ipcRenderer.on('account:locked', listener)
    return () => ipcRenderer.removeListener('account:locked', listener)
  },
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
  servingServe: (input: {
    templateId: string
    access: 'account' | 'paid'
    priceUsd?: string
    summary?: string
    tags?: readonly string[]
  }) => ipcRenderer.invoke('serving:serve', input),
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

  // ── import a served team (caller side) ──
  serveInspect: (link: string) => ipcRenderer.invoke('serve:inspect', link),
  serveBrowse: (link: string) => ipcRenderer.invoke('serve:browse', link),
  serveGate: (link: string) => ipcRenderer.invoke('serve:gate', link),
  serveCheckout: (link: string) => ipcRenderer.invoke('serve:checkout', link),
  serveSettle: (link: string, rail: 'x402' | 'stripe', session?: string) =>
    ipcRenderer.invoke('serve:settle', link, rail, session),
  serveImport: (
    link: string,
    position?: { x: number; y: number },
    paid?: { price: string; asset: string; rail: 'x402' | 'stripe' }
  ) => ipcRenderer.invoke('serve:import', link, position, paid),

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
  // Why a remote card's record is empty or stale — null for every local card.
  traceStatus: (terminalId: string) => ipcRenderer.invoke('trace:status', terminalId),
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
  // Sous driving the canvas: a sentence up, zoom / zoom-back down.
  sousCommand: (text: string, ctx: { surface: string; focusedAgentId?: string | null }) =>
    ipcRenderer.invoke('sous:command', text, ctx),
  onUiCommand: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown): void => cb(event)
    ipcRenderer.on('ui:command', listener)
    return () => ipcRenderer.removeListener('ui:command', listener)
  },
  quitApp: () => ipcRenderer.send('app:quit'),
  // A `cookrew://` link, already parsed by main (src/main/deep-link.ts) —
  // the renderer only ever sees one of the three verbs, never a raw URL.
  // Held here until App subscribes: main sends on did-finish-load, and React's
  // effects can run a beat after that, so a link the app was LAUNCHED with
  // would otherwise land on nobody.
  onDeepLink: (cb: (link: unknown) => void) => {
    deepLinkSubscriber = cb
    const held = heldDeepLinks
    heldDeepLinks = []
    held.forEach(cb)
    return () => {
      if (deepLinkSubscriber === cb) deepLinkSubscriber = null
    }
  },
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
