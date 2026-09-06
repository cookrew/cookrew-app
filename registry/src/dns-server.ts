import { createSocket, type Socket } from 'node:dgram'
import { createServer, type Server, type Socket as TcpSocket } from 'node:net'
import {
  RCODE,
  TCP_MAX,
  answerWithin,
  budgetFor,
  buildAnswer,
  parseQuery
} from './dns-wire'
import type { Responder } from './dns-zone'

/**
 * AUTHORITATIVE DNS — THE TWO LISTENERS.
 *
 * UDP and TCP on ONE port, because that is what a resolver expects and what
 * the Kubernetes Service in front of this maps 53 onto. The file holds no
 * knowledge of the zone: it parses, asks the responder, builds, and counts.
 *
 * WHY THE RATE LIMIT IS SILENT. A refusal is still a packet, and a packet sent
 * to a forged source address is exactly the attack the limit exists to stop.
 * Over the budget, the query is dropped and a counter moves; nobody is told.
 *
 * WHY THE COUNTERS ARE ALL THERE IS. A query name is somebody's device id and
 * somebody's address. This process never writes one down — the operational
 * questions ("is it answering, is it being flooded") are answered by counts,
 * and the ones that would need contents are not ours to answer.
 *
 * WHY NOTHING IN HERE THROWS. Every byte arriving on these two sockets came
 * from anyone at all. A handler that can raise takes the registry's HTTP down
 * with it, so each one is wrapped and the worst outcome is silence.
 */

/** Twenty a second per source, bursting to forty: a resolver needs far less. */
const RATE_PER_SECOND = 20
const BURST = 40
/** More distinct sources than one pod sees; beyond it, idle buckets are dropped. */
const SOURCES_MAX = 4096
/** A DNS conversation over TCP is one question and one answer, then done. */
const TCP_IDLE_MS = 5000
const TCP_CONNECTIONS_MAX = 64

export interface DnsServerOptions {
  port: number
  /** The interface to bind. Tests use 127.0.0.1; the pod binds everything. */
  address?: string
  respond: Responder
  /** Lifecycle lines only — a bind, a close, a refused bind. Never a query. */
  log?: (message: string) => void
  ratePerSecond?: number
  burst?: number
  now?: () => number
}

export interface DnsCounts {
  queries: number
  answers: number
  refusedByRate: number
  malformed: number
  truncated: number
}

export interface DnsServer {
  /** Resolves with the bound port — the same one for UDP and TCP. */
  start: () => Promise<number>
  stop: () => Promise<void>
  counts: () => DnsCounts
}

/**
 * A token bucket per source address. Deliberately not a class with a timer:
 * the refill is computed from the clock when the bucket is touched, so a
 * source that never comes back costs nothing but a map entry, and the map is
 * pruned when it grows past what a real pod sees.
 */
class Buckets {
  private readonly held = new Map<string, { tokens: number; at: number }>()

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number
  ) {}

  take(source: string): boolean {
    const at = this.now()
    const held = this.held.get(source) ?? { tokens: this.burst, at }
    const tokens = Math.min(this.burst, held.tokens + ((at - held.at) / 1000) * this.rate)
    if (tokens < 1) {
      this.held.set(source, { tokens, at })
      return false
    }
    if (this.held.size > SOURCES_MAX) this.prune(at)
    this.held.set(source, { tokens: tokens - 1, at })
    return true
  }

  /** Buckets that have refilled hold no state worth the memory. */
  private prune(at: number): void {
    for (const [source, held] of this.held) {
      if (held.tokens + ((at - held.at) / 1000) * this.rate >= this.burst) this.held.delete(source)
    }
  }
}

export function createDnsServer(options: DnsServerOptions): DnsServer {
  const buckets = new Buckets(
    options.ratePerSecond ?? RATE_PER_SECOND,
    options.burst ?? BURST,
    options.now ?? Date.now
  )
  const counts: DnsCounts = { queries: 0, answers: 0, refusedByRate: 0, malformed: 0, truncated: 0 }
  const note = options.log ?? ((): void => undefined)
  let udp: Socket | null = null
  let tcp: Server | null = null
  const open = new Set<TcpSocket>()

  /**
   * One message in, one message out — or null for "say nothing at all".
   *
   * Null covers three different silences on purpose: a packet too short to
   * hold an id (there is nobody to answer), a RESPONSE arriving at our port
   * (somebody else's conversation, or a reflection being set up), and a
   * record we could not encode (a bug of ours, and a SERVFAIL storm is worse
   * than a gap).
   */
  const answerFor = (message: Uint8Array, viaTcp: boolean): Uint8Array | null => {
    const parsed = parseQuery(message)
    if (!parsed.ok) {
      counts.malformed += 1
      if (parsed.reason === 'drop' || parsed.id === null) return null
      return buildAnswer({ id: parsed.id, question: null, rcode: RCODE.FORMERR, aa: false, rd: false, edns: null })
    }
    const { query } = parsed
    counts.queries += 1
    const budget = viaTcp ? TCP_MAX : budgetFor(query.edns)
    // Only a standard query is ours. UPDATE, NOTIFY and the rest get NOTIMP,
    // which is the honest answer and the small one.
    if (query.opcode !== 0) {
      return buildAnswer({
        id: query.id,
        question: query.question,
        rcode: RCODE.NOTIMP,
        aa: false,
        rd: query.rd,
        edns: query.edns,
        opcode: query.opcode
      })
    }
    const zone = options.respond(query.question)
    const answer = answerWithin(
      {
        id: query.id,
        question: query.question,
        rcode: zone.rcode,
        aa: zone.aa,
        rd: query.rd,
        answers: zone.answers,
        authority: zone.authority,
        edns: query.edns
      },
      budget
    )
    if (answer === null) return null
    counts.answers += 1
    // The TC bit, read back off the message we are about to send: the one
    // place that knows whether the budget bit is the same one that set it.
    if ((answer[2] & 0x02) !== 0) counts.truncated += 1
    return answer
  }

  const allowed = (source: string): boolean => {
    if (buckets.take(source)) return true
    counts.refusedByRate += 1
    return false
  }

  // ── UDP ────────────────────────────────────────────────────────────────

  const onDatagram = (message: Buffer, from: { address: string; port: number }): void => {
    try {
      if (!allowed(from.address)) return
      const answer = answerFor(message, false)
      if (answer === null || udp === null) return
      udp.send(answer, from.port, from.address, () => undefined)
    } catch {
      // A datagram must never be able to end the process. There is nothing
      // useful to say about it that would not be the query itself.
      counts.malformed += 1
    }
  }

  // ── TCP ────────────────────────────────────────────────────────────────

  const onConnection = (socket: TcpSocket): void => {
    if (open.size >= TCP_CONNECTIONS_MAX) {
      socket.destroy()
      return
    }
    open.add(socket)
    const source = socket.remoteAddress ?? ''
    let held = Buffer.alloc(0)
    socket.setTimeout(TCP_IDLE_MS)
    socket.on('timeout', () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => open.delete(socket))
    socket.on('data', (chunk) => {
      try {
        held = Buffer.concat([held, chunk])
        // Two bytes of length, then that many bytes of message, repeatedly.
        for (;;) {
          if (held.length < 2) return
          const length = held.readUInt16BE(0)
          if (length === 0) {
            socket.destroy()
            return
          }
          if (held.length < 2 + length) return
          const message = held.subarray(2, 2 + length)
          held = held.subarray(2 + length)
          if (!allowed(source)) {
            socket.destroy()
            return
          }
          const answer = answerFor(message, true)
          if (answer === null) {
            socket.destroy()
            return
          }
          const framed = Buffer.alloc(2 + answer.length)
          framed.writeUInt16BE(answer.length, 0)
          framed.set(answer, 2)
          socket.write(framed)
        }
      } catch {
        counts.malformed += 1
        socket.destroy()
      }
    })
  }

  return {
    start: () =>
      new Promise<number>((resolve, reject) => {
        const address = options.address ?? '0.0.0.0'
        const socket = createSocket({ type: 'udp4', reuseAddr: true })
        socket.on('error', reject)
        socket.on('message', onDatagram)
        socket.bind(options.port, address, () => {
          udp = socket
          // BOUND FROM THE UDP PORT, not from the flag: a test asks for port 0
          // and both listeners must still be the same port, or a resolver's
          // TC retry lands somewhere else entirely.
          const bound = socket.address().port
          const server = createServer(onConnection)
          server.on('error', reject)
          server.listen(bound, address, () => {
            tcp = server
            note(`dns on ${address}:${bound} (udp+tcp)`)
            resolve(bound)
          })
        })
      }),
    stop: async () => {
      for (const socket of open) socket.destroy()
      open.clear()
      await new Promise<void>((resolve) => {
        if (tcp === null) return resolve()
        tcp.close(() => resolve())
      })
      await new Promise<void>((resolve) => {
        if (udp === null) return resolve()
        udp.close(() => resolve())
      })
      tcp = null
      udp = null
    },
    counts: () => ({ ...counts })
  }
}
