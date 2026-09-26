import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createRelayHttp } from '../registry/src/relay-http'
import type { IdentityService } from '../registry/src/identity'
import { dialRelay } from '../src/main/relay-dial'
import { joinRelay } from '../src/main/relay-session'

/**
 * TWO MACS OF ONE ACCOUNT, ONE TEAM SLUG — over a real relay (V3-18).
 *
 * The failure this replaces: both Macs derive `alpha` from the same repo, the
 * second dials, the hub answers `name-taken`, and nothing anywhere says so.
 * The team saved. The door never opened. The URL the owner had handed out went
 * on answering from the other machine.
 *
 * What is proved here is the whole move over HTTP, because the pieces are only
 * correct together: the second Mac's claim replaces the first's, the FIRST is
 * told on its own line before that line ends, the caller traffic is not left
 * hanging, and a Mac that cannot say which machine it is still gets today's
 * refusal rather than somebody else's door.
 */

const NAME = '@drej/cookrew-alpha'

/** An identity that says yes for @drej — the transport is what is under test. */
const alwaysDrej = {
  challenge: () => 'ch',
  assert: () => ({ ok: true as const, sub: 'drej', token: 'tok' })
} as unknown as IdentityService

/** An identity that has never met anybody: the v1 ceremony cannot be climbed. */
const knowsNobody = {
  challenge: () => 'ch',
  assert: () => ({ ok: false as const, reason: 'unknown' })
} as unknown as IdentityService

interface Stood {
  origin: string
  moves: { handle: string; team: string; deviceId: string; by: string }[]
  hub: { has(name: string): boolean; holderOf(name: string): string | null }
}

const shut: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of shut.splice(0)) await close()
})

async function standUp(
  identity: IdentityService = alwaysDrej,
  signedInAs: string | null = null
): Promise<Stood> {
  const moves: Stood['moves'] = []
  const relay = createRelayHttp({
    identity,
    ...(signedInAs === null ? {} : { accountOf: () => signedInAs }),
    onDoorMoved: (move) => moves.push(move)
  })
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://relay.local')
    const parts = url.pathname.split('/').filter(Boolean)
    if (relay.handle(request, response, parts, url)) return
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
  return { origin: `http://127.0.0.1:${port}`, moves, hub: relay.hub }
}

/** A ticket, as a Mac that names itself asks for one. */
async function ticket(
  origin: string,
  as?: { deviceId: string; name: string }
): Promise<{ status: number; ticket?: string }> {
  const response = await fetch(`${origin}/v1/relay/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: NAME,
      assertion: { credentialId: 'drej' },
      ...(as === undefined ? {} : { as: as.name, deviceId: as.deviceId })
    })
  })
  const body = (await response.json().catch(() => ({}))) as { ticket?: string }
  return { status: response.status, ...(body.ticket === undefined ? {} : { ticket: body.ticket }) }
}

/** A door, dialled out and holding the line. */
async function dial(origin: string, as: { deviceId: string; name: string }) {
  const got = await ticket(origin, as)
  if (got.ticket === undefined) throw new Error(`no ticket (${got.status})`)
  const line = dialRelay({ origin, ticket: got.ticket })
  const superseded: string[] = []
  const ended: string[] = []
  line.onSuperseded((by) => superseded.push(by))
  line.onEnded((why) => ended.push(why))
  await line.ready
  shut.push(async () => line.close())
  return { line, superseded, ended }
}

async function until(what: () => boolean, why: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (what()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${why}`)
}

describe('the second Mac takes the door', () => {
  it('replaces the first, and the FIRST IS TOLD WHICH MACHINE TOOK IT', async () => {
    const relay = await standUp()
    const first = await dial(relay.origin, { deviceId: 'mac-1', name: 'MacBook Pro' })
    const second = await dial(relay.origin, { deviceId: 'mac-2', name: 'Mac Studio' })

    await until(() => first.superseded.length > 0, 'the first Mac to be told')
    expect(first.superseded).toEqual(['Mac Studio'])
    // And its line ended, so nothing is left believing it still serves.
    await until(() => first.ended.length > 0, 'the first line to end')
    expect(relay.hub.holderOf(NAME)).toBe('mac-2')
    expect(second.superseded).toEqual([])
  })

  it('reports the move ONCE, naming the door and both ends', async () => {
    const relay = await standUp()
    await dial(relay.origin, { deviceId: 'mac-1', name: 'MacBook Pro' })
    await dial(relay.origin, { deviceId: 'mac-2', name: 'Mac Studio' })
    await until(() => relay.moves.length > 0, 'the move to be reported')
    expect(relay.moves).toEqual([
      { handle: 'drej', team: 'cookrew-alpha', deviceId: 'mac-2', by: 'Mac Studio' }
    ])
  })

  it('says NOTHING when the same Mac reclaims its own name', async () => {
    // Its wifi came back. Nothing moved, and a card saying "alpha moved to
    // MacBook Pro" on MacBook Pro would be a lie on somebody's screen.
    const relay = await standUp()
    const first = await dial(relay.origin, { deviceId: 'mac-1', name: 'MacBook Pro' })
    await dial(relay.origin, { deviceId: 'mac-1', name: 'MacBook Pro' })
    await until(() => first.ended.length > 0, 'the old line to end')
    expect(first.superseded).toEqual([])
    expect(relay.moves).toEqual([])
    expect(relay.hub.holderOf(NAME)).toBe('mac-1')
  })

  it('serves the door from the NEW Mac afterwards', async () => {
    const relay = await standUp()
    await dial(relay.origin, { deviceId: 'mac-1', name: 'MacBook Pro' })
    await dial(relay.origin, { deviceId: 'mac-2', name: 'Mac Studio' })
    await until(() => relay.hub.holderOf(NAME) === 'mac-2', 'the name to move')
    expect(relay.hub.has(NAME)).toBe(true)
  })
})

describe('what is still refused', () => {
  it('a Mac that cannot say which machine it is — today’s refusal, unchanged', async () => {
    // Without a device id there is no way to tell a second Mac from the same
    // one reconnecting, so `name-taken` stands rather than being guessed at.
    const relay = await standUp()
    await dial(relay.origin, { deviceId: 'mac-1', name: 'MacBook Pro' })
    const anonymous = await joinRelay({ origin: relay.origin, handle: 'drej', team: 'cookrew-alpha' })
    expect(anonymous).toEqual({ ok: false, reason: 'name-taken' })
    expect(relay.hub.holderOf(NAME)).toBe('mac-1')
    expect(relay.moves).toEqual([])
  })

  it('A STRANGER — a name whose handle they cannot prove', async () => {
    // The ticket is the gate, and it was the gate before this lane: the handle
    // comes from the assertion, never from what the caller typed. Taking a door
    // over is something one ACCOUNT does to itself.
    const relay = await standUp()
    await dial(relay.origin, { deviceId: 'mac-1', name: 'MacBook Pro' })
    const refused = await fetch(`${relay.origin}/v1/relay/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '@sam/cookrew-alpha',
        assertion: { credentialId: 'drej' },
        as: 'Some Mac',
        deviceId: 'mac-9'
      })
    })
    expect(refused.status).toBe(403)
    expect(relay.hub.holderOf(NAME)).toBe('mac-1')
  })

  it('a session for somebody else’s handle', async () => {
    const relay = await standUp(knowsNobody, 'sam')
    const refused = await fetch(`${relay.origin}/v1/relay/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: NAME, as: 'Mac Studio', deviceId: 'mac-2' })
    })
    // No assertion and a session for the wrong name: the ceremony is offered,
    // not the ticket.
    expect(refused.status).toBe(401)
    expect(relay.hub.has(NAME)).toBe(false)
  })
})

describe('the second Mac can reach the relay at all', () => {
  it('serves on its account session, where the v1 key cannot be enrolled twice', async () => {
    // The v1 ceremony is the one a second Mac can never climb: it mints its own
    // key, enrols it under the same credential id as the first Mac's, and is
    // answered `credential_exists` for ever. `knowsNobody` is that registry.
    const relay = await standUp(knowsNobody, 'drej')
    const joined = await joinRelay({
      origin: relay.origin,
      handle: 'drej',
      team: 'cookrew-alpha',
      as: { deviceId: 'mac-2', name: 'Mac Studio', session: 'a-real-session' }
    })
    expect(joined.ok).toBe(true)
    if (!joined.ok) return
    shut.push(async () => joined.dial.close())
    expect(joined.name).toBe(NAME)
    expect(relay.hub.holderOf(NAME)).toBe('mac-2')
  })

  it('is refused without one, exactly as it is today', async () => {
    const relay = await standUp(knowsNobody, null)
    const joined = await joinRelay({
      origin: relay.origin,
      handle: 'drej',
      team: 'cookrew-alpha',
      as: { deviceId: 'mac-2', name: 'Mac Studio' }
    })
    expect(joined).toEqual({ ok: false, reason: 'unidentified' })
  })
})
