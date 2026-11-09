import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer as netServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from 'vitest'
import { createRegistry } from '../../registry/src/server'
import { RegistryStore } from '../../registry/src/store'
import { TransparencyLog } from '../../registry/src/log'
import { IdentityService } from '../../registry/src/identity'
import { DoorStore } from '../../registry/src/doors'
import { StarStore } from '../../registry/src/stars'
import { createV2 } from '../../registry/src/v2-routes'
import { base32Decode, totpAt } from '../../registry/src/v2-totp'
import { fakeOAuth } from './fake-oauth'
import type { AuthSite, Client } from './auth-site-harness'

/**
 * THE AUTH SITE WITH A CLOCK THE TEST HOLDS — for the /me step-up suites.
 *
 * The five-minute window is the whole subject, so the registry's `now` is a
 * number the test moves. Every store reads it (sessions, pendings, requests,
 * TOTP steps), so "six minutes later" is one assignment rather than a wait.
 * Shaped like auth-site-harness's AuthSite, so its Client and helpers drive it.
 */

export interface ClockedSite extends AuthSite {
  /** Move the registry's clock forward. */
  advance: (ms: number) => void
  now: () => number
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = netServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })

export async function bootClockedSite(): Promise<ClockedSite> {
  const dir = mkdtempSync(path.join(tmpdir(), 'me-stepup-'))
  const fake = await fakeOAuth()
  const port = await freePort()
  const P = `http://localhost:${port}`
  const A = `http://auth.localhost:${port}`
  const logged: string[] = []
  let clock = Date.now()
  const now = (): number => clock
  const v2 = createV2(dir, {
    log: (message) => logged.push(message),
    limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, oauthPerMinute: 1000, lookupsPerMinute: 1000, joinPerMinute: 1000 },
    oauth: fake.config(),
    origin: P,
    secondStep: 'legacy',
    authOrigin: A,
    now
  })
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    origin: P,
    v2
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    await fake.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { P, A, port, fake, v2, logged, close, now, advance: (ms) => (clock += ms) }
}

/** Turn an authenticator on for the browser's account; answers the secret. */
export async function addAuthenticator(site: ClockedSite, browser: Client): Promise<string> {
  const started = await browser.product('POST', '/v2/me/totp/enrol', {})
  expect(started.status, started.text).toBe(201)
  const secret = String(started.body.secret)
  const confirmed = await browser.product('POST', '/v2/me/totp/confirm', { code: codeFor(site, secret) })
  expect(confirmed.status, confirmed.text).toBe(204)
  return secret
}

/** The six digits the authenticator shows at the registry's present moment. */
export const codeFor = (site: ClockedSite, secret: string, offsetMs = 0): string =>
  totpAt(base32Decode(secret) as Buffer, site.now() + offsetMs)
