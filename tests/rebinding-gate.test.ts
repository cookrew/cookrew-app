import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  bareHost,
  hostVerdict,
  refuseMisdirected,
  refuseMisdirectedUpgrade,
  relayedRequest
} from '../src/main/host-gate'
import { companionHostsOf, LOOPBACK_HOSTS } from '../src/main/companion-hosts'
import type { MobileEndpoint } from '../src/main/mobile-endpoints'

/**
 * WHAT A REBINDING ATTACKER SENDS, AND WHAT HAPPENS.
 *
 * The attack, in four steps: a page on `evil.example` is loaded from the
 * internet; its DNS answer is re-pointed at `192.168.2.40`, this Mac; the
 * browser reconnects to the SAME origin, so same-origin policy is satisfied
 * and CORS is never consulted; the script now reads whatever the Mac answers.
 * The only field that still tells the truth is `Host`, because the browser
 * writes the name IT thinks it dialled — `evil.example`, never ours.
 *
 * Transmission (CVE-2018-5702) shipped this hole and fixed it with exactly
 * this allow-list; the MCP inspector (CVE-2025-49596) needed authentication
 * PLUS Host and Origin validation. Docker's gateway shipped it in the
 * event-stream path specifically, which is why the streams are tested
 * separately in tests/stream-rebinding.test.ts.
 */

const MAC = '3f2b9c14-7a55-4d2e-9d0f-1c8e6b4a7f30'
const LAN = '192.168.2.40'
const NAMED = `192-168-2-40.${MAC}.d.cookrew.dev`
const TAILNET = 'fd7a:115c:a1e0::1234'
const ALLOWED = [LAN, NAMED, TAILNET, ...LOOPBACK_HOSTS]

const check = (host: string | string[] | undefined, relayed = false): ReturnType<typeof hostVerdict> =>
  hostVerdict({ host, relayed, allowed: ALLOWED })

describe('the rebinding attacker', () => {
  it('is refused 421 with one sentence that echoes nothing back', () => {
    const verdict = check('evil.example')
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.status).toBe(421)
    expect(verdict.message).toMatch(/does not answer for that Host/)
    // The body is read by the attacker too: it must not reflect what was asked.
    expect(verdict.message).not.toContain('evil')
  })

  it('is refused whichever of our names it decorates', () => {
    for (const host of [
      `${LAN}.evil.example`, // our address as a prefix label
      `evil.example.${LAN}.nip.io`, // ours in the middle
      `x${NAMED}`, // one character off the trusted name
      `${NAMED}.attacker.example`, // the zone as a suffix — the endsWith() bug
      'd.cookrew.dev.attacker.example',
      'cookrew.dev',
      'notcookrew.dev'
    ]) {
      expect(check(host).ok, host).toBe(false)
    }
  })

  it('gains nothing by pointing the name at us on a different port', () => {
    // The port is not identity: the connection already proves which listener
    // answered, and an attacker picks the NAME, never the socket.
    expect(check('evil.example:8643').ok).toBe(false)
    expect(check('evil.example:80').ok).toBe(false)
  })

  it('cannot smuggle a second Host past the gate', () => {
    const verdict = check([LAN, 'evil.example'])
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.status).toBe(400)
  })

  it('cannot dress a hostname up as something a parser reads two ways', () => {
    for (const host of [
      `evil.example@${LAN}`, // userinfo — a URL parser and a header reader disagree
      `${LAN} evil.example`,
      `${LAN}\r\nX-Injected: 1`,
      `${LAN}:notaport`,
      `${LAN}:99999`,
      '[not:an:address',
      `${'a'.repeat(300)}.example`
    ]) {
      const verdict = check(host)
      expect(verdict.ok, host).toBe(false)
      if (!verdict.ok) expect(verdict.status, host).toBe(400)
    }
  })

  it('is refused on an absent Host, as 400 rather than 421', () => {
    for (const host of [undefined, '', '   ']) {
      const verdict = check(host)
      expect(verdict.ok).toBe(false)
      // HTTP/1.1 requires the field: this request is malformed, not misdirected.
      if (!verdict.ok) expect(verdict.status).toBe(400)
    }
  })
})

describe('the hosts this Mac genuinely answers for', () => {
  it('accepts its own addresses, with and without a port', () => {
    for (const host of [LAN, `${LAN}:8643`, `${LAN}:8639`, NAMED, `${NAMED}:8643`]) {
      expect(check(host).ok, host).toBe(true)
    }
  })

  it('accepts the same name however a resolver or a browser spells it', () => {
    expect(check(`${LAN}.`).ok).toBe(true) // trailing root dot
    expect(check(NAMED.toUpperCase()).ok).toBe(true) // Host is case-insensitive
    expect(check(`${NAMED.toUpperCase()}.:8643`).ok).toBe(true)
  })

  it('accepts an IPv6 literal in the bracketed form a browser sends', () => {
    expect(check(`[${TAILNET}]`).ok).toBe(true)
    expect(check(`[${TAILNET}]:8643`).ok).toBe(true)
    expect(check(TAILNET).ok).toBe(false) // unbracketed, that is not one authority
  })

  it('accepts loopback, which is the desktop, the CLI and the bridge', () => {
    for (const host of ['localhost', 'localhost:8639', '127.0.0.1:8643', '[::1]:8639']) {
      expect(check(host).ok, host).toBe(true)
    }
  })

  it('refuses everything when the allowed set is empty rather than falling open', () => {
    expect(hostVerdict({ host: LAN, relayed: false, allowed: [] }).ok).toBe(false)
  })
})

describe('the relay bridge, whose hop is ours', () => {
  const relayRequest = (headers: Record<string, string>, remoteAddress: string): http.IncomingMessage =>
    ({ headers, socket: { remoteAddress } }) as unknown as http.IncomingMessage

  it('is exempt: the bridge writes the Host, dialling 127.0.0.1 in this process', () => {
    // canvas-bridge rewrites Host to its own loopback authority, so what
    // arrives is the BRIDGE's opinion and not the caller's.
    expect(hostVerdict({ host: 'some.registry.host', relayed: true, allowed: ALLOWED }).ok).toBe(true)
  })

  it('needs BOTH halves of the proof — the marker and a loopback peer', () => {
    expect(relayedRequest(relayRequest({ 'x-cookrew-relay': '1' }, '127.0.0.1'))).toBe(true)
    expect(relayedRequest(relayRequest({ 'x-cookrew-relay': '1' }, '::ffff:127.0.0.1'))).toBe(true)
    // A LAN client that types the header is not the bridge.
    expect(relayedRequest(relayRequest({ 'x-cookrew-relay': '1' }, '192.168.2.77'))).toBe(false)
    expect(relayedRequest(relayRequest({}, '127.0.0.1'))).toBe(false)
  })

  it('refuses a forged marker from a LAN peer at the gate itself', () => {
    const response = fakeResponse()
    const refused = refuseMisdirected(
      relayRequest({ host: 'evil.example', 'x-cookrew-relay': '1' }, '192.168.2.77'),
      response.value,
      ALLOWED
    )
    expect(refused).toBe(true)
    expect(response.status).toBe(421)
  })
})

describe('the allow-list is the endpoint list, never a second opinion', () => {
  const endpoint = (over: Partial<MobileEndpoint>): MobileEndpoint =>
    ({ url: `https://${LAN}:8643/?token=secret`, kind: 'lan', host: LAN, label: '', ...over }) as MobileEndpoint

  it('holds both spellings of each listener and always the loopback literals', () => {
    const hosts = companionHostsOf([
      endpoint({ trustedUrl: `https://${NAMED}:8643/?token=secret` }),
      endpoint({ url: `https://[${TAILNET}]:8643/`, host: TAILNET, kind: 'tailscale' })
    ])
    expect(hosts).toContain(LAN)
    expect(hosts).toContain(NAMED)
    expect(hosts).toContain(TAILNET) // unbracketed, as bareHost() will compare it
    for (const loopback of LOOPBACK_HOSTS) expect(hosts).toContain(loopback)
  })

  it('carries no token, no port and no scheme into the comparison', () => {
    for (const host of companionHostsOf([endpoint({ trustedUrl: `https://${NAMED}:8643/?token=secret` })])) {
      expect(host).not.toContain('token')
      expect(host).not.toContain(':8643')
      expect(host).not.toContain('/')
    }
  })

  it('is empty of everything else — a name nobody advertised is not answered for', () => {
    const hosts = companionHostsOf([endpoint({})])
    expect(hosts).not.toContain('cookrew.dev')
    expect(hosts.length).toBe(LOOPBACK_HOSTS.length + 1)
  })
})

describe('what the refused caller actually receives', () => {
  it('gets a plain-text 421 that no cache may hand to another origin', () => {
    const response = fakeResponse()
    const refused = refuseMisdirected(
      { headers: { host: 'evil.example' }, socket: {} } as unknown as http.IncomingMessage,
      response.value,
      ALLOWED
    )
    expect(refused).toBe(true)
    expect(response.status).toBe(421)
    expect(response.headers['content-type']).toMatch(/text\/plain/)
    expect(response.headers.vary).toBe('origin')
    expect(response.body).toMatch(/refused/)
    // Nothing a script can read cross-origin: no allow-origin on a refusal.
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('leaves an allowed request completely untouched', () => {
    const response = fakeResponse()
    const refused = refuseMisdirected(
      { headers: { host: `${LAN}:8643` }, socket: {} } as unknown as http.IncomingMessage,
      response.value,
      ALLOWED
    )
    expect(refused).toBe(false)
    expect(response.status).toBe(0)
  })

  it('closes a misdirected WebSocket handshake before it is ever accepted', () => {
    const written: string[] = []
    let destroyed = false
    const socket = {
      write: (chunk: string) => written.push(chunk),
      destroy: () => {
        destroyed = true
      }
    } as unknown as Duplex
    const refused = refuseMisdirectedUpgrade(
      { headers: { host: 'evil.example' }, socket: {} } as unknown as http.IncomingMessage,
      socket,
      ALLOWED
    )
    expect(refused).toBe(true)
    expect(destroyed).toBe(true)
    expect(written.join('')).toMatch(/^HTTP\/1\.1 421 Misdirected Request/)
    // Never a 101: the handshake must not complete before the check.
    expect(written.join('')).not.toContain('101')
  })
})

describe('bareHost, the one place a Host is parsed', () => {
  it('reduces an authority to the name a resolver would compare', () => {
    expect(bareHost('192.168.2.40:8643')).toBe('192.168.2.40')
    expect(bareHost('LOCALHOST.')).toBe('localhost')
    expect(bareHost('[fd7a::1]:8643')).toBe('fd7a::1')
    expect(bareHost('[fd7a::1]')).toBe('fd7a::1')
  })

  it('returns null for anything that is not exactly one host', () => {
    for (const value of ['', '   ', 'a b', 'a@b', 'a:b', '[]', '[fd7a::1]x']) {
      expect(bareHost(value), value).toBeNull()
    }
  })
})

/** A ServerResponse with only the surface the gate touches. */
function fakeResponse(): {
  value: http.ServerResponse
  status: number
  headers: Record<string, string>
  body: string
} {
  const state = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    value: null as unknown as http.ServerResponse
  }
  state.value = {
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status
      state.headers = headers
      return this
    },
    end(chunk?: string) {
      state.body = chunk ?? ''
    },
    destroy() {
      /* the socket is gone; the refusal stands either way */
    }
  } as unknown as http.ServerResponse
  return state
}
