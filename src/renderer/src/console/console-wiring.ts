/**
 * THE CONSOLE'S REAL PARTS, MADE ONCE AT BOOT.
 *
 * Importing this module is what makes the page the console: it reads what the
 * page was built for (console-config.ts), makes the session, and tells the
 * renderer's machine scope that machines are reached through the relay with
 * that session (machine-scope.ts · configureMachineScope). It is the first
 * import of the console's entry, so that is true before anything else on the
 * page can ask which kind of page it is.
 *
 * On a page that is not the console (no mark, or hosts it cannot name) it
 * makes nothing and `consoleParts` is null: the entry says so and asks nobody
 * anything.
 */
import { CROSS_ORIGIN_NO_COOKIE } from '../data-plane'
import { configureMachineScope, enterMachine, machineBaseOf, machineScope } from '../machine-scope'
import { browserPairDeps, enterWithGrant, type GrantStore } from '../account-pair-client'
import { relayAccountMachines } from '../relay-machines'
import { relayMachineWhy, relayMachines } from '../relay-machine-call'
import { tokenKeyForBase } from '../pairing-scope'
import { takeSeat } from '../device-seat'
import { readConsoleConfig, type ConsoleConfig } from './console-config'
import { browserDeviceStore, consoleDevice, type ConsoleDevice } from './device-key'
import { createConsoleSession, type ConsoleSession, type RegistryCall } from './console-session'
import { createConsoleGate, type ConsoleGate } from './console-gate'
import { createConsoleDevices, type ConsoleDevices } from './console-devices'
import { browserHistoryPort, createConsoleRouter, type ConsoleRouter } from './console-router'
import { createConsoleRuntime, type ConsoleRuntime, type DoorAnswer } from './console-runtime'

export interface ConsoleParts {
  readonly config: ConsoleConfig
  readonly session: ConsoleSession
  readonly gate: ConsoleGate
  readonly devices: ConsoleDevices
  readonly router: ConsoleRouter
  readonly runtime: ConsoleRuntime
}

const TOKEN_PREFIX = 'cr_token:'
/** Everything this browser keeps for a machine: its key, the seat taken on it, its connect code, a token pasted for it. */
const MACHINE_KEYS = [TOKEN_PREFIX, 'cookrew.seat:', 'cr_code:', 'cookrew-pairing-token']

const storage = (pick: () => Storage): Storage | null => {
  try {
    const held = pick()
    held.getItem(TOKEN_PREFIX)
    return held
  } catch {
    return null
  }
}

/** Storage that may refuse (private browsing): it then keeps nothing, and says nothing. */
const tolerant = (held: Storage | null): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => ({
  getItem: (key) => {
    try {
      return held?.getItem(key) ?? null
    } catch {
      return null
    }
  },
  setItem: (key, value) => {
    if (held === null) throw new Error('this browser keeps nothing for this page')
    held.setItem(key, value)
  },
  removeItem: (key) => {
    try {
      held?.removeItem(key)
    } catch {
      // Nothing held.
    }
  }
})

function registryAt(origin: string): RegistryCall {
  return async (method, path, body, headers = {}) => {
    try {
      const response = await fetch(`${origin}${path}`, {
        method,
        cache: 'no-store',
        ...CROSS_ORIGIN_NO_COOKIE,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      let parsed: unknown = null
      try {
        parsed = response.status === 204 ? null : await response.json()
      } catch {
        parsed = null
      }
      return { status: response.status, body: parsed }
    } catch {
      return { status: 0, body: null }
    }
  }
}

function build(config: ConsoleConfig, win: Window): ConsoleParts {
  const local = storage(() => win.localStorage)
  const kept = tolerant(local)
  const pending = tolerant(storage(() => win.sessionStorage))

  let minted: Promise<ConsoleDevice> | null = null
  const device = (): Promise<ConsoleDevice> => {
    minted ??= consoleDevice({ ...keys, userAgent: win.navigator.userAgent }).catch((error: unknown) => {
      minted = null
      throw error
    })
    return minted
  }

  const keys = browserDeviceStore()
  const session = createConsoleSession({
    registry: registryAt(config.apiOrigin),
    authOrigin: config.authOrigin,
    device,
    forgetDevice: async () => {
      minted = null
      await keys.clear()
    },
    kept,
    pending,
    navigate: (url) => win.location.assign(url)
  })

  // FROM HERE ON THE PAGE IS THE CONSOLE: machines are reached through the relay, with this session.
  configureMachineScope({ relay: { origin: config.apiOrigin, session: () => session.token(), refused: () => session.refused() } })

  const signedIn = (): boolean => session.get().status === 'signed-in'
  const pair = browserPairDeps('', device)
  // NOTHING IS KEPT FOR NOBODY: an answer that lands after the person signed out (a pass, a
  // machine's key) is not written down for whoever signs in next.
  const grants: GrantStore = {
    ...pair.grants,
    write: (grant) => {
      if (signedIn()) pair.grants.write(grant)
    }
  }
  const gate = createConsoleGate({
    registry: pair.registry,
    deviceId: async () => (await device()).id,
    passkey: pair.passkey,
    grants,
    passwordElsewhere: (returnTo) => session.passByPassword(returnTo)
  })

  const devices = createConsoleDevices({
    account: async () => {
      // A token about to end is renewed before it is used; one that cannot be is not a signed-out page yet.
      if ((await session.fresh()) === null) return { ok: false, reason: session.get().status === 'signed-out' ? 'signed-out' : 'offline' }
      return relayAccountMachines({ ...machineScope(), machineId: null })
    },
    fleetOf: async (machineId) => (await relayMachines()).fleetOf(machineId),
    why: relayMachineWhy,
    gateOpen: () => gate.get().status === 'open',
    // It looks; it does not let go. One machine's word never takes the pass from the others.
    onReproof: () => void gate.check(),
    // The registry refused a token the page thought good: the device key says whether the sign-in still stands.
    onSignedOut: () => session.refused()
  })

  const openDoor = async (machineId: string): Promise<DoorAnswer> => {
    const target = machineBaseOf(machineId)
    if (target === null) return { kind: 'refused', from: 'page', message: 'That is not a machine.' }
    const key = tokenKeyForBase(target)
    if (kept.getItem(key) !== null) return { kind: 'open' }
    const door = browserPairDeps(target, device)
    // One machine turning the pass away does not take it from the others.
    const entered = await enterWithGrant({ ...door, grants: { ...door.grants, clear: () => undefined } }, machineId)
    if (entered.kind === 'entered') {
      // Signed out while the door was answering: its key is kept for nobody.
      if (!signedIn()) return { kind: 'refused', from: 'page', message: 'Signed out.' }
      try {
        kept.setItem(key, entered.token)
      } catch {
        return { kind: 'refused', from: 'page', message: 'This browser keeps nothing for this page, so it cannot hold a machine’s key. Private browsing does this.' }
      }
      return { kind: 'open' }
    }
    if (entered.kind === 'needs-proof') return { kind: 'needs-proof' }
    if (entered.kind === 'no-device') return { kind: 'refused', from: 'page', message: 'This browser has no key for Cookrew. Sign out and in again.' }
    // `failed` is this page's own sentence (it could not sign, or the door named another machine); `refused` is the machine's.
    return { kind: 'refused', from: entered.kind === 'refused' ? 'machine' : 'page', message: entered.message }
  }

  const router = createConsoleRouter(browserHistoryPort(win))
  const runtime = createConsoleRuntime({
    session,
    gate,
    devices,
    router,
    openDoor,
    forgetDoor: (machineId) => {
      const target = machineBaseOf(machineId)
      if (target !== null) kept.removeItem(tokenKeyForBase(target))
    },
    enterScope: enterMachine,
    takeSeat,
    forgetMachines: () => {
      if (local === null) return
      try {
        const held = Array.from({ length: local.length }, (_, at) => local.key(at)).filter((key): key is string => key !== null)
        for (const key of held) if (MACHINE_KEYS.some((prefix) => key.startsWith(prefix))) local.removeItem(key)
      } catch {
        // Storage that refuses held nothing.
      }
    }
  })

  // A page that slept past its token's end renews on the way back, before anything asks with the dead one.
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'visible') void session.fresh()
  })

  return { config, session, gate, devices, router, runtime }
}

const config = typeof document === 'undefined' ? null : readConsoleConfig(document)

/** The console's parts, or null on a page that is not the console. */
export const consoleParts: ConsoleParts | null = config === null ? null : build(config, window)
