import http from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { attachDoorToRelay, type RelayResponse } from './relay-client'
import { joinRelay, type JoinRefusal } from './relay-session'
import { registryAccount } from './registry-account'
import { generateSealKeyPair } from '../shared/relay-seal'
import type { RelayDial } from './relay-dial'

/**
 * SERVING A TEAM THROUGH THE RELAY — the owner's side, end to end.
 *
 * Dial out, hold the line, list the door, answer what arrives. What arrives is
 * answered by THE SAME LISTENER that answers on the LAN: this makes a loopback
 * request to the app's own server rather than reaching into the gate.
 *
 * That is the important decision here. The gate — sign-in, the owner's lending
 * budget, the 402, the session mint, the sandbox — is long and was reviewed
 * without a relay in it. A second dispatch into it would be a second set of
 * rules that could drift from the first, and the first person to notice would
 * be someone who paid. So the relay adds no path into anything: it turns a
 * relayed request back into an ordinary HTTP request to a door that already
 * exists, and the gate never learns it happened.
 */

export interface RelayServing {
  /** The published address for a slug, or null if it is not being relayed. */
  addressFor(slug: string): { address: string; name: string } | null
  /** Start relaying this team. Idempotent per slug. */
  serve(input: ServeThroughRelay): Promise<{ ok: true; address: string; name: string } | { ok: false; reason: JoinRefusal | 'not-listed' }>
  /** Stop relaying it, and delist it. The seal key is kept. */
  withdraw(slug: string): Promise<void>
  closeAll(): void
}

export interface ServeThroughRelay {
  slug: string
  /** The team's url-safe name at the registry. Usually the slug itself. */
  team: string
  handle: string
  /** What the directory shows. Nothing here describes the owner's machine. */
  face: {
    title: string
    door: string
    agents: number
    access: 'account' | 'paid'
    priceUsd?: string
    rails: readonly ('x402' | 'stripe')[]
    /** The owner's words and the harness names — see served-face.ts. */
    summary?: string
    tags?: readonly string[]
    harnesses?: readonly string[]
  }
}

/** The door record a registration POSTs — see registry/src/doors.ts `DoorInput`. */
export type DoorRegistration = Record<string, unknown>

/**
 * THE REGISTRATION BODY, pure. Optional face words are present when given and
 * ABSENT otherwise — an empty summary or an empty list is not a face the owner
 * wrote, and the registry would refuse or show it as one.
 */
export function doorRegistration(
  input: ServeThroughRelay,
  where: { address: string; sealKey: string }
): DoorRegistration {
  const { face } = input
  return {
    handle: input.handle,
    name: input.team,
    title: face.title,
    door: face.door,
    agents: face.agents,
    address: where.address,
    transport: 'relay',
    access: face.access,
    ...(face.priceUsd !== undefined ? { priceUsd: face.priceUsd } : {}),
    rails: [...face.rails],
    sealKey: where.sealKey,
    ...(face.summary !== undefined ? { summary: face.summary } : {}),
    ...(face.tags !== undefined && face.tags.length > 0 ? { tags: [...face.tags] } : {}),
    ...(face.harnesses !== undefined && face.harnesses.length > 0
      ? { harnesses: [...face.harnesses] }
      : {})
  }
}

interface Held {
  name: string
  address: string
  handle: string
  team: string
  dial: RelayDial
  detach: () => void
  /** Set when the owner stops serving, so a redial knows not to bother. */
  withdrawn: boolean
}

/**
 * How long to wait before dialling again, growing to a minute.
 *
 * A connection can end for reasons that are nobody's fault — a proxy's idle
 * timeout, a laptop's wifi, a relay restart — and serving is an INTENT that
 * outlives all of them. What must not happen is what did happen: the dial
 * ended, nothing redialled, and the door sat listed and unreachable while its
 * owner believed it was up.
 */
const REDIAL_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]

export function createRelayServing(options: {
  /** The registry and relay, e.g. https://cookrew.dev */
  origin: string
  /** The app's own plain-HTTP listener, which already serves every door. */
  loopbackPort: () => number
  log?: (message: string) => void
}): RelayServing {
  const log = options.log ?? ((): void => undefined)
  const held = new Map<string, Held>()

  return {
    addressFor: (slug) => {
      const door = held.get(slug)
      return door ? { address: door.address, name: door.name } : null
    },

    async serve(input) {
      const existing = held.get(input.slug)
      if (existing) return { ok: true, address: existing.address, name: existing.name }

      const keys = sealKeyFor(input.slug)
      const joined = await joinRelay({
        origin: options.origin,
        handle: input.handle,
        team: input.team,
        log
      })
      if (!joined.ok) return { ok: false, reason: joined.reason }

      const address = `${new URL(options.origin).origin}/${joined.name}`
      const attach = (dial: RelayDial): (() => void) =>
        attachDoorToRelay(dial.socket, options.origin, {
          slug: input.slug,
          seal: { privateKey: keys.privateKey, name: joined.name },
          handle: (request) => askOurselves(options.loopbackPort(), request),
          log
        })
      const detach = attach(joined.dial)

      const listed = await list(options.origin, input, {
        address,
        sealKey: keys.publicKey
      })
      if (!listed) {
        // A door that is carried but not listed is a link nobody can look up.
        // Rather than serve half of it, this comes down — the owner is told,
        // and nothing is left running that they cannot see.
        detach()
        joined.dial.close()
        return { ok: false, reason: 'not-listed' }
      }

      const entry: Held = {
        name: joined.name,
        address,
        handle: input.handle,
        team: input.team,
        dial: joined.dial,
        detach,
        withdrawn: false
      }
      held.set(input.slug, entry)

      /** Dial again, and keep the door's identity and listing as they were. */
      const redial = (attempt: number): void => {
        if (entry.withdrawn || held.get(input.slug) !== entry) return
        const wait = REDIAL_MS[Math.min(attempt, REDIAL_MS.length - 1)]
        setTimeout(() => {
          if (entry.withdrawn || held.get(input.slug) !== entry) return
          void joinRelay({ origin: options.origin, handle: input.handle, team: input.team, log })
            .then((again) => {
              if (entry.withdrawn || held.get(input.slug) !== entry) {
                if (again.ok) again.dial.close()
                return
              }
              if (!again.ok) {
                log(`relay: ${joined.name} could not redial (${again.reason})`)
                redial(attempt + 1)
                return
              }
              entry.dial = again.dial
              entry.detach = attach(again.dial)
              again.dial.onEnded(() => redial(0))
              log(`relay: ${joined.name} is back`)
            })
            .catch(() => redial(attempt + 1))
        }, wait).unref?.()
      }
      joined.dial.onEnded((why) => {
        log(`relay: ${joined.name} dropped (${why}) — dialling again`)
        redial(0)
      })

      log(`serving ${joined.name} through ${new URL(options.origin).host}`)
      return { ok: true, address, name: joined.name }
    },

    async withdraw(slug) {
      const door = held.get(slug)
      if (!door) return
      door.withdrawn = true
      held.delete(slug)
      door.detach()
      door.dial.close()
      await delist(options.origin, door.handle, door.team).catch(() => undefined)
    },

    closeAll() {
      for (const door of held.values()) {
        door.withdrawn = true
        door.detach()
        door.dial.close()
      }
      held.clear()
    }
  }
}

/**
 * Answer a relayed request by asking our own listener, on loopback.
 *
 * `path` already carries the door's slug — relay-client prepends it, so a
 * caller cannot name a different team — and this changes nothing else about
 * the request. What comes back is what a caller on the LAN would have got.
 */
function askOurselves(
  port: number,
  request: { method: string; path: string; headers: Record<string, string>; body: string }
): Promise<RelayResponse> {
  return new Promise((resolve) => {
    const outgoing = { ...request.headers }
    delete outgoing.host
    delete outgoing.connection
    delete outgoing['content-length']
    const payload = request.body.length > 0 ? Buffer.from(request.body, 'utf8') : null

    const call = http.request(
      {
        host: '127.0.0.1',
        port,
        path: request.path,
        method: request.method,
        headers: {
          ...outgoing,
          ...(payload ? { 'content-length': String(payload.byteLength) } : {})
        }
      },
      (response) => {
        const status = response.statusCode ?? 502
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') headers[key] = value
        }
        // A STREAM stays a stream. The line is an SSE response that never ends,
        // and buffering it here would turn a live terminal into a transcript
        // delivered when the session was already over.
        if ((headers['content-type'] ?? '').includes('text/event-stream')) {
          // Paused until the relay is ready to carry it, so no burst is lost
          // between answering and being asked to start.
          response.pause()
          resolve({
            status,
            headers,
            stream: (write, done) => {
              response.setEncoding('utf8')
              response.on('data', (chunk: string) => write(chunk))
              response.on('end', () => done())
              response.resume()
              return () => response.destroy()
            }
          })
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () => resolve({ status, headers, body }))
      }
    )
    call.on('error', (error) => {
      // OUR listener, unreachable from our own machine. 502 rather than a
      // thrown error, so one bad request cannot take the relay connection
      // down with it and drop every other caller.
      resolve({ status: 502, headers: {}, body: JSON.stringify({ error: String(error) }) })
    })
    if (payload) call.write(payload)
    call.end()
  })
}

/**
 * THE DOOR'S SEAL KEY, kept.
 *
 * A caller pins this the first time they import the team. Minting a new one on
 * every restart would make every pinned caller's next call fail to verify —
 * which is exactly what a man in the middle looks like, so it would teach
 * people to ignore the one signal that matters.
 */
export function sealKeyFor(slug: string): { publicKey: string; privateKey: string } {
  const file = path.join(
    homedir(),
    '.cookrew',
    'serve-keys',
    `${slug.replace(/[^a-z0-9._-]/gi, '_').slice(0, 96) || 'unknown'}.json`
  )
  if (existsSync(file)) {
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as {
        publicKey?: string
        privateKey?: string
      }
      if (stored.publicKey && stored.privateKey) {
        return { publicKey: stored.publicKey, privateKey: stored.privateKey }
      }
    } catch {
      // Unreadable. A new key is better than no door, and the cost is that
      // callers who pinned the old one must import again — which they will be
      // told about, because their call will refuse rather than proceed.
    }
  }
  const keys = generateSealKeyPair()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 })
  chmodSync(file, 0o600)
  return keys
}

/** A challenge from the route that will judge it. One ceremony, one place. */
async function challengeFrom(origin: string, at: string): Promise<string | null> {
  const asked = await fetch(new URL(at, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  const offered = (await asked.json().catch(() => ({}))) as { challenge?: string }
  return offered.challenge ?? null
}

async function list(
  origin: string,
  input: ServeThroughRelay,
  where: { address: string; sealKey: string }
): Promise<boolean> {
  const account = registryAccount(origin, input.handle)
  const challenge = await challengeFrom(origin, '/v1/doors')
  if (!challenge) return false
  const registered = await fetch(new URL('/v1/doors', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assertion: account.assert(challenge),
      door: doorRegistration(input, where)
    })
  })
  return registered.ok
}

async function delist(origin: string, handle: string, team: string): Promise<void> {
  const challenge = await challengeFrom(origin, '/v1/doors')
  if (!challenge) return
  await fetch(new URL('/v1/doors', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assertion: registryAccount(origin, handle).assert(challenge),
      withdraw: team
    })
  })
}
