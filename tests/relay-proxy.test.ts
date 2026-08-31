import http from 'node:http'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createRelayHttp } from '../registry/src/relay-http'
import type { IdentityService } from '../registry/src/identity'
import { dialRelay } from '../src/main/relay-dial'
import { startRelayProxy, type RelayProxy } from '../src/main/relay-proxy'
import { attachDoorToRelay, type RelayResponse } from '../src/main/relay-client'
import { generateSealKeyPair } from '../src/shared/relay-seal'

/**
 * THE CALLER'S END, AS A DOOR ON LOOPBACK.
 *
 * The imported card is `orch-line.mjs`, which speaks plain HTTP to a served
 * door and knows nothing about relays. What is tested here is that it does not
 * have to: the requests it already makes, made against this proxy, come back
 * answered by a door on the other side of a relay.
 *
 * So the requests below are deliberately made with bare `http.request` rather
 * than any of our own client code — this passes only if the shape the card
 * sends is the shape the proxy takes.
 */

const NAME = '@drej/cookrew-alpha'
const alwaysDrej = {
  assert: () => ({ ok: true as const, sub: 'drej', token: 'tok' })
} as unknown as IdentityService

const shut: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of shut.splice(0)) await close()
})

async function relayServer(): Promise<{ origin: string; server: Server }> {
  const relay = createRelayHttp({ identity: alwaysDrej })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://relay.local')
    if (relay.handle(request, response, url.pathname.split('/').filter(Boolean), url)) return
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  shut.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  return { origin: `http://127.0.0.1:${port}`, server }
}

/** Everything: a relay, a door dialled into it, and the caller's proxy. */
async function wholePath(
  respond: (input: { method: string; path: string; headers: Record<string, string>; body: string }) => RelayResponse
): Promise<{ proxy: RelayProxy }> {
  const { origin } = await relayServer()
  const keys = generateSealKeyPair()
  const ticket = await (
    await fetch(`${origin}/v1/relay/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: NAME, assertion: { credentialId: 'drej' } })
    })
  ).json() as { ticket: string }

  const dial = dialRelay({ origin, ticket: ticket.ticket })
  attachDoorToRelay(dial.socket, origin, {
    slug: 'cookrew-alpha',
    seal: { privateKey: keys.privateKey, name: NAME },
    handle: async (request) => respond(request)
  })
  await dial.ready
  shut.push(() => dial.close())

  const proxy = await startRelayProxy({ relayOrigin: origin })
  proxy.serve({ name: NAME, key: keys.publicKey })
  shut.push(() => proxy.close())
  return { proxy }
}

/** Exactly what orch-line.mjs does: `/<slug><path>` against its origin. */
function ask(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: '127.0.0.1', port, path: `/${NAME}${path}`, method, headers },
      (res) => {
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (buffer += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buffer }))
      }
    )
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

async function until(what: () => boolean, why: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (what()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${why}`)
}

describe('an imported card reaches a relayed door without knowing it', () => {
  it('carries a signed-in request and its answer', async () => {
    const seen: string[] = []
    const { proxy } = await wholePath((request) => {
      seen.push(`${request.method} ${request.path} ${request.headers.authorization ?? '-'}`)
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"reply":"51"}'
      }
    })

    const answered = await ask(
      proxy.port,
      'POST',
      '/line/raw',
      { authorization: 'Bearer tok_1', 'content-type': 'application/json' },
      '{"data":"ls\\r"}'
    )

    // The door saw the card's own credential, under the door's own slug. The
    // proxy added no authority — it holds no token of its own to add.
    expect(seen).toEqual(['POST /cookrew-alpha/line/raw Bearer tok_1'])
    expect(answered.status).toBe(200)
    expect(answered.body).toBe('{"reply":"51"}')
    expect(answered.headers['content-type']).toBe('application/json')
  })

  it('carries the LINE as a stream, burst by burst', async () => {
    const pushes: ((chunk: string) => void)[] = []
    let stopped = false
    const { proxy } = await wholePath(() => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      stream: (write) => {
        pushes.push(write)
        return () => {
          stopped = true
        }
      }
    }))

    const got: string[] = []
    let status = 0
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: proxy.port,
        path: `/${NAME}/line`,
        method: 'GET',
        headers: { authorization: 'Bearer tok_1', accept: 'text/event-stream' }
      },
      (res) => {
        status = res.statusCode ?? 0
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => got.push(chunk))
      }
    )
    request.end()

    // The line opens BEFORE anything is said on it: an idle agent says nothing,
    // and a card that waited for output to believe it was connected would sit
    // dead in front of a working session.
    await until(() => pushes.length > 0, 'the door to be asked')
    await until(() => status === 200, 'the head, before any output')

    pushes[0]?.('event: hello\ndata: {"cols":100,"rows":30}\n\n')
    await until(() => got.length === 1, 'the geometry')
    pushes[0]?.('event: data\ndata: "51 passing"\n\n')
    await until(() => got.length === 2, 'a burst')
    // Each burst arrives on its own. Buffered, this would be one chunk at the
    // end, and a terminal would have become a transcript.
    expect(got[0]).toContain('cols')
    expect(got[1]).toContain('51 passing')

    // The card going away stops the door producing, all the way through.
    request.destroy()
    await until(() => stopped, 'the door to be told')
  })

  it('a door this app is not reaching is simply not there', async () => {
    const { proxy } = await wholePath(() => ({ status: 200, headers: {}, body: 'x' }))
    const answered = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        { hostname: '127.0.0.1', port: proxy.port, path: '/@ana/research/crew', method: 'GET' },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      request.on('error', reject)
      request.end()
    })
    expect(answered).toBe(404)
  })

  it('listens on loopback only', async () => {
    const { proxy } = await wholePath(() => ({ status: 200, headers: {}, body: 'x' }))
    // Not a firewall rule — an address. Asserted on the bound interface rather
    // than by probing, because a connection to 0.0.0.0 is routed to this host
    // anyway and would prove nothing either way.
    expect(proxy.address).toBe('127.0.0.1')
  })
})
