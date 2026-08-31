import http, { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService, identityConfigFor } from '../registry/src/identity'
import { DoorStore, type DoorRecord } from '../registry/src/doors'
import { createRelayServing } from '../src/main/relay-serving'
import { startRelayProxy } from '../src/main/relay-proxy'

/**
 * SERVE HERE, IMPORT THERE — the whole round trip, no Electron.
 *
 * An owner's app serves a team through the relay; a registry lists it under a
 * name; a caller who has only that name looks it up, pins the key it publishes
 * and talks to the team. Everything in between is the real thing: a real
 * registry, a real ceremony, a real relay, a real seal.
 *
 * The one stand-in is the app's own HTTP listener, replaced here by a server
 * that answers the same door paths — because what is under test is the relay
 * reaching it, not what the gate decides once reached.
 */

const HANDLE = 'drej'
const TEAM = 'cookrew-alpha'
const NAME = `@${HANDLE}/${TEAM}`

const shut: (() => void | Promise<void>)[] = []
const scratch: string[] = []
afterEach(async () => {
  for (const close of shut.splice(0)) await close()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  // The account this test enrolled is keyed by origin, and each run binds a
  // new port — so nothing is shared between runs and nothing needs cleaning
  // beyond the registry's own data.
})

/** A port nobody is using, resolved before the identity config needs it. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function registry(): Promise<{ origin: string; doors: DoorStore }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-serving-'))
  scratch.push(dir)
  const port = await freePort()
  const config = identityConfigFor({ port })
  if (!config.ok) throw new Error(config.reason)
  // This relay is on localhost, which a production registry would refuse to
  // list as reachable by anyone — correctly, and it is why dev has an escape.
  const doors = new DoorStore(dir, { allowPrivate: true })
  const server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir, config.config),
    doors,
    relay: true
  })
  await new Promise<void>((resolve) => server.listen(port, resolve))
  shut.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  // localhost, not 127.0.0.1: the ceremony compares the origin exactly, and
  // the two spellings of one machine are two different strings to it.
  return { origin: `http://localhost:${port}`, doors }
}

/** Stands in for the app's own listener, answering the door's paths. */
async function appListener(
  answer: (input: { method: string; path: string; headers: http.IncomingHttpHeaders }) => void
): Promise<{ port: number; push: (chunk: string) => void }> {
  let push: ((chunk: string) => void) | null = null
  const server = createServer((request, response) => {
    answer({ method: request.method ?? '', path: request.url ?? '', headers: request.headers })
    if ((request.url ?? '').endsWith('/line')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      push = (chunk) => {
        if (!response.writableEnded) response.write(chunk)
      }
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"door":"Pilot","reply":"51"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  shut.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  return {
    port: (server.address() as { port: number }).port,
    push: (chunk) => push?.(chunk)
  }
}

async function until(what: () => boolean, why: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (what()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${why}`)
}

describe('serve here, import there', () => {
  it('publishes a name a stranger can look up, and answers through it', async () => {
    const { origin } = await registry()
    const seen: string[] = []
    const app = await appListener((request) => seen.push(`${request.method} ${request.path}`))

    // ── THE OWNER SERVES ────────────────────────────────────────────────
    const serving = createRelayServing({ origin, loopbackPort: () => app.port })
    shut.push(() => serving.closeAll())
    const served = await serving.serve({
      slug: TEAM,
      team: TEAM,
      handle: HANDLE,
      face: {
        title: 'COOKREW Alpha',
        door: 'Pilot',
        agents: 3,
        access: 'paid',
        priceUsd: '2.50',
        rails: ['x402', 'stripe']
      }
    })
    expect(served).toMatchObject({ ok: true, name: NAME })
    if (!served.ok) return
    expect(served.address).toBe(`${origin}/@${HANDLE}/${TEAM}`)

    // ── THE DIRECTORY, as a stranger reads it ───────────────────────────
    const listed = (await (
      await fetch(`${origin}/v1/doors/@${HANDLE}/${TEAM}`)
    ).json()) as DoorRecord
    expect(listed.title).toBe('COOKREW Alpha')
    expect(listed.transport).toBe('relay')
    expect(listed.priceUsd).toBe('2.50')
    expect(listed.sealKey).toBeTruthy()
    // Nothing about where the owner's machine actually is.
    expect(JSON.stringify(listed)).not.toContain(String(app.port))

    // ── THE OTHER END, which knows only the name ────────────────────────
    const proxy = await startRelayProxy({})
    shut.push(() => proxy.close())
    proxy.serve({ name: NAME, key: listed.sealKey ?? '', relayOrigin: origin })

    const face = await card(proxy.port, 'GET', '/crew')
    expect(face.status).toBe(200)
    expect(face.body).toContain('Pilot')
    // The owner's listener saw an ordinary request, under the door's own slug.
    expect(seen).toEqual([`GET /${TEAM}/crew`])
  })

  it('carries the live terminal from one end to the other', async () => {
    const { origin } = await registry()
    const app = await appListener(() => undefined)
    const serving = createRelayServing({ origin, loopbackPort: () => app.port })
    shut.push(() => serving.closeAll())
    const served = await serving.serve({
      slug: TEAM,
      team: TEAM,
      handle: HANDLE,
      face: { title: 'COOKREW Alpha', door: 'Pilot', agents: 1, access: 'account', rails: [] }
    })
    expect(served.ok).toBe(true)

    const listed = (await (
      await fetch(`${origin}/v1/doors/@${HANDLE}/${TEAM}`)
    ).json()) as DoorRecord
    const proxy = await startRelayProxy({})
    shut.push(() => proxy.close())
    proxy.serve({ name: NAME, key: listed.sealKey ?? '', relayOrigin: origin })

    const got: string[] = []
    let status = 0
    const line = http.request(
      { hostname: '127.0.0.1', port: proxy.port, path: `/${NAME}/line`, method: 'GET' },
      (res) => {
        status = res.statusCode ?? 0
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => got.push(chunk))
      }
    )
    line.end()
    await until(() => status === 200, 'the line to open')

    app.push('event: hello\ndata: {"cols":100,"rows":30}\n\n')
    await until(() => got.length === 1, 'the geometry')
    app.push('event: data\ndata: "\\u001b[2m$ npm test\\u001b[0m 51 passing"\n\n')
    await until(() => got.length === 2, 'a burst')
    expect(got[1]).toContain('51 passing')
    line.destroy()
  })

  it('the seal key survives a restart, or every pinned caller would be refused', async () => {
    // A caller pins the key on import. Minting a new one each run would make
    // their next call fail to verify — which is what a man in the middle looks
    // like, so it would teach people to ignore the one signal that matters.
    const { sealKeyFor } = await import('../src/main/relay-serving')
    const slug = `test-stability-${process.pid}`
    const first = sealKeyFor(slug)
    const again = sealKeyFor(slug)
    expect(again.publicKey).toBe(first.publicKey)
    rmSync(path.join(homedir(), '.cookrew', 'serve-keys', `${slug}.json`), { force: true })
  })
})

/** A request in the shape orch-line.mjs makes them. */
function card(
  port: number,
  method: string,
  at: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: '127.0.0.1', port, path: `/${NAME}${at}`, method },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    request.on('error', reject)
    request.end()
  })
}
