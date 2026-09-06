import { describe, expect, it } from 'vitest'
import {
  DNS_TYPE,
  EDNS_PAYLOAD,
  RCODE,
  UDP_FLOOR,
  answerWithin,
  budgetFor,
  buildAnswer,
  encodeName,
  ipText,
  parseIp,
  parseQuery,
  readName,
  sameIp
} from '../registry/src/dns-wire'
import { T, buildPointerFixture, buildQuery, parseAnswer } from './support/dns-probe'

/**
 * THE WIRE, BYTE BY BYTE.
 *
 * Every fixture here is assembled by hand from RFC 1035 and read back with the
 * test's own independent parser (tests/support/dns-probe.ts). Nothing in this
 * file round-trips our encoder through our decoder, because a matching pair of
 * bugs would pass that and fail against a real resolver.
 */

const ZONE = 'd.cookrew.dev'

describe('addresses', () => {
  it('reads IPv4 and IPv6, and compares by bytes rather than by spelling', () => {
    expect(parseIp('192.168.2.40')?.family).toBe(4)
    expect(parseIp('::1')?.family).toBe(6)
    expect(parseIp('fd7a:115c:a1e0::1234')?.family).toBe(6)
    expect(parseIp('[fd7a::1]')?.family).toBe(6)
    const short = parseIp('::1')
    const long = parseIp('0:0:0:0:0:0:0:1')
    expect(short && long && sameIp(short, long)).toBe(true)
    expect(ipText(parseIp('192.168.2.40')!)).toBe('192.168.2.40')
    expect(ipText(parseIp('fd7a:115c:a1e0::1234')!)).toBe('fd7a:115c:a1e0:0:0:0:0:1234')
  })

  it('refuses what a reach card can never carry', () => {
    for (const bad of ['256.1.1.1', '1.2.3', 'localhost', '', 'g::1', '::1::2', '1:2:3:4:5:6:7:8:9', 'a'.repeat(60)]) {
      expect(parseIp(bad)).toBeNull()
    }
  })
})

describe('names', () => {
  it('encodes and reads a name, and follows a backward compression pointer', () => {
    const encoded = encodeName(`192-168-2-40.${ZONE}`)
    expect(encoded).not.toBeNull()
    // Length-prefixed labels, terminated by a zero byte.
    expect(encoded![0]).toBe(12)
    expect(encoded![encoded!.length - 1]).toBe(0)
    const fixture = buildPointerFixture('192-168-2-40.abcd1234-aaaa-bbbb-cccc-000000000001', ZONE)
    const read = readName(fixture.message, fixture.at)
    expect(read?.name).toBe(`192-168-2-40.abcd1234-aaaa-bbbb-cccc-000000000001.${ZONE}`)
    // The offset AFTER the name is past the pointer, not past the target.
    expect(read?.next).toBe(fixture.message.length)
  })

  it('refuses a forward pointer rather than looping on it', () => {
    // A name at offset 12 whose first byte is a pointer to offset 40 — forward,
    // which is the shape a hand-made packet uses to hang a parser.
    const buf = Buffer.alloc(64)
    buf[12] = 0xc0
    buf[13] = 40
    expect(readName(buf, 12)).toBeNull()
  })

  it('lowercases on the way in, because DNS names are case-insensitive', () => {
    const parsed = parseQuery(buildQuery({ name: `192-168-2-40.ABCD.${ZONE.toUpperCase()}`, type: T.A }))
    expect(parsed.ok && parsed.query.question.name).toBe(`192-168-2-40.abcd.${ZONE}`)
  })
})

describe('queries', () => {
  it('reads a plain query and reports no EDNS budget', () => {
    const parsed = parseQuery(buildQuery({ name: ZONE, type: T.SOA, id: 0x1234, rd: true }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.query.id).toBe(0x1234)
    expect(parsed.query.rd).toBe(true)
    expect(parsed.query.edns).toBeNull()
    expect(budgetFor(null)).toBe(UDP_FLOOR)
  })

  it('reads the EDNS0 OPT and clamps the budget to ours', () => {
    const parsed = parseQuery(buildQuery({ name: ZONE, type: T.SOA, edns: 4096 }))
    expect(parsed.ok && parsed.query.edns).toBe(4096)
    expect(budgetFor(4096)).toBe(EDNS_PAYLOAD)
    // A resolver that asks for less than the floor still gets the floor.
    expect(budgetFor(200)).toBe(UDP_FLOOR)
  })

  it('drops a response and refuses a query with no question', () => {
    const response = buildQuery({ name: ZONE, type: T.SOA })
    response.writeUInt16BE(0x8000, 2)
    const dropped = parseQuery(response)
    expect(dropped.ok).toBe(false)
    if (!dropped.ok) expect(dropped.reason).toBe('drop')

    const empty = buildQuery({ name: ZONE, type: T.SOA })
    empty.writeUInt16BE(0, 4)
    const formerr = parseQuery(empty)
    expect(formerr.ok).toBe(false)
    if (!formerr.ok) expect(formerr.reason).toBe('formerr')

    const stub = parseQuery(Buffer.alloc(4))
    expect(stub.ok).toBe(false)
    if (!stub.ok) expect(stub.reason).toBe('drop')
  })

  it('refuses a truncated name rather than reading past the buffer', () => {
    const query = buildQuery({ name: ZONE, type: T.SOA })
    expect(parseQuery(query.subarray(0, query.length - 6)).ok).toBe(false)
  })
})

describe('answers', () => {
  const question = { name: ZONE, type: DNS_TYPE.SOA, class: 1 }

  it('writes every record type our zone uses, readable by an outside parser', () => {
    const built = buildAnswer({
      id: 7,
      question: { name: `192-168-2-40.dev.${ZONE}`, type: DNS_TYPE.A, class: 1 },
      rcode: RCODE.NOERROR,
      aa: true,
      rd: false,
      edns: null,
      answers: [
        { name: `192-168-2-40.dev.${ZONE}`, type: 'A', ttl: 60, address: '192.168.2.40' },
        { name: `fd7a--1.dev.${ZONE}`, type: 'AAAA', ttl: 60, address: 'fd7a::1' },
        { name: `_acme-challenge.dev.${ZONE}`, type: 'TXT', ttl: 5, text: 'a-digest' },
        { name: ZONE, type: 'NS', ttl: 300, host: `ns1.${ZONE}` }
      ],
      authority: [
        {
          name: ZONE,
          type: 'SOA',
          ttl: 60,
          soa: {
            mname: `ns1.${ZONE}`,
            rname: `hostmaster.${ZONE}`,
            serial: 1757000000,
            refresh: 7200,
            retry: 3600,
            expire: 1209600,
            minimum: 60
          }
        }
      ]
    })
    expect(built).not.toBeNull()
    const read = parseAnswer(Buffer.from(built!))
    expect(read.qr).toBe(true)
    expect(read.aa).toBe(true)
    expect(read.ra).toBe(false)
    expect(read.answers.map((r) => r.data)).toEqual([
      '192.168.2.40',
      'fd7a:0:0:0:0:0:0:1',
      'a-digest',
      `ns1.${ZONE}`
    ])
    expect(read.answers.map((r) => r.ttl)).toEqual([60, 60, 5, 300])
    expect(read.answers.every((r) => r.klass === 1)).toBe(true)
    expect(read.authority[0].data).toBe(`ns1.${ZONE} hostmaster.${ZONE} 1757000000 7200 3600 1209600 60`)
  })

  it('echoes an OPT with OUR payload size, and none when the query had none', () => {
    const withOpt = parseAnswer(
      Buffer.from(buildAnswer({ id: 1, question, rcode: 0, aa: true, rd: false, edns: 4096 })!)
    )
    expect(withOpt.edns).toBe(EDNS_PAYLOAD)
    const without = parseAnswer(
      Buffer.from(buildAnswer({ id: 1, question, rcode: 0, aa: true, rd: false, edns: null })!)
    )
    expect(without.edns).toBeNull()
    expect(without.additional).toHaveLength(0)
  })

  it('sets TC and empties the sections when the answer will not fit', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `_acme-challenge.dev.${ZONE}`,
      type: 'TXT' as const,
      ttl: 5,
      text: `digest-${i}-${'x'.repeat(40)}`
    }))
    const spec = { id: 9, question, rcode: 0, aa: true, rd: false, edns: null, answers: many }
    const full = buildAnswer(spec)!
    expect(full.length).toBeGreaterThan(UDP_FLOOR)
    const held = answerWithin(spec, UDP_FLOOR)!
    expect(held.length).toBeLessThanOrEqual(UDP_FLOOR)
    const read = parseAnswer(Buffer.from(held))
    expect(read.tc).toBe(true)
    expect(read.answers).toHaveLength(0)
    expect(read.question?.name).toBe(ZONE)
    // Under the budget nothing is dropped and TC stays clear.
    const small = answerWithin({ ...spec, answers: many.slice(0, 1) }, UDP_FLOOR)!
    expect(parseAnswer(Buffer.from(small)).tc).toBe(false)
  })
})
