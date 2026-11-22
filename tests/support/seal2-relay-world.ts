// A real relay for cookrew-seal/2 tests: the unmodified registry on loopback,
// one account with two desktops (each a real Ed25519 device key whose id is
// its key's, as account-v2.ts mints them) and a phone, and the Mac's held line.
// Every line the registry exchanges with the Mac, and every request and answer
// the callers exchange with the registry, is kept: that is what a relay sees.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DoorStore } from '../../registry/src/doors'
import { IdentityService } from '../../registry/src/identity'
import { TransparencyLog } from '../../registry/src/log'
import { createRegistry } from '../../registry/src/server'
import { StarStore } from '../../registry/src/stars'
import { RegistryStore } from '../../registry/src/store'
import { createV2 } from '../../registry/src/v2-routes'
import { createCanvasBridge, loopbackDialer } from '../../src/main/canvas-bridge'
import { createCanvasLink, type CanvasLink } from '../../src/main/canvas-link'
import { relayLineHeaders } from '../../src/main/seal-proof'
import { createSealTerminus, isSealPath, routeSeal, type SealTerminus, type SealTerminusDeps } from '../../src/main/canvas-seal-terminus'
import { RELAY_SESSION_HEADER } from '../../src/shared/machine-relay'
import { newDevice, signUp, type Device } from './seal2-accounts'


/** Waits for a condition, with no test runner in it: scripts load this module too. */
export const until = async (what: () => boolean, why: string, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export interface Up {
  readonly origin: string
  close(): Promise<void>
}

export const listen = async (server: Server): Promise<Up> => {
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

/** One exchange a caller had with the registry, as the registry read it. */
export interface CallerExchange {
  readonly url: string
  readonly headers: Record<string, string>
  readonly sent: Buffer
  readonly answered: Buffer
}

export interface RelayWorld {
  readonly site: Up
  readonly mac: Up
  /** The Mac (desktop B): its device, and its terminus. */
  readonly macDevice: Device
  /** Another desktop of the same account (A), signed in. */
  readonly otherDesktop: Device & { readonly session: Record<string, string> }
  /** A phone of the account, signed in. */
  readonly phoneSession: Record<string, string>
  /** That phone's account device id: a random uuid, as a watch's is. */
  readonly phoneDeviceId: string
  /** Every line between the registry and the Mac. */
  readonly lines: string[]
  /** Every exchange a caller had with the registry, through `capture`. */
  readonly exchanges: CallerExchange[]
  terminus(): SealTerminus
  /** A fetch that keeps what crossed, adding a caller's session header. */
  capture(session: Record<string, string>): typeof fetch
  /** The relay's prefix for the Mac. */
  prefix(): string
  /** Everything the registry could read, decoded where it is base64, from line `from` and exchange `fromExchange` on. */
  relayCouldRead(from: number, fromExchange: number): string
  close(): Promise<void>
}

export async function startRelayWorld(companion: (terminus: () => SealTerminus | undefined) => Server, terminusDeps: (port: number, mac: Device, other: Device) => SealTerminusDeps): Promise<RelayWorld> {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal2-relay-'))
  let terminus: SealTerminus | undefined
  const mac = await listen(companion(() => terminus))
  const site = await listen(
    createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      identity: new IdentityService(dir),
      doors: new DoorStore(dir, { allowPrivate: true }),
      stars: new StarStore(dir),
      origin: 'https://cookrew.dev',
      v2: createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } })
    })
  )
  const macDevice = newDevice()
  const other = newDevice()
  const { desktopToken, otherSession, phoneSession, phoneDeviceId } = await signUp(site, macDevice, other)
  const port = Number(new URL(mac.origin).port)
  terminus = createSealTerminus(terminusDeps(port, macDevice, other))
  const lines: string[] = []
  const exchanges: CallerExchange[] = []
  const link: CanvasLink = createCanvasLink({ origin: () => site.origin, credential: () => ({ token: desktopToken, deviceId: macDevice.id }) })
  const bridge = createCanvasBridge({
    send: (line) => {
      lines.push(line)
      link.send(line)
    },
    // As index.ts dials the canvas line: with the line's own proof (seal-proof.ts).
    dial: loopbackDialer(port, undefined, relayLineHeaders())
  })
  link.onFrame((line) => {
    lines.push(line)
    bridge.frame(line)
  })
  link.onDrop(bridge.reset)
  link.start()
  await until(() => link.held(), 'the line', 4000)

  const capture = (session: Record<string, string>): typeof fetch => async (input, init) => {
    const headers = { ...(init?.headers as Record<string, string> | undefined), ...session }
    const sent = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(typeof init?.body === 'string' ? init.body : '')
    const answer = await fetch(input, { ...init, headers })
    const record: CallerExchange = { url: String(input), headers, sent, answered: Buffer.alloc(0) }
    exchanges.push(record)
    if (answer.body === null) return answer
    // Keep what comes down as it comes, and hand the very same bytes on.
    const kept: Buffer[] = []
    const tee = answer.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          kept.push(Buffer.from(chunk))
          ;(record as { answered: Buffer }).answered = Buffer.concat(kept)
          controller.enqueue(chunk)
        }
      })
    )
    return new Response(tee, { status: answer.status, headers: answer.headers })
  }

  const decodedLine = (line: string): string => {
    try {
      const frame = JSON.parse(line) as { data?: string }
      return frame.data ? Buffer.from(frame.data, 'base64').toString('latin1') : ''
    } catch {
      return ''
    }
  }

  return {
    site,
    mac,
    macDevice,
    otherDesktop: { ...other, session: { [RELAY_SESSION_HEADER]: otherSession } },
    phoneSession: { [RELAY_SESSION_HEADER]: phoneSession },
    phoneDeviceId,
    lines,
    exchanges,
    terminus: () => terminus as SealTerminus,
    capture,
    prefix: () => `${site.origin}/api/m/${macDevice.id}`,
    relayCouldRead(from, fromExchange) {
      const kept = lines.slice(from)
      const callers = exchanges.slice(fromExchange).flatMap((exchange) => [exchange.url, JSON.stringify(exchange.headers), exchange.sent.toString('latin1'), exchange.answered.toString('latin1')])
      return [...kept, ...kept.map(decodedLine), ...callers].join('\n')
    },
    async close() {
      link.stop()
      terminus?.close()
      await site.close()
      await mac.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export { isSealPath, routeSeal, loopbackDialer }
export { newDevice, signUp, verifyDevice, type Device } from './seal2-accounts'
