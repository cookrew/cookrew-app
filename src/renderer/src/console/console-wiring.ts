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
import { CROSS_ORIGIN_NO_COOKIE, RELAY_PLANE, subscribeDataPlane } from '../data-plane'
import { configureMachineScope, enterMachine, machineBaseOf, machineScope } from '../machine-scope'
import { browserPairDeps, enterWithGrant, type EnterResult, type GrantStore } from '../account-pair-client'
import { relayAccountMachines } from '../relay-machines'
import { relayMachineWhy, relayMachines } from '../relay-machine-call'
import { codeKeyForBase, nextCodeKey, tokenKeyForBase } from '../pairing-scope'
import { takeSeat } from '../device-seat'
import { readConsoleConfig, type ConsoleConfig } from './console-config'
import { browserDeviceStore, consoleDevice, type ConsoleDevice } from './device-key'
import { SESSION_KEY, createConsoleSession, type ConsoleSession, type KeyValue, type RegistryCall } from './console-session'
import { createConsoleGate, type ConsoleGate } from './console-gate'
import { createConsoleDevices, type ConsoleDevices } from './console-devices'
import { browserHistoryPort, createConsoleRouter, type ConsoleRouter } from './console-router'
import { createConsoleRuntime, type ConsoleRuntime, type DoorAnswer } from './console-runtime'
import { createMachinePaths, type MachinePaths } from './machine-paths'
import { forgetHandedCode, landHandedCode, takeHandedCode } from './handed-code'
import { createConsolePush, isIos, pushLabel, routeOfOpenMessage, type ConsolePush, type PushManagerLike } from './console-push'

export interface ConsoleParts {
  readonly config: ConsoleConfig
  readonly session: ConsoleSession
  readonly gate: ConsoleGate
  readonly devices: ConsoleDevices
  readonly router: ConsoleRouter
  readonly runtime: ConsoleRuntime
  readonly paths: MachinePaths
  /** This browser's notifications (HITL phase 4). */
  readonly push: ConsolePush
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

export interface MachineDoorDeps {
  /** This browser's lasting storage: machines' keys and connect codes. */
  readonly kept: KeyValue
  /** This tab's: the code a machine's own screen handed over (handed-code.ts). */
  readonly pending: KeyValue
  readonly signedIn: () => boolean
  /**
   * Into the machine's door at `target` with the pass held here (account-pair-client.ts · enterWithGrant).
   * `explicit`: a person asked, or a code they scanned has just landed: a failed sealed try's wait is cut short.
   */
  readonly enter: (target: string, machineId: string, explicit: boolean) => Promise<EnterResult>
}

export interface MachineDoor {
  /**
   * This browser into one machine: the key it holds for it, or its door entered with the pass. `explicit`
   * says a person asked (console-runtime.ts); left out, the ask is the page's own and waits its turn.
   */
  readonly open: (machineId: string, ask?: { readonly explicit: boolean }) => Promise<DoorAnswer>
  /** File the code that machine's own screen handed over, for that machine only (handed-code.ts · landHandedCode). True when one landed. */
  readonly landCode: (machineId: string) => boolean
}

/** The connect code's place in this browser for a machine, or null for what is not a machine. */
const codeKeyFor = (machineId: string): string | null => {
  const base = machineBaseOf(machineId)
  return base === null ? null : codeKeyForBase(base)
}

export function createMachineDoor(deps: MachineDoorDeps): MachineDoor {
  const { kept, pending, signedIn } = deps
  const landCode = (machineId: string): boolean => {
    const key = codeKeyFor(machineId)
    const holding = (): string => (key === null ? '' : `${kept.getItem(key)}\n${kept.getItem(nextCodeKey(key))}`)
    const before = holding()
    landHandedCode({ machineId, pending, kept, keyFor: codeKeyFor })
    return holding() !== before
  }
  const open = async (machineId: string, ask?: { readonly explicit: boolean }): Promise<DoorAnswer> => {
    const target = machineBaseOf(machineId)
    if (target === null) return { kind: 'refused', from: 'page', message: 'That is not a machine.' }
    // FILED BEFORE THE DOOR IS ASKED, not only on entering (console-runtime.ts asks the door first and
    // enters after it opens): a machine that takes only sealed connections answers the door's own
    // begin sealed or not at all, and the sealed session is keyed by this code. Only the machine the
    // code was handed for, and never in place of a code already held (handed-code.ts).
    // A code that has just landed is a person's act (they scanned it) as much as a press is.
    const landed = landCode(machineId)
    const key = tokenKeyForBase(target)
    if (kept.getItem(key) !== null) return { kind: 'open' }
    const entered = await deps.enter(target, machineId, ask?.explicit === true || landed)
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
  return { open, landCode }
}

const REGISTRY_ANSWER_MS = 20_000
/** How long a press waits for the worker to be active before saying this browser cannot subscribe. */
const WORKER_READY_MS = 5_000

function registryAt(origin: string): RegistryCall {
  return async (method, path, body, headers = {}) => {
    try {
      const response = await fetch(`${origin}${path}`, {
        method,
        // No `cache: 'no-store'`: it would cost a preflight on every call (data-plane.ts · CROSS_ORIGIN_NO_COOKIE).
        ...CROSS_ORIGIN_NO_COOKIE,
        // A registry that takes the call and never answers is one that did not answer.
        signal: AbortSignal.timeout(REGISTRY_ANSWER_MS),
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

/** The active worker's push manager, or null: none registered (a page served without one), or not active in time. */
function workerPushManager(win: Window): () => Promise<PushManagerLike | null> {
  return async () => {
    const workers = win.navigator.serviceWorker as ServiceWorkerContainer | undefined
    if (workers === undefined) return null
    const late = new Promise<null>((resolve) => win.setTimeout(() => resolve(null), WORKER_READY_MS))
    const ready = await Promise.race([workers.ready, late])
    return ready?.pushManager ?? null
  }
}

/** This browser's notifications, asked of the registry with this page's session. */
function consolePush(win: Window, registry: RegistryCall, session: ConsoleSession, kept: KeyValue): ConsolePush {
  const standalone = (win.navigator as Navigator & { standalone?: boolean }).standalone === true || win.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen)').matches === true
  const notifications = (win as Window & { Notification?: typeof Notification }).Notification
  return createConsolePush({
    call: async (method, path, body) => {
      const token = await session.fresh()
      if (token === null) return { status: 401, body: null }
      return registry(method, path, body, { authorization: `Bearer ${token}` })
    },
    env: {
      notification: notifications !== undefined,
      serviceWorker: 'serviceWorker' in win.navigator,
      pushManager: 'PushManager' in win,
      ios: isIos(win.navigator.userAgent, win.navigator.maxTouchPoints),
      standalone
    },
    permission: () => notifications?.permission ?? 'denied',
    requestPermission: () => (notifications === undefined ? Promise.resolve('denied') : notifications.requestPermission()),
    pushManager: workerPushManager(win),
    kept,
    label: pushLabel(win.navigator.userAgent, win.navigator.maxTouchPoints)
  })
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
  const registry = registryAt(config.apiOrigin)
  const session = createConsoleSession({
    registry,
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
    onSignedOut: () => session.refused(),
    // A hidden tab asks nobody anything (bytes 0.6.2).
    sight: {
      hidden: () => win.document.visibilityState === 'hidden',
      watch: (changed) => {
        win.document.addEventListener('visibilitychange', changed)
        return () => win.document.removeEventListener('visibilitychange', changed)
      }
    }
  })

  const door = createMachineDoor({
    kept,
    pending,
    signedIn,
    enter: (target, machineId, explicit) => {
      const pair = browserPairDeps(target, device, undefined, { explicit })
      // One machine turning the pass away does not take it from the others.
      return enterWithGrant({ ...pair, grants: { ...pair.grants, clear: () => undefined } }, machineId)
    }
  })

  // THE PATH EACH MACHINE'S SESSION SETTLED ON, for its tile. Noted while that machine is in
  // scope and at no other moment: leaving a machine puts the plane back on the relay as part of
  // letting go, and that is not news about the machine being left.
  const paths = createMachinePaths()
  let changingScope = false
  subscribeDataPlane((plane) => {
    const machineId = machineScope().machineId
    if (!changingScope && machineId !== null) paths.note(machineId, plane)
  })
  const enterScope = (machineId: string | null): void => {
    // The unlock code this machine's own screen handed over, filed before anything of the machine
    // is made (its unlock sheet reads it when it is).
    if (machineId !== null) door.landCode(machineId)
    changingScope = true
    try {
      enterMachine(machineId)
    } finally {
      changingScope = false
    }
    // Entered: on the relay, as every machine is at first. What its tile said of an earlier
    // visit is not true of this one until a nearer path is proved again.
    if (machineId !== null) paths.note(machineId, RELAY_PLANE)
  }

  const router = createConsoleRouter(browserHistoryPort(win))
  // WHAT RODE THE FRAGMENT IS TAKEN OFF THE ADDRESS AT ONCE (handed-code.ts): a machine's unlock
  // code, kept for this tab; anything else there is nobody's and goes with it.
  if (win.location.hash !== '') {
    takeHandedCode({ hash: win.location.hash, route: router.get(), pending })
    win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`)
  }
  const runtime = createConsoleRuntime({
    session,
    gate,
    devices,
    router,
    openDoor: door.open,
    forgetDoor: (machineId) => {
      const target = machineBaseOf(machineId)
      if (target !== null) kept.removeItem(tokenKeyForBase(target))
    },
    enterScope,
    takeSeat,
    forgetMachines: () => {
      paths.forget()
      forgetHandedCode(pending)
      if (local === null) return
      try {
        const held = Array.from({ length: local.length }, (_, at) => local.key(at)).filter((key): key is string => key !== null)
        for (const key of held) if (MACHINE_KEYS.some((prefix) => key.startsWith(prefix))) local.removeItem(key)
      } catch {
        // Storage that refuses held nothing.
      }
    }
  })

  // Another tab of this browser renewed the session, signed out, or signed in: this one follows
  // (a renewal closes the token this tab holds; console-session.ts · reread).
  win.addEventListener('storage', (event) => {
    if (event.key !== SESSION_KEY && event.key !== null) return
    // The other tab may have signed in with a key minted since this tab last looked.
    minted = null
    session.reread()
  })

  // NOTIFICATIONS FOLLOW THE SIGN-IN: signed out, this browser lets go of its subscription, so the
  // next person to sign in here is told nothing of the last one's agents.
  const push = consolePush(win, registry, session, kept)
  session.subscribe(() => {
    if (session.get().status === 'signed-out') void push.forget()
  })
  // A press on a notification while this page is open: the worker brings it forward and says where to go.
  win.navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
    const route = routeOfOpenMessage(event.data)
    if (route !== null) router.go(route)
  })

  // A page that slept past its token's end renews on the way back, before anything asks with the dead one.
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'visible') void session.fresh()
  })

  return { config, session, gate, devices, router, runtime, paths, push }
}

const config = typeof document === 'undefined' ? null : readConsoleConfig(document)

/** The console's parts, or null on a page that is not the console. */
export const consoleParts: ConsoleParts | null = config === null ? null : build(config, window)
