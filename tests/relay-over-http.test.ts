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
  hub: { has(name: string): boolean }
  close: () => Promise<void>
}

async function standUp(
  identity: IdentityService = alwaysDrej,
  pulse: { pulseMs?: number; pulseDeadlineMs?: number } = {}
): Promise<Stood> {
  const relay = createRelayHttp({ identity, ...pulse })
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
    hub: relay.hub,
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

  it('a door that just connected stays connected', async () => {
    // The regression this exists for: the uplink's liveness was read from
    // request.on('close'), which on a streaming request fires at once — so a
    // door was un-registered the moment it arrived and reported offline while
    // holding a perfectly good line.
    const relay = await standUp()
    open.push(relay.close)
    const { key } = await serve(relay.origin, () => ({ status: 200, headers: {}, body: 'ok' }))
    expect(relay.hub.has(NAME)).toBe(true)
    // Still there a moment later, having done nothing at all.
    await new Promise((r) => setTimeout(r, 250))
    expect(relay.hub.has(NAME)).toBe(true)
    expect((await callerFor(relay.origin, key).request('GET', '/crew', {})).status).toBe(200)
  })

  it('a door that loses its uplink stops being listed as serving', async () => {
    /**
     * THE ZOMBIE. Found in production: nginx timed out the door's idle uplink,
     * and because the DOWNLINK is what claims the name, the relay went on
     * saying the door was there. It received every call and answered none —
     * which reads to a caller as the address being unreachable, and to the
     * owner as nothing at all.
     */
    const relay = await standUp()
    open.push(relay.close)
    const keys = generateSealKeyPair()
    const ticket = await ticketFor(relay.origin, NAME)
    const dial = dialRelay({ origin: relay.origin, ticket })
    attachDoorToRelay(dial.socket, relay.origin, {
      slug: SLUG,
      seal: { privateKey: keys.privateKey, name: NAME },
      handle: async () => ({ status: 200, headers: {}, body: 'ok' })
    })
    await dial.ready
    // It is up, and answering.
    expect((await callerFor(relay.origin, keys.publicKey).request('GET', '/crew', {})).status).toBe(
      200
    )

    // The uplink dies on its own — a proxy's idle timeout, not a withdrawal.
    let ended = ''
    dial.onEnded((why) => (ended = why))
    relay.server.closeAllConnections()
    await until(() => ended.length > 0, 'the dial to notice')

    // The door must no longer be claimed, so nothing can be told it is live.
    expect(relay.hub.has(NAME)).toBe(false)
  })

  it('a door that stops answering pings is dropped — sockets open or not', async () => {
    /**
     * THE THIRD ZOMBIE (2026-09-02). Through a proxy, both halves of a door
     * stayed ESTABLISHED at both ends while carrying nothing: every call hung,
     * nothing was logged anywhere. No socket event will ever say so; only a
     * missed pong can.
     */
    const relay = await standUp(alwaysDrej, { pulseMs: 40, pulseDeadlineMs: 120 })
    open.push(relay.close)
    // A door that opens its downlink and never an uplink: it hears every ping
    // and can answer none — exactly what a dead uplink looks like from here.
    const ticket = await ticketFor(relay.origin, NAME)
    let ended = false
    const res = await fetch(`${relay.origin}/v1/relay/door?ticket=${encodeURIComponent(ticket)}`)
    const reader = res.body!.getReader()
    void (async () => {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
      ended = true
    })()
    await until(() => relay.hub.has(NAME), 'the door to be claimed')
    await until(() => !relay.hub.has(NAME), 'the pulse to drop it', 2000)
    // And the door is TOLD: its downlink ends, which is what makes it redial.
    await until(() => ended, 'the downlink to end')
  })

  it('a door that answers its pings stays; one whose relay goes quiet gives up and says so', async () => {
    const relay = await standUp(alwaysDrej, { pulseMs: 40, pulseDeadlineMs: 120 })
    open.push(relay.close)
    const { key } = await serve(relay.origin, () => ({ status: 200, headers: {}, body: 'ok' }))
    // Well past the deadline, still there: the pongs are arriving.
    await new Promise((r) => setTimeout(r, 400))
    expect(relay.hub.has(NAME)).toBe(true)
    expect((await callerFor(relay.origin, key).request('GET', '/crew', {})).status).toBe(200)

    // A relay that never pings (a proxy eating the downlink) is given up on.
    const silent = await standUp(alwaysDrej, { pulseMs: 60_000 })
    open.push(silent.close)
    const dial = dialRelay({
      origin: silent.origin,
      ticket: await ticketFor(silent.origin, '@drej/quiet'),
      quietMs: 200
    })
    let why = ''
    dial.onEnded((reason) => (why = reason))
    await dial.ready
    await until(() => why.length > 0, 'the dial to give up', 2000)
    expect(why).toBe('the relay went quiet')
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
