// A REVOKED PHONE IS REFUSED ON EVERY SURFACE IT HOLDS (V3-05, through the
// routes rather than through the pure function).
//
// The V3-05 review asked for this and V3-21 could not write it: the strict
// mode lives in a module-level `let` that only `startMobileServer` sets, so a
// test that did not bind a port could not reach the world where the root
// token has been demoted — and every revocation assertion in the lane was
// therefore against the store or the pure gate, never against a route.
//
// That was a testability defect of the same shape as the token singleton
// Conductor fixed at 6ab8c94, and it is fixed the same way: the request path
// reads the mode from the deps it was handed and falls back to the mode the
// server was started in. Never looser than the server — a caller cannot open
// the root door by omitting a field — and reachable without a listener.
//
// So: one admitted phone holding its own token, and the three ways it talks
// to this Mac — an ordinary GET, the event stream, and the browser-cast
// socket — before and after the registry's revoked list reaches the ledger.

import type http from 'node:http'
import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handle, type MobileServerDeps } from '../src/main/mobile-server'
import { createBrowserCast } from '../src/main/browser-cast'
import { companionTokenAccepted } from '../src/main/mobile-server'
import { companionAccepted } from '../src/main/companion-gate'
import { createAdmittedDeviceStore, hashToken, writeAdmittedDevices } from '../src/main/admitted-devices'
import { tempBase } from './support/idv2'

const ROOT = 'the-root-pairing-token-abcdefgh'
const PHONE = 'a1b2c3d4-1111-8222-8333-444444444444'
const PHONE_TOKEN = 'the-phones-own-per-device-token1'
const HOST = '127.0.0.1:8643'

let temp: { base: string; clean: () => void }
beforeEach(() => {
  temp = tempBase()
  // The phone as the ledger holds it: a row, and the hash of the token it
  // was handed at admission.
  writeAdmittedDevices(
    [{ deviceId: PHONE, name: 'iPhone', admittedAt: 1, lastSeenAt: 1, tokenHash: hashToken(PHONE_TOKEN) }],
    temp.base
  )
})
afterEach(() => temp.clean())

const store = () => createAdmittedDeviceStore({ base: temp.base })

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

function fakeResponse(request: http.IncomingMessage): { response: http.ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: '' }
  const set: Record<string, string> = {}
  const emitter = request as unknown as EventEmitter
  const response = {
    setHeader(name: string, value: string) {
      set[name.toLowerCase()] = value
    },
    getHeader(name: string) {
      return set[name.toLowerCase()]
    },
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.status = status
      captured.headers = { ...set, ...headers }
      return response
    },
    write(chunk: string | Buffer) {
      captured.body += chunk.toString()
      return true
    },
    end(chunk?: string | Buffer) {
      if (chunk) captured.body += chunk.toString()
      emitter.emit('close')
    },
    // The SSE route registers a close listener and a heartbeat; a response
    // that cannot be subscribed to is not a response this server can stream.
    on: () => response,
    once: () => response,
    removeListener: () => response,
    writableEnded: false,
    destroy: vi.fn()
  } as unknown as http.ServerResponse
  return { response, captured }
}

function request(url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  const made = new EventEmitter() as http.IncomingMessage
  made.method = 'GET'
  made.url = url
  made.headers = { host: HOST, ...headers }
  Object.assign(made, { socket: { remoteAddress: '192.168.2.77' } })
  return made
}

/** Every dep these routes touch, plus the mode this lane is about. */
function deps(strict: boolean): MobileServerDeps {
  return {
    multiInstance: () => false,
    // Enough for the stream's opening snapshot: the route sends the scoped
    // workspace and the list before anything else, and a dep that answers
    // undefined is a stream that dies after the gate has already let it in —
    // which would hide the thing under test behind a harness bug.
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
    pairingToken: ROOT,
    perDeviceOnly: () => strict,
    rendererDir: '/nonexistent',
    identity: {
      account: () => null,
      registryOrigin: () => 'https://cookrew.dev',
      admitted: store()
    }
  } as unknown as MobileServerDeps
}

const get = async (url: string, strict = true): Promise<Captured> => {
  const made = request(url)
  const { response, captured } = fakeResponse(made)
  await handle(made, response, deps(strict))
  return captured
}

const bearer = async (url: string, token: string, strict = true): Promise<Captured> => {
  const made = request(url, { authorization: `Bearer ${token}` })
  const { response, captured } = fakeResponse(made)
  await handle(made, response, deps(strict))
  return captured
}

describe('strict mode is reachable through handle(), without binding a port', () => {
  it('refuses the ROOT token on an ordinary route when the deps say strict', async () => {
    // The demotion, finally asserted through a route. Before this the mode
    // was a module `let` only startMobileServer could set, so this world was
    // unreachable and had zero wired coverage.
    expect((await bearer('/api/presets', ROOT, true)).status).toBe(401)
  })

  it('still serves the root where the build has not demoted it', async () => {
    expect((await bearer('/api/presets', ROOT, false)).status).toBe(200)
  })

  it('says what it decided, in its own words', async () => {
    const strict = await bearer('/api/auth/status', ROOT, true)
    expect(JSON.parse(strict.body).scope).toBe('none')
    const loose = await bearer('/api/auth/status', ROOT, false)
    expect(JSON.parse(loose.body).scope).toBe('pairing')
  })
})

describe('a per-device token opens the three surfaces, until the revoke reaches them', () => {
  it('HTTP: 200 while admitted, 401 once pruned', async () => {
    expect((await bearer('/api/presets', PHONE_TOKEN)).status).toBe(200)

    // What the /v2/keys sweep does when the registry publishes the id.
    expect(store().prune([PHONE]).map((row) => row.deviceId)).toEqual([PHONE])

    expect((await bearer('/api/presets', PHONE_TOKEN)).status).toBe(401)
  })

  it('SSE: the stream opens while admitted and is refused once pruned', async () => {
    // The event stream is an EventSource, which cannot set a header — so it
    // is the one shape that carries the token in the query, and the reason
    // the query form exists at all. `/api/admit` refuses it; this does not.
    const open = await get(`/api/events?token=${PHONE_TOKEN}`)
    expect(open.status).toBe(200)
    expect(open.headers['content-type']).toContain('text/event-stream')

    store().prune([PHONE])

    const shut = await get(`/api/events?token=${PHONE_TOKEN}`)
    expect(shut.status).toBe(401)
    expect(shut.headers['content-type'] ?? '').not.toContain('text/event-stream')
  })

  it('WS: the browser-cast upgrade is accepted while admitted and destroyed once pruned', () => {
    // Composed exactly as index.ts composes it — the gate plus the naming
    // reader — because the socket cannot call the HTTP gate and must not
    // answer the question a second way.
    const paired = (credential: string | null): boolean =>
      companionAccepted({
        route: 'other',
        presented: credential,
        rootToken: ROOT,
        perDevice: (one) => store().deviceFor(one),
        rootEverywhere: false
      })
    const cast = createBrowserCast({
      getInstance: () => Promise.resolve(null),
      enabled: () => true,
      desktopToken: () => 'a-desktop-token',
      paired
    })

    const upgrade = (): { destroyed: boolean; wrote: string } => {
      let wrote = ''
      let destroyed = false
      const socket = {
        write: (chunk: string) => {
          wrote += chunk
          return true
        },
        destroy: () => {
          destroyed = true
        },
        on: () => socket,
        destroyed: false
      } as unknown as Duplex
      cast.upgrade(
        {
          url: `/api/browser/b1/stream?w=390&h=844&token=${PHONE_TOKEN}`,
          headers: { host: HOST, 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }
        } as unknown as http.IncomingMessage,
        socket
      )
      return { destroyed, wrote }
    }

    const admittedNow = upgrade()
    expect(admittedNow.destroyed).toBe(false)
    expect(admittedNow.wrote).toContain('101 Switching Protocols')

    store().prune([PHONE])

    const afterRevoke = upgrade()
    expect(afterRevoke.destroyed).toBe(true)
    expect(afterRevoke.wrote).toBe('')
  })

  it('and the root token never stood in for it — the phone is out, not swapped', async () => {
    store().prune([PHONE])
    expect((await bearer('/api/presets', PHONE_TOKEN, true)).status).toBe(401)
    expect((await bearer('/api/presets', ROOT, true)).status).toBe(401)
    // The module-level gate the WebSocket uses answers the same way with no
    // server started: no token minted, nothing opens.
    expect(companionTokenAccepted(PHONE_TOKEN, (one) => store().deviceFor(one))).toBe(false)
  })
})
