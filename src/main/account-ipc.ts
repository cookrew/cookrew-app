import type { AdmittedDevice } from './admitted-devices'
import type { PairingKeyRing } from './pairing-key'
import type { AccountStatus, AccountResult, UsernameCheck } from '../shared/account-v2'
import type { PairingKeyHandout } from '../shared/account-v2'
import type { AccountDevice, AccountProfile } from '../shared/account-v2'
import type { Accounts } from './account-v2'
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
  /** COOKREW_HANDLE, when serving was pointed at a name by the environment. */
  envUsername: string | null
  /** This Mac's workspaces, by id and name — never their content (P1). */
  workspaces: () => readonly { id: string; name: string }[]
  /**
   * The rotating pairing key shown in the popout. Owner-only like everything
   * else here, and for a sharper reason: it is a live credential for two
   * minutes, and any page that could read it could pair itself.
   */
  pairing?: PairingKeyRing
  /** Phones this Mac has admitted, listed beside the registry's devices. */
  admitted?: {
    list: () => readonly AdmittedDevice[]
    forget: (deviceId: string) => boolean
  }
  /** Republish the reach card — the reachability toggle's other half. */
  publishReach?: (reason: string) => void
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
  'account:setLock',
  'account:setProfile',
  'account:workspacesReachable',
  'account:pairingKey',
  'account:admittedDevices',
  'account:forgetAdmitted',
] as const

export type AccountChannel = (typeof ACCOUNT_CHANNELS)[number]

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The status, rebuilt from main's own state on every ask. */
export function accountStatus(deps: AccountIpcDeps): AccountStatus {
  const account = deps.accounts.account()
  return {
    username: account?.username ?? null,
    displayName: account?.username ?? '',
    avatar: null,
    locked: deps.lock.locked,
    lockAfterMs: deps.lock.lockAfterMs,
    // D6 IS PHASE 4. The count is real in the view-model and in the badge; the
    // producer that could raise it above zero is the approval prompt, which
    // this phase deliberately does not build.
    requests: 0,
    envUsername: deps.envUsername,
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
    'account:workspacesReachable': (on: unknown) => {
      deps.accounts.setWorkspacesReachable(on === true)
      // Re-file the desktop so the change reaches cookrew.dev now rather than
      // at the next boot — the toggle's promise is about what the phone sees.
      // With reach wired, the publisher does the filing so the addresses go up
      // with the workspaces; without it, the plain register still happens.
      if (deps.publishReach) deps.publishReach('reachable toggled')
      else void deps.accounts.registerDesktop(deps.workspaces()).catch(() => undefined)
      return accountStatus(deps)
    },
    /**
     * The popout's key. Handing out the DEVICE ID beside it is deliberate —
     * the QR carries both, and the phone needs the id to know which of the
     * account's desktops it just pointed at. No URL and no token: the phone
     * is already signed in at cookrew.dev, and an address on a screen is the
     * thing v2 exists to stop printing.
     *
     * Null when there is no account: a Mac with no username has no device id
     * to name, and the popout falls back to the legacy URL QR.
     */
    'account:pairingKey': (): PairingKeyHandout | null => {
      const account = deps.accounts.account()
      if (!account || !deps.pairing) return null
      const current = deps.pairing.current()
      return {
        deviceId: account.deviceId,
        key: current.key,
        expiresAt: current.expiresAt,
        desktopName: account.name,
      }
    },
    'account:admittedDevices': (): readonly AdmittedDevice[] => deps.admitted?.list() ?? [],
    /**
     * FORGET is local and says so. It drops the admission on this Mac; it does
     * not revoke the phone at cookrew.dev, which is a heavier act with its own
     * button. The phone stays attached to the account and has to be admitted
     * here again.
     */
    'account:forgetAdmitted': (deviceId: unknown): boolean =>
      typeof deviceId === 'string' ? (deps.admitted?.forget(deviceId) ?? false) : false,
  }
}

/**
 * Register every channel through `register`.
 *
 * Main passes a `register` that wraps each handler in `ownerOnly`, so the
 * guard is applied by construction to all twelve rather than remembered
 * twelve times.
 */
export function registerAccountIpc(
  register: (channel: AccountChannel, handler: AccountHandler) => void,
  deps: AccountIpcDeps,
): void {
  const handlers = accountHandlers(deps)
  for (const channel of ACCOUNT_CHANNELS) register(channel, handlers[channel])
}
