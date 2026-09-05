import type { AccountStatus, AccountResult, UsernameCheck } from '../shared/account-v2'
import type { AccountDevice, AccountProfile } from '../shared/account-v2'
import type {
  ApprovalDecision,
  ApprovalRequest,
  FactorsView,
  PasskeySummary,
  TotpEnrolment,
} from '../shared/account-approvals'
import type { Accounts } from './account-v2'
import type { Approvals } from './approvals'
import type { Factors } from './factors'
import type { IdleLock, UnlockOutcome } from './lock'

/**
 * THE ACCOUNT'S IPC, and why it is a module rather than twelve lines in index.
 *
 * Every channel here is OWNER-ONLY. Not "IPC, therefore private" — the app
 * renders pages it did not author (browser cards, install pages, presets that
 * ship a URL), and the account surface can claim a name, revoke a device and
 * mint recovery codes. So this module never touches ipcMain at all: it hands
 * main a table of handlers, and main registers each one through the same
 * `ownerOnly` wrapper the grant surface uses (owner-grant.ts, isOwnerSender).
 * A channel that forgets the wrapper is then a missing argument, not a silent
 * hole.
 *
 * NOTHING SECRET CROSSES THE BRIDGE. The status is public facts about the
 * account; the private key, the session token and the unlock verifier stay in
 * main. The renderer never needs them and a renderer that had them would put
 * them one XSS away from a page the owner browsed to.
 */

/** What main hands the handlers so they can answer without importing index. */
export interface AccountIpcDeps {
  accounts: Accounts
  lock: IdleLock
  /** The waiting sign-in requests (D6) — the producer of `status.requests`. */
  approvals: Approvals
  /** The second-factor ladder (D3): passkeys, the authenticator app. */
  factors: Factors
  /** COOKREW_HANDLE, when serving was pointed at a name by the environment. */
  envUsername: string | null
  /** This Mac's workspaces, by id and name — never their content (P1). */
  workspaces: () => readonly { id: string; name: string }[]
  /**
   * Put the pending recovery codes on disk, behind a save dialog.
   *
   * Injected because this module must stay free of Electron — it is the one
   * account surface a rendered page could try to reach, and the guard test's
   * whole premise is that it never touches ipcMain or a dialog itself. Main
   * supplies the dialog; the CODES come from the account, never from the
   * renderer, so nothing here can be talked into writing chosen bytes.
   */
  saveCodes: (codes: readonly string[]) => Promise<{ ok: boolean; reason?: string }>
}

/** An IPC handler as this module writes them: args in, a value or promise out. */
export type AccountHandler = (...args: readonly unknown[]) => unknown

/**
 * The channels, named once.
 *
 * Exported so the guard test can assert the whole set is registered through
 * the owner check rather than trusting a reader to notice a thirteenth.
 */
export const ACCOUNT_CHANNELS = [
  'account:status',
  'account:activity',
  'account:check',
  'account:claim',
  'account:lock',
  'account:unlock',
  'account:profile',
  'account:devices',
  'account:revoke',
  'account:recoveryCodes',
  'account:saveRecoveryCodes',
  'account:codesSaved',
  'account:setLock',
  'account:setProfile',
  'account:workspacesReachable',
  // ── phase 4: the approval prompt (D6) and the factor ladder (D3) ──
  'account:approvals',
  'account:decide',
  'account:setPassword',
  'account:factors',
  'account:totpEnrol',
  'account:totpConfirm',
  'account:totpRemove',
  'account:passkeys',
  'account:passkeyOptions',
  'account:passkeyAdd',
  'account:passkeyRemove',
] as const

export type AccountChannel = (typeof ACCOUNT_CHANNELS)[number]

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/** Three words and no fourth: an unknown decision is refused, never guessed. */
const isDecision = (value: unknown): value is ApprovalDecision =>
  value === 'approve' || value === 'deny' || value === 'not-me'

/** The status, rebuilt from main's own state on every ask. */
export function accountStatus(deps: AccountIpcDeps): AccountStatus {
  const account = deps.accounts.account()
  return {
    username: account?.username ?? null,
    displayName: account?.username ?? '',
    avatar: null,
    locked: deps.lock.locked,
    lockAfterMs: deps.lock.lockAfterMs,
    // THE PRODUCER, at last (phase 4): the polled queue of devices asking to
    // sign in. The seam phase 1 left is now live, and the avatar's rose badge
    // and the profile sheet's card read this one number.
    requests: deps.approvals.count,
    envUsername: deps.envUsername,
    recoveryCodesSavedAt: account?.recoveryCodesSavedAt ?? null,
    recoveryCodesLeft: null,
    sessionExpired: account !== null && !deps.accounts.sessionLive(),
    workspacesReachable: account?.workspacesReachable ?? false,
  }
}

/**
 * Unlock, and — while the password is in hand — renew a dead session.
 *
 * A DELIBERATE FOLD, called out because the wire contract has no refresh. The
 * session cannot be renewed without the password (there is no refresh token by
 * design), so the only honest moment to renew is the one moment the owner
 * types it. Adding a second channel for the same secret would mean two places
 * that take a password instead of one.
 */
async function unlock(
  deps: AccountIpcDeps,
  password: string,
): Promise<UnlockOutcome & { sessionRenewed?: boolean }> {
  const outcome = deps.lock.unlock(password)
  if (!outcome.ok) return outcome
  if (deps.accounts.account() === null || deps.accounts.sessionLive()) return outcome
  const renewed = await deps.accounts.resume(password)
  return { ...outcome, sessionRenewed: renewed.ok }
}

/**
 * Claiming answers with the STATUS, not the account file.
 *
 * The file holds a private key. Handing the renderer "the account it just
 * claimed" would put that key on the bridge for the convenience of drawing two
 * initials, so the sheet is told what it needs: it worked, and here is what the
 * avatar now shows.
 */
async function claim(deps: AccountIpcDeps, input: unknown): Promise<AccountResult<AccountStatus>> {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >
  const result = await deps.accounts.claim({
    username: asString(record.username),
    password: asString(record.password),
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
  })
  if (!result.ok) return result
  deps.lock.setLockAfterMs(result.value.lockAfterMs)
  // Register the workspaces at once: a name claimed and no desktop filed under
  // it is an account whose Workspaces tab is empty until the next boot.
  void deps.accounts.registerDesktop(deps.workspaces()).catch(() => undefined)
  return { ok: true, value: accountStatus(deps) }
}

/** The table. Pure in, promise or value out; no Electron types anywhere. */
export function accountHandlers(deps: AccountIpcDeps): Record<AccountChannel, AccountHandler> {
  return {
    'account:status': () => accountStatus(deps),
    // THE IDLE PING, and it is guarded like everything else here. A page the
    // owner merely browsed to, pinging presence on a timer, would hold the
    // lock open forever — the setting would be on and would never fire.
    'account:activity': () => {
      deps.lock.activity()
      return deps.lock.locked
    },
    'account:check': (username: unknown): Promise<UsernameCheck> =>
      deps.accounts.checkUsername(asString(username)),
    'account:claim': (input: unknown) => claim(deps, input),
    'account:lock': () => {
      deps.lock.lock()
      return accountStatus(deps)
    },
    'account:unlock': (password: unknown) => unlock(deps, asString(password)),
    'account:profile': (): Promise<AccountResult<AccountProfile>> => deps.accounts.profile(),
    'account:devices': (): Promise<AccountResult<readonly AccountDevice[]>> =>
      deps.accounts.devices(),
    'account:revoke': (id: unknown): Promise<AccountResult<void>> =>
      deps.accounts.revokeDevice(asString(id)),
    'account:recoveryCodes': (): Promise<AccountResult<readonly string[]>> =>
      deps.accounts.recoveryCodes(),
    /**
     * SAVE AS FILE. The codes are read from main's own memory, never from the
     * call — the renderer already has them on screen, and a channel that took
     * text plus a path would write whatever it was handed.
     */
    'account:saveRecoveryCodes': async (): Promise<{ ok: boolean; reason?: string }> => {
      const codes = deps.accounts.pendingRecoveryCodes()
      if (!codes) return { ok: false, reason: 'nothing_to_save' }
      const saved = await deps.saveCodes(codes)
      if (saved.ok) deps.accounts.markRecoveryCodesSaved()
      return saved
    },
    /** I SAVED THEM — recorded, so the RESCUE row stops saying NOT SAVED. */
    'account:codesSaved': () => {
      deps.accounts.markRecoveryCodesSaved()
      return accountStatus(deps)
    },
    'account:setLock': (ms: unknown) => {
      const value = typeof ms === 'number' ? ms : 0
      deps.accounts.setLockAfterMs(value)
      deps.lock.setLockAfterMs(value)
      return accountStatus(deps)
    },
    'account:setProfile': (patch: unknown): Promise<AccountResult<AccountProfile>> => {
      const record = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<
        string,
        unknown
      >
      return deps.accounts.setProfile({
        ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
        ...(typeof record.avatar === 'string' || record.avatar === null
          ? { avatar: record.avatar as string | null }
          : {}),
      })
    },
    // ── phase 4 ──
    //
    // The list is the POLL'S list, not a fresh call: the queue is refreshed on
    // a timer and on window focus, so a sheet that opened a socket of its own
    // would just be a third clock disagreeing with the other two.
    'account:approvals': (): readonly ApprovalRequest[] => deps.approvals.list(),
    // A DECISION ANSWERS WITH THE STATUS, so the badge is right the instant
    // the button is released — the alternative is a card that vanishes while
    // the avatar still wears a 1 until the next poll.
    'account:decide': async (input: unknown): Promise<AccountResult<AccountStatus>> => {
      const record = asRecord(input)
      const decision = record.decision
      if (!isDecision(decision)) return { ok: false, reason: 'unknown' }
      const result = await deps.approvals.decide(asString(record.id), decision)
      if (!result.ok) return result
      return { ok: true, value: accountStatus(deps) }
    },
    // The password change the registry demands after "not me" (D6). It is the
    // same call phase 1 built; this is the channel the form needed.
    'account:setPassword': (input: unknown): Promise<AccountResult<void>> => {
      const record = asRecord(input)
      return deps.accounts.setPassword({
        current: asString(record.current),
        next: asString(record.next),
      })
    },
    'account:factors': (): Promise<AccountResult<FactorsView>> => deps.factors.view(),
    // THE SECRET CROSSES THE BRIDGE ONCE, to be drawn. It is never logged on
    // either side, and the sheet holds it only while it is on screen.
    'account:totpEnrol': (): Promise<AccountResult<TotpEnrolment>> => deps.factors.enrolTotp(),
    'account:totpConfirm': (code: unknown): Promise<AccountResult<void>> =>
      deps.factors.confirmTotp(asString(code)),
    'account:totpRemove': (): Promise<AccountResult<void>> => deps.factors.removeTotp(),
    'account:passkeys': (): Promise<AccountResult<readonly PasskeySummary[]>> =>
      deps.factors.passkeys(),
    'account:passkeyOptions': (): Promise<AccountResult<Record<string, unknown>>> =>
      deps.factors.passkeyOptions(),
    'account:passkeyAdd': (input: unknown): Promise<AccountResult<PasskeySummary>> => {
      const record = asRecord(input)
      return deps.factors.addPasskey({
        name: asString(record.name),
        credential: asRecord(record.credential),
      })
    },
    'account:passkeyRemove': (id: unknown): Promise<AccountResult<void>> =>
      deps.factors.removePasskey(asString(id)),
    'account:workspacesReachable': (on: unknown) => {
      deps.accounts.setWorkspacesReachable(on === true)
      // Re-file the desktop so the change reaches cookrew.dev now rather than
      // at the next boot — the toggle's promise is about what the phone sees.
      void deps.accounts.registerDesktop(deps.workspaces()).catch(() => undefined)
      return accountStatus(deps)
    },
  }
}

/**
 * Register every channel through `register`.
 *
 * Main passes a `register` that wraps each handler in `ownerOnly`, so the
 * guard is applied by construction to every channel rather than remembered
 * once per channel.
 */
export function registerAccountIpc(
  register: (channel: AccountChannel, handler: AccountHandler) => void,
  deps: AccountIpcDeps,
): void {
  const handlers = accountHandlers(deps)
  for (const channel of ACCOUNT_CHANNELS) register(channel, handlers[channel])
}
