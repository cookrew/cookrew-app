// /api/reach, THROUGH THE REAL ROAD: the unmodified registry on loopback, a
// real held line and canvas bridge, the real seal terminus, and the Mac's own
// request handler — mobile-server.ts · handle(), with nothing in front of it,
// on a random loopback port. The terminus dials it as index.ts does (with the
// seal's proof), and the bridge as index.ts does (with the line's proof).
//
// The reach answer is this Mac's own copy of its reach card: its LAN and
// tailnet addresses, the certificate it pins, the trusted names and where its
// publish stands. Like a path report (path-report-sealed-relay.test.ts) it is
// for the owner only, and only inside cookrew-seal/2:
//   - the owner's v2 GET reads the answer whole, and the relay reads neither
//     the canary in it, the token nor the route;
//   - the read-only wall token reads nothing, even sealed v2;
//   - plain over the relay, a forged seal header over the relay, and a forged
//     seal header straight at the Mac on loopback are all refused before any
//     of the answer is built;
//   - the control: what goes plain through the same relay IS found by the same
//     search, so a clean search means something.
//
// In-process there is no HTTPS listener, so `lan`/`tailnet` come back empty
// (reach.ts · reachCard lists nothing without a certificate fingerprint). The
// canaries this answer DOES carry are the account's device id and the
// publisher's refusal words, so those stand in for "the addresses" below.
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handle, type MobileServerDeps } from '../src/main/mobile-server'
import type { SealTerminus } from '../src/main/canvas-seal-terminus'
import { RELAY_LINE_MARKER, SEALED_PEER_HEADER, SEALED_V2_HEADER, sealProofHeaders } from '../src/main/seal-proof'
import { SEALED_MARKER } from '../src/shared/remote-unlock'
import { connectCodeId, newConnectCode } from '../src/shared/canvas-seal'
import { openSeal, type SealClient } from '../src/renderer/src/path/seal-client'
import { loopbackDialer, startRelayWorld, type RelayWorld } from './support/seal2-relay-world'

const OWNER = 'canary-owner-pairing-token-5b81d4'
const WALL = 'canary-wall-token-e02c7a'
const OWNER_BEARER = `Bearer ${OWNER}`
const WALL_BEARER = `Bearer ${WALL}`

const REACH_ROUTE = '/api/reach'

/** What the reach answer carries and a refused caller must never see: the publisher's own words. */
const REFUSED_WORDS = 'canary-reach-refused-8d3f'
/** Rides a plain request's query string, so the relay search has something it must find. */
const PLAIN_PROBE = 'canary-plain-probe-41e9'

const SEALED_ONLY = 'sealed session required'

const code = newConnectCode()
const encodedCode = Buffer.from(code).toString('base64url')
let world: RelayWorld
const clients: SealClient[] = []

/** The Mac's signed-in account: fake, keyless, and nothing in it is a real secret. */
const fakeAccount = () => ({
  username: 'canary-owner',
  deviceId: world.macDevice.id,
  kind: 'desktop' as const,
  name: 'Canary Mac',
  privateKeyJwk: {},
  publicKeyJwk: {},
  registry: world.site.origin,
  session: null,
  unlock: null
})

/** Every dep handle() touches on the way to /api/reach: the real gate, the real route. */
const macDeps = (terminus: () => SealTerminus | undefined): MobileServerDeps =>
  ({
    multiInstance: () => false,
    store: {
      focusedId: 'w1',
      focusedState: { nodes: [], edges: [] },
      workspaceState: () => ({ nodes: [], edges: [] }),
      list: () => ({ workspaces: [] }),
      bySlug: () => undefined,
      on: () => () => undefined
    },
    ptys: { get: () => null, on: () => () => undefined },
    turns: { list: () => [], on: () => () => undefined },
    activity: { on: () => () => undefined },
    events: { on: () => () => undefined },
    ops: { listWorkspaces: () => [], onUiCommand: () => () => undefined },
    presets: [],
    traces: { latestCheckpoint: () => null },
    interactiveBrowserEnabled: () => false,
    pairingToken: OWNER,
    wallToken: WALL,
    perDeviceOnly: () => false,
    rendererDir: '/nonexistent',
    sealTerminus: terminus,
    reachPublish: () => ({ acceptedAt: null, refused: REFUSED_WORDS }),
    identity: {
      account: fakeAccount,
      registryOrigin: () => 'https://cookrew.dev',
      admitted: { accepts: () => false, deviceFor: () => null, has: () => false, record: () => undefined }
    }
  }) as unknown as MobileServerDeps

/** The Mac: handle() and nothing else, the seal paths included (deps.sealTerminus). */
const companion = (terminus: () => SealTerminus | undefined): Server =>
  createServer((request, response) => {
    handle(request, response, macDeps(terminus)).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(String(error))
    })
  })

beforeAll(async () => {
  const codeId = await connectCodeId(code)
  world = await startRelayWorld(companion, (port) => ({
    codeFor: (asked) => (asked === codeId ? code : null),
    replacedKeyFor: () => null,
    currentCodeId: async () => codeId,
    // As index.ts dials the terminus: with the seal's own proof on every inner request.
    dial: loopbackDialer(port, undefined, sealProofHeaders())
  }))
})

afterAll(async () => {
  for (const client of clients) client.close()
  await world?.close()
})

const mark = (): [number, number] => [world.lines.length, world.exchanges.length]
const relayRead = ([from, fromExchange]: [number, number]): string => world.relayCouldRead(from, fromExchange)
const text = (body: Uint8Array): string => Buffer.from(body).toString('utf8')

/** The page's own v2 client (path/seal-client.ts), through the relay, every exchange kept. */
async function sealedV2(): Promise<SealClient> {
  const client = await openSeal({ url: (route) => `${world.prefix()}${route}`, code: encodedCode, fetchFn: world.capture(world.phoneSession), retryMs: 50 })
  clients.push(client)
  expect(client.version).toBe(2)
  return client
}

const sealedGet = (client: SealClient, bearer: string) => client.request({ method: 'GET', path: REACH_ROUTE, headers: { authorization: bearer } })

/** A plain request through the relay, as anybody holding the account's session could send one. */
const plain = (route: string, init: RequestInit): Promise<Response> => world.capture(world.phoneSession)(`${world.prefix()}${route}`, init)

/** Seal headers a relay (or a local process) could write: none of them carries the per-launch proof. */
const forgedSealHeaders = (): Record<string, string> => ({
  [SEALED_V2_HEADER]: '1',
  [SEALED_MARKER]: randomBytes(32).toString('base64url'),
  [SEALED_PEER_HEADER]: world.macDevice.id,
  [RELAY_LINE_MARKER]: randomBytes(32).toString('base64url')
})

/** A refusal hands back an error and nothing of the reach answer. */
function expectNoReach(said: string): void {
  expect(said).not.toContain(REFUSED_WORDS)
  expect(said).not.toContain(world.macDevice.id)
  const body = JSON.parse(said) as Record<string, unknown>
  for (const field of ['deviceId', 'lan', 'tailnet', 'trusted', 'publish']) expect(body, field).not.toHaveProperty(field)
}

describe('the owner, inside cookrew-seal/2', () => {
  it('reads the reach answer whole; the relay reads neither its words, the token nor the route', async () => {
    const at = mark()
    const answer = await sealedGet(await sealedV2(), OWNER_BEARER)
    expect(answer.status).toBe(200)
    const body = JSON.parse(text(answer.body)) as Record<string, unknown>
    expect(body).toMatchObject({ deviceId: world.macDevice.id, publish: { refused: REFUSED_WORDS } })
    for (const field of ['lan', 'tailnet', 'trusted']) expect(body, field).toHaveProperty(field)

    const relay = relayRead(at)
    // The search had something to search: the session's frames crossed it.
    expect(relay.length).toBeGreaterThan(500)
    for (const canary of [REFUSED_WORDS, OWNER, REACH_ROUTE]) expect(relay, canary).not.toContain(canary)
  })
})

describe('the read-only wall token', () => {
  it('reads nothing, though it comes sealed v2', async () => {
    const at = mark()
    const answer = await sealedGet(await sealedV2(), WALL_BEARER)
    expect(answer.status).toBe(403)
    expectNoReach(text(answer.body))
    expect(relayRead(at)).not.toContain(REFUSED_WORDS)
  })
})

describe('every road but cookrew-seal/2 is refused before the answer is built', () => {
  it('plain over the relay with the owner token', async () => {
    const at = mark()
    const got = await plain(`${REACH_ROUTE}?probe=${PLAIN_PROBE}`, { headers: { authorization: OWNER_BEARER } })
    expect(got.status).toBe(403)
    const said = await got.text()
    expectNoReach(said)
    expect(JSON.parse(said)).toEqual({ error: SEALED_ONLY })

    const relay = relayRead(at)
    // The control: the same search finds what went plain, so its silence on the answer means something.
    expect(relay).toContain(PLAIN_PROBE)
    expect(relay).not.toContain(REFUSED_WORDS)
  })

  it('forged seal headers over the relay (v2 flag, seal proof, peer, line proof)', async () => {
    const at = mark()
    const got = await plain(REACH_ROUTE, { headers: { authorization: OWNER_BEARER, ...forgedSealHeaders() } })
    expect(got.status).toBe(403)
    const said = await got.text()
    expectNoReach(said)
    expect(JSON.parse(said)).toEqual({ error: SEALED_ONLY })
    expect(relayRead(at)).not.toContain(REFUSED_WORDS)
  })

  it('forged seal headers straight at the Mac on loopback (no relay at all)', async () => {
    const got = await fetch(`${world.mac.origin}${REACH_ROUTE}`, { headers: { authorization: OWNER_BEARER, ...forgedSealHeaders() } })
    expect(got.status).toBe(403)
    const said = await got.text()
    expectNoReach(said)
    expect(JSON.parse(said)).toEqual({ error: SEALED_ONLY })
  })
})
