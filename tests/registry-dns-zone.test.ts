import { describe, expect, it } from 'vitest'
import { DNS_CLASS_IN, DNS_TYPE, RCODE } from '../registry/src/dns-wire'
import {
  ADDRESS_TTL,
  NEGATIVE_TTL,
  REACH_TTL_MS,
  TXT_TTL,
  addressFromLabel,
  createZone,
  labelForAddress,
  type ReachedDevice,
  type Responder
} from '../registry/src/dns-zone'

/**
 * THE ZONE'S RULES — and above all THE GATE.
 *
 * A name under d.cookrew.dev exists only while a signed-in Mac is publishing
 * that exact address in its current reach card. Every other question here is a
 * different way of asking that one: an address the Mac never published, a Mac
 * we have never heard of, a card that went stale, a zone transfer that would
 * hand over the lot.
 */

const ZONE = 'd.cookrew.dev'
const MAC = 'abcd1234-aaaa-bbbb-cccc-000000000001'
const OTHER = 'abcd1234-aaaa-bbbb-cccc-000000000002'

let clock = 1_757_000_000_000
const cards = new Map<string, ReachedDevice>()
const challenges = new Map<string, string[]>()

const zone = (): Responder =>
  createZone({
    zone: ZONE,
    ns: [
      { host: `ns1.${ZONE}`, address: '203.0.113.10' },
      { host: `ns2.${ZONE}`, address: '203.0.113.11' }
    ],
    reach: { find: (id) => cards.get(id) ?? null },
    challenges: { textsFor: (id) => challenges.get(id) ?? [] },
    changedAt: () => clock,
    now: () => clock
  })

const ask = (name: string, type: number, klass = DNS_CLASS_IN): ReturnType<Responder> =>
  zone()({ name, type, class: klass })

const publish = (id: string, addresses: string[], at = clock): void => {
  cards.set(id, { addresses, at })
}

describe('addresses, gated by the reach card', () => {
  it('answers an IPv4 label the Mac is publishing, and nothing else', () => {
    cards.clear()
    publish(MAC, ['192.168.2.40', '10.0.0.7'])
    const found = ask(`192-168-2-40.${MAC}.${ZONE}`, DNS_TYPE.A)
    expect(found.rcode).toBe(RCODE.NOERROR)
    expect(found.aa).toBe(true)
    expect(found.answers).toEqual([
      { name: `192-168-2-40.${MAC}.${ZONE}`, type: 'A', ttl: ADDRESS_TTL, address: '192.168.2.40' }
    ])

    // The same label under a DIFFERENT Mac is not a name at all.
    const wrong = ask(`192-168-2-40.${OTHER}.${ZONE}`, DNS_TYPE.A)
    expect(wrong.rcode).toBe(RCODE.NXDOMAIN)
    expect(wrong.authority[0]?.type).toBe('SOA')
    expect(wrong.authority[0]?.ttl).toBe(NEGATIVE_TTL)
  })

  it('is not sslip.io: an address this Mac never published does not resolve', () => {
    cards.clear()
    publish(MAC, ['192.168.2.40'])
    for (const label of ['1-2-3-4', '8-8-8-8', '169-254-1-1', '192-168-2-41']) {
      expect(ask(`${label}.${MAC}.${ZONE}`, DNS_TYPE.A).rcode).toBe(RCODE.NXDOMAIN)
    }
  })

  it('answers IPv6 in both spellings, because `--` stands for a run of zeros', () => {
    cards.clear()
    publish(MAC, ['fd7a:115c:a1e0::1234', '::1'])
    const compressed = ask(`fd7a-115c-a1e0--1234.${MAC}.${ZONE}`, DNS_TYPE.AAAA)
    expect(compressed.answers[0]).toMatchObject({ type: 'AAAA', address: 'fd7a:115c:a1e0:0:0:0:0:1234' })
    // Spelled out in full, the same address, and the card still matches by bytes.
    const long = ask(`fd7a-115c-a1e0-0-0-0-0-1234.${MAC}.${ZONE}`, DNS_TYPE.AAAA)
    expect(long.answers[0]).toMatchObject({ type: 'AAAA', address: 'fd7a:115c:a1e0:0:0:0:0:1234' })
    // A leading `--` is `::` at the front.
    expect(ask(`--1.${MAC}.${ZONE}`, DNS_TYPE.AAAA).answers[0]).toMatchObject({ address: '0:0:0:0:0:0:0:1' })
  })

  it('answers NODATA, not NXDOMAIN, when the name exists but the type does not', () => {
    cards.clear()
    publish(MAC, ['192.168.2.40'])
    const wrongType = ask(`192-168-2-40.${MAC}.${ZONE}`, DNS_TYPE.AAAA)
    expect(wrongType.rcode).toBe(RCODE.NOERROR)
    expect(wrongType.answers).toHaveLength(0)
    expect(wrongType.authority[0]?.type).toBe('SOA')
    // And the Mac's own label is an empty non-terminal while it publishes.
    const bare = ask(`${MAC}.${ZONE}`, DNS_TYPE.A)
    expect(bare.rcode).toBe(RCODE.NOERROR)
    expect(bare.answers).toHaveLength(0)
    cards.clear()
    expect(ask(`${MAC}.${ZONE}`, DNS_TYPE.A).rcode).toBe(RCODE.NXDOMAIN)
  })

  it('lets a card go stale rather than pointing at whoever holds that address now', () => {
    cards.clear()
    publish(MAC, ['192.168.2.40'], clock - REACH_TTL_MS + 1000)
    expect(ask(`192-168-2-40.${MAC}.${ZONE}`, DNS_TYPE.A).rcode).toBe(RCODE.NOERROR)
    publish(MAC, ['192.168.2.40'], clock - REACH_TTL_MS - 1000)
    expect(ask(`192-168-2-40.${MAC}.${ZONE}`, DNS_TYPE.A).rcode).toBe(RCODE.NXDOMAIN)
  })

  it('refuses a device label that is not one, without asking the store', () => {
    cards.clear()
    let asked = 0
    const guarded = createZone({
      zone: ZONE,
      ns: [{ host: `ns1.${ZONE}`, address: '203.0.113.10' }],
      reach: {
        find: (id) => {
          asked += 1
          return cards.get(id) ?? null
        }
      },
      challenges: { textsFor: () => [] },
      changedAt: () => clock,
      now: () => clock
    })
    expect(guarded({ name: `192-168-2-40.x.${ZONE}`, type: DNS_TYPE.A, class: 1 }).rcode).toBe(RCODE.NXDOMAIN)
    expect(asked).toBe(0)
  })
})

describe('the challenge name', () => {
  it('answers TXT while an order is in flight, and NXDOMAIN once it is gone', () => {
    challenges.clear()
    expect(ask(`_acme-challenge.${MAC}.${ZONE}`, DNS_TYPE.TXT).rcode).toBe(RCODE.NXDOMAIN)
    challenges.set(MAC, ['a-digest', 'a-second-digest'])
    const found = ask(`_acme-challenge.${MAC}.${ZONE}`, DNS_TYPE.TXT)
    expect(found.rcode).toBe(RCODE.NOERROR)
    expect(found.answers).toHaveLength(2)
    expect(found.answers[0]).toMatchObject({ type: 'TXT', ttl: TXT_TTL, text: 'a-digest' })
    // Another type at a name that exists is NODATA.
    expect(ask(`_acme-challenge.${MAC}.${ZONE}`, DNS_TYPE.A).rcode).toBe(RCODE.NOERROR)
    expect(ask(`_acme-challenge.${MAC}.${ZONE}`, DNS_TYPE.A).answers).toHaveLength(0)
    challenges.clear()
    expect(ask(`_acme-challenge.${MAC}.${ZONE}`, DNS_TYPE.TXT).rcode).toBe(RCODE.NXDOMAIN)
  })

  it('needs no reach card: a Mac proves the name before it has published one', () => {
    cards.clear()
    challenges.set(MAC, ['a-digest'])
    expect(ask(`_acme-challenge.${MAC}.${ZONE}`, DNS_TYPE.TXT).answers).toHaveLength(1)
    challenges.clear()
  })
})

describe('the apex and the name servers', () => {
  it('answers SOA with a serial in seconds and NS from the flags', () => {
    const soa = ask(ZONE, DNS_TYPE.SOA)
    expect(soa.aa).toBe(true)
    expect(soa.answers[0]).toMatchObject({ type: 'SOA', name: ZONE })
    const record = soa.answers[0]
    if (record.type !== 'SOA') throw new Error('expected SOA')
    expect(record.soa.serial).toBe(Math.floor(clock / 1000))
    expect(record.soa.mname).toBe(`ns1.${ZONE}`)
    expect(record.soa.minimum).toBe(NEGATIVE_TTL)

    const ns = ask(ZONE, DNS_TYPE.NS)
    expect(ns.answers.map((r) => (r.type === 'NS' ? r.host : ''))).toEqual([`ns1.${ZONE}`, `ns2.${ZONE}`])
    // Anything else at the apex is NODATA, not NXDOMAIN.
    expect(ask(ZONE, DNS_TYPE.A).rcode).toBe(RCODE.NOERROR)
    expect(ask(ZONE, DNS_TYPE.A).answers).toHaveLength(0)
  })

  it('answers the glue addresses for its own name servers', () => {
    expect(ask(`ns1.${ZONE}`, DNS_TYPE.A).answers[0]).toMatchObject({ type: 'A', address: '203.0.113.10' })
    expect(ask(`ns2.${ZONE}`, DNS_TYPE.A).answers[0]).toMatchObject({ type: 'A', address: '203.0.113.11' })
    expect(ask(`ns1.${ZONE}`, DNS_TYPE.AAAA).answers).toHaveLength(0)
    expect(ask(`ns3.${ZONE}`, DNS_TYPE.A).rcode).toBe(RCODE.NXDOMAIN)
  })
})

describe('what is refused outright', () => {
  it('refuses ANY, AXFR and IXFR — a zone dump is everyone’s addresses at once', () => {
    for (const type of [DNS_TYPE.ANY, DNS_TYPE.AXFR, DNS_TYPE.IXFR]) {
      const out = ask(ZONE, type)
      expect(out.rcode).toBe(RCODE.REFUSED)
      expect(out.aa).toBe(false)
      expect(out.answers).toHaveLength(0)
      expect(out.authority).toHaveLength(0)
    }
  })

  it('refuses a class we do not serve and a name outside the zone', () => {
    expect(ask(ZONE, DNS_TYPE.SOA, 3).rcode).toBe(RCODE.REFUSED)
    // No SOA in a refusal for somebody else's name: we are nobody's resolver.
    const outside = ask('www.google.com', DNS_TYPE.A)
    expect(outside.rcode).toBe(RCODE.REFUSED)
    expect(outside.authority).toHaveLength(0)
    // A near miss is still outside.
    expect(ask('notd.cookrew.dev', DNS_TYPE.A).rcode).toBe(RCODE.REFUSED)
  })

  it('refuses a name with more labels than the zone has shapes', () => {
    cards.clear()
    publish(MAC, ['192.168.2.40'])
    expect(ask(`a.b.192-168-2-40.${MAC}.${ZONE}`, DNS_TYPE.A).rcode).toBe(RCODE.NXDOMAIN)
  })
})

describe('the label mapping, both ways', () => {
  it('round trips every form a reach card can hold', () => {
    expect(labelForAddress('192.168.2.40')).toBe('192-168-2-40')
    expect(labelForAddress('fd7a:115c:a1e0::1234')).toBe('fd7a-115c-a1e0--1234')
    expect(labelForAddress('::1')).toBe('--1')
    expect(labelForAddress('mac.tail1234.ts.net')).toBeNull()
    for (const address of ['192.168.2.40', 'fd7a:115c:a1e0::1234', '::1', '100.101.102.103']) {
      const label = labelForAddress(address)
      expect(label).not.toBeNull()
      expect(addressFromLabel(label!)).not.toBeNull()
    }
    expect(addressFromLabel('a--b--c')).toBeNull()
    expect(addressFromLabel('not-an-address')).toBeNull()
  })
})
