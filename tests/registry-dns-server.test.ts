import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RCODE, UDP_FLOOR } from '../registry/src/dns-wire'
import { createDnsServer, type DnsServer } from '../registry/src/dns-server'
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
