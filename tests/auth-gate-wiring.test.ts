import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  gateMessage,
  gateRequest,
  gatedPath,
  identifyConsumer,
  routeTarget
} from '../src/main/auth-gate'
import {
  PHONE_CONSUMER,
  WALL_CONSUMER,
  consumerRow,
  loadConsumerRows
} from '../src/main/consumers'
import { createBrowserCast } from '../src/main/browser-cast'
import { secretEquals } from '../src/main/mobile-http'
import { withStreamToken } from '../src/renderer/src/stream-ticket'

// V4 §4 — the LIVE gate, as opposed to Piye's pure decision modules.
//
// Those two answer "what is this route" and "may this consumer have it". This
// file covers the wiring that stands between them and a socket: which
// credential was presented, which door it arrived at, and what the caller is
// told. Probe's eval (scratchpad/v4-auth-eval.mjs) is the same matrix over a
// running app; these are the parts that can be pinned without one.

const PAIRING = 'pairing-token-123'
const WALL = 'wall-token-456'
const TOKENS = { pairingToken: PAIRING, wallToken: WALL }

const req = (authorization?: string): Pick<http.IncomingMessage, 'headers'> => ({
  headers: authorization ? { authorization } : {}
})

const at = (path: string): URL => new URL(path, 'http://lan.local')

describe('identifyConsumer — which credential is this', () => {
  it('maps the two tokens to the two generated rows', () => {
    expect(identifyConsumer(req(`Bearer ${PAIRING}`), at('/api/state'), TOKENS)).toEqual({
      name: 'phone',
      consumer: PHONE_CONSUMER
    })
    expect(identifyConsumer(req(`Bearer ${WALL}`), at('/api/state'), TOKENS)).toEqual({
      name: 'wall',
      consumer: WALL_CONSUMER
    })
  })

  it('accepts a query token — EventSource and WebSocket cannot set headers', () => {
    expect(identifyConsumer(req(), at(`/api/events?token=${PAIRING}`), TOKENS)?.name).toBe('phone')
  })

  it('knows nobody else, whatever they present', () => {
    expect(identifyConsumer(req(), at('/api/state'), TOKENS)).toBeNull()
    expect(identifyConsumer(req('Bearer xxxxxxxxxxxxxxxxx'), at('/api/state'), TOKENS)).toBeNull()
    // No configured token can never be matched by a caller sending one.
    expect(identifyConsumer(req('Bearer undefined'), at('/api/state'), {})).toBeNull()
  })
})

describe('routeTarget — the workspace or agent a path names', () => {
  it('reads the id out of the manifest shapes', () => {
    expect(routeTarget('/api/workspaces/ws-1/service')).toEqual({ workspace: 'ws-1' })
    expect(routeTarget('/api/agents/a-1/dispatch')).toEqual({ agent: 'a-1' })
    expect(routeTarget('/api/terminal/t-1/turns')).toEqual({ agent: 't-1' })
    expect(routeTarget('/api/state')).toEqual({})
  })

  it('does not mistake a literal segment for an id', () => {
    // POST /api/workspaces/switch is a route, not a workspace called "switch";
    // treating it as one would refuse it for any scoped consumer.
    expect(routeTarget('/api/workspaces/switch')).toEqual({})
    expect(routeTarget('/api/workspaces/rename')).toEqual({})
  })

  it('decodes an encoded id, and survives a malformed one', () => {
    expect(routeTarget('/api/workspaces/a%20b/dirs')).toEqual({ workspace: 'a b' })
    expect(routeTarget('/api/workspaces/%E0%A4%A/dirs')).toEqual({ workspace: '%E0%A4%A' })
  })
})

describe('gateRequest — the order, over a real request', () => {
  const status = (method: string, path: string, token?: string): number =>
    gateRequest({
      method,
      url: at(path),
      request: req(token ? `Bearer ${token}` : undefined),
      tokens: TOKENS
    }).status

  it('401s an unknown caller before anything is resolved', () => {
    expect(status('GET', '/api/board')).toBe(401)
    expect(status('POST', '/api/agents/does-not-exist/dispatch')).toBe(401)
    expect(status('GET', '/api/v4-unclassified')).toBe(401)
  })

  it('403s a known caller outside its groups — never 401', () => {
    expect(status('POST', '/api/workspaces/ws-1/service', WALL)).toBe(403)
    expect(status('GET', '/api/browser/b-1/stream', WALL)).toBe(403)
    expect(status('GET', '/api/v4-unclassified', PAIRING)).toBe(403)
  })

  it('200s what each credential is actually for', () => {
    expect(status('GET', '/api/board', WALL)).toBe(200)
    expect(status('GET', '/api/auth/status')).toBe(200)
    expect(status('POST', '/api/agents/a-1/dispatch', PAIRING)).toBe(200)
    expect(status('GET', '/api/browser/b-1/stream', PAIRING)).toBe(200)
  })

  it('enforces a configured workspace scope — PATH-ADDRESSED routes only', () => {
    // Not reachable today (no third token is mintable), but the row shape is
    // the one wave 5 mints against — so the scope step has to be live, not
    // aspirational. The body-addressed case is the fail-closed test below.
    const scoped = {
      ...TOKENS,
      consumers: { wall: { groups: ['observe' as const], workspaces: ['inst-*'] } }
    }
    const call = (path: string): number =>
      gateRequest({ method: 'GET', url: at(path), request: req(`Bearer ${WALL}`), tokens: scoped })
        .status
    expect(call('/api/workspaces/inst-42/service')).toBe(403) // group, first
    expect(call('/api/board')).toBe(200)
  })

  it('fails CLOSED when a scoped consumer hits a BODY-ADDRESSED route (D2a)', () => {
    // /api/workspaces/switch names its workspace in the BODY, so routeTarget
    // resolves none — a scoped consumer must not become unconstrained there.
    const scoped = {
      ...TOKENS,
      consumers: {
        phone: { groups: ['observe' as const, 'orchestrate' as const], workspaces: ['inst-*'] }
      }
    }
    const call = (method: string, path: string): number =>
      gateRequest({ method, url: at(path), request: req(`Bearer ${PAIRING}`), tokens: scoped }).status
    expect(call('POST', '/api/workspaces/switch')).toBe(403)
    expect(call('POST', '/api/workspaces/rename')).toBe(403)
    // observe stays exempt — board/state are scoped at the serializer (Sol F7).
    expect(call('GET', '/api/board')).toBe(200)
  })
})

describe('gateMessage — enough to act on, never a map of the surface', () => {
  const message = (method: string, path: string, token?: string): string =>
    gateMessage(
      gateRequest({
        method,
        url: at(path),
        request: req(token ? `Bearer ${token}` : undefined),
        tokens: TOKENS
      })
    )

  it('tells an unknown caller to pair', () => {
    expect(message('GET', '/api/board')).toMatch(/pairing URL/i)
  })

  it('keeps the phrase the phone reads to recognise a read-only refusal', () => {
    // remote-api.ts matches /read-only/i to raise an AuthError with the right
    // scope; losing the phrase silently downgrades the re-pair screen to a
    // generic failure toast.
    expect(message('POST', '/api/workspaces/ws-1/service', WALL)).toMatch(/read-only/i)
  })

  it('never names the route it refused', () => {
    expect(message('GET', '/api/secret-internal-thing', PAIRING)).not.toContain('secret')
  })
})

describe('gatedPath — the API is gated, the bootstrap is not', () => {
  it('covers /api/* and nothing else', () => {
    expect(gatedPath('/api/state')).toBe(true)
    expect(gatedPath('/api')).toBe(true)
    expect(gatedPath('/')).toBe(false)
    expect(gatedPath('/index.html')).toBe(false)
    expect(gatedPath('/assets/index-abc123.js')).toBe(false)
    // A phone that cannot load the client can never pair, so the bundle is
    // deliberately outside the gate.
    expect(gatedPath('/apiary')).toBe(false)
  })
})

describe('consumers.json — the two tokens as rows 1 and 2', () => {
  const write = (body: string, mode = 0o600): string => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-consumers-')), 'consumers.json')
    writeFileSync(file, body, 'utf8')
    chmodSync(file, mode)
    return file
  }

  it('an absent file is exactly today two-token behaviour', () => {
    const rows = loadConsumerRows(path.join(tmpdir(), 'cookrew-no-such-consumers.json'))
    expect(rows).toEqual({})
    expect(consumerRow('phone', rows)).toEqual(PHONE_CONSUMER)
    expect(consumerRow('wall', rows)).toEqual(WALL_CONSUMER)
  })

  it('a file row REFINES the generated one', () => {
    const file = write(JSON.stringify({ wall: { groups: ['observe'], workspaces: ['tv-*'] } }))
    const rows = loadConsumerRows(file)
    expect(consumerRow('wall', rows)).toEqual({ groups: ['observe'], workspaces: ['tv-*'] })
    // Untouched rows still fall back, so tightening one consumer cannot
    // accidentally unconfigure the other.
    expect(consumerRow('phone', rows)).toEqual(PHONE_CONSUMER)
  })

  it('keeps §4 fields it does not enforce yet instead of rejecting the file', () => {
    const file = write(
      JSON.stringify({
        'ha-sous': {
          groups: ['observe', 'dispatch'],
          workspaces: ['homelab-*'],
          dispatch: 'catalog-only',
          rate: '6/h'
        }
      })
    )
    expect(loadConsumerRows(file)['ha-sous']).toEqual({
      groups: ['observe', 'dispatch'],
      workspaces: ['homelab-*']
    })
  })

  it('IGNORES a group/world-readable file — that is not a credential store', () => {
    const file = write(JSON.stringify({ wall: { groups: ['admin'] } }), 0o644)
    // Falling back to the generated rows means a loose file cannot WIDEN
    // anyone's scope; it also cannot lock the owner out.
    expect(loadConsumerRows(file)).toEqual({})
  })

  it('ignores a malformed or wrong-shaped file rather than failing open or dead', () => {
    expect(loadConsumerRows(write('{not json'))).toEqual({})
    expect(loadConsumerRows(write(JSON.stringify({ wall: { groups: ['telepathy'] } })))).toEqual({})
    expect(loadConsumerRows(write(JSON.stringify({ wall: 'admin' })))).toEqual({})
  })

  it('a row nobody can present is inert — no token minting before wave 5', () => {
    const file = write(JSON.stringify({ 'cust-42': { groups: ['dispatch'], workspaces: ['inst-42'] } }))
    const rows = loadConsumerRows(file)
    // It parses, and it authenticates nothing: only the two tokens resolve.
    expect(rows['cust-42']).toBeDefined()
    expect(identifyConsumer(req('Bearer cust-42'), at('/api/state'), { ...TOKENS, consumers: rows }))
      .toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The WS door (Sol F2 of the v2 review): the upgrade used to admit anyone.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  written = ''
  destroyed = false
  write(chunk: string): boolean {
    this.written += chunk
    return true
  }
  destroy(): void {
    this.destroyed = true
  }
  once(): this {
    return this
  }
  on(): this {
    return this
  }
}

function upgradeWith(token?: string, extraHeaders: Record<string, string> = {}): FakeSocket {
  const cast = createBrowserCast({
    getInstance: async () => null,
    enabled: () => true,
    desktopToken: () => 'desktop-secret',
    authorize: (request, url) =>
      gateRequest({ method: 'GET', url, request, tokens: TOKENS })
  })
  const socket = new FakeSocket()
  const request = {
    url: '/api/browser/b-1/stream',
    headers: {
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      host: 'lan.local',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders
    }
  } as unknown as http.IncomingMessage
  cast.upgrade(request, socket as unknown as Duplex)
  return socket
}

describe('the browser stream upgrade is gated like every other route', () => {
  it('refuses an anonymous upgrade with 401 — origin alone was never a credential', () => {
    // A curl with no Origin header passed the same-origin check by default,
    // which admitted anyone on the LAN to a live page stream.
    const socket = upgradeWith()
    expect(socket.written).toContain('401')
    expect(socket.written).not.toContain('101')
    expect(socket.destroyed).toBe(true)
  })

  it('refuses a garbage credential with 401', () => {
    expect(upgradeWith('xxxxxxxxxxxxxxxxxxxx').written).toContain('401')
  })

  it('refuses the WALL token with 403 — the stream is terminal-io, not observe', () => {
    // Raw page bytes are not a curated projection: the wall renders from the
    // board, and a known token outside its groups is 403, not 401.
    const socket = upgradeWith(WALL)
    expect(socket.written).toContain('403')
    expect(socket.destroyed).toBe(true)
  })

  it('admits the pairing token', () => {
    expect(upgradeWith(PAIRING).written).toContain('101 Switching Protocols')
  })

  it('admits a query stream ticket — a WebSocket cannot send a header', () => {
    const cast = createBrowserCast({
      getInstance: async () => null,
      enabled: () => true,
      desktopToken: () => 'desktop-secret',
      authorize: (request, url) => gateRequest({ method: 'GET', url, request, tokens: TOKENS })
    })
    const socket = new FakeSocket()
    cast.upgrade(
      {
        url: `/api/browser/b-1/stream?w=800&h=600&token=${PAIRING}`,
        headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', host: 'lan.local' }
      } as unknown as http.IncomingMessage,
      socket as unknown as Duplex
    )
    expect(socket.written).toContain('101 Switching Protocols')
  })

  it('still admits the desktop’s per-process secret', () => {
    // The Electron renderer is cross-origin by construction and holds no
    // pairing token; its secret never leaves this machine.
    const cast = createBrowserCast({
      getInstance: async () => null,
      enabled: () => true,
      desktopToken: () => 'desktop-secret',
      authorize: () => ({ status: 401, reason: 'unknown-token' })
    })
    const socket = new FakeSocket()
    cast.upgrade(
      {
        url: '/api/browser/b-1/stream?desktopToken=desktop-secret',
        headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', host: 'lan.local' }
      } as unknown as http.IncomingMessage,
      socket as unknown as Duplex
    )
    expect(socket.written).toContain('101 Switching Protocols')
  })

  it('compares the desktop secret in constant time, and rejects near misses (D5)', () => {
    // The one credential that bypasses the gate entirely, on a 0.0.0.0
    // listener where the attacker sets the retry rate — `===` bails at the
    // first differing byte and hands back a prefix oracle.
    const source = readFileSync('src/main/browser-cast.ts', 'utf8')
    expect(source).toContain('secretEquals(url.searchParams.get(\'desktopToken\')')
    expect(source).not.toMatch(/desktopToken'\)\s*===/)

    const attempt = (candidate: string): string => {
      const cast = createBrowserCast({
        getInstance: async () => null,
        enabled: () => true,
        desktopToken: () => 'desktop-secret',
        authorize: () => ({ status: 401, reason: 'unknown-token' })
      })
      const socket = new FakeSocket()
      cast.upgrade(
        {
          url: `/api/browser/b-1/stream?desktopToken=${encodeURIComponent(candidate)}`,
          headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', host: 'lan.local' }
        } as unknown as http.IncomingMessage,
        socket as unknown as Duplex
      )
      return socket.written
    }
    // A shared prefix, a longer string and an empty one all refuse — and the
    // length mismatch is answered without throwing out of timingSafeEqual.
    expect(attempt('desktop-secre')).toContain('401')
    expect(attempt('desktop-secrets')).toContain('401')
    expect(attempt('')).toContain('401')
    expect(attempt('desktop-secret')).toContain('101 Switching Protocols')
  })
})

describe('secretEquals — one constant-time compare for every credential', () => {
  it('matches only an exact secret, and never throws on a length mismatch', () => {
    expect(secretEquals('abc', 'abc')).toBe(true)
    expect(secretEquals('abcd', 'abc')).toBe(false)
    expect(secretEquals('ab', 'abc')).toBe(false)
    expect(secretEquals('abd', 'abc')).toBe(false)
  })

  it('refuses absent inputs on both sides', () => {
    // An unconfigured secret must not be matchable by an empty candidate.
    expect(secretEquals(null, 'abc')).toBe(false)
    expect(secretEquals(undefined, 'abc')).toBe(false)
    expect(secretEquals('', 'abc')).toBe(false)
    expect(secretEquals('abc', '')).toBe(false)
  })
})

describe('stream tickets — the credential for header-less URLs', () => {
  it('appends to whatever query the URL already has', () => {
    expect(withStreamToken('/api/events', 't')).toBe('/api/events?token=t')
    expect(withStreamToken('/api/browser/b/thumb?f=3', 't')).toBe('/api/browser/b/thumb?f=3&token=t')
    expect(withStreamToken('wss://h/api/browser/b/stream?w=1', 't')).toBe(
      'wss://h/api/browser/b/stream?w=1&token=t'
    )
  })

  it('appends NOTHING without a token — a desktop must not grow an empty one', () => {
    expect(withStreamToken('/api/events', null)).toBe('/api/events')
    expect(withStreamToken('/api/events', undefined)).toBe('/api/events')
    expect(withStreamToken('/api/events', '')).toBe('/api/events')
  })

  it('escapes the token and keeps a fragment last', () => {
    expect(withStreamToken('/api/events', 'a b&c')).toBe('/api/events?token=a%20b%26c')
    expect(withStreamToken('/api/events#tail', 't')).toBe('/api/events?token=t#tail')
  })
})
