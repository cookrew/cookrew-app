import { createSocket, type Socket } from 'node:dgram'
import { createServer, type Server, type Socket as TcpSocket } from 'node:net'
import {
  RCODE,
  TCP_MAX,
  answerWithin,
  budgetFor,
  buildAnswer,
  parseQuery,
  type ParsedQuery
} from './dns-wire'
import { parseIp } from './dns-address'
import type { Responder } from './dns-zone'

/**
 * AUTHORITATIVE DNS — THE TWO LISTENERS.
 *
 * UDP and TCP on ONE port, because that is what a resolver expects and what
 * the Kubernetes Service in front of this maps 53 onto. The file holds no
 * knowledge of the zone: it parses, asks the responder, builds, and counts.
 *
 * WHY THE RATE LIMIT IS NOT QUITE SILENT. A refusal is still a packet, and a
 * packet sent to a forged source address is exactly the attack the limit
 * exists to stop — so most over-budget queries are dropped and only a counter
 * moves. Every second one, though, gets the question echoed with TC set and
 * nothing else (BIND's slip 2), because total silence is indistinguishable
 * from a dead server and would hand an attacker a way to take the zone away
 * from a chosen resolver. A TC answer is the same size as the question.
 *
 * WHAT THIS ACTUALLY AMPLIFIES, measured rather than hoped for
 * (tests/registry-dns-server.test.ts, "amplification, measured"):
 *
 *   REFUSED, out of zone or ANY   1.0×   (29 bytes in, 29 out)
 *   an address, a TXT set, NXDOMAIN 1.9–2.5×
 *   the apex SOA                  3.9×   (31 bytes in, 121 out)
 *
 * Nothing here is a reflector worth building — an open resolver is 50×, and a
 * DNSSEC-signed ANY is hundreds — but it is not 1×, and a comment that said so
 * was a reason not to look. The EDNS ceiling, the refusal of ANY and AXFR, and
 * the empty TC form are what hold the top of that range where it is.
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

/**
 * FIFTY A SECOND PER (SOURCE BLOCK, NAME, TYPE), bursting to a hundred.
 *
 * It was twenty a second per SOURCE, and both halves of that were wrong
 * together. A source address is something a UDP sender writes, so anyone could
 * spend a chosen resolver's whole budget by spelling its address on their own
 * packets — and going over meant silence, which reads as a dead server rather
 * than a busy one, so the victim's users saw an outage.
 *
 * The name and the type are in the key because they are the part an attacker
 * cannot aim at somebody else's question: flooding `d.cookrew.dev SOA` costs
 * that question its budget and leaves every Mac's own name alone. The floor is
 * higher because the key is narrower, and a real resolver asking one question
 * fifty times a second is already a broken one.
 */
const RATE_PER_SECOND = 50
const BURST = 100
/** A DNS conversation over TCP is one question and one answer, then done. */
const TCP_IDLE_MS = 5000
const TCP_CONNECTIONS_MAX = 64
/**
 * AND FOUR OF THEM PER SOURCE, AND FIVE SECONDS EACH, WHATEVER ARRIVES.
 *
 * One global cap and an inactivity timer that any byte reset meant sixty-four
 * sockets from one address — each announcing a 65535-byte message and
 * dribbling a byte a second — held TCP DNS shut for as long as the attacker
 * kept typing. Every resolver we had just told TC=1 then had nowhere to go.
 *
 * So: a cap per source, so one address can never hold more than a sixteenth of
 * the pool; an ABSOLUTE deadline from accept that a byte does not push back;
 * and a shorter one for a message that has been half-arrived too long. A real
 * resolver's whole conversation is one round trip inside a few milliseconds.
 */
const TCP_PER_SOURCE_MAX = 4
const TCP_DEADLINE_MS = 5000
const TCP_PARTIAL_MS = 1000

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
  /** The TCP limits, settable so a test can fill a pool without sixty sockets. */
  tcp?: {
    max?: number
    perSource?: number
    /** From ACCEPT, not from the last byte. */
    deadlineMs?: number
    /** How long a half-arrived message may stay half-arrived. */
    partialMs?: number
  }
}

export interface DnsCounts {
  queries: number
  answers: number
  refusedByRate: number
  malformed: number
  truncated: number
  /** TCP connections turned away at accept — pool full, or that source's share. */
  tcpRefused: number
  /** TCP connections cut off by a deadline rather than by their own FIN. */
  tcpCutOff: number
}

export interface DnsServer {
  /** Resolves with the bound port — the same one for UDP and TCP. */
  start: () => Promise<number>
  stop: () => Promise<void>
  counts: () => DnsCounts
}

/**
 * A SOURCE IS A BLOCK, NOT AN ADDRESS.
 *
 * IPv4 to its /24 and IPv6 to its /56 — the smallest allocation one operator
 * hands to one customer. Counting single addresses is counting something the
 * sender chooses: a /64 is 18 quintillion of them, and on IPv6 every packet of
 * a flood can carry a source nothing has ever seen before.
 *
 * A `::ffff:` prefix is stripped first, because a dual-stack socket reports a
 * v4 peer that way and it is the same address either way.
 */
export function sourceGroup(address: string): string {
  const ip = parseIp(address.replace(/^::ffff:/i, ''))
  if (ip === null) return address
  const keep = ip.family === 4 ? 3 : 7
  let key = ip.family === 4 ? '4' : '6'
  for (let i = 0; i < keep; i += 1) key += `.${ip.bytes[i]}`
  return key
}

/**
 * A FIXED TABLE OF TOKEN BUCKETS, indexed by a hash of the key.
 *
 * It was a Map, pruned whenever it grew past 4096 entries — and the prune
 * walked every entry, on the hot path, inside the handler for a packet anyone
 * can send. When sources arrive faster than their buckets refill (a flood, in
 * other words) the table never shrinks and the scan runs on EVERY packet:
 * measured at 125 µs each against 0.9 µs, so the flood made itself dearer the
 * longer it went on.
 *
 * So: 8192 slots, allocated once, never grown, never scanned. Two typed arrays
 * of doubles and one of counters — 200 KB, flat, for ever.
 *
 * COLLISIONS ARE THE PRICE and they are the right one. Two sources that hash
 * to the same slot share a budget, which can cost an innocent resolver some of
 * its allowance; the budget below is per (source block, name, type) and
 * generous, and a shared bucket is a bounded unfairness where an unbounded
 * table is a way to spend the whole process.
 *
 * The refill is computed from the clock when a slot is touched rather than by
 * a timer, so a slot nobody comes back to costs nothing at all.
 */
const BUCKETS = 8192

/** FNV-1a, 32-bit. Not a security hash — a spreader, and a cheap one. */
function slotFor(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) & (BUCKETS - 1)
}

/**
 * SLIP, as every rate-limiting authoritative server does it (BIND calls it
 * slip 2). Silence is indistinguishable from a dead server, and a legitimate
 * resolver whose block is being spoofed at us would simply lose the zone. So
 * every SECOND query over the budget is answered with the question echoed and
 * TC set and nothing else: a resolver reads TC and comes back over TCP, where
 * the source address is not a matter of opinion, and the packet is no bigger
 * than the one that caused it.
 */
export interface Verdict {
  ok: boolean
  /** Only meaningful when `ok` is false: answer with TC rather than say nothing. */
  slip: boolean
}

export class Buckets {
  private readonly tokens = new Float64Array(BUCKETS)
  /** When each slot was last touched. Zero means never, which refills to full. */
  private readonly stamp = new Float64Array(BUCKETS)
  /** Over-budget queries per slot, for the one-in-two slip. Wraps; only parity matters. */
  private readonly over = new Uint8Array(BUCKETS)

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number
  ) {}

  take(key: string): Verdict {
    const slot = slotFor(key)
    const at = this.now()
    // A slot never touched has stamp 0, and the refill from the epoch is
    // astronomical — which clamps to the burst, exactly as a fresh bucket should.
    const tokens = Math.min(this.burst, this.tokens[slot] + ((at - this.stamp[slot]) / 1000) * this.rate)
    this.stamp[slot] = at
    if (tokens < 1) {
      this.tokens[slot] = tokens
      this.over[slot] = (this.over[slot] + 1) & 0xff
      return { ok: false, slip: this.over[slot] % 2 === 0 }
    }
    this.tokens[slot] = tokens - 1
    return { ok: true, slip: false }
  }
}

export function createDnsServer(options: DnsServerOptions): DnsServer {
  const buckets = new Buckets(
    options.ratePerSecond ?? RATE_PER_SECOND,
    options.burst ?? BURST,
    options.now ?? Date.now
  )
  const counts: DnsCounts = {
    queries: 0,
    answers: 0,
    refusedByRate: 0,
    malformed: 0,
    truncated: 0,
    tcpRefused: 0,
    tcpCutOff: 0
  }
  const tcpMax = options.tcp?.max ?? TCP_CONNECTIONS_MAX
  const tcpPerSource = options.tcp?.perSource ?? TCP_PER_SOURCE_MAX
  const tcpDeadlineMs = options.tcp?.deadlineMs ?? TCP_DEADLINE_MS
  const tcpPartialMs = options.tcp?.partialMs ?? TCP_PARTIAL_MS
  const note = options.log ?? ((): void => undefined)
  let udp: Socket | null = null
  let tcp: Server | null = null
  const open = new Set<TcpSocket>()
  /** How many TCP connections each source group holds right now. */
  const perSource = new Map<string, number>()

  /**
   * One message in, one message out — or null for "say nothing at all".
   *
   * Null covers three different silences on purpose: a packet too short to
   * hold an id (there is nobody to answer), a RESPONSE arriving at our port
   * (somebody else's conversation, or a reflection being set up), and a
   * record we could not encode (a bug of ours, and a SERVFAIL storm is worse
   * than a gap).
   */
  const answerFor = (parsed: ParsedQuery, viaTcp: boolean): Uint8Array | null => {
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

  /**
   * THE KEY THE BUDGET IS SPENT AGAINST.
   *
   * The source BLOCK (a v4 /24, a v6 /56) and the question, which is the part
   * an attacker cannot aim at somebody else. A packet too broken to hold a
   * question shares one key per block — there is no question in it to protect.
   *
   * AND THE TRANSPORT, which matters more than it looks. A slip answer tells a
   * resolver to come back over TCP; if TCP spent the same bucket, the door we
   * had just pointed at would already be shut. UDP is the spoofable one and
   * the one this budget is for — a TCP client has proved its address by
   * completing a handshake, and is held by the connection caps above instead.
   */
  const keyFor = (group: string, parsed: ParsedQuery, viaTcp: boolean): string => {
    const transport = viaTcp ? 't' : 'u'
    return parsed.ok
      ? `${transport}|${group}|${parsed.query.question.name}|${parsed.query.question.type}`
      : `${transport}|${group}|?`
  }

  const verdictFor = (group: string, parsed: ParsedQuery, viaTcp: boolean): Verdict => {
    const verdict = buckets.take(keyFor(group, parsed, viaTcp))
    if (!verdict.ok) counts.refusedByRate += 1
    return verdict
  }

  /**
   * The query echoed with TC set and no records at all — the SLIP answer.
   *
   * Not `aa`: this says nothing about the zone, only "ask me again over TCP".
   */
  const slipFor = (parsed: ParsedQuery): Uint8Array | null => {
    if (!parsed.ok) return null
    counts.truncated += 1
    return buildAnswer({
      id: parsed.query.id,
      question: parsed.query.question,
      rcode: RCODE.NOERROR,
      aa: false,
      rd: parsed.query.rd,
      edns: parsed.query.edns,
      truncated: true
    })
  }

  // ── UDP ────────────────────────────────────────────────────────────────

  const onDatagram = (message: Buffer, from: { address: string; port: number }): void => {
    try {
      // PARSED BEFORE COUNTED, because the budget is per question now and the
      // question is inside the packet. Parsing is bounded and cannot throw.
      const parsed = parseQuery(message)
      const verdict = verdictFor(sourceGroup(from.address), parsed, false)
      const answer = verdict.ok ? answerFor(parsed, false) : verdict.slip ? slipFor(parsed) : null
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
    const source = sourceGroup(socket.remoteAddress ?? '')
    const fromHere = perSource.get(source) ?? 0
    // BOTH CAPS AT ACCEPT. The global one keeps the process's file descriptors
    // finite; the per-source one keeps one address from spending them all.
    if (open.size >= tcpMax || fromHere >= tcpPerSource) {
      counts.tcpRefused += 1
      socket.destroy()
      return
    }
    open.add(socket)
    perSource.set(source, fromHere + 1)
    let held = Buffer.alloc(0)
    let partial: ReturnType<typeof setTimeout> | null = null
    const stopPartial = (): void => {
      if (partial === null) return
      clearTimeout(partial)
      partial = null
    }
    const cutOff = (): void => {
      counts.tcpCutOff += 1
      socket.destroy()
    }
    // ABSOLUTE, from accept. `setTimeout` on the socket is an INACTIVITY timer
    // and every byte resets it, which is exactly what a dribbler sends.
    const deadline = setTimeout(cutOff, tcpDeadlineMs)
    deadline.unref?.()
    socket.setTimeout(TCP_IDLE_MS)
    socket.on('timeout', () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(deadline)
      stopPartial()
      open.delete(socket)
      const left = (perSource.get(source) ?? 1) - 1
      if (left <= 0) perSource.delete(source)
      else perSource.set(source, left)
    })
    socket.on('data', (chunk) => {
      try {
        held = Buffer.concat([held, chunk])
        // A buffer bigger than the biggest message that could be in it is not
        // a slow client, it is somebody filling our heap one write at a time.
        if (held.length > 2 + TCP_MAX) {
          cutOff()
          return
        }
        // Two bytes of length, then that many bytes of message, repeatedly.
        for (;;) {
          if (held.length < 2) break
          const length = held.readUInt16BE(0)
          if (length === 0) {
            socket.destroy()
            return
          }
          if (held.length < 2 + length) break
          const message = held.subarray(2, 2 + length)
          held = held.subarray(2 + length)
          const parsed = parseQuery(message)
          // No slip over TCP: the connection already proves the source, and a
          // client over its budget on one socket is told by the FIN.
          if (!verdictFor(source, parsed, true).ok) {
            socket.destroy()
            return
          }
          const answer = answerFor(parsed, true)
          if (answer === null) {
            socket.destroy()
            return
          }
          const framed = Buffer.alloc(2 + answer.length)
          framed.writeUInt16BE(answer.length, 0)
          framed.set(answer, 2)
          socket.write(framed)
        }
        // A message that is half here is on a clock of its own: a resolver's
        // whole conversation is one round trip, so a second is generous.
        if (held.length === 0) stopPartial()
        else if (partial === null) {
          partial = setTimeout(cutOff, tcpPartialMs)
          partial.unref?.()
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
        const address = options.address ?? '::'
        /**
         * ONE SOCKET FOR BOTH FAMILIES. `udp6` with `ipv6Only` unset is dual
         * stack: a v4 peer arrives as `::ffff:a.b.c.d` and is answered on the
         * same socket, which is what a resolver reaching us over either
         * protocol needs and what the Service in front of this hands us. A
         * literal v4 bind address — every test, and a pod that was told one —
         * still gets a v4 socket, because `udp6` cannot bind 127.0.0.1.
         *
         * AND NO reuseAddr. It bought nothing here (this port is bound once,
         * at boot, by one process) and it is how a second copy of the registry
         * binds the same UDP port silently instead of refusing loudly — two
         * processes then split the queries between them at the kernel's whim.
         */
        const socket = address.includes(':')
          ? createSocket({ type: 'udp6', ipv6Only: false })
          : createSocket({ type: 'udp4' })
        /**
         * THE BIND-TIME HANDLERS ARE REPLACED, NOT KEPT.
         *
         * `reject` belongs to a promise that has already settled by the time
         * the listener is serving; leaving it attached meant every runtime
         * socket error after start was swallowed into a resolved promise and
         * nobody was ever told. Node also treats an EventEmitter with no
         * 'error' listener as fatal, so removing them without putting
         * something back would trade silence for a dead process.
         */
        socket.on('error', reject)
        socket.on('message', onDatagram)
        socket.bind(options.port, address, () => {
          udp = socket
          socket.off('error', reject)
          socket.on('error', (error) => note(`dns: the udp socket errored (${error.message})`))
          // BOUND FROM THE UDP PORT, not from the flag: a test asks for port 0
          // and both listeners must still be the same port, or a resolver's
          // TC retry lands somewhere else entirely.
          const bound = socket.address().port
          const server = createServer(onConnection)
          server.on('error', reject)
          server.listen(bound, address, () => {
            tcp = server
            server.off('error', reject)
            server.on('error', (error) => note(`dns: the tcp listener errored (${error.message})`))
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
