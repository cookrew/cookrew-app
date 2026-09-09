import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { RelayCaller } from './relay-caller'
import { reachOverHttp } from './relay-reach'

/**
 * THE CALLER'S END OF THE RELAY, as a door on loopback.
 *
 * An imported card is a terminal running `orch-line.mjs`, and that script
 * already knows how to speak to a served door over HTTP: sign in, hold the
 * line, type. Teaching it the relay would mean a second copy of the seal in
 * plain .mjs, and two copies of a cipher is how one of them quietly stops
 * matching the other. So the card is left exactly as it is, and the relay is
 * put behind an address it already understands.
 *
 * IT ADDS NO AUTHORITY, which is the whole reason it may sit unauthenticated
 * on loopback. It holds no token and no private key: every request carries the
 * card's OWN Authorization, minted by the card's own ed25519 key in a file only
 * this user can read, and the door decides. A local process that found this
 * port would gain nothing it could not already get by reaching cookrew.dev
 * directly — the door is public; being admitted is not.
 *
 * The plaintext leg is loopback only. Everything that leaves the machine is
 * sealed, by the same code the app uses everywhere else.
 */

export interface ProxiedDoor {
  /** The published name, `@handle/team`. */
  name: string
  /** The door's seal key, as published in its registry record. */
  key: string
  /**
   * WHICH RELAY CARRIES IT — per door, not per proxy.
   *
   * A caller can hold cards from more than one registry at once, and one
   * listener per registry would mean several processes competing to write the
   * single file a card reads its port from. The door knows where it is; this
   * does not have to.
   */
  relayOrigin: string
}

export interface RelayProxy {
  /** Assigned when the listener binds; 0 before that. */
  port: number
  /** The interface it bound. Loopback, and asserted rather than assumed. */
  address: string
  /** Reach this door through the proxy. Idempotent; a changed key replaces. */
  serve(door: ProxiedDoor): void
  /** Stop reaching it, and drop any exchange still open. */
  withdraw(name: string): void
  close(): void
}

/**
 * Where a card finds this proxy.
 *
 * The port cannot go in the card's stored command: it changes every time the
 * app restarts, and a command that pins one is a card that silently stops
 * working the next morning. The card resolves the port at run time instead,
 * and a missing file means Cookrew is not running — which is the truth, and a
 * better thing to say than a connection refused.
 */
export function proxyPortFile(): string {
  return path.join(homedir(), '.cookrew', 'relay-proxy.json')
}

/** Headers that describe the hop, not the request. Never forwarded. */
const HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length'
])

export function startRelayProxy(
  options: {
    log?: (message: string) => void
    /**
     * Look a door up the first time a card asks for it.
     *
     * WITHOUT THIS, only doors imported during THIS run would work: a card
     * placed yesterday would start, find the proxy reaching nothing, and read
     * as a team that had gone away. The card is durable, so resolution has to
     * be too.
     */
    resolve?: (name: string) => Promise<ProxiedDoor | null>
  } = {}
): Promise<RelayProxy> {
  const log = options.log ?? ((): void => undefined)
  const doors = new Map<string, { key: string; origin: string; caller: RelayCaller }>()
  /** Lookups in flight, so ten cards starting at once make one request. */
  const finding = new Map<string, Promise<void>>()

  const server = createServer((request, response) => {
    const asked = read(request)
    if (!asked) {
      response.writeHead(404).end()
      return
    }
    void (async () => {
      if (!doors.has(asked.name) && options.resolve) {
        let lookup = finding.get(asked.name)
        if (!lookup) {
          lookup = options
            .resolve(asked.name)
            .then((found) => {
              if (found) proxy.serve(found)
            })
            .catch(() => undefined)
            .finally(() => finding.delete(asked.name))
          finding.set(asked.name, lookup)
        }
        await lookup
      }
      const door = doors.get(asked.name)
      if (!door) {
        // A door this app is not reaching. The refusal NAMES ITSELF, because
        // the door's own 404 is a bare `{}` and a caller reading the record
        // must be able to tell "nobody is serving this" from "your session is
        // over". It still says nothing about what other doors exist.
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{"error":"not-serving"}')
        return
      }
      await carry(door.caller, asked, request, response, log)
    })()
  })

  const proxy: RelayProxy = {
    port: 0,
    address: '',
    serve: (door) => {
      const existing = doors.get(door.name)
      if (existing?.key === door.key && existing.origin === door.relayOrigin) return
      existing?.caller.close()
      doors.set(door.name, {
        key: door.key,
        origin: door.relayOrigin,
        caller: new RelayCaller(
          reachOverHttp({ origin: door.relayOrigin, name: door.name, log }),
          door.name,
          door.key
        )
      })
    },
    withdraw: (name) => {
      doors.get(name)?.caller.close()
      doors.delete(name)
    },
    close: () => {
      for (const door of doors.values()) door.caller.close()
      doors.clear()
      clearPort()
      server.close()
    }
  }

  return new Promise((settle) => {
    // LOOPBACK ONLY, stated as an address rather than a firewall rule: this
    // listener must not be reachable from the network under any configuration.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      proxy.port = typeof address === 'object' && address ? address.port : 0
      proxy.address = typeof address === 'object' && address ? address.address : ''
      writePort(proxy.port)
      log(`relay proxy on 127.0.0.1:${proxy.port}`)
      settle(proxy)
    })
  })
}

/** `/@handle/team/rest` → which door, and the path the door will answer. */
function read(request: IncomingMessage): { name: string; path: string } | null {
  const url = new URL(request.url ?? '/', 'http://proxy.local')
  const segments = url.pathname.split('/').filter((part) => part.length > 0)
  if (segments.length < 2 || !segments[0].startsWith('@')) return null
  const name = `${decodeURIComponent(segments[0])}/${decodeURIComponent(segments[1])}`
  const rest = segments.slice(2).join('/')
  return { name, path: `/${rest}${url.search}` }
}

async function carry(
  caller: RelayCaller,
  asked: { name: string; path: string },
  request: IncomingMessage,
  response: ServerResponse,
  log: (message: string) => void
): Promise<void> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (HOP.has(key) || typeof value !== 'string') continue
    headers[key] = value
  }
  const method = request.method ?? 'GET'

  // THE LINE. A stream, answered as one: the head goes out the moment it
  // arrives and every burst is written as it lands. Buffering here would turn
  // a terminal into a transcript, which is the one thing this must not do.
  if (method === 'GET' && asked.path.startsWith('/line')) {
    const line = caller.stream(
      method,
      asked.path,
      headers,
      (status, answered) => {
        response.writeHead(status, answered)
        // FLUSHED, because a line that is open and silent is still open. Node
        // holds a head until the first body byte, so without this the card
        // would sit as though it had not connected until the agent happened to
        // say something — and an idle agent says nothing.
        response.flushHeaders()
      },
      (chunk) => {
        if (!response.writableEnded) response.write(chunk)
      },
      (error) => {
        log(`relay proxy: the line to ${asked.name} ended: ${error.message}`)
        if (!response.headersSent) response.writeHead(502)
        if (!response.writableEnded) response.end()
      }
    )
    // The card going away must stop the door producing, all the way through.
    response.on('close', () => line?.close())
    return
  }

  const body = await collect(request)
  if (body === null) {
    response.writeHead(413).end()
    return
  }
  try {
    const answer = await caller.request(method, asked.path, headers, body)
    response.writeHead(answer.status, answer.headers)
    response.end(answer.body)
  } catch (error) {
    log(`relay proxy: ${method} ${asked.path} failed: ${String(error)}`)
    // 502, not 500: the failure is between here and the door, and the card's
    // refusal handling already knows what to do with a gateway that could not
    // deliver — it retries, rather than telling someone their session ended.
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(
        error instanceof Error && error.message === 'not-serving'
          ? '{"error":"not-serving"}'
          : '{"error":"relay"}'
      )
      return
    }
    response.end()
  }
}

/** A card's post is small. Anything larger is not one. */
const MAX_BODY = 256 * 1024

function collect(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      if (body.length > MAX_BODY) return
      body += chunk
      if (body.length > MAX_BODY) {
        body = ''
        resolve(null)
        request.resume()
      }
    })
    request.on('end', () => resolve(body))
    request.on('error', () => resolve(null))
  })
}

function writePort(port: number): void {
  const file = proxyPortFile()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ port }, null, 2), { mode: 0o600 })
  chmodSync(file, 0o600)
}

function clearPort(): void {
  try {
    rmSync(proxyPortFile())
  } catch {
    // Already gone, or never written. Either way there is nothing to repair.
  }
}
