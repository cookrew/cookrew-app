import {
  DNS_CLASS_IN,
  DNS_TYPE,
  RCODE,
  ipText,
  parseIp,
  sameIp,
  type DnsQuestion,
  type DnsRecord,
  type Ip,
  type Soa
} from './dns-wire'

/**
 * AUTHORITATIVE DNS — WHAT THE ZONE d.cookrew.dev ANSWERS.
 *
 * One function of one question. It holds no sockets and no store: the reach
 * cards and the pending ACME challenges arrive as two tiny interfaces, so the
 * whole rule set can be driven from a test with two object literals.
 *
 * THE GATE IS THE WHOLE DESIGN. Without it this is a public sslip.io — any
 * label resolves to any address, and a phisher mints `1-2-3-4.anything.
 * d.cookrew.dev` under our own domain. With it a name exists only while a
 * signed-in Mac is publishing that exact address in its signed reach card, and
 * it disappears the moment the Mac stops. The DNS answer is not a second
 * source of truth about where a machine is; it is the reach card, served on a
 * second protocol.
 *
 * A CARD THAT STOPPED BEING REFRESHED IS NOT A FACT. A desktop that was
 * unplugged a month ago should not keep a name pointing into whoever's network
 * now holds that address, so a card older than the reach TTL answers NXDOMAIN
 * exactly as an unknown device does.
 *
 * NO RECURSION, NO TRANSFER, NO ANY. We are authoritative for one zone and a
 * resolver for nobody. ANY and AXFR are REFUSED rather than answered, both
 * because a zone dump is a list of everyone's addresses and because a large
 * answer to a small spoofed question is the whole of DNS amplification.
 */

/** Addresses live 60 s: a Mac changing Wi-Fi must not be wrong for longer. */
export const ADDRESS_TTL = 60
/** A challenge answer is read once, by one CA, within seconds. */
export const TXT_TTL = 5
export const APEX_TTL = 300
/** How long a resolver may cache "no". Short, for the same reason as above. */
export const NEGATIVE_TTL = 60
/** A reach card nobody refreshed for a day stops naming anything. */
export const REACH_TTL_MS = 24 * 60 * 60 * 1000

const SOA_REFRESH = 7200
const SOA_RETRY = 3600
const SOA_EXPIRE = 1209600

/** What a desktop is publishing right now, flattened to bare host addresses. */
export interface ReachedDevice {
  /** Every host from the current card — LAN and tailnet alike, as text. */
  addresses: readonly string[]
  /** When the desktop signed that card, epoch ms. */
  at: number
}

export interface ReachLookup {
  /** The device's current card, or null when we hold none for that id. */
  find: (deviceId: string) => ReachedDevice | null
}

export interface ChallengeLookup {
  /** The dns-01 digests standing for this device, newest first. Empty is normal. */
  textsFor: (deviceId: string) => readonly string[]
}

export interface NameServer {
  host: string
  address: string
}

export interface ZoneOptions {
  zone: string
  ns: readonly NameServer[]
  reach: ReachLookup
  challenges: ChallengeLookup
  /** Epoch ms of the last change to anything in the zone — the SOA serial. */
  changedAt: () => number
  now?: () => number
  reachTtlMs?: number
}

export interface ZoneAnswer {
  rcode: number
  aa: boolean
  answers: readonly DnsRecord[]
  authority: readonly DnsRecord[]
}

export type Responder = (question: DnsQuestion) => ZoneAnswer

const ACME_LABEL = '_acme-challenge'
const DEVICE_LABEL = /^[a-z0-9][a-z0-9-]{7,62}$/
const IPV4_LABEL = /^\d{1,3}(?:-\d{1,3}){3}$/
const IPV6_LABEL = /^[0-9a-f-]{1,45}$/

/**
 * A LABEL BACK INTO AN ADDRESS. Dots become dashes for IPv4; for IPv6 colons
 * become dashes and `::` becomes `--`, which is the one sequence a hextet can
 * never contain, so the mapping is reversible without escaping.
 */
export function addressFromLabel(label: string): Ip | null {
  if (IPV4_LABEL.test(label)) return parseIp(label.replace(/-/g, '.'))
  if (!IPV6_LABEL.test(label)) return null
  const halves = label.split('--')
  if (halves.length > 2) return null
  return parseIp(halves.map((half) => half.replace(/-/g, ':')).join('::'))
}

/** The same mapping forwards, for whoever has to print the name. */
export function labelForAddress(address: string): string | null {
  const ip = parseIp(address)
  if (ip === null) return null
  const bare = address.replace(/^\[|\]$/g, '').toLowerCase()
  return ip.family === 4 ? bare.replace(/\./g, '-') : bare.replace(/::/g, '--').replace(/:/g, '-')
}

const refused = (): ZoneAnswer => ({ rcode: RCODE.REFUSED, aa: false, answers: [], authority: [] })

export function createZone(options: ZoneOptions): Responder {
  const zone = options.zone.toLowerCase().replace(/\.$/, '')
  const now = options.now ?? Date.now
  const ttl = options.reachTtlMs ?? REACH_TTL_MS
  const suffix = `.${zone}`

  const soa = (): Soa => ({
    mname: options.ns[0]?.host ?? `ns1${suffix}`,
    rname: `hostmaster${suffix}`,
    // Seconds, not milliseconds: a serial is a uint32 and epoch ms overflows
    // it in 1970. Every change to any card moves it, which is all a secondary
    // would ever need and all we promise.
    serial: Math.max(1, Math.floor(options.changedAt() / 1000)) >>> 0,
    refresh: SOA_REFRESH,
    retry: SOA_RETRY,
    expire: SOA_EXPIRE,
    minimum: NEGATIVE_TTL
  })

  const soaRecord = (ttlSeconds: number): DnsRecord => ({ name: zone, type: 'SOA', ttl: ttlSeconds, soa: soa() })
  const negative = (rcode: number): ZoneAnswer => ({
    rcode,
    aa: true,
    answers: [],
    authority: [soaRecord(NEGATIVE_TTL)]
  })
  const nxdomain = (): ZoneAnswer => negative(RCODE.NXDOMAIN)
  /** The name exists, this type does not. NOERROR with the SOA, never NXDOMAIN. */
  const noData = (): ZoneAnswer => negative(RCODE.NOERROR)
  const found = (answers: readonly DnsRecord[]): ZoneAnswer => ({ rcode: RCODE.NOERROR, aa: true, answers, authority: [] })

  /** The card, or null when the device is unknown, has no card, or let it go stale. */
  const live = (deviceId: string): ReachedDevice | null => {
    if (!DEVICE_LABEL.test(deviceId)) return null
    const device = options.reach.find(deviceId)
    if (device === null) return null
    return now() - device.at > ttl ? null : device
  }

  const apex = (type: number): ZoneAnswer => {
    if (type === DNS_TYPE.SOA) return found([soaRecord(APEX_TTL)])
    if (type === DNS_TYPE.NS) {
      return found(options.ns.map((server) => ({ name: zone, type: 'NS', ttl: APEX_TTL, host: server.host })))
    }
    return noData()
  }

  const nameServer = (name: string, type: number): ZoneAnswer | null => {
    const server = options.ns.find((entry) => entry.host.toLowerCase() === name)
    if (server === undefined) return null
    const ip = parseIp(server.address)
    if (ip === null) return noData()
    const wanted = ip.family === 4 ? DNS_TYPE.A : DNS_TYPE.AAAA
    if (type !== wanted) return noData()
    return found([
      { name, type: ip.family === 4 ? 'A' : 'AAAA', ttl: APEX_TTL, address: server.address }
    ])
  }

  const challenge = (deviceId: string, type: number): ZoneAnswer => {
    if (!DEVICE_LABEL.test(deviceId)) return nxdomain()
    const texts = options.challenges.textsFor(deviceId)
    if (texts.length === 0) return nxdomain()
    if (type !== DNS_TYPE.TXT) return noData()
    return found(texts.map((text) => ({ name: `${ACME_LABEL}.${deviceId}${suffix}`, type: 'TXT', ttl: TXT_TTL, text })))
  }

  const address = (name: string, label: string, deviceId: string, type: number): ZoneAnswer => {
    const wanted = addressFromLabel(label)
    if (wanted === null) return nxdomain()
    const device = live(deviceId)
    if (device === null) return nxdomain()
    // THE GATE. Byte equality against the card, so `--1` and `0-0-0-0-0-0-0-1`
    // are the same address and neither is invented.
    const published = device.addresses.some((held) => {
      const ip = parseIp(held)
      return ip !== null && sameIp(ip, wanted)
    })
    if (!published) return nxdomain()
    const kind = wanted.family === 4 ? 'A' : 'AAAA'
    if (type !== (wanted.family === 4 ? DNS_TYPE.A : DNS_TYPE.AAAA)) return noData()
    // Rendered from the PARSED bytes, never from the label: `--` stands for a
    // run of zero hextets and a text substitution would put two colons where
    // the address needs eight groups.
    return found([{ name, type: kind, ttl: ADDRESS_TTL, address: ipText(wanted) }])
  }

  return (question: DnsQuestion): ZoneAnswer => {
    // A class we do not serve is not a question about our zone at all.
    if (question.class !== DNS_CLASS_IN) return refused()
    const { type } = question
    // ANY is a zone dump in one packet and the classic amplifier; AXFR and
    // IXFR are the same thing said honestly. Neither is ours to answer.
    if (type === DNS_TYPE.ANY || type === DNS_TYPE.AXFR || type === DNS_TYPE.IXFR) return refused()

    const name = question.name.toLowerCase()
    if (name === zone) return apex(type)
    // OUT OF ZONE is REFUSED and small: we are nobody's resolver, and a
    // negative answer with an SOA for a name we do not serve would be a lie
    // with bytes attached.
    if (!name.endsWith(suffix)) return refused()

    const rest = name.slice(0, -suffix.length)
    const labels = rest.split('.')
    if (labels.length === 1) {
      const server = nameServer(name, type)
      if (server !== null) return server
      // A device id on its own is an empty non-terminal while that Mac
      // publishes anything at all: the name exists, it just has no records.
      return live(labels[0]) === null ? nxdomain() : noData()
    }
    if (labels.length !== 2) return nxdomain()
    const [label, deviceId] = labels
    if (label === ACME_LABEL) return challenge(deviceId, type)
    return address(name, label, deviceId, type)
  }
}
