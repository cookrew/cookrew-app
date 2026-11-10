/**
 * THE CONSOLE'S PAGE, FOR A SUITE: its session module wired to a real registry
 * (auth-site-harness.ts, split hosts), with a real browser key (WebCrypto), a
 * memory for storage and a note of where it tried to send the browser.
 */
import { expect } from 'vitest'
import { PASSWORD, Client, bearer, type AuthSite } from './auth-site-harness'
import { consoleDevice, type ConsoleDevice, type DeviceStore, type StoredDevice } from '../../src/renderer/src/console/device-key'
import { createConsoleSession, type ConsoleSession, type KeyValue, type RegistryCall } from '../../src/renderer/src/console/console-session'
import { parseConsoleRoute } from '../../src/renderer/src/console/console-route'

export const memory = (): KeyValue & { readonly all: Map<string, string> } => {
  const all = new Map<string, string>()
  return { all, getItem: (key) => all.get(key) ?? null, setItem: (key, value) => void all.set(key, value), removeItem: (key) => void all.delete(key) }
}

/** One browser's key store: the same device for every page opened in it. */
export const keyStore = (): DeviceStore => {
  let held: StoredDevice | null = null
  return {
    load: async () => held,
    claim: async (device, usable) => {
      if (held !== null && usable(held)) return held
      held = device
      return device
    },
    clear: async () => void (held = null)
  }
}

export interface ConsolePage {
  readonly session: ConsoleSession
  readonly registry: RegistryCall
  readonly device: () => Promise<ConsoleDevice>
  readonly kept: ReturnType<typeof memory>
  readonly pending: ReturnType<typeof memory>
  /** Where the page sent the browser, newest last. */
  readonly went: string[]
  readonly calls: { method: string; path: string; headers: Record<string, string> }[]
}

export interface Browser {
  readonly keys: ReturnType<typeof keyStore>
  readonly kept: ReturnType<typeof memory>
  readonly pending: ReturnType<typeof memory>
}

export const browser = (): Browser => ({ keys: keyStore(), kept: memory(), pending: memory() })

/** A page of the console opened in this browser (a reload is a second page over the same browser). */
export function openConsolePage(site: AuthSite, now: () => number, from: Browser = browser(), timers?: { set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void }): ConsolePage {
  const client = new Client(site, 'console-page')
  const went: string[] = []
  const calls: ConsolePage['calls'] = []
  const registry: RegistryCall = async (method, path, body, headers = {}) => {
    calls.push({ method, path, headers })
    const answer = await client.console(method, path, body, headers)
    return { status: answer.status, body: answer.text === '' ? null : answer.body }
  }
  const device = (): Promise<ConsoleDevice> => consoleDevice({ ...from.keys, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0 Safari/537.36' })
  const session = createConsoleSession({
    registry,
    authOrigin: site.A,
    device,
    kept: from.kept,
    pending: from.pending,
    navigate: (url) => void went.push(url),
    now,
    // A suite that does not drive the clock leaves no real timer behind it.
    setTimer: timers?.set ?? (() => null),
    clearTimer: timers?.clear ?? (() => undefined)
  })
  return { session, registry, device, kept: from.kept, pending: from.pending, went, calls }
}

/**
 * The person, on the auth host: signs in with the password and has the first
 * machine say yes. Answers the address the browser is sent back to.
 */
export async function signInOnAuthHost(site: AuthSite, authorizeUrl: string, who: { username: string; approver: string }): Promise<string> {
  const request = new URL(authorizeUrl).searchParams.get('request') ?? ''
  const page = new Client(site, 'auth-page')
  expect((await page.page('POST', '/auth/api/claim', null, { request })).status).toBe(200)
  const asked = await page.page('POST', '/v2/sessions', request, { username: who.username, password: PASSWORD })
  // A device the account already knows is let in by the password alone.
  if (asked.status === 200) return String((asked.body.handoff as { url: string }).url)
  expect(asked.status, asked.text).toBe(401)
  const rung = await page.page('POST', `/v2/sessions/${asked.body.pending}/approve`, request, {})
  expect(rung.status, rung.text).toBe(202)
  const decided = await new Client(site).api('POST', `/v2/me/approvals/${rung.body.approval}`, { decision: 'approve', match: asked.body.match }, bearer(who.approver))
  expect(decided.status, decided.text).toBe(204)
  const done = await page.page('GET', `/v2/sessions/${asked.body.pending}`, request)
  expect(done.status, done.text).toBe(200)
  return String((done.body.handoff as { url: string }).url)
}

/** The person, on the auth host, typing the password for a device pass. */
export async function typePasswordOnAuthHost(site: AuthSite, authorizeUrl: string, password = PASSWORD): Promise<string> {
  const request = new URL(authorizeUrl).searchParams.get('request') ?? ''
  const page = new Client(site, 'auth-page')
  expect((await page.page('POST', '/auth/api/claim', null, { request })).status).toBe(200)
  const typed = await page.page('POST', '/auth/api/grant', request, { password })
  expect(typed.status, typed.text).toBe(200)
  return String((typed.body.handoff as { url: string }).url)
}

/** What the page reads off the address the browser came back to. */
export const backFrom = (url: string): { code: string | null; state: string | null; error: string | null } => {
  const at = new URL(url)
  const route = parseConsoleRoute(at.pathname, at.search)
  if (route.kind !== 'auth-complete') throw new Error(`not the way back: ${url}`)
  return { code: route.code, state: route.state, error: route.error }
}
