/**
 * THE CONSOLE'S NOTIFICATIONS (HITL phase 4): this browser, subscribed to be
 * told when an agent on one of the account's machines needs its person.
 *
 * The order of a press is the browser's, not ours. Safari takes a permission
 * prompt only from the person's own act, so `turnOn` asks for permission
 * BEFORE it awaits anything, and the registry's key is fetched ahead of the
 * press (`check`, when the menu opens) so the subscribe that follows does not
 * wait on the network either. An iPhone offers push only to the console added
 * to its Home Screen: outside it there is no PushManager at all, and the page
 * says what to do instead of showing a button that cannot work.
 *
 * What is filed at the registry is the browser's subscription (its endpoint
 * and the two keys a desktop encrypts to). What is kept here is the id the
 * registry gave it and the endpoint it was for, so the way off can take the
 * same row off, and so a subscription this page did not file reads as off.
 *
 * THE OWNER SEES EVERY BROWSER THE ACCOUNT TELLS (security review M2): the
 * menu lists them, label and date, each with a Remove. The registry answers
 * that list without a key or an endpoint (GET /v2/me/push/subscriptions/mine).
 *
 * Its parts are handed in (console-wiring.ts builds the real ones), so the
 * whole order of a press runs in a test with no browser.
 */
import type { Answer, KeyValue } from './console-session'
import { parseConsoleRoute, type ConsoleRoute } from './console-route'

/** What the worker posts an open console when its notification is pressed (scripts/console-sw.mjs). */
export const CONSOLE_OPEN_MESSAGE = 'cookrew-open'
/** Kept beside the session: `{id, endpoint}` of the subscription this page filed. */
export const PUSH_KEPT_KEY = 'cr_push_subscription'

export type PushStatus = 'checking' | 'hidden' | 'unsupported' | 'home-screen' | 'blocked' | 'off' | 'on' | 'busy'

/** One browser the account tells, as the owner is shown it. */
export interface PushRow {
  readonly id: string
  readonly label: string
  readonly createdAt: number
  /** This browser's own. */
  readonly here: boolean
}

export interface PushState {
  readonly status: PushStatus
  /** One sentence about the last thing that did not work. */
  readonly line: string | null
  /** Every browser the account tells; absent until read. */
  readonly rows?: readonly PushRow[]
}

export interface PushEnv {
  readonly notification: boolean
  readonly serviceWorker: boolean
  readonly pushManager: boolean
  readonly ios: boolean
  /** Opened from the Home Screen: the only place an iPhone offers push. */
  readonly standalone: boolean
}

export interface PushSubscriptionLike {
  readonly endpoint: string
  readonly options?: { readonly applicationServerKey?: ArrayBuffer | null }
  toJSON(): { endpoint?: string; keys?: Record<string, string> }
  unsubscribe(): Promise<boolean>
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>
  subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSubscriptionLike>
}

export interface PushDeps {
  /** A registry call with this page's session. Status 0: it did not arrive. */
  readonly call: (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<Answer>
  readonly env: PushEnv
  readonly permission: () => NotificationPermission
  readonly requestPermission: () => Promise<NotificationPermission>
  /** The worker's push manager once the worker is active; null when there is none. */
  readonly pushManager: () => Promise<PushManagerLike | null>
  readonly kept: KeyValue
  /** What the registry lists this browser as: "iPhone · Safari". */
  readonly label: string
}

export interface ConsolePush {
  get(): PushState
  subscribe(listener: () => void): () => void
  /** Where this browser stands now. Fetches the registry's key ahead of a press. */
  check(): Promise<void>
  /** From a press: permission, subscribe, file. */
  turnOn(): Promise<void>
  turnOff(): Promise<void>
  /** Signed out: this browser lets go of its subscription and keeps nothing (the registry's row then answers gone). */
  forget(): Promise<void>
  /** Take one browser off the account. This browser's own is turning it off. */
  remove(id: string): Promise<void>
}

// ── pure ────────────────────────────────────────────────────────────────────

export function pushSupport(env: PushEnv): 'ready' | 'unsupported' | 'home-screen' {
  if (env.notification && env.serviceWorker && env.pushManager) return 'ready'
  return env.ios && !env.standalone ? 'home-screen' : 'unsupported'
}

/** An iPhone, or an iPad that says it is a Mac (it is the Mac with a touch screen). */
export const isIos = (userAgent: string, maxTouchPoints: number): boolean =>
  /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)

function platformOf(userAgent: string, maxTouchPoints: number): string {
  if (/iPhone|iPod/.test(userAgent)) return 'iPhone'
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return 'iPad'
  if (/Android/.test(userAgent)) return 'Android'
  if (/Windows/.test(userAgent)) return 'Windows'
  if (/CrOS/.test(userAgent)) return 'ChromeOS'
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'Mac'
  if (/Linux|X11/.test(userAgent)) return 'Linux'
  return ''
}

function browserOf(userAgent: string): string {
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return 'Edge'
  if (/Firefox\/|FxiOS\//.test(userAgent)) return 'Firefox'
  if (/Chrome\/|CriOS\//.test(userAgent)) return 'Chrome'
  if (/Safari\//.test(userAgent)) return 'Safari'
  return ''
}

/** "iPhone · Safari": what the registry lists the subscription as. Never more than the 64 it takes. */
export function pushLabel(userAgent: string, maxTouchPoints: number): string {
  const said = [platformOf(userAgent, maxTouchPoints), browserOf(userAgent)].filter((part) => part !== '').join(' · ')
  return said === '' ? 'Browser' : said.slice(0, 64)
}

/** The registry's key as a subscribe takes it: 65 bytes, an uncompressed point. Null for anything else. */
export function keyBytes(base64url: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof base64url !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(base64url)) return null
  try {
    const binary = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '=')
    const bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
    return bytes.byteLength === 65 && bytes[0] === 0x04 ? bytes : null
  } catch {
    return null
  }
}

const sameKey = (held: ArrayBuffer | null | undefined, key: Uint8Array): boolean => {
  if (held === null || held === undefined || held.byteLength !== key.byteLength) return false
  const bytes = new Uint8Array(held)
  return bytes.every((byte, at) => byte === key[at])
}

/** The route a press on a notification names, from the worker's message; null for anything else. */
export function routeOfOpenMessage(data: unknown): ConsoleRoute | null {
  if (typeof data !== 'object' || data === null) return null
  const { type, path } = data as { type?: unknown; path?: unknown }
  if (type !== CONSOLE_OPEN_MESSAGE || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null
  const at = new URL(path, 'https://console.invalid')
  const route = parseConsoleRoute(at.pathname, at.search)
  return route.kind === 'auth-complete' ? null : route
}

/** "iPhone · Safari · this browser · since 2026-11-17". */
export function pushRowLine(row: PushRow): string {
  return [row.label || 'A browser', row.here ? 'this browser' : null, `since ${new Date(row.createdAt).toISOString().slice(0, 10)}`]
    .filter((part) => part !== null)
    .join(' · ')
}

const isRow = (value: unknown): value is PushRow => {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(row.id) && typeof row.label === 'string' && row.label.length <= 64 &&
    typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) && typeof row.here === 'boolean'
}

export interface PushWords {
  /** What the button does, or null when there is no button. */
  readonly action: 'on' | 'off' | null
  readonly button: string | null
  readonly says: string | null
}

const SAYS: Partial<Record<PushStatus, string>> = {
  'home-screen': 'Add Cookrew to the Home Screen to get notifications.',
  blocked: 'Notifications are blocked for this site. Allow them in the browser’s settings.',
  unsupported: 'This browser cannot show Cookrew’s notifications.',
  busy: 'One moment…'
}

/** What the account menu shows for a state. Null: nothing at all (push is off at the registry, or not known yet). */
export function pushWords(state: PushState): PushWords | null {
  if (state.status === 'hidden' || state.status === 'checking') return null
  if (state.status === 'off') return { action: 'on', button: 'Turn on notifications', says: state.line }
  if (state.status === 'on') return { action: 'off', button: 'Turn off notifications', says: state.line ?? 'Notifications are on for this browser.' }
  return { action: null, button: null, says: state.line ?? SAYS[state.status] ?? null }
}

// ── the controller ──────────────────────────────────────────────────────────

const UNREACHED = 'Cookrew could not be reached. Try again in a moment.'
const NOT_ALLOWED = 'Notifications were not allowed. Press again to be asked again.'
const WOULD_NOT = 'This browser would not subscribe to notifications. Try again in a moment.'
const ID = /^[A-Za-z0-9_-]{22}$/

interface Filed {
  readonly id: string
  readonly endpoint: string
}

const sentenceOf = (answer: Answer): string => {
  if (answer.status === 0) return UNREACHED
  const message = (answer.body as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.length <= 200 ? message : WOULD_NOT
}

export function createConsolePush(deps: PushDeps): ConsolePush {
  const listeners = new Set<() => void>()
  let state: PushState = { status: 'checking', line: null }
  let key: Uint8Array<ArrayBuffer> | null = null

  const tell = (status: PushStatus, line: string | null = null): void => {
    state = { status, line, ...(state.rows === undefined ? {} : { rows: state.rows }) }
    for (const listener of listeners) listener()
  }

  /** The account's browsers, read again. Kept as they were when the registry does not answer. */
  const loadRows = async (): Promise<void> => {
    const answer = await deps.call('GET', '/v2/me/push/subscriptions/mine').catch(() => null)
    if (answer?.status !== 200 || !Array.isArray(answer.body)) return
    state = { ...state, rows: answer.body.filter(isRow).map(({ id, label, createdAt, here }) => ({ id, label, createdAt, here })) }
    for (const listener of listeners) listener()
  }

  const readFiled = (): Filed | null => {
    try {
      const held = JSON.parse(deps.kept.getItem(PUSH_KEPT_KEY) ?? 'null') as Partial<Filed> | null
      return typeof held?.id === 'string' && ID.test(held.id) && typeof held.endpoint === 'string' ? { id: held.id, endpoint: held.endpoint } : null
    } catch {
      return null
    }
  }

  /** The registry's key, or why there is none: 'off' is push off at the registry. */
  const fetchKey = async (): Promise<Uint8Array<ArrayBuffer> | 'off' | Answer> => {
    if (key !== null) return key
    const answer = await deps.call('GET', '/v2/me/push/key')
    if (answer.status === 404 && (answer.body as { error?: unknown } | null)?.error === 'push_off') return 'off'
    const bytes = answer.status === 200 ? keyBytes((answer.body as { publicKey?: unknown } | null)?.publicKey) : null
    if (bytes === null) return answer
    key = bytes
    return bytes
  }

  const manager = (): Promise<PushManagerLike | null> => deps.pushManager().catch(() => null)

  const check = async (): Promise<void> => {
    if (state.status === 'busy') return
    const fetched = await fetchKey()
    if (fetched === 'off' || !(fetched instanceof Uint8Array)) return tell('hidden')
    const support = pushSupport(deps.env)
    if (support !== 'ready') return tell(support)
    if (deps.permission() === 'denied') return tell('blocked')
    const held = await (await manager())?.getSubscription().catch(() => null)
    const filed = readFiled()
    const on = deps.permission() === 'granted' && held !== null && held !== undefined && filed !== null && filed.endpoint === held.endpoint
    tell(on ? 'on' : 'off')
  }

  /** The list is the account's, whatever this browser can do, so it is read for every state but hidden. */
  const checkAndList = async (): Promise<void> => {
    await check()
    if (state.status !== 'hidden') await loadRows()
  }

  const file = async (subscription: PushSubscriptionLike): Promise<void> => {
    const json = subscription.toJSON()
    const answer = await deps.call('POST', '/v2/me/push/subscriptions', { endpoint: json.endpoint ?? subscription.endpoint, keys: json.keys ?? {}, label: deps.label })
    const id = (answer.body as { id?: unknown } | null)?.id
    if (answer.status === 201 && typeof id === 'string' && ID.test(id)) {
      deps.kept.setItem(PUSH_KEPT_KEY, JSON.stringify({ id, endpoint: subscription.endpoint }))
      tell('on')
      return loadRows()
    }
    // Not filed: a subscription nobody will send to is one this browser should not hold.
    await subscription.unsubscribe().catch(() => false)
    tell('off', sentenceOf(answer))
  }

  const subscribeWith = async (bytes: Uint8Array<ArrayBuffer>): Promise<void> => {
    const pushManager = await manager()
    if (pushManager === null) return tell('unsupported')
    try {
      const held = await pushManager.getSubscription()
      // Made with another key (the registry's was rotated): it would be refused, so it goes first.
      if (held !== null && !sameKey(held.options?.applicationServerKey, bytes)) await held.unsubscribe()
      return await file(await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }))
    } catch {
      return tell('off', WOULD_NOT)
    }
  }

  const turnOn = async (): Promise<void> => {
    // FIRST, before any await: the prompt is taken only from the person's own press.
    const asked = deps.permission() === 'granted' ? Promise.resolve<NotificationPermission>('granted') : deps.requestPermission()
    tell('busy')
    const permission = await asked.catch((): NotificationPermission => 'default')
    if (permission === 'denied') return tell('blocked')
    if (permission !== 'granted') return tell('off', NOT_ALLOWED)
    const fetched = await fetchKey()
    if (fetched === 'off') return tell('hidden')
    if (!(fetched instanceof Uint8Array)) return tell('off', sentenceOf(fetched))
    return subscribeWith(fetched)
  }

  const letGo = async (): Promise<void> => {
    const held = await (await manager())?.getSubscription().catch(() => null)
    await held?.unsubscribe().catch(() => false)
  }

  const turnOff = async (): Promise<void> => {
    const filed = readFiled()
    tell('busy')
    await letGo()
    // Gone here first: if the registry cannot be told now, its next send to this row answers gone and it is taken off there.
    if (filed !== null) await deps.call('DELETE', `/v2/me/push/subscriptions/${filed.id}`).catch(() => null)
    deps.kept.removeItem(PUSH_KEPT_KEY)
    tell('off')
    await loadRows()
  }

  const remove = async (id: string): Promise<void> => {
    if (readFiled()?.id === id) return turnOff()
    await deps.call('DELETE', `/v2/me/push/subscriptions/${id}`).catch(() => null)
    await loadRows()
  }

  const forget = async (): Promise<void> => {
    key = null
    const filed = readFiled()
    state = { status: state.status, line: state.line }
    if (filed === null) return
    deps.kept.removeItem(PUSH_KEPT_KEY)
    await letGo()
    tell('checking')
  }

  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    check: checkAndList,
    turnOn,
    turnOff,
    forget,
    remove
  }
}
