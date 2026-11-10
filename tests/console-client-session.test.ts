import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONSOLE_SESSION_TTL_MS } from '../registry/src/v2-tokens'
import { PASSWORD, Client, bearer, bootAuthSite, desktopDevice, type AuthSite, type Device } from './support/auth-site-harness'
import { backFrom, browser, openConsolePage, signInOnAuthHost, typePasswordOnAuthHost } from './support/console-client'
import { PENDING_KEY, PENDING_TTL_MS, RENEW_BEFORE_MS, SESSION_KEY, safeReturn } from '../src/renderer/src/console/console-session'

/**
 * THE CONSOLE'S PAGE SIGNS IN, STAYS SIGNED IN AND SIGNS OUT, against the real
 * registry on its split hosts, with a real browser key.
 *
 * What this holds: the page never sees a password; the only place it sends the
 * browser is the auth host; the code that comes back is spent only by the tab
 * that asked; the fifteen-minute token is renewed by the device key; and
 * signing out ends it at the registry, not just on the page.
 */

const MINUTE = 60_000
let clock = Date.UTC(2026, 10, 11, 9, 0, 0)
const now = (): number => clock
let site: AuthSite
const username = 'pageowner'
let desktop: { token: string; device: Device }

beforeAll(async () => {
  site = await bootAuthSite({ split: true, now })
  const device = desktopDevice('Studio Mac')
  const made = await new Client(site).api('POST', '/v2/accounts', { username, password: PASSWORD, device: device.payload })
  expect(made.status, made.text).toBe(201)
  desktop = { token: String((made.body.session as { token: string }).token), device }
})

afterAll(async () => {
  await site.close()
})

const who = (): { username: string; approver: string } => ({ username, approver: desktop.token })

async function signedIn(from = browser()): Promise<ReturnType<typeof openConsolePage>> {
  const page = openConsolePage(site, now, from)
  await page.session.boot()
  expect((await page.session.signIn('/')).ok).toBe(true)
  const back = await signInOnAuthHost(site, page.went.at(-1) ?? '', who())
  expect((await page.session.complete(backFrom(back))).ok).toBe(true)
  return page
}

describe('a page nobody has signed in on', () => {
  it('is signed out, holds no token and asked the registry nothing to learn that', async () => {
    const page = openConsolePage(site, now)
    expect(page.session.get()).toEqual({ status: 'starting' })
    await page.session.boot()
    expect(page.session.get()).toEqual({ status: 'signed-out' })
    expect(page.session.token()).toBeNull()
    expect(page.calls).toEqual([])
  })
})

describe('signing in', () => {
  it('sends the browser to the auth host and nowhere else, and comes back signed in to where it was going', async () => {
    const page = openConsolePage(site, now)
    await page.session.boot()
    const heard: string[] = []
    page.session.subscribe(() => heard.push(page.session.get().status))
    const started = await page.session.signIn('/d/11111111-1111-4111-8111-111111111111')
    expect(started).toEqual({ ok: true })
    expect(page.went).toHaveLength(1)
    expect(page.went[0].startsWith(`${site.A}/?request=`)).toBe(true)
    // Nothing the page sent carried a password or a session: there is none yet.
    expect(page.calls.every((call) => call.headers.authorization === undefined)).toBe(true)

    const back = await signInOnAuthHost(site, page.went[0], who())
    expect(back.startsWith(`${site.C}/auth/complete?`)).toBe(true)
    const done = await page.session.complete(backFrom(back))
    expect(done).toEqual({ ok: true, intent: 'sign-in', returnTo: '/d/11111111-1111-4111-8111-111111111111' })
    expect(page.session.get()).toEqual({ status: 'signed-in', username })
    expect(heard).toEqual(['signed-in'])
    const token = page.session.token()
    expect(token).not.toBeNull()
    // The registry takes it, as a console's: the machines list, and no sensitive act.
    expect((await page.registry('GET', '/v2/me/desktops', undefined, bearer(token ?? ''))).status).toBe(200)
    expect((await page.registry('POST', '/v2/me/password', { next: 'another-password-123' }, bearer(token ?? ''))).status).toBe(403)
    // The verifier is gone the moment it is spent.
    expect(page.pending.getItem(PENDING_KEY)).toBeNull()
  })

  it('is the same device every time this browser signs in', async () => {
    const one = browser()
    const first = await signedIn(one)
    const firstDevice = (await first.device()).id
    await first.session.signOut()
    const second = await signedIn(one)
    expect((await second.device()).id).toBe(firstDevice)
    const devices = await new Client(site).api('GET', '/v2/me', undefined, bearer(desktop.token))
    const named = ((devices.body.devices ?? []) as { id: string; name: string }[]).filter((device) => device.id === firstDevice)
    expect(named.map((device) => device.name)).toEqual(['Console in Chrome on macOS'])
  })

  it('does not spend a code this tab did not ask for', async () => {
    const asking = openConsolePage(site, now)
    await asking.session.boot()
    await asking.session.signIn('/')
    const back = backFrom(await signInOnAuthHost(site, asking.went[0], who()))
    // Another tab, or a link somebody sent: no verifier, no state of its own.
    const other = openConsolePage(site, now)
    await other.session.boot()
    const refused = await other.session.complete(back)
    expect(refused.ok).toBe(false)
    expect(other.session.get()).toEqual({ status: 'signed-out' })
    expect(other.calls.some((call) => call.path === '/v2/auth/token')).toBe(false)
    // And a state that is not the one this tab made is not spent either.
    const wrong = await asking.session.complete({ ...back, state: 'not-the-state-this-tab-made' })
    expect(wrong.ok).toBe(false)
    expect(asking.calls.some((call) => call.path === '/v2/auth/token')).toBe(false)
    // The round trip is over: the right state afterwards finds no verifier waiting.
    expect((await asking.session.complete(back)).ok).toBe(false)
  })

  it('says so when the person cancelled, or took too long, and stays signed out', async () => {
    const page = openConsolePage(site, now)
    await page.session.boot()
    await page.session.signIn('/d/x')
    const state = JSON.parse(page.pending.getItem(PENDING_KEY) ?? '{}').state as string
    expect(await page.session.complete({ code: null, state, error: 'cancelled' })).toMatchObject({ ok: false, message: 'Cancelled.' })

    await page.session.signIn('/')
    const back = backFrom(await signInOnAuthHost(site, page.went.at(-1) ?? '', who()))
    clock += PENDING_TTL_MS + 1
    expect((await page.session.complete(back)).ok).toBe(false)
    expect(page.session.get()).toEqual({ status: 'signed-out' })
  })

  it('goes nowhere when the registry points the browser at another host', async () => {
    const page = openConsolePage(site, now)
    const lying = openConsolePage(site, now)
    await page.session.boot()
    // The same module over a registry whose answer names another origin to open.
    const { createConsoleSession } = await import('../src/renderer/src/console/console-session')
    const went: string[] = []
    const session = createConsoleSession({
      registry: async (method, path, body, headers) => {
        const answer = await lying.registry(method, path, body, headers)
        if (path !== '/v2/auth/requests' || typeof answer.body !== 'object' || answer.body === null) return answer
        return { status: answer.status, body: { ...answer.body, authorizeUrl: 'https://auth.cookrew.dev.evil.example/?request=x' } }
      },
      authOrigin: site.A,
      device: lying.device,
      kept: lying.kept,
      pending: lying.pending,
      navigate: (url) => void went.push(url),
      now
    })
    const started = await session.signIn('/')
    expect(started.ok).toBe(false)
    expect(went).toEqual([])
    // And it proved nothing to that registry: no signature was sent.
    expect(lying.calls.some((call) => call.path.endsWith('/proof'))).toBe(false)
  })
})

describe('where it comes back to', () => {
  it('is a path of this page, or the root', () => {
    expect(safeReturn('/d/abc/w/def')).toBe('/d/abc/w/def')
    expect(safeReturn('/')).toBe('/')
    for (const bad of ['https://evil.example/', '//evil.example/', 'd/abc', '/auth/complete?code=x', '/a b', '/a\\b', '']) expect(safeReturn(bad), bad).toBe('/')
  })
})

describe('staying signed in', () => {
  it('a reopened page is still signed in, from what the browser kept', async () => {
    const one = browser()
    const first = await signedIn(one)
    const token = first.session.token()
    const reopened = openConsolePage(site, now, one)
    await reopened.session.boot()
    expect(reopened.session.get()).toEqual({ status: 'signed-in', username })
    expect(reopened.session.token()).toBe(token)
    expect(reopened.calls).toEqual([])
  })

  it('renews before the fifteen minutes are up, with the device key and nothing else', async () => {
    const timers: { run: () => void; ms: number }[] = []
    const one = browser()
    await signedIn(one)
    const page = openConsolePage(site, now, one, { set: (run, ms) => timers.push({ run, ms }), clear: () => undefined })
    await page.session.boot()
    const before = page.session.token()
    expect(timers.at(-1)?.ms).toBe(CONSOLE_SESSION_TTL_MS - RENEW_BEFORE_MS)
    clock += CONSOLE_SESSION_TTL_MS - RENEW_BEFORE_MS
    timers.at(-1)?.run()
    await expect.poll(() => page.session.token()).not.toBe(before)
    const renewed = page.session.token() ?? ''
    expect((await page.registry('GET', '/v2/me/desktops', undefined, bearer(renewed))).status).toBe(200)
    // The renewal named the device and carried no session: the key is the credential.
    const renewal = page.calls.filter((call) => call.path.startsWith('/v2/sessions/renew'))
    expect(renewal.map((call) => call.path)).toEqual(['/v2/sessions/renew-nonce', '/v2/sessions/renew'])
    expect(renewal.every((call) => call.headers.authorization === undefined)).toBe(true)
    expect(JSON.parse(page.kept.getItem(SESSION_KEY) ?? '{}').token).toBe(renewed)
  })

  it('a page opened after the token ran out renews on the way in, and never hands out the dead one', async () => {
    const one = browser()
    await signedIn(one)
    clock += CONSOLE_SESSION_TTL_MS + MINUTE
    const page = openConsolePage(site, now, one)
    expect(page.session.token()).toBeNull()
    await page.session.boot()
    expect(page.session.get()).toEqual({ status: 'signed-in', username })
    const token = page.session.token() ?? ''
    expect((await page.registry('GET', '/v2/me/desktops', undefined, bearer(token))).status).toBe(200)
  })

  it('is signed out when the registry says the sign-in is over: the device was taken back', async () => {
    const one = browser()
    const first = await signedIn(one)
    const device = (await first.device()).id
    const revoked = await new Client(site).api('DELETE', `/v2/me/devices/${device}`, { current: PASSWORD }, bearer(desktop.token))
    expect(revoked.status, revoked.text).toBeLessThan(300)
    clock += CONSOLE_SESSION_TTL_MS + MINUTE
    const page = openConsolePage(site, now, one)
    await page.session.boot()
    expect(page.session.get()).toEqual({ status: 'signed-out' })
    expect(page.session.token()).toBeNull()
    expect(page.kept.getItem(SESSION_KEY)).toBeNull()
  })

  it('keeps the session while the registry cannot be reached, and asks again', async () => {
    const one = browser()
    await signedIn(one)
    const timers: { run: () => void; ms: number }[] = []
    const { createConsoleSession } = await import('../src/renderer/src/console/console-session')
    const real = openConsolePage(site, now, one)
    const session = createConsoleSession({
      registry: async () => ({ status: 0, body: null }),
      authOrigin: site.A,
      device: real.device,
      kept: one.kept,
      pending: one.pending,
      navigate: () => undefined,
      now,
      setTimer: (run, ms) => timers.push({ run, ms }),
      clearTimer: () => undefined
    })
    clock += CONSOLE_SESSION_TTL_MS - MINUTE
    await session.boot()
    expect(session.get()).toEqual({ status: 'signed-in', username })
    expect(session.token()).not.toBeNull()
    expect(timers.at(-1)?.ms).toBe(30_000)
  })
})

describe('the relay refusing the session', () => {
  it('renews it, and a burst of refusals is one renewal', async () => {
    const one = browser()
    await signedIn(one)
    const page = openConsolePage(site, now, one)
    await page.session.boot()
    const before = page.session.token()
    for (let i = 0; i < 5; i += 1) page.session.refused()
    await expect.poll(() => page.session.token()).not.toBe(before)
    expect(page.calls.filter((call) => call.path === '/v2/sessions/renew')).toHaveLength(1)
    page.session.refused()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(page.calls.filter((call) => call.path === '/v2/sessions/renew')).toHaveLength(1)
  })
})

describe('signing out', () => {
  it('ends the session at the registry and on the page', async () => {
    const one = browser()
    const page = await signedIn(one)
    const token = page.session.token() ?? ''
    await page.session.signOut()
    expect(page.session.get()).toEqual({ status: 'signed-out' })
    expect(page.session.token()).toBeNull()
    expect(page.kept.getItem(SESSION_KEY)).toBeNull()
    expect((await page.registry('GET', '/v2/me/desktops', undefined, bearer(token))).status).toBe(401)
    // And the device key does not bring it back: the sign-in itself is over.
    const reopened = openConsolePage(site, now, one)
    await reopened.session.boot()
    expect(reopened.session.get()).toEqual({ status: 'signed-out' })
  })
})

describe('the device pass by password', () => {
  it('is typed on the auth host and comes back as a pass for this browser’s own key', async () => {
    const page = await signedIn()
    const device = (await page.device()).id
    const before = page.calls.length
    expect(await page.session.passByPassword('/d/22222222-2222-4222-8222-222222222222')).toEqual({ ok: true })
    expect(page.went.at(-1)?.startsWith(`${site.A}/?request=`)).toBe(true)
    // The page asked with its session and sent no password anywhere.
    const opened = page.calls.slice(before).find((call) => call.path === '/v2/auth/requests')
    expect(opened?.headers.authorization).toBe(`Bearer ${page.session.token()}`)

    const back = await typePasswordOnAuthHost(site, page.went.at(-1) ?? '')
    const done = await page.session.complete(backFrom(back))
    expect(done).toMatchObject({ ok: true, intent: 'grant', returnTo: '/d/22222222-2222-4222-8222-222222222222' })
    const grant = done.ok ? done.grant : undefined
    expect(grant?.deviceId).toBe(device)
    expect(site.v2.tokens.verify(String(grant?.grant), 'grant')?.dev).toBe(device)
    // Still the same sign-in.
    expect(page.session.get()).toEqual({ status: 'signed-in', username })
  })

  it('is not started by a page that is not signed in', async () => {
    const page = openConsolePage(site, now)
    await page.session.boot()
    expect(await page.session.passByPassword('/')).toEqual({ ok: false, message: 'Sign in first.' })
    expect(page.went).toEqual([])
    expect(page.calls).toEqual([])
  })
})
