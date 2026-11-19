// PATH REPORTS, THROUGH THE REAL ROAD: the unmodified registry on loopback, a
// real held line and canvas bridge, the real seal terminus, and the Mac's own
// request handler — mobile-server.ts · handle(), with nothing in front of it,
// on a random loopback port. The terminus dials it as index.ts does (with the
// seal's proof), and the bridge as index.ts does (with the line's proof).
//
// A report names the Mac's LAN and tailnet addresses, so (security review,
// 2026-11-19) it is filed and read only inside cookrew-seal/2, and read only by
// the owner (path-report-routes.ts). Here, end to end:
//   - the owner's v2 POST is filed and its v2 GET reads it back, and the relay
//     reads neither the canary address, the canary words nor the token —
//     through the page's own v2 client and through the console page's own
//     sender (path/report.ts · postPathReport over seal-plane · sealedFetchFor);
//   - the read-only wall token is refused, even sealed v2, and files nothing;
//   - plain over the relay, a forged seal header over the relay, a forged seal
//     header straight at the Mac on loopback, and a cookrew-seal/1 session are
//     all refused, and none of them gets a held report back;
//   - the control: what goes plain through the same relay IS found by the
//     same search, so a clean search means something.
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { handle, type MobileServerDeps } from '../src/main/mobile-server'
import type { SealTerminus } from '../src/main/canvas-seal-terminus'
import { RELAY_LINE_MARKER, SEALED_PEER_HEADER, SEALED_V2_HEADER, sealProofHeaders } from '../src/main/seal-proof'
import { SEALED_MARKER } from '../src/shared/remote-unlock'
import { connectCodeId, newConnectCode } from '../src/shared/canvas-seal'
import { RELAY_SESSION_HEADER } from '../src/shared/machine-relay'
import { PATH_REPORT_ROUTE, PATH_REPORTS_ROUTE, type PathReport } from '../src/shared/path-report'
import { openSeal, type SealClient } from '../src/renderer/src/path/seal-client'
import { SealPhone } from './support/seal-phone'
import { bareWindow } from './support/memory-storage'
import { inConsole } from './support/console-scope'
import { loopbackDialer, startRelayWorld, until, type CallerExchange, type RelayWorld } from './support/seal2-relay-world'

const OWNER = 'canary-owner-pairing-token-a7c2e9'
const WALL = 'canary-wall-token-3d9e51'
const OWNER_BEARER = `Bearer ${OWNER}`
const WALL_BEARER = `Bearer ${WALL}`

/** What a report must never show the relay: the Mac's address, and the browser's own words around it. */
const ADDRESS = '192.168.231.47'
const WORDS = 'canary-path-words-5f0b'

/** Canaries a refused request carried, which must never be filed. */
const PLAIN_WORDS = 'canary-plain-post-91c4'
const WALL_WORDS = 'canary-wall-post-77ad'
const FORGED_WORDS = 'canary-forged-post-2be0'
const LOOPBACK_WORDS = 'canary-loopback-post-c3f1'
const V1_WORDS = 'canary-v1-post-0d6a'
const PAGE_WORDS = 'canary-page-post-48e2'
const NO_SESSION_WORDS = 'canary-no-session-6a1f'

const SEALED_ONLY = 'sealed session required'

const report = (words: string): PathReport => ({
  at: 1_800_000_000_000,
  plane: 'RELAY',
  permission: 'granted',
  browser: 'Chrome 142',
  attempts: [{ name: `${ADDRESS}:8643`, outcome: 'blocked', ms: 1, detail: `${words} connect to ${ADDRESS}:8643 refused` }],
  probes: [{ kind: 'rtc', name: `${ADDRESS} closed: ${words}`, outcome: 'closed', ms: 9000 }]
})

/** Every dep handle() touches on the way to the path-report routes: the real gate, the real routes. */
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
    identity: {
      account: () => null,
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

const code = newConnectCode()
const encodedCode = Buffer.from(code).toString('base64url')
let world: RelayWorld
const clients: SealClient[] = []
const phones: SealPhone[] = []

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

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  for (const client of clients) client.close()
  for (const phone of phones) phone.hangUp()
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

const sealedPost = (client: SealClient, bearer: string, words: string) =>
  client.request({ method: 'POST', path: PATH_REPORT_ROUTE, headers: { authorization: bearer, 'content-type': 'application/json' }, body: JSON.stringify(report(words)) })

const sealedGet = (client: SealClient, bearer: string) =>
  client.request({ method: 'GET', path: PATH_REPORTS_ROUTE, headers: { authorization: bearer } })

/** What the owner reads, sealed: the measure of what was filed. */
async function held(): Promise<string> {
  const answer = await sealedGet(await sealedV2(), OWNER_BEARER)
  expect(answer.status).toBe(200)
  return text(answer.body)
}

/** A plain request through the relay, as anybody holding the account's session could send one. */
const plain = (route: string, init: RequestInit): Promise<Response> => world.capture(world.phoneSession)(`${world.prefix()}${route}`, init)

/** Seal headers a relay (or a local process) could write: none of them carries the per-launch proof. */
const forgedSealHeaders = (): Record<string, string> => ({
  [SEALED_V2_HEADER]: '1',
  [SEALED_MARKER]: randomBytes(32).toString('base64url'),
  [SEALED_PEER_HEADER]: world.macDevice.id,
  [RELAY_LINE_MARKER]: randomBytes(32).toString('base64url')
})

describe('the owner, inside cookrew-seal/2', () => {
  it('files a report and reads it back whole; the relay reads neither the address, the words nor the token', async () => {
    const at = mark()
    const client = await sealedV2()
    const posted = await sealedPost(client, OWNER_BEARER, WORDS)
    expect(posted.status).toBe(204)
    const read = await sealedGet(client, OWNER_BEARER)
    expect(read.status).toBe(200)
    const body = JSON.parse(text(read.body)) as { reports: PathReport[]; count: number }
    // Nothing redacted where it is allowed to go.
    const mine = body.reports.find((one) => one.probes?.[0]?.name === `${ADDRESS} closed: ${WORDS}`)
    expect(mine?.attempts[0]).toMatchObject({ name: `${ADDRESS}:8643`, detail: `${WORDS} connect to ${ADDRESS}:8643 refused` })

    const relay = relayRead(at)
    // The search had something to search: the session's frames crossed it.
    expect(relay.length).toBeGreaterThan(500)
    for (const canary of [ADDRESS, WORDS, OWNER, PATH_REPORT_ROUTE, PATH_REPORTS_ROUTE]) expect(relay, canary).not.toContain(canary)
  })

  it("the console page's own sender (postPathReport over sealedFetchFor) files it sealed, and the relay reads no canary on either side", async () => {
    vi.stubGlobal('window', bareWindow('https://console.cookrew.dev/'))
    // The page's side of the relay, kept as world.capture keeps the other callers'.
    const pageSaw: CallerExchange[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await realFetch(input, init)
      const sent = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(typeof init?.body === 'string' ? init.body : '')
      const record = { url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), sent, answered: Buffer.alloc(0) }
      pageSaw.push(record)
      if (answer.body === null) return answer
      const kept: Buffer[] = []
      const tee = answer.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            kept.push(Buffer.from(chunk))
            record.answered = Buffer.concat(kept)
            controller.enqueue(chunk)
          }
        })
      )
      return new Response(tee, { status: answer.status, headers: answer.headers })
    })

    const at = mark()
    vi.resetModules()
    const session = world.phoneSession[RELAY_SESSION_HEADER]
    const scope = await inConsole(world.macDevice.id, { origin: world.site.origin, session: () => session })
    const plane = await import('../src/renderer/src/path/seal-plane')
    plane.configureSealPlane({ retryMs: 40, maxRetryMs: 160, refusedMs: 400, oldMacMs: 2_000 })
    const storage = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    const codeKey = `cr_code:${world.macDevice.id}`
    storage.setItem(codeKey, encodedCode)
    const base = scope.machineBaseOf(world.macDevice.id) as string
    const { postPathReport } = await import('../src/renderer/src/path/report')

    // Before the Mac has said it speaks v2 there is no sealed sender, so the report stays on the page.
    expect(plane.sealOutcome(`${base}${PATH_REPORT_ROUTE}`)).toBe('undecided')
    await until(() => storage.getItem(`${codeKey}:seal2`) !== null, 'the v2 pin', 4000)

    await postPathReport(report(PAGE_WORDS), { url: `${base}${PATH_REPORT_ROUTE}`, headers: { authorization: OWNER_BEARER }, sealed: plane.sealedFetchFor })
    const read = await plane.sealedFetchFor(`${base}${PATH_REPORTS_ROUTE}`, { headers: { authorization: OWNER_BEARER } })
    expect(read?.status).toBe(200)
    expect(await read?.text()).toContain(PAGE_WORDS)

    const relay = [relayRead(at), ...pageSaw.flatMap((one) => [one.url, JSON.stringify(one.headers), one.sent.toString('latin1'), one.answered.toString('latin1')])].join('\n')
    expect(pageSaw.length).toBeGreaterThan(0)
    for (const canary of [ADDRESS, PAGE_WORDS, WORDS, OWNER]) expect(relay, canary).not.toContain(canary)
  })

  it('a console page holding no code sends nothing: the report stays on the page', async () => {
    vi.stubGlobal('window', bareWindow('https://console.cookrew.dev/'))
    const at = mark()
    vi.resetModules()
    const session = world.phoneSession[RELAY_SESSION_HEADER]
    const scope = await inConsole(world.macDevice.id, { origin: world.site.origin, session: () => session })
    const plane = await import('../src/renderer/src/path/seal-plane')
    const base = scope.machineBaseOf(world.macDevice.id) as string
    const { postPathReport } = await import('../src/renderer/src/path/report')
    await expect(
      postPathReport(report(NO_SESSION_WORDS), { url: `${base}${PATH_REPORT_ROUTE}`, headers: { authorization: OWNER_BEARER }, sealed: plane.sealedFetchFor })
    ).rejects.toThrow('a sealed session is required')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(relayRead(at)).not.toContain(NO_SESSION_WORDS)
    expect(await held()).not.toContain(NO_SESSION_WORDS)
  })
})

describe('the read-only wall token', () => {
  it('reads nothing, though it comes sealed v2 and a report is held', async () => {
    expect((await sealedPost(await sealedV2(), OWNER_BEARER, WORDS)).status).toBe(204)
    expect(await held()).toContain(WORDS)
    const at = mark()
    const answer = await sealedGet(await sealedV2(), WALL_BEARER)
    expect(answer.status).toBe(403)
    expect(JSON.parse(text(answer.body))).toEqual({ error: 'owner pairing required' })
    expect(text(answer.body)).not.toContain(ADDRESS)
    expect(relayRead(at)).not.toContain(ADDRESS)
  })

  it('files nothing, though it comes sealed v2', async () => {
    const answer = await sealedPost(await sealedV2(), WALL_BEARER, WALL_WORDS)
    expect(answer.status).toBeGreaterThanOrEqual(400)
    expect(await held()).not.toContain(WALL_WORDS)
  })
})

describe('every road but cookrew-seal/2 is refused', () => {
  it('plain over the relay with the owner token: the POST is not filed and the GET hands back nothing held', async () => {
    expect((await sealedPost(await sealedV2(), OWNER_BEARER, WORDS)).status).toBe(204)
    expect(await held()).toContain(WORDS)
    const at = mark()
    const got = await plain(PATH_REPORTS_ROUTE, { headers: { authorization: OWNER_BEARER } })
    expect(got.status).toBe(403)
    expect(await got.json()).toEqual({ error: SEALED_ONLY })
    const posted = await plain(PATH_REPORT_ROUTE, { method: 'POST', headers: { authorization: OWNER_BEARER, 'content-type': 'application/json' }, body: JSON.stringify(report(PLAIN_WORDS)) })
    expect(posted.status).toBe(403)
    expect(await posted.json()).toEqual({ error: SEALED_ONLY })

    const relay = relayRead(at)
    // The control: the same search finds what went plain, so its silence on the held words means something.
    expect(relay).toContain(PLAIN_WORDS)
    expect(relay).not.toContain(WORDS)
    expect(await held()).not.toContain(PLAIN_WORDS)
  })

  it('forged seal headers over the relay (v2 flag, seal proof, peer, line proof) are refused, POST and GET', async () => {
    const at = mark()
    const got = await plain(PATH_REPORTS_ROUTE, { headers: { authorization: OWNER_BEARER, ...forgedSealHeaders() } })
    expect(got.status).toBe(403)
    expect(await got.json()).toEqual({ error: SEALED_ONLY })
    const posted = await plain(PATH_REPORT_ROUTE, {
      method: 'POST',
      headers: { authorization: OWNER_BEARER, 'content-type': 'application/json', ...forgedSealHeaders() },
      body: JSON.stringify(report(FORGED_WORDS))
    })
    expect(posted.status).toBe(403)
    expect(relayRead(at)).not.toContain(WORDS)
    expect(await held()).not.toContain(FORGED_WORDS)
  })

  it('forged seal headers straight at the Mac on loopback (no relay at all) are refused, POST and GET', async () => {
    const got = await fetch(`${world.mac.origin}${PATH_REPORTS_ROUTE}`, { headers: { authorization: OWNER_BEARER, ...forgedSealHeaders() } })
    expect(got.status).toBe(403)
    const said = await got.text()
    expect(said).not.toContain(WORDS)
    expect(JSON.parse(said)).toEqual({ error: SEALED_ONLY })
    const posted = await fetch(`${world.mac.origin}${PATH_REPORT_ROUTE}`, {
      method: 'POST',
      headers: { authorization: OWNER_BEARER, 'content-type': 'application/json', ...forgedSealHeaders() },
      body: JSON.stringify(report(LOOPBACK_WORDS))
    })
    expect(posted.status).toBe(403)
    expect(await held()).not.toContain(LOOPBACK_WORDS)
  })

  it('a cookrew-seal/1 session is refused, though it is sealed and carries the owner token', async () => {
    const phone = new SealPhone(world.prefix(), code, world.phoneSession)
    phones.push(phone)
    await phone.connect()
    await phone.send(
      { kind: 'open', stream: 1, method: 'GET', path: PATH_REPORTS_ROUTE, headers: { authorization: OWNER_BEARER } },
      { kind: 'end', stream: 1 }
    )
    await until(() => phone.of(1).some((frame) => frame.kind === 'end'), 'the v1 GET answer')
    expect(phone.of(1).find((frame) => frame.kind === 'head')).toMatchObject({ status: 403 })
    expect(phone.text(1)).not.toContain(WORDS)
    expect(JSON.parse(phone.text(1))).toEqual({ error: SEALED_ONLY })

    await phone.send(
      { kind: 'open', stream: 3, method: 'POST', path: PATH_REPORT_ROUTE, headers: { authorization: OWNER_BEARER, 'content-type': 'application/json' } },
      { kind: 'data', stream: 3, data: Buffer.from(JSON.stringify(report(V1_WORDS))) },
      { kind: 'end', stream: 3 }
    )
    await until(() => phone.of(3).some((frame) => frame.kind === 'end'), 'the v1 POST answer')
    expect(phone.of(3).find((frame) => frame.kind === 'head')).toMatchObject({ status: 403 })
    expect(await held()).not.toContain(V1_WORDS)
  })
})
