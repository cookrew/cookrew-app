import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootAuthSite, Client, codeOf, desktopDevice, openDesktop, PASSWORD, type AuthSite } from './support/auth-site-harness'
import { codeNow } from './support/second-step'

/**
 * GATE 1 ON AUTH.COOKREW.DEV, in the deployed mode (auth UX 2026-11-09).
 *
 * The page reaches the registry only through an allow-list (auth-host.ts), and
 * the set-up routes were missing from it: the real-browser walk found the page
 * stuck on "Make a passkey" with "There is nothing at that address". This
 * drives the whole set-up through the auth origin, so the list cannot drop a
 * route again without a test saying so.
 */

let site: AuthSite
beforeAll(async () => {
  site = await bootAuthSite({ secondStep: 'required' })
})
afterAll(async () => {
  await site.close()
})

describe('a new account made on the auth page', () => {
  it('sets up its second step there, saves its codes, and only then hands the app its code', async () => {
    const app = new Client(site)
    const device = desktopDevice('New Mac')
    const opened = await openDesktop(site, app, device, { intent: 'create' })
    const browser = new Client(site, 'browser')
    await browser.page('POST', '/auth/api/claim', null, { request: opened.request })
    const made = await browser.page('POST', '/v2/accounts', opened.request, { username: 'setupnew', password: PASSWORD })
    expect(made.status).toBe(403)
    expect(made.body.error).toBe('second_step_setup')
    const pending = String(made.body.pending)
    const started = await browser.page('POST', `/v2/sessions/${pending}/setup/totp`, opened.request, {})
    expect(started.status).toBe(201)
    const confirmed = await browser.page('POST', `/v2/sessions/${pending}/setup/totp/confirm`, opened.request, { code: codeNow(String(started.body.secret)) })
    expect(confirmed.status).toBe(201)
    expect((confirmed.body.codes as string[]).length).toBe(8)
    expect((await browser.page('POST', `/v2/sessions/${pending}/setup/passkey/options`, opened.request, {})).status).not.toBe(404)
    const finished = await browser.page('POST', `/v2/sessions/${pending}/setup/finish`, opened.request, { saved: true })
    expect(finished.status).toBe(200)
    expect(finished.body.status).toBe('authorized')
    const spent = await app.call(site.P, 'POST', '/v2/auth/token', { code: codeOf(finished.body.handoff).code, verifier: opened.verifier })
    expect(spent.body).toMatchObject({ username: 'setupnew', deviceId: device.payload.id })
  })
})
