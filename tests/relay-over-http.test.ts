import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createRelayHttp } from '../registry/src/relay-http'
import type { IdentityService } from '../registry/src/identity'
import { dialRelay } from '../src/main/relay-dial'
import { reachOverHttp } from '../src/main/relay-reach'
import { RelayCaller, RelayCallFailed } from '../src/main/relay-caller'
import { attachDoorToRelay, type RelayResponse } from '../src/main/relay-client'
import { generateSealKeyPair } from '../src/shared/relay-seal'

/**
 * THE RELAY OVER A REAL NETWORK.
 *
 * Everything until now was structural: sockets that were arrays, a hub with no
 * runtime. This is the same protocol over real HTTP, on a real port, with the
 * door dialling OUT the way a laptop behind a router has to — which is the only
 * arrangement that proves the design works where it will actually run.
 *
 * What is being tested is the TRANSPORT. The seal, the containment and the
 * refusals were proven in relay-sealed-call; here they only have to survive
 * being chopped into TCP segments and reassembled.
 */

const NAME = '@drej/cookrew-alpha'
const SLUG = 'cookrew-alpha'

/** An identity that says yes, so the transport is what is under test. */
const alwaysDrej = {
  assert: () => ({ ok: true as const, sub: 'drej', token: 'tok' })
} as unknown as IdentityService

interface Stood {
  origin: string
  server: Server
  close: () => Promise<void>
}

async function standUp(identity: IdentityService = alwaysDrej): Promise<Stood> {
  const relay = createRelayHttp({ identity })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://relay.local')
    const parts = url.pathname.split('/').filter(Boolean)
    if (relay.handle(request, response, parts, url)) return
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

async function ticketFor(origin: string, name: string): Promise<string> {
  const response = await fetch(`${origin}/v1/relay/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, assertion: { credentialId: 'drej' } })
  })
  const body = (await response.json()) as { ticket?: string }
  if (!body.ticket) throw new Error(`no ticket: ${response.status}`)
  return body.ticket
}

/** Wait for a condition, so a test never races the network. */
async function until(what: () => boolean, why: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const open: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

/** A door, dialled out to a relay that is really listening. */
async function serve(
  origin: string,
  respond: (input: { path: string; body: string }) => RelayResponse
): Promise<{ key: string }> {
  const keys = generateSealKeyPair()
  const ticket = await ticketFor(origin, NAME)
  const dial = dialRelay({ origin, ticket })
  const detach = attachDoorToRelay(dial.socket, origin, {
    slug: SLUG,
    seal: { privateKey: keys.privateKey, name: NAME },
    handle: async (request) => respond({ path: request.path, body: request.body })
  })
  await dial.ready
  open.push(async () => {
    detach()
    dial.close()
  })
  return { key: keys.publicKey }
}

function callerFor(origin: string, key: string): RelayCaller {
  const transport = reachOverHttp({ origin, name: NAME })
  const caller = new RelayCaller(transport, NAME, key)
  open.push(async () => caller.close())
  return caller
}

describe('a door that dialled out, reached from outside', () => {
  it('answers a request, sealed, over real HTTP', async () => {
    const relay = await standUp()
    open.push(relay.close)
    const seen: string[] = []
    const { key } = await serve(relay.origin, ({ path, body }) => {
      seen.push(`${path} ${body}`)
      return {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-cookrew-session': 'sess_9f2' },
        body: '{"reply":"51"}'
      }
    })

    const answer = await callerFor(relay.origin, key).request(
      'POST',
      '/ask',
      { authorization: 'Bearer tok_secret' },
      '{"prompt":"17 * 3"}'
    )

    // The door was handed the request under its own slug, with the caller's
    // real headers — the relay in the middle changed nothing and read nothing.
    expect(seen).toEqual([`/${SLUG}/ask {"prompt":"17 * 3"}`])
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('{"reply":"51"}')
    expect(answer.headers['x-cookrew-session']).toBe('sess_9f2')
  })

  it('carries the LINE — output arrives as it is produced, not at the end', async () => {
    const relay = await standUp()
    open.push(relay.close)
    const pushes: ((chunk: string) => void)[] = []
    let stopped = false
    const { key } = await serve(relay.origin, () => ({
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
    const line = callerFor(relay.origin, key).stream(
      'GET',
      '/line',
      {},
      (code) => {
        status = code
      },
      (chunk) => got.push(chunk)
    )

    await until(() => pushes.length > 0 && status === 200, 'the line to open')

    // Pushed one at a time, and each must arrive on its own: a relay that
    // batched would make a terminal feel like a transcript.
    pushes[0]?.('event: hello\ndata: {"cols":100,"rows":30}\n\n')
    await until(() => got.length === 1, 'the first burst')
    pushes[0]?.('event: data\ndata: "\\u001b[2m$ npm test\\u001b[0m"\n\n')
    await until(() => got.length === 2, 'the second burst')
    expect(got[1]).toContain('npm test')

    // Closing the card stops the door producing, across the network.
    line?.close()
    await until(() => stopped, 'the door to be told')
  })

  it('a door that is not there answers like a name that never existed', async () => {
    const relay = await standUp()
    open.push(relay.close)
    const stranger = generateSealKeyPair()

    await expect(
      callerFor(relay.origin, stranger.publicKey).request('GET', '/crew', {})
    ).rejects.toThrow(RelayCallFailed)
  })

  it('a ticket for someone else’s handle is refused', async () => {
    // The handle comes from the assertion. Without this, anyone could park on
    // a name and take its callers offline.
    const relay = await standUp()
    open.push(relay.close)
    const response = await fetch(`${relay.origin}/v1/relay/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '@ana/research', assertion: { credentialId: 'drej' } })
    })
    expect(response.status).toBe(403)
  })

  it('a door without a ticket does not get a line', async () => {
    const relay = await standUp()
    open.push(relay.close)
    const dial = dialRelay({ origin: relay.origin, ticket: 'not-a-ticket' })
    await expect(dial.ready).rejects.toThrow(/refused the door/)
    dial.close()
  })

  it('two exchanges at once do not cross', async () => {
    const relay = await standUp()
    open.push(relay.close)
    const { key } = await serve(relay.origin, ({ body }) => ({
      status: 200,
      headers: {},
      body: `echo:${body}`
    }))
    const caller = callerFor(relay.origin, key)

    const [first, second] = await Promise.all([
      caller.request('POST', '/ask', {}, 'one'),
      caller.request('POST', '/ask', {}, 'two')
    ])
    expect([first.body, second.body]).toEqual(['echo:one', 'echo:two'])
  })
})
