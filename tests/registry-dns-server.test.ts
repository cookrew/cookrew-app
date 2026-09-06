import { connect } from 'node:net'
import { createSocket } from 'node:dgram'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RCODE, UDP_FLOOR } from '../registry/src/dns-wire'
import { Buckets, createDnsServer, sourceGroup, type DnsServer } from '../registry/src/dns-server'
import { createZone } from '../registry/src/dns-zone'
import { T, askTcp, askUdp, buildQuery, parseAnswer } from './support/dns-probe'

/**
 * THE TWO LISTENERS, OVER REAL SOCKETS.
 *
 * Nothing is stubbed: a UDP socket and a TCP connection on 127.0.0.1, the same
 * two paths a resolver uses. What is being proved is the behaviour a resolver
 * depends on and an attacker probes — one port for both transports, TC over
 * UDP with the full answer waiting on TCP, RA never set, and a flood answered
 * with silence rather than with a refusal packet aimed at a forged address.
 */

const ZONE = 'd.cookrew.dev'
const MAC = 'abcd1234-aaaa-bbbb-cccc-000000000001'

const cards = new Map<string, { addresses: string[]; at: number }>([
  [MAC, { addresses: ['192.168.2.40', 'fd7a:115c:a1e0::1234'], at: Date.now() }]
])
const challenges = new Map<string, string[]>()

const responder = createZone({
  zone: ZONE,
  ns: [{ host: `ns1.${ZONE}`, address: '203.0.113.10' }],
  reach: { find: (id) => cards.get(id) ?? null },
  challenges: { textsFor: (id) => challenges.get(id) ?? [] },
  changedAt: () => 1_757_000_000_000
})

let server: DnsServer
let port = 0

beforeAll(async () => {
  server = createDnsServer({ port: 0, address: '127.0.0.1', respond: responder })
  port = await server.start()
})

afterAll(async () => {
  await server.stop()
})

describe('one port, two transports', () => {
  it('answers the same question over UDP and over TCP', async () => {
    const query = buildQuery({ name: `192-168-2-40.${MAC}.${ZONE}`, type: T.A, id: 0x0abc })
    const overUdp = await askUdp(port, query)
    expect(overUdp).not.toBeNull()
    const udpRead = parseAnswer(overUdp!)
    expect(udpRead.id).toBe(0x0abc)
    expect(udpRead.qr).toBe(true)
    expect(udpRead.aa).toBe(true)
    expect(udpRead.answers[0]?.data).toBe('192.168.2.40')

    const overTcp = await askTcp(port, query)
    expect(overTcp).not.toBeNull()
    expect(parseAnswer(overTcp!).answers[0]?.data).toBe('192.168.2.40')
  })

  it('never claims recursion, however the question is asked', async () => {
    const reply = await askUdp(port, buildQuery({ name: ZONE, type: T.SOA, rd: true }))
    const read = parseAnswer(reply!)
    expect(read.ra).toBe(false)
    // RD is echoed, as RFC 1035 requires — echoed is not obeyed.
    expect(read.rd).toBe(true)
    expect(read.answers[0]?.type).toBe(T.SOA)
  })

  it('refuses a zone transfer and an unpublished name over the wire', async () => {
    const any = parseAnswer((await askUdp(port, buildQuery({ name: ZONE, type: T.ANY })))!)
    expect(any.rcode).toBe(RCODE.REFUSED)
    const axfr = parseAnswer((await askTcp(port, buildQuery({ name: ZONE, type: T.AXFR })))!)
    expect(axfr.rcode).toBe(RCODE.REFUSED)
    const unknown = parseAnswer((await askUdp(port, buildQuery({ name: `8-8-8-8.${MAC}.${ZONE}`, type: T.A })))!)
    expect(unknown.rcode).toBe(RCODE.NXDOMAIN)
    expect(unknown.authority[0]?.type).toBe(T.SOA)
  })
})

describe('truncation', () => {
  it('sets TC over UDP and serves the whole answer over TCP', async () => {
    // More digests than fit in 512 bytes — the shape a busy renewal makes.
    challenges.set(MAC, Array.from({ length: 6 }, (_, i) => `digest-${i}-${'x'.repeat(43)}`))
    const query = buildQuery({ name: `_acme-challenge.${MAC}.${ZONE}`, type: T.TXT })
    const overUdp = await askUdp(port, query)
    expect(overUdp!.length).toBeLessThanOrEqual(UDP_FLOOR)
    const udpRead = parseAnswer(overUdp!)
    expect(udpRead.tc).toBe(true)
    expect(udpRead.answers).toHaveLength(0)

    const overTcp = parseAnswer((await askTcp(port, query))!)
    expect(overTcp.tc).toBe(false)
    expect(overTcp.answers).toHaveLength(6)

    // With EDNS0 the same answer fits in one datagram, and TC stays clear.
    const roomy = parseAnswer(
      (await askUdp(port, buildQuery({ name: `_acme-challenge.${MAC}.${ZONE}`, type: T.TXT, edns: 4096 })))!
    )
    expect(roomy.tc).toBe(false)
    expect(roomy.answers).toHaveLength(6)
    expect(roomy.edns).toBe(1232)
    challenges.clear()
  })
})

describe('malformed input', () => {
  it('answers FORMERR for a readable header with an unreadable body, and drops the rest', async () => {
    const broken = buildQuery({ name: ZONE, type: T.SOA })
    broken.writeUInt16BE(3, 4) // three questions, one question's worth of bytes
    const reply = await askUdp(port, broken, 400)
    expect(reply).not.toBeNull()
    expect(parseAnswer(reply!).rcode).toBe(RCODE.FORMERR)

    // Too short to hold an id: there is nobody to answer.
    expect(await askUdp(port, Buffer.from([1, 2, 3]), 250)).toBeNull()
    // A RESPONSE aimed at our port is somebody else's conversation.
    const response = buildQuery({ name: ZONE, type: T.SOA })
    response.writeUInt16BE(0x8000, 2)
    expect(await askUdp(port, response, 250)).toBeNull()
  })

  it('stays up: the counters move and the next real query is still answered', async () => {
    const before = server.counts()
    expect(before.malformed).toBeGreaterThan(0)
    const reply = await askUdp(port, buildQuery({ name: ZONE, type: T.SOA }))
    expect(parseAnswer(reply!).rcode).toBe(RCODE.NOERROR)
  })
})

describe('the rate limit', () => {
  it('drops silently past the burst rather than sending a refusal to a forged source', async () => {
    const limited = createDnsServer({
      port: 0,
      address: '127.0.0.1',
      respond: responder,
      ratePerSecond: 1,
      burst: 2
    })
    const on = await limited.start()
    try {
      const query = buildQuery({ name: ZONE, type: T.SOA })
      const first = await askUdp(on, query, 400)
      const second = await askUdp(on, query, 400)
      const third = await askUdp(on, query, 300)
      const fourth = await askUdp(on, query, 300)
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      // The bucket refills at one a second and these took well under one.
      expect([third, fourth].filter((r) => r === null).length).toBeGreaterThan(0)
      expect(limited.counts().refusedByRate).toBeGreaterThan(0)
    } finally {
      await limited.stop()
    }
  })
})

/**
 * H3 — SLOWLORIS OVER TCP.
 *
 * TCP DNS had one global cap of 64 connections and an INACTIVITY timer that
 * any byte reset. Sixty-four sockets from one address, each announcing a
 * 65535-byte message and dribbling a byte a second, therefore held the whole
 * listener shut for as long as the attacker cared to keep typing — and every
 * resolver that had been told TC=1 over UDP had nowhere to go.
 *
 * Three things stop it, and all three are proved here: a cap per source so one
 * address cannot take the pool, an absolute deadline from accept that a byte
 * does not extend, and a shorter one for a message that never completes.
 */
describe('a dribbling TCP client', () => {
  /** Announces 0xffff and then sends a byte at a time, for ever. */
  const dribble = (on: number): { socket: ReturnType<typeof connect>; closed: Promise<number> } => {
    const socket = connect(on, '127.0.0.1')
    const opened = Date.now()
    socket.on('error', () => undefined)
    socket.on('connect', () => {
      socket.write(Buffer.from([0xff, 0xff]))
      const tick = setInterval(() => {
        if (socket.destroyed) return clearInterval(tick)
        socket.write(Buffer.from([0x41]))
      }, 40)
      socket.on('close', () => clearInterval(tick))
    })
    return { socket, closed: new Promise<number>((resolve) => socket.on('close', () => resolve(Date.now() - opened))) }
  }

  /** One question over TCP to an explicit host, so a test can pick its source. */
  const askFrom = (host: string, on: number, message: Buffer): Promise<Buffer | null> =>
    new Promise((resolve) => {
      const socket = connect(on, host)
      let got = Buffer.alloc(0)
      const done = (value: Buffer | null): void => {
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(1500, () => done(null))
      socket.on('error', () => done(null))
      socket.on('connect', () => {
        const framed = Buffer.alloc(2 + message.length)
        framed.writeUInt16BE(message.length, 0)
        message.copy(framed, 2)
        socket.write(framed)
      })
      socket.on('data', (chunk) => {
        got = Buffer.concat([got, chunk])
        if (got.length >= 2 && got.length >= 2 + got.readUInt16BE(0)) done(got.subarray(2, 2 + got.readUInt16BE(0)))
      })
      socket.on('close', () => resolve(null))
    })

  it('cannot take more than its share of the pool, so a real query still lands', async () => {
    const guarded = createDnsServer({
      port: 0,
      // Dual stack, so the test has two source groups to work with: v4
      // loopback is one block and ::1 is another, which is exactly the shape
      // the cap is about — one address cannot spend everybody's pool.
      address: '::',
      respond: responder,
      // The shipped numbers are 64 and 4; these are the same ratio, small
      // enough that a test can fill the pool without opening sixty sockets.
      tcp: { max: 8, perSource: 4, deadlineMs: 5000 }
    })
    const on = await guarded.start()
    const dribblers = Array.from({ length: 8 }, () => dribble(on))
    try {
      await new Promise((resolve) => setTimeout(resolve, 250))
      // Four of them were let in; the rest were shown the door on arrival.
      expect(dribblers.filter((one) => !one.socket.destroyed).length).toBeLessThanOrEqual(4)
      expect(guarded.counts().tcpRefused).toBeGreaterThanOrEqual(4)
      // AND THE LISTENER STILL ANSWERS somebody else. Half the pool is free,
      // which is the whole point of counting per source rather than in total.
      const reply = await askFrom('::1', on, buildQuery({ name: ZONE, type: T.SOA }))
      expect(reply).not.toBeNull()
      expect(parseAnswer(reply!).rcode).toBe(RCODE.NOERROR)
    } finally {
      for (const one of dribblers) one.socket.destroy()
      await guarded.stop()
    }
  })

  it('is destroyed by a deadline it cannot push back with a byte', async () => {
    const guarded = createDnsServer({
      port: 0,
      address: '127.0.0.1',
      respond: responder,
      // Far shorter than the idle timeout the dribbler keeps resetting, so
      // what is being measured is the absolute deadline and nothing else.
      tcp: { max: 8, perSource: 8, deadlineMs: 400, partialMs: 100_000 }
    })
    const on = await guarded.start()
    const one = dribble(on)
    try {
      const lived = await Promise.race([
        one.closed,
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2500))
      ])
      expect(lived).toBeGreaterThan(0)
      expect(lived).toBeLessThan(2000)
    } finally {
      one.socket.destroy()
      await guarded.stop()
    }
  })

  it('is destroyed sooner still for a message that never completes', async () => {
    const guarded = createDnsServer({
      port: 0,
      address: '127.0.0.1',
      respond: responder,
      tcp: { max: 8, perSource: 8, deadlineMs: 100_000, partialMs: 300 }
    })
    const on = await guarded.start()
    const one = dribble(on)
    try {
      const lived = await Promise.race([
        one.closed,
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2500))
      ])
      expect(lived).toBeGreaterThan(0)
      expect(lived).toBeLessThan(2000)
      // A whole message inside the same window is still served, of course.
      const reply = await askTcp(on, buildQuery({ name: ZONE, type: T.SOA }), 1500)
      expect(parseAnswer(reply!).rcode).toBe(RCODE.NOERROR)
    } finally {
      one.socket.destroy()
      await guarded.stop()
    }
  })
})

/**
 * L6 — ONE LISTENER, BOTH FAMILIES.
 *
 * A resolver reaching us over IPv6 was reaching a socket that did not exist:
 * the listener was `udp4` only. `udp6` with `ipv6Only` unset is dual stack, so
 * one socket answers both and a v4 peer arrives as `::ffff:a.b.c.d`. A test
 * that names a v4 address still gets a v4 socket, because `udp6` cannot bind
 * 127.0.0.1 — which is also what a pod told one interface gets.
 */
describe('dual stack', () => {
  it('answers the same question over IPv4 and over IPv6 on one socket', async () => {
    const both = createDnsServer({ port: 0, address: '::', respond: responder })
    const on = await both.start()
    try {
      const query = buildQuery({ name: ZONE, type: T.SOA })
      const over4 = await askUdp(on, query)
      expect(over4).not.toBeNull()
      expect(parseAnswer(over4!).rcode).toBe(RCODE.NOERROR)

      const over6 = await new Promise<Buffer | null>((resolve) => {
        const socket = createSocket('udp6')
        const timer = setTimeout(() => {
          socket.close()
          resolve(null)
        }, 700)
        socket.on('message', (reply) => {
          clearTimeout(timer)
          socket.close()
          resolve(reply)
        })
        socket.send(query, on, '::1')
      })
      expect(over6).not.toBeNull()
      expect(parseAnswer(over6!).rcode).toBe(RCODE.NOERROR)
    } finally {
      await both.stop()
    }
  })

  it('groups a v4-mapped peer with the v4 block it came from', () => {
    expect(sourceGroup('::ffff:192.168.2.40')).toBe(sourceGroup('192.168.2.99'))
    expect(sourceGroup('192.168.2.40')).not.toBe(sourceGroup('192.168.3.40'))
    // /56 for v6 — seven bytes, so the fourth hextet's low byte is outside it
    // and its high byte is inside. `…:1:2::` and `…:1:3::` are one customer;
    // `…:1:200::` and `…:1:300::` are two.
    expect(sourceGroup('2001:db8:1:2::1')).toBe(sourceGroup('2001:db8:1:3:ffff::9'))
    expect(sourceGroup('2001:db8:1:200::1')).not.toBe(sourceGroup('2001:db8:1:300::1'))
    // Something that is not an address at all is still its own key, not a crash.
    expect(sourceGroup('')).toBe('')
  })
})

/**
 * M3 — WHAT THE LIMITER COSTS WHEN IT IS THE THING BEING ATTACKED.
 *
 * The buckets lived in a Map that was pruned whenever it passed 4096 entries,
 * and the prune walked every entry — on the hot path, inside the handler for a
 * packet anyone can send. Past that many distinct sources the per-packet cost
 * fell off a cliff, so a flood from many addresses (trivial over IPv6, where a
 * single /64 holds eighteen quintillion of them) made every packet dearer than
 * the last. The table is a fixed array now: no growth, no scan, no cliff.
 */
describe('the limiter under a flood from everywhere', () => {
  it('costs the same per packet whether it has seen ten sources or sixty thousand', () => {
    const clock = { at: 1_757_000_000_000 }
    const buckets = new Buckets(50, 100, () => clock.at)
    const sources = Array.from({ length: 60_000 }, (_, i) => `${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${i & 0xff}.0`)

    // NO WARM-UP. The flood IS the growth: the cost being measured is the one
    // paid while the table is filling with sources it has never seen, which is
    // exactly what an attacker sends and exactly where the old cliff was.
    const rounds = 100_000
    const started = performance.now()
    for (let i = 0; i < rounds; i += 1) {
      // A million packets a second: a real flood, and the shape that made the
      // old Map pathological — sources arrive faster than the buckets behind
      // them refill, so the prune walked a table that never got any smaller.
      clock.at = 1_757_000_000_000 + i / 1000
      buckets.take(sourceGroup(sources[i % sources.length]))
    }
    const each = ((performance.now() - started) * 1000) / rounds
    console.log(`M3: ${each.toFixed(3)} µs per packet across 60 000 sources`)
    expect(each).toBeLessThan(5)
  })

  it('still refuses a source that is over its budget, however many others there are', () => {
    const clock = { at: 1_757_000_000_000 }
    const buckets = new Buckets(1, 2, () => clock.at)
    for (let i = 0; i < 60_000; i += 1) {
      clock.at += 0.01
      buckets.take(`filler-${i}`)
    }
    clock.at += 10_000
    expect(buckets.take('4.203.0.113').ok).toBe(true)
    expect(buckets.take('4.203.0.113').ok).toBe(true)
    expect(buckets.take('4.203.0.113').ok).toBe(false)
    // And it refills on the clock rather than on a timer.
    clock.at += 3000
    expect(buckets.take('4.203.0.113').ok).toBe(true)
  })

  it('slips every second refusal, so silence is never the only answer', () => {
    const clock = { at: 1_757_000_000_000 }
    const buckets = new Buckets(1, 1, () => clock.at)
    expect(buckets.take('one').ok).toBe(true)
    // Every SECOND one over: silence, then a truncation, then silence again.
    expect(buckets.take('one')).toEqual({ ok: false, slip: false })
    expect(buckets.take('one')).toEqual({ ok: false, slip: true })
    expect(buckets.take('one')).toEqual({ ok: false, slip: false })
    expect(buckets.take('one')).toEqual({ ok: false, slip: true })
  })
})

/**
 * M4 — WHOSE QUERIES A FLOOD ACTUALLY STOPS.
 *
 * The bucket was keyed on the source address alone and going over it meant
 * silence. Both halves were exploitable together: a source address is
 * something a UDP sender writes, so anyone could spend a chosen resolver's
 * whole budget by spelling its address on their own packets — and the resolver
 * would then be met with nothing at all, which reads as a dead server rather
 * than as a busy one.
 *
 * So the budget is per (source block, name, type), which is what an attacker
 * cannot aim at somebody else's question, and every SECOND over-budget query
 * gets an empty answer with TC set instead of silence. A real resolver reads
 * TC and comes back over TCP, where the source address is not a matter of
 * opinion. The bytes are no more than the query's own, so it amplifies nothing.
 */
describe('the budget, and what going over it looks like', () => {
  const limited = (): ReturnType<typeof createDnsServer> =>
    createDnsServer({ port: 0, address: '127.0.0.1', respond: responder, ratePerSecond: 1, burst: 2 })

  it('is spent per name, so one flooded name does not take the others down', async () => {
    const server = limited()
    const on = await server.start()
    try {
      // Two over budget on the apex.
      for (let i = 0; i < 4; i += 1) await askUdp(on, buildQuery({ name: ZONE, type: T.SOA }), 250)
      // A different question from the same address is untouched.
      const other = await askUdp(on, buildQuery({ name: `ns1.${ZONE}`, type: T.A }), 500)
      expect(other).not.toBeNull()
      expect(parseAnswer(other!).answers[0]?.data).toBe('203.0.113.10')
      // As is a different TYPE of the same name.
      const byType = await askUdp(on, buildQuery({ name: ZONE, type: T.NS }), 500)
      expect(parseAnswer(byType!).answers.length).toBeGreaterThan(0)
    } finally {
      await server.stop()
    }
  })

  it('slips every second refusal back as an empty TC=1 answer, not as silence', async () => {
    const server = limited()
    const on = await server.start()
    try {
      const query = buildQuery({ name: ZONE, type: T.SOA, id: 0x7f7f })
      const replies: (Buffer | null)[] = []
      for (let i = 0; i < 6; i += 1) replies.push(await askUdp(on, query, 300))
      // The first two are the burst; after that it is alternately nothing and
      // a truncation, so a resolver behind the flood always has a way through.
      const slips = replies.slice(2).filter((one): one is Buffer => one !== null)
      expect(slips.length).toBeGreaterThan(0)
      expect(replies.slice(2).filter((one) => one === null).length).toBeGreaterThan(0)
      for (const slip of slips) {
        const read = parseAnswer(slip)
        expect(read.tc).toBe(true)
        expect(read.id).toBe(0x7f7f)
        expect(read.answers).toHaveLength(0)
        expect(read.authority).toHaveLength(0)
        // NO AMPLIFICATION: the way out of a flood must not be a bigger packet
        // than the one that caused it.
        expect(slip.length).toBeLessThanOrEqual(query.length + 16)
      }
      expect(server.counts().refusedByRate).toBeGreaterThan(0)
      // And the whole answer is there over TCP, which is where TC sends it.
      const overTcp = await askTcp(on, query)
      expect(parseAnswer(overTcp!).answers[0]?.type).toBe(T.SOA)
    } finally {
      await server.stop()
    }
  })
})
