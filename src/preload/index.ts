import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { registryFromArgv } from '../shared/machine-words'

let deepLinkSubscriber: ((link: unknown) => void) | null = null
let heldDeepLinks: readonly unknown[] = []
ipcRenderer.on('app:deep-link', (_e, link: unknown) => {
  if (deepLinkSubscriber) deepLinkSubscriber(link)
  else heldDeepLinks = [...heldDeepLinks, link]
})

/**
 * A browser card's live view, straight from main (browser-cast-ipc.ts). Main
 * answers an ask with one end of a MessageChannel, paired by nonce. The port
 * stays HERE: the page gets post/close and its own callbacks, which is all a
 * view needs and keeps the port itself out of the main world.
 */
interface BrowserStreamHandlers {
  onOpen: () => void
  onMessage: (message: unknown) => void
  onClose: () => void
}
const browserStreamWaiters = new Map<string, (port: MessagePort) => void>()
ipcRenderer.on('browser-stream:port', (event, info: { nonce?: unknown } | null) => {
  const port = event.ports[0]
  const nonce = typeof info?.nonce === 'string' ? info.nonce : ''
  const waiter = browserStreamWaiters.get(nonce)
  browserStreamWaiters.delete(nonce)
  if (waiter && port) waiter(port)
  else port?.close()
})

function openBrowserStream(
  browserId: string,
  handlers: BrowserStreamHandlers
): { post: (message: unknown) => void; close: () => void } {
  const nonce = crypto.randomUUID()
  let port: MessagePort | null = null
  let closed = false
  const queued: unknown[] = []
  const end = (): void => {
    if (closed) return
    closed = true
    browserStreamWaiters.delete(nonce)
    port?.close()
    handlers.onClose()
  }
  browserStreamWaiters.set(nonce, (answer) => {
    if (closed) return answer.close()
    port = answer
    answer.onmessage = (event: MessageEvent): void => {
      const data = event.data as { t?: unknown } | null
      // Main says goodbye before it closes its end (the card's instance was
      // replaced or removed): the view redials, the same as a dropped socket.
      if (data?.t === 'bye') return end()
      handlers.onMessage(data)
    }
    answer.start()
    for (const message of queued.splice(0)) answer.postMessage(message)
    handlers.onOpen()
  })
  ipcRenderer.send('browser-stream:open', browserId, nonce)
  return {
    post: (message) => {
      if (closed) return
      if (port) port.postMessage(message)
      else queued.push(message)
    },
    close: () => {
      if (closed) return
      closed = true
      browserStreamWaiters.delete(nonce)
      port?.close()
    }
  }
}

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
  /**
   * v3: the second Mac. A name and a password for an account this Mac has
   * never held; a fresh device key is minted in main. Answers the same ladder
   * as `accountResume`, and the same three rungs finish it.
   */
  // v3 (D8 · D12): join with a code minted where the trust already is, and
  // mint one for the next machine.
  accountJoin: (input: { code: string; name?: string }) =>
    ipcRenderer.invoke('account:join', input),
  accountJoinCode: (current: string) => ipcRenderer.invoke('account:joinCode', current),
  accountSignIn: (input: { username: string; password: string; name?: string }) =>
    ipcRenderer.invoke('account:signIn', input),
  accountResumeCode: (input: { pending: string; factor: 'totp' | 'recovery'; code: string }) =>
    ipcRenderer.invoke('account:resumeCode', input),
  /** Ask the account's other devices to approve this sign-in (D6). */
  accountResumeAsk: (pending: string) => ipcRenderer.invoke('account:resumeAsk', pending),
  /** And wait for the nod. One long call; the card drops it if it closes. */
  accountResumeWait: (pending: string) => ipcRenderer.invoke('account:resumeWait', pending),
  accountProfile: () => ipcRenderer.invoke('account:profile'),
  accountDevices: () => ipcRenderer.invoke('account:devices'),
  // v3 (D12): both verbs on the Devices tab step up for the password.
  accountRevoke: (input: { deviceId: string; password: string }) =>
    ipcRenderer.invoke('account:revoke', input),
  accountSignOut: (password: string) => ipcRenderer.invoke('account:signOut', password),
  accountDelete: (input: { confirm: string; password: string }) => ipcRenderer.invoke('account:delete', input),
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
  /** The one queue (D11): what is waiting, and what is over. */
  accountRequests: () => ipcRenderer.invoke('account:requests'),
  /** Answer one row. The verb is the button's own id; the number rides along. */
  accountDecideRequest: (input: { id: string; action: string; match?: string }) =>
    ipcRenderer.invoke('account:decideRequest', input),
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
  /**
   * SOMETHING HAPPENED TO THE ACCOUNT (account:changed) — a device joined, one
   * was revoked, the password changed, a door moved, somebody pressed "not
   * me". Pushed with its sentence already written by the one view model, so
   * the toast and the system notification cannot word it differently.
   */
  onAccountEvent: (cb: (event: { kind: string; device?: string; at: number; sentence: string }) => void) => {
    const listener = (_e: unknown, event: { kind: string; device?: string; at: number; sentence: string }): void =>
      cb(event)
    ipcRenderer.on('account:event', listener)
    return () => ipcRenderer.removeListener('account:event', listener)
  },
  // ── seats & teams (identity v2, phase 5) ──
  accountSeats: () => ipcRenderer.invoke('account:seats'),
  accountTeamSeats: (slug: string) => ipcRenderer.invoke('account:teamSeats', slug),
  accountGrantSeat: (input: { slug: string; username: string }) =>
    ipcRenderer.invoke('account:grantSeat', input),
  accountEndSeat: (input: { slug: string; id: string }) =>
    ipcRenderer.invoke('account:endSeat', input),
  // Third-party sign-in. The browser trip runs in main; nothing here carries a
  // verifier, a handoff or a ticket.
  accountOAuthProviders: () => ipcRenderer.invoke('account:oauthProviders'),
  accountOAuthStart: (provider: string) => ipcRenderer.invoke('account:oauthStart', provider),
  accountOAuthCancel: () => ipcRenderer.invoke('account:oauthCancel'),
  accountOAuthClaim: (username: string) => ipcRenderer.invoke('account:oauthClaim', username),
  accountOAuthLink: (input: { provider: string; current?: string; rescue?: string }) =>
    ipcRenderer.invoke('account:oauthLink', input),
  accountOAuthUnlink: (input: { provider: string; current?: string }) =>
    ipcRenderer.invoke('account:oauthUnlink', input),
  // The one sign-in page. The request, the proof and the code stay in main.
  accountBrowserSignIn: (intent: string, username?: string) =>
    ipcRenderer.invoke('account:browserSignIn', intent, username),
  accountBrowserResume: () => ipcRenderer.invoke('account:browserResume'),
  accountBrowserLink: (input: { provider: string; current?: string; rescue?: string }) =>
    ipcRenderer.invoke('account:browserLink', input),
  accountSetPasscode: (input: { next: string; current?: string }) =>
    ipcRenderer.invoke('account:setPasscode', input),
  accountSetTouchId: (on: boolean) => ipcRenderer.invoke('account:setTouchId', on),
  accountUnlockTouchId: () => ipcRenderer.invoke('account:unlockTouchId'),
  accountRescueUnlock: (code: string) => ipcRenderer.invoke('account:rescueUnlock', code),
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
  onReachChanged: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('reach:changed', listener)
    return () => ipcRenderer.removeListener('reach:changed', listener)
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
  renameNode: (id: string, name: string) => ipcRenderer.invoke('node:rename', id, name),
  removeNode: (id: string) => ipcRenderer.invoke('node:remove', id),
  connectNodes: (a: string, b: string) => ipcRenderer.invoke('node:connect', a, b),
  disconnect: (connId: string) => ipcRenderer.invoke('node:disconnect', connId),
  listPresets: () => ipcRenderer.invoke('preset:list'),
  createTerminal: (opts: unknown) => ipcRenderer.invoke('terminal:create', opts),
  firstRunRead: () => ipcRenderer.invoke('first-run:read'),
  firstRunAdvance: (to: string) => ipcRenderer.invoke('first-run:advance', to),
  firstRunPreflight: () => ipcRenderer.invoke('first-run:preflight'),
  firstRunTask: () => ipcRenderer.invoke('first-run:task'),
  firstRunDiscard: () => ipcRenderer.invoke('first-run:discard'),
  firstRunCanStart: (preset: string) => ipcRenderer.invoke('first-run:can-start', preset),
  onFirstRun: (cb: (view: unknown) => void) => {
    const listener = (_e: unknown, view: unknown): void => cb(view)
    ipcRenderer.on('first-run:changed', listener)
    return () => ipcRenderer.removeListener('first-run:changed', listener)
  },
  setupLineStart: (ask: unknown) => ipcRenderer.invoke('setup-line:start', ask),
  setupLineNow: (terminalId: string, runId: string) => ipcRenderer.invoke('setup-line:now', terminalId, runId),
  setupLineCurrent: (terminalId: string) => ipcRenderer.invoke('setup-line:current', terminalId),
  accessState: () => ipcRenderer.invoke('access:state'),
  // The key crosses once, into the secrets store, and is never sent back.
  accessSave: (input: unknown) => ipcRenderer.invoke('access:save', input),
  accessClear: () => ipcRenderer.invoke('access:clear'),
  accessSimple: (input: unknown) => ipcRenderer.invoke('access:simple', input),
  accessSimpleOffer: (terminalId: string) => ipcRenderer.invoke('access:simple-offer', terminalId),
  useSources: () => ipcRenderer.invoke('use:sources'),
  onUseRested: (cb: (card: string) => void) => {
    const listener = (_event: unknown, card: string): void => cb(card)
    ipcRenderer.on('use:rested', listener)
    return () => ipcRenderer.removeListener('use:rested', listener)
  },
  openUseSource: (pick: unknown) => ipcRenderer.invoke('use:open-source', pick),
  openScreenSettings: (pane?: string) => ipcRenderer.invoke('use:screen-settings', pane),
  remoteAccess: () => ipcRenderer.invoke('use:remote-access'),
  remoteControl: (ask: unknown) => ipcRenderer.invoke('use:remote-control', ask),
  remoteRestart: () => ipcRenderer.invoke('use:remote-restart'),
  setRemoteSwitch: (on: boolean) => ipcRenderer.invoke('use:remote-switch', on),
  stopRemote: () => ipcRenderer.invoke('use:remote-stop'),
  remoteHost: () => ipcRenderer.invoke('use:remote-host'),
  onRemoteHost: (cb: (view: unknown) => void) => {
    const listener = (_e: unknown, view: unknown): void => cb(view)
    ipcRenderer.on('use:remote-host', listener)
    return () => ipcRenderer.removeListener('use:remote-host', listener)
  },
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
  /**
   * D14 · a door of this Mac moved to another of the account's (V3-18). The
   * list is asked for on mount and pushed on every move, because a window that
   * was closed when it happened must still find the sentence waiting.
   */
  servingMoved: (): Promise<readonly { slug: string; team: string; by: string; at: number }[]> =>
    ipcRenderer.invoke('serving:moved'),
  onServingMoved: (listener: (door: { slug: string; team: string; by: string }) => void) => {
    const on = (_e: unknown, door: { slug: string; team: string; by: string }): void => listener(door)
    ipcRenderer.on('serving:moved', on)
    return () => ipcRenderer.removeListener('serving:moved', on)
  },
  /** TAKE IT BACK — dial the same door again, superseding whoever holds it. */
  servingTakeBack: (slug: string) => ipcRenderer.invoke('serving:take-back', slug),
  /** Let the sentence go without taking the door back. */
  servingMovedClear: (slug: string) => ipcRenderer.invoke('serving:moved-clear', slug),
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
  /**
   * The screen wall's two calls. `snapWorkspace` is given the canvas rect
   * because only the renderer knows where the canvas is on screen; `shots`
   * reads what is on disk and is called when the wall opens, never held.
   */
  snapWorkspace: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('workspace:snap', rect),
  workspaceShots: () => ipcRenderer.invoke('workspace:shots'),
  /** Whether the terminals' herdr server predates this macOS login (main/terminal-session.ts). */
  terminalSession: () => ipcRenderer.invoke('terminals:session'),
  renameWorkspace: (id: string, name: string) =>
    ipcRenderer.invoke('workspace:rename', id, name),
  setWorkspaceBrief: (id: string, brief: string) => ipcRenderer.invoke('workspace:brief', id, brief),
  setWorkspaceIcon: (id: string, icon: string) => ipcRenderer.invoke('workspace:icon', id, icon),
  checkWorkspace: (name: string, dir: string) => ipcRenderer.invoke('workspace:check', name, dir),
  workspaceRemovePlan: (id: string) => ipcRenderer.invoke('workspace:removePlan', id),
  removeWorkspace: (id: string, options?: { worktree?: boolean }) =>
    ipcRenderer.invoke('workspace:remove', id, options),
  addWorkspaceDir: (id: string, dir: string) => ipcRenderer.invoke('workspace:dir:add', id, dir),
  removeWorkspaceDir: (id: string, dir: string) =>
    ipcRenderer.invoke('workspace:dir:remove', id, dir),
  setPrimaryDir: (id: string, dir: string) =>
    ipcRenderer.invoke('workspace:dir:setPrimary', id, dir),
  setTerminalCwd: (nodeId: string, dir: string) =>
    ipcRenderer.invoke('terminal:setCwd', nodeId, dir),
  pickDir: () => ipcRenderer.invoke('dir:pick'),
  gitInfo: (dir: string) => ipcRenderer.invoke('git:info', dir),
  // Lanes (main/lanes.ts): a worktree per agent, landing as a product action.
  laneList: (dir: string) => ipcRenderer.invoke('lane:list', dir),
  laneOpen: (nodeId: string, name: string) => ipcRenderer.invoke('lane:open', nodeId, name),
  laneLand: (nodeId: string, opts?: { close?: boolean; gate?: string[] | null }) =>
    ipcRenderer.invoke('lane:land', nodeId, opts),
  laneClose: (nodeId: string, force?: boolean) => ipcRenderer.invoke('lane:close', nodeId, force),
  // The sealed slots (R4): names and dates come back; the value only ever goes in.
  secretPut: (name: string, value: string, served: boolean) =>
    ipcRenderer.invoke('secret:put', name, value, served),
  secretList: () => ipcRenderer.invoke('secret:list'),
  secretRemove: (name: string) => ipcRenderer.invoke('secret:remove', name),
  laneAuto: (nodeId: string, on: boolean) => ipcRenderer.invoke('lane:auto', nodeId, on),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  browserSnapshot: (browserId: string) => ipcRenderer.invoke('browser:snapshot', browserId),
  onWorkspaceList: (cb: (list: unknown) => void) => {
    const listener = (_e: unknown, list: unknown): void => cb(list)
    ipcRenderer.on('workspace:list', listener)
    return () => ipcRenderer.removeListener('workspace:list', listener)
  },

  ptyInput: (terminalId: string, data: string) => ipcRenderer.send('pty:input', terminalId, data),
  answerMenu: (terminalId: string, answer: unknown) => ipcRenderer.invoke('menu:answer', terminalId, answer),
  terminalTuning: (terminalId: string) => ipcRenderer.invoke('terminal:tuning', terminalId),
  listTuning: () => ipcRenderer.invoke('tuning:list'),
  onTerminalTuning: (cb: (row: { terminalId: string; tuning: unknown }) => void) => {
    const listener = (_e: unknown, row: { terminalId: string; tuning: unknown }): void => cb(row)
    ipcRenderer.on('terminal:tuning', listener)
    return () => ipcRenderer.removeListener('terminal:tuning', listener)
  },
  tuneTerminal: (terminalId: string, knob: string, value: string) =>
    ipcRenderer.invoke('terminal:tune', terminalId, knob, value),
  ptyResize: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', terminalId, cols, rows),
  ptyJump: (terminalId: string, text: string | null) =>
    ipcRenderer.send('pty:jump', terminalId, text),
  turnSeen: (terminalId: string) => ipcRenderer.send('turn:seen', terminalId),
  ptySeed: (terminalId: string, nonce: string, lines: number): Promise<boolean> =>
    ipcRenderer.invoke('pty:seed', terminalId, nonce, lines),
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
  // A prompt's picture (main/prompt-image.ts), asked for once a view scrolls to it.
  readImage: (ref: unknown) => ipcRenderer.invoke('image:read', ref),

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
  // ONE STREAM (T3). The five reads and the one write the rail, the drawer
  // and the pager use — the desktop's door onto the same StreamService the
  // HTTP routes serve. There is no live channel here: the file watch behind
  // trace:latest-watch already says "this card's record changed", and the
  // bridge transport rides it rather than opening a second watcher.
  streamOpen: (terminalId: string) => ipcRenderer.invoke('stream:open', terminalId),
  streamIndex: (terminalId: string, request?: unknown) =>
    ipcRenderer.invoke('stream:index', terminalId, request),
  streamBlocks: (terminalId: string, request?: unknown) =>
    ipcRenderer.invoke('stream:blocks', terminalId, request),
  streamTail: (terminalId: string) => ipcRenderer.invoke('stream:tail', terminalId),
  streamMarks: (terminalId: string) => ipcRenderer.invoke('stream:marks', terminalId),
  streamMark: (terminalId: string, patch: unknown) =>
    ipcRenderer.invoke('stream:mark', terminalId, patch),
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
  // A cable lit: one agent asked another, or answered (cable-signal.ts).
  // The route program (shared/route.ts): the gateway state, the owner's one
  // default, and each card's route. Pushed, never polled, like the dials.
  routeState: () => ipcRenderer.invoke('route:state'),
  routeSetDefault: (model: string | null) => ipcRenderer.invoke('route:set-default', model),
  routeSetSharedMcp: (on: boolean) => ipcRenderer.invoke('route:set-shared-mcp', on),
  terminalRoute: (terminalId: string) => ipcRenderer.invoke('terminal:route', terminalId),
  terminalRouteSet: (terminalId: string, route: string) => ipcRenderer.invoke('terminal:route-set', terminalId, route),
  onRoute: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown): void => cb(state)
    ipcRenderer.on('route', listener)
    return () => ipcRenderer.removeListener('route', listener)
  },
  onCardRoute: (cb: (row: unknown) => void) => {
    const listener = (_e: unknown, row: unknown): void => cb(row)
    ipcRenderer.on('card-route', listener)
    return () => ipcRenderer.removeListener('card-route', listener)
  },
  // An agent acted on a card: the cursor over its screen (use-signal-bus.ts).
  onUseSignal: (cb: (signal: unknown) => void) => {
    const listener = (_e: unknown, signal: unknown): void => cb(signal)
    ipcRenderer.on('use:signal', listener)
    return () => ipcRenderer.removeListener('use:signal', listener)
  },
  onCableSignal: (cb: (signal: unknown) => void) => {
    const listener = (_e: unknown, signal: unknown): void => cb(signal)
    ipcRenderer.on('cable:signal', listener)
    return () => ipcRenderer.removeListener('cable:signal', listener)
  },
  queryEvents: (query: unknown) => ipcRenderer.invoke('events:query', query),
  countEvents: (query: unknown) => ipcRenderer.invoke('events:count', query),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  launchCheck: (id: string) => ipcRenderer.invoke('agents:launch-check', id),
  listStrayPanes: () => ipcRenderer.invoke('strays:list'),
  endStrayPane: (session: string) => ipcRenderer.invoke('strays:end', session),
  onAgentChanged: (cb: (entry: unknown) => void) => {
    const listener = (_e: unknown, entry: unknown): void => cb(entry)
    ipcRenderer.on('agents:changed', listener)
    return () => ipcRenderer.removeListener('agents:changed', listener)
  },
  listBoard: (window?: string) => ipcRenderer.invoke('board:list', window),
  // A board panel that stays open: the probe runs while at least one of
  // these holds, and every change arrives pushed instead of polled.
  subscribeBoard: (cb: (board: unknown) => void) => {
    const listener = (_e: unknown, board: unknown): void => cb(board)
    ipcRenderer.on('board:update', listener)
    void ipcRenderer.invoke('board:subscribe')
    return () => {
      ipcRenderer.removeListener('board:update', listener)
      void ipcRenderer.invoke('board:unsubscribe')
    }
  },
  /** This desktop's name for the header's device step (its account record); null when it has none. */
  machineName: () => ipcRenderer.invoke('machine:name'),
  /** The usage-data switch; it lives on this machine, so the phone has no such call. */
  telemetryStatus: () => ipcRenderer.invoke('telemetry:status'),
  setTelemetry: (on: boolean) => ipcRenderer.invoke('telemetry:set', on),
  launchSettings: () => ipcRenderer.invoke('launch-settings:status'),
  saveLaunchSettings: (choices: unknown) => ipcRenderer.invoke('launch-settings:save', choices),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  setUpdateCheck: (on: boolean) => ipcRenderer.invoke('update:set', on),
  restartToUpdate: () => ipcRenderer.invoke('update:restart'),
  onUpdateStatus: (cb: (status: unknown) => void) => {
    const listener = (_e: unknown, status: unknown): void => cb(status)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
  // THE ZOOM NAVIGATOR'S DEVICES: this desktop's fleet feed, a snapshot
  // first, then every delta, pushed; the release closes this window's stream
  // when its last reader goes. A refused hold (the companion is not up yet)
  // is said, so the reader can ask again.
  subscribeZoomFleet: (cb: (event: unknown) => void, refused?: () => void) => {
    const listener = (_e: unknown, event: unknown): void => cb(event)
    ipcRenderer.on('zoom-fleet:event', listener)
    const held = ipcRenderer.invoke('zoom-fleet:subscribe').then(
      (ok: unknown) => ok === true,
      () => false
    )
    void held.then((ok) => (ok ? undefined : refused?.()))
    return () => {
      ipcRenderer.removeListener('zoom-fleet:event', listener)
      // Only a hold that was taken is given back: a refused one must not release another reader's.
      void held.then((ok) => (ok ? ipcRenderer.invoke('zoom-fleet:unsubscribe') : undefined)).catch(() => undefined)
    }
  },
  zoomFleetMachines: () => ipcRenderer.invoke('zoom-fleet:machines'),
  machineGauges: () => ipcRenderer.invoke('zoom-fleet:gauges'),
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
  watchCode: () => ipcRenderer.invoke('watch:code'),
  watchState: () => ipcRenderer.invoke('watch:state'),
  watchInvite: (current: string) => ipcRenderer.invoke('watch:invite', current),
  watchForget: () => ipcRenderer.invoke('watch:forget'),
  openBrowserStream,
  onCmdW: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:cmd-w', listener)
    return () => ipcRenderer.removeListener('app:cmd-w', listener)
  },
  // Sous driving the canvas: a sentence up, zoom / zoom-back down.
  sousCommand: (text: string, ctx: { surface: string; focusedAgentId?: string | null; alternates?: string[]; box?: boolean }) =>
    ipcRenderer.invoke('sous:command', text, ctx),
  onUiCommand: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown): void => cb(event)
    ipcRenderer.on('ui:command', listener)
    return () => ipcRenderer.removeListener('ui:command', listener)
  },
  // R3: the decide step's commit, and the HITL inbox.
  sousCommit: (token: string, choice?: { target?: string; ack?: 'send-anyway' }, surface?: string) => ipcRenderer.invoke('sous:commit', token, choice ?? {}, surface ?? 'canvas'),
  sousCancel: (token: string, surface?: string) => ipcRenderer.invoke('sous:cancel', token, surface ?? 'canvas'),
  // HP: a late revision may only append alternates; the box merges them.
  onSousDecisionUpdated: (cb: (update: unknown) => void) => {
    const listener = (_e: unknown, update: unknown): void => cb(update)
    ipcRenderer.on('sous:decision-updated', listener)
    return () => ipcRenderer.removeListener('sous:decision-updated', listener)
  },
  inbox: () => ipcRenderer.invoke('inbox:list'),
  inboxAct: (id: string) => ipcRenderer.invoke('inbox:act', id),
  inboxDismiss: (id: string) => ipcRenderer.invoke('inbox:dismiss', id),
  // Subscribing HOLDS the list open in main (it is built only while someone
  // looks); the opening rows arrive through the callback too.
  onInbox: (cb: (rows: unknown) => void) => {
    const listener = (_e: unknown, rows: unknown): void => cb(rows)
    ipcRenderer.on('inbox:changed', listener)
    void ipcRenderer.invoke('inbox:subscribe').then((rows: unknown) => cb(rows))
    return () => {
      ipcRenderer.removeListener('inbox:changed', listener)
      void ipcRenderer.invoke('inbox:unsubscribe')
    }
  },
  // Hold ⌘ to talk: main runs the on-device recognizer and streams what it hears.
  listenAvailable: () => ipcRenderer.invoke('listen:available'),
  listenStart: () => ipcRenderer.invoke('listen:start'),
  listenStop: () => ipcRenderer.invoke('listen:stop'),
  // Spoken replies in the Mac's local voice: main runs it, the box gets audio.
  speakAvailable: () => ipcRenderer.invoke('speak:available'),
  // Strings only: the context bridge clones an AbortSignal into a plain
  // object with no addEventListener, so cancelling is by request id.
  speakAudio: (text: string, lang?: 'zh' | 'en', requestId?: string) =>
    ipcRenderer
      .invoke('speak:audio', requestId ?? null, text, lang)
      .then((spoken: { audio: Uint8Array; type: string }) => new Blob([new Uint8Array(spoken.audio)], { type: spoken.type })),
  speakCancel: (requestId: string) => ipcRenderer.send('speak:cancel', requestId),
  onListenEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown): void => cb(event)
    ipcRenderer.on('listen:event', listener)
    return () => ipcRenderer.removeListener('listen:event', listener)
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
// Read by shared/machine-words.ts as the copy tables load, so it has to be here
// before any page script runs. The phone and the site never get it, and their
// sentences stand as written.
contextBridge.exposeInMainWorld('cookrewPlatform', process.platform)
contextBridge.exposeInMainWorld('cookrewRegistry', registryFromArgv(process.argv))

export type CookrewApi = typeof api
