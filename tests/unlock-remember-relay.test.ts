// REMEMBER ON THE CONSOLE, THROUGH THE REAL RELAY: the page's own client (openSeal on cookrew-seal/2, sealedUnlockApi,
// runUnlock, the vault) against the unmodified registry, the real terminus and the Mac's real unlock door. Everything
// the registry could read is searched for the password, the remembered box and its id: none of them leaves the page
// except inside the v2 session. A plain request through the same relay shows the search finds them when they are there.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SealTerminus } from '../src/main/canvas-seal-terminus'
import { createUnlockDoor } from '../src/main/remote-unlock'
import { createRememberedUnlocks } from '../src/main/unlock-remembered'
import { carriesSealProof, sealedV2Of, sealProofHeaders } from '../src/main/seal-proof'
import { takeRelayDevice } from '../src/main/relay-device'
import { connectCodeId, newConnectCode } from '../src/shared/canvas-seal'
import { generateSealKeyPair } from '../src/shared/relay-seal'
import type { ViewerWho } from '../src/shared/remote-access'
import { USE_SOURCES_PATH } from '../src/shared/use-sources'
import { openSeal, type SealClient } from '../src/renderer/src/path/seal-client'
import { forgetRemembered, prepareUnlock, runUnlock, type UnlockFlowDeps } from '../src/renderer/src/use/unlock-flow'
import { sealedUnlockApi } from '../src/renderer/src/use/unlock-sealed'
import { createUnlockVault, type VaultStore } from '../src/renderer/src/use/unlock-vault'
import { isSealPath, loopbackDialer, routeSeal, startRelayWorld, type RelayWorld } from './support/seal2-relay-world'

const PASSWORD = 'canary-mac-password-5d2e'
const BEARER = 'Bearer canary-pairing-token-unlock'
const who: ViewerWho = { key: 'root', name: 'A paired device', here: false }

const dir = mkdtempSync(path.join(tmpdir(), 'unlock-remember-relay-'))
const code = newConnectCode()
let codeId = ''
const mac = { locked: true, typed: [] as string[] }
const remembered = createRememberedUnlocks(path.join(dir, 'ids.json'), { currentCode: () => codeId })
const door = createUnlockDoor({
  keyPair: (() => {
    const pair = generateSealKeyPair()
    return () => pair
  })(),
  refusal: () => null,
  locked: async () => mac.locked,
  wake: async () => undefined,
  type: async (password) => {
    mac.typed.push(password)
    if (password === PASSWORD) mac.locked = false
  },
  record: () => undefined,
  sleep: async () => undefined,
  remembered
})

const reply = (response: import('node:http').ServerResponse, body: unknown): void => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** The companion's order (mobile-server.ts, use-source-routes.ts): the seal, then the unlock routes, sealed only. */
const companion = (terminus: () => SealTerminus | undefined): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://mac')
    if (isSealPath(url.pathname)) return void routeSeal(request, response, terminus())
    takeRelayDevice(request)
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {}
      if (!url.pathname.startsWith(`${USE_SOURCES_PATH}/unlock`)) return reply(response, { ok: true, plain: true })
      if (!carriesSealProof(request) || request.headers.authorization !== BEARER) return reply(response, { ok: false, error: 'sealed only' })
      const road = { sealedV2: sealedV2Of(request) }
      if (url.pathname === `${USE_SOURCES_PATH}/unlock/begin`) return void door.begin(who, road).then((answer) => reply(response, answer))
      if (url.pathname === `${USE_SOURCES_PATH}/unlock`) return void door.unlock(who, String(body.sealed), road).then((answer) => reply(response, answer))
      if (url.pathname === `${USE_SOURCES_PATH}/unlock/forget`) return reply(response, { ok: true, forgotten: door.forget(who, body.id, road) })
      reply(response, { ok: false, error: 'not found' })
    })
  })

let world: RelayWorld
const clients: SealClient[] = []
/** The box and id the first case kept: the control sends them in the clear and must find them. */
let canaries: { box: string; id: string } | null = null

beforeAll(async () => {
  codeId = await connectCodeId(code)
  world = await startRelayWorld(companion, (port) => ({
    codeFor: (asked) => (asked === codeId ? code : null),
    // As index.ts dials: the terminus's own proof on every request it hands on.
    dial: loopbackDialer(port, undefined, sealProofHeaders())
  }))
})

afterAll(async () => {
  for (const client of clients) client.close()
  await world?.close()
  rmSync(dir, { recursive: true, force: true })
})

const memory = (): VaultStore => {
  const rows = new Map<string, unknown>()
  return { get: async (k) => rows.get(k), set: async (k, v) => void rows.set(k, v), del: async (k) => void rows.delete(k) }
}

/** The console page: its own session, client, api and vault, holding the Mac's code. */
async function consolePage(vault = createUnlockVault(memory())): Promise<UnlockFlowDeps> {
  const client = await openSeal({ url: (route) => `${world.prefix()}${route}`, code: Buffer.from(code).toString('base64url'), fetchFn: world.capture(world.phoneSession), retryMs: 50 })
  clients.push(client)
  return { api: sealedUnlockApi(client, () => ({ authorization: BEARER })), vault, machine: 'the-mac', codeId }
}

const mark = (): [number, number] => [world.lines.length, world.exchanges.length]

describe('Remember on the console through the real relay', () => {
  it('remembers over v2, unlocks with the box, forgets on both ends, and the relay reads no password, box or id', async () => {
    const [from, fromExchange] = mark()
    const vault = createUnlockVault(memory())
    const page = await consolePage(vault)
    expect(page.api.sealedV2).toBe(true)
    const shown = await prepareUnlock(page)
    expect(shown).toMatchObject({ kind: 'ready', rememberable: true })
    if (shown.kind !== 'ready') throw new Error('not ready')
    expect(await runUnlock(page, { shownKey: shown.key, password: PASSWORD, remember: true })).toEqual({ kind: 'done' })
    const kept = await vault.boxFor('the-mac', codeId)
    expect(kept).not.toBeNull()
    canaries = kept
    mac.locked = true
    expect(await runUnlock(page, { shownKey: shown.key, password: null, remember: false })).toEqual({ kind: 'done' })
    expect(mac.typed).toEqual([PASSWORD, PASSWORD])
    await forgetRemembered(page)
    expect(remembered.live(kept?.id ?? '', who.key)).toBe(false)
    const read = world.relayCouldRead(from, fromExchange)
    for (const canary of [PASSWORD, kept?.box ?? 'no-box', kept?.box.split('.')[1] ?? 'no-box', kept?.id ?? 'no-id', 'canary-pairing-token']) expect(read, canary).not.toContain(canary)
  })

  it('the control: the same canaries sent in the clear through the same relay are found, password, box and id', async () => {
    expect(canaries).not.toBeNull()
    const [from, fromExchange] = mark()
    await world.capture(world.phoneSession)(`${world.prefix()}/api/plain`, { method: 'POST', headers: { authorization: BEARER }, body: JSON.stringify({ p: PASSWORD, b: canaries?.box, r: canaries?.id }) })
    const read = world.relayCouldRead(from, fromExchange)
    for (const canary of [PASSWORD, canaries?.box ?? '', canaries?.box.split('.')[1] ?? '', canaries?.id ?? '', 'canary-pairing-token']) expect(read, canary).toContain(canary)
  })
})
