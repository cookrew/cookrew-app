import { claimThroughSetup, codeNow } from './second-step'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../../registry/src/server'
import { RegistryStore } from '../../registry/src/store'
import { TransparencyLog } from '../../registry/src/log'
import { IdentityService } from '../../registry/src/identity'
import { DoorStore } from '../../registry/src/doors'
import { StarStore } from '../../registry/src/stars'
import { createV2 } from '../../registry/src/v2-routes'
import { RELAY_SESSION_HEADER } from '../../src/shared/machine-relay'

/**
 * A REAL REGISTRY WITH ONE DESKTOP AND ONE PHONE SIGNED IN — the world every
 * test of the Mac's own relay line starts from. The desktop holds its v2
 * session token; the phone holds a session it can call the desktop's API with
 * down the relay path, `/api/m/<id>/api/…`.
 */

const PASSWORD = 'correct horse battery staple'

export interface Listening {
  readonly origin: string
  readonly close: () => Promise<void>
}

export const listenOn = async (server: Server): Promise<Listening> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

export interface CanvasWorld {
  readonly site: Listening
  readonly deviceId: string
  readonly desktopToken: string
  /** `fetch` as the signed-in phone, at a route of the desktop's API down the relay path. */
  readonly asPhone: (route: string, init?: RequestInit) => Promise<Response>
  readonly close: () => Promise<void>
}

const jwkOf = (): Record<string, string> =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>

export const canvasWorld = async (options: { note?: (message: string) => void } = {}): Promise<CanvasWorld> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'canvas-world-'))
  const site = await listenOn(
    createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      identity: new IdentityService(dir),
      doors: new DoorStore(dir, { allowPrivate: true }),
      stars: new StarStore(dir),
      origin: 'https://cookrew.dev',
      ...(options.note ? { note: options.note } : {}),
      v2: createV2(dir, {
        limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 }
      })
    })
  )
  const deviceId = randomUUID()
  const claimed = await claimThroughSetup(site.origin, {
    username: 'owner',
    password: PASSWORD,
    device: { id: deviceId, kind: 'desktop', name: 'This Mac', jwk: jwkOf() }
  })
  const attached = await fetch(`${site.origin}/v2/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'owner',
      password: PASSWORD,
      device: { id: randomUUID(), kind: 'phone', name: 'A phone', jwk: jwkOf() }
    })
  })
  const asked = (await attached.json()) as { pending: string }
  // The set-up just spent this half-minute's code, so the phone types the next.
  const done = await fetch(`${site.origin}/v2/sessions/${asked.pending}/totp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codeNow(claimed.secret, Date.now() + 30_000) })
  })
  const phoneSession = ((await done.json()) as { token: string }).token
  return {
    site,
    deviceId,
    desktopToken: claimed.token,
    asPhone: (route, init = {}) =>
      fetch(`${site.origin}/api/m/${deviceId}/api${route}`, {
        ...init,
        headers: { [RELAY_SESSION_HEADER]: phoneSession, ...(init.headers as Record<string, string>) }
      }),
    close: async () => {
      await site.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** A companion reduced to what the relay tests need: a fixed big body, and a tiny answer. */
export const bodyServer = (big: Buffer): Server =>
  createServer((request, response) => {
    // A machine's API lives under /api, which is all the relay carries.
    if ((request.url ?? '').startsWith('/api/big')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(big.byteLength) })
      response.end(big)
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })

/** Poll until `what` holds. */
export const until = async (what: () => boolean, why: string, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Read a body to the end, calling `onBytes` with the running total. */
export const drain = async (response: Response, onBytes: (total: number) => void = () => undefined): Promise<number> => {
  const reader = response.body!.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return total
    total += value.byteLength
    onBytes(total)
  }
}
