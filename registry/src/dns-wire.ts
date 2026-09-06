/**
 * AUTHORITATIVE DNS — THE WIRE FORMAT (RFC 1035, plus the sliver of 6891 we need).
 *
 * Pure functions over bytes: parse a query, build an answer. No sockets, no
 * clock, no store — everything this file knows comes in as an argument, so the
 * one part of the DNS server that a malformed packet can reach is also the one
 * part a test can drive with a Buffer it typed by hand.
 *
 * Three decisions worth stating, because each of them is a defence:
 *
 *   COMPRESSION POINTERS ARE READ, NEVER WRITTEN. A resolver may compress the
 *   question it sends us and we must follow it; our answers are one or two
 *   records and compressing them would save a dozen bytes at the cost of the
 *   trickiest code in the file. Pointers are only followed BACKWARDS and only
 *   sixteen times, which is what makes a hand-built loop a `null` instead of a
 *   hang.
 *
 *   A PARSE FAILURE IS A VALUE, not a throw. These bytes came from anyone on
 *   the internet. Every reader answers `null` and the caller decides between
 *   FORMERR and silence; nothing in here can take the process down.
 *
 *   THE BUDGET IS THE ANSWER'S, not the question's. A query with no EDNS0 OPT
 *   gets 512 bytes and the TC bit beyond that; one that advertises more gets
 *   the smaller of what it asked for and our own 1232. That ceiling is what
 *   keeps the amplification factor near 1 — see dns-server.ts.
 */

import { parseIp } from './dns-address'

// Re-exported so a reader of the wire has one import for the wire. The
// definitions live apart because the gate in dns-zone needs them without
// needing a message parser.
export { ipText, parseIp, sameIp, type Ip } from './dns-address'

export const DNS_TYPE = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  TXT: 16,
  AAAA: 28,
  OPT: 41,
  IXFR: 251,
  AXFR: 252,
  ANY: 255
} as const

export const DNS_CLASS_IN = 1
export const DNS_CLASS_ANY = 255

export const RCODE = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5
} as const

/** What we tell a resolver we can receive, and the ceiling on what we send. */
export const EDNS_PAYLOAD = 1232
/** RFC 1035's floor, for a query that carried no OPT at all. */
export const UDP_FLOOR = 512
/** A DNS message over TCP is length-prefixed with two bytes, so this is its roof. */
export const TCP_MAX = 0xffff

const HEADER = 12
const NAME_MAX = 255
const LABEL_MAX = 63
const POINTER_HOPS = 16

// ── names ────────────────────────────────────────────────────────────────

const decodeLabel = (bytes: Uint8Array): string => {
  let text = ''
  for (const byte of bytes) {
    // Lowercased on the way in: DNS names are case-insensitive, and every
    // comparison in dns-zone is a plain string equality against lower case.
    text += String.fromCharCode(byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte)
  }
  return text
}

export interface NameRead {
  name: string
  /** The offset AFTER the name in the original message, pointers followed. */
  next: number
}

export function readName(buf: Uint8Array, at: number): NameRead | null {
  const labels: string[] = []
  let offset = at
  let next = -1
  let hops = 0
  let length = 0
  for (;;) {
    if (offset >= buf.length) return null
    const len = buf[offset]
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) return null
      const target = ((len & 0x3f) << 8) | buf[offset + 1]
      if (next < 0) next = offset + 2
      // BACKWARDS ONLY. A pointer that goes forward or sideways is how a
      // hand-made packet turns a parser into an infinite loop.
      if (target >= offset) return null
      if ((hops += 1) > POINTER_HOPS) return null
      offset = target
      continue
    }
    if ((len & 0xc0) !== 0) return null
    if (len === 0) {
      if (next < 0) next = offset + 1
      break
    }
    if (len > LABEL_MAX || offset + 1 + len > buf.length) return null
    length += len + 1
    if (length > NAME_MAX) return null
    labels.push(decodeLabel(buf.subarray(offset + 1, offset + 1 + len)))
    offset += 1 + len
  }
  return { name: labels.join('.'), next }
}

export function encodeName(name: string): Uint8Array | null {
  const trimmed = name.replace(/\.$/, '')
  const labels = trimmed === '' ? [] : trimmed.split('.')
  const parts: number[] = []
  for (const label of labels) {
    if (label.length === 0 || label.length > LABEL_MAX) return null
    parts.push(label.length)
    for (let i = 0; i < label.length; i += 1) {
      const code = label.charCodeAt(i)
      if (code > 0xff) return null
      parts.push(code)
    }
  }
  parts.push(0)
  return parts.length > NAME_MAX + 1 ? null : Uint8Array.from(parts)
}

// ── records ──────────────────────────────────────────────────────────────

export interface Soa {
  mname: string
  rname: string
  serial: number
  refresh: number
  retry: number
  expire: number
  minimum: number
}

export type DnsRecord =
  | { name: string; type: 'A' | 'AAAA'; ttl: number; address: string }
  | { name: string; type: 'TXT'; ttl: number; text: string }
  | { name: string; type: 'NS'; ttl: number; host: string }
  | { name: string; type: 'SOA'; ttl: number; soa: Soa }

const u16 = (n: number): Uint8Array => Uint8Array.from([(n >> 8) & 0xff, n & 0xff])
const u32 = (n: number): Uint8Array =>
  Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const txtRdata = (text: string): Uint8Array => {
  const bytes = new TextEncoder().encode(text)
  const chunks: Uint8Array[] = []
  for (let at = 0; at < bytes.length || at === 0; at += 255) {
    const chunk = bytes.subarray(at, Math.min(at + 255, bytes.length))
    chunks.push(Uint8Array.from([chunk.length]), chunk)
  }
  return join(chunks)
}

const rdataOf = (record: DnsRecord): Uint8Array | null => {
  if (record.type === 'A' || record.type === 'AAAA') {
    const ip = parseIp(record.address)
    if (ip === null) return null
    if (record.type === 'A' ? ip.family !== 4 : ip.family !== 6) return null
    return ip.bytes
  }
  if (record.type === 'TXT') return txtRdata(record.text)
  if (record.type === 'NS') return encodeName(record.host)
  if (record.type !== 'SOA') return null
  const mname = encodeName(record.soa.mname)
  const rname = encodeName(record.soa.rname)
  if (mname === null || rname === null) return null
  const { serial, refresh, retry, expire, minimum } = record.soa
  return join([mname, rname, u32(serial), u32(refresh), u32(retry), u32(expire), u32(minimum)])
}

const TYPE_OF: Record<DnsRecord['type'], number> = {
  A: DNS_TYPE.A,
  AAAA: DNS_TYPE.AAAA,
  TXT: DNS_TYPE.TXT,
  NS: DNS_TYPE.NS,
  SOA: DNS_TYPE.SOA
}

/** A record on the wire, or null when it names something unencodable. */
export function encodeRecord(record: DnsRecord): Uint8Array | null {
  const name = encodeName(record.name)
  const rdata = rdataOf(record)
  if (name === null || rdata === null) return null
  return join([name, u16(TYPE_OF[record.type]), u16(DNS_CLASS_IN), u32(record.ttl), u16(rdata.length), rdata])
}

/** The OPT pseudo-record: our payload size, version 0, no options, no DO bit. */
const optRecord = (): Uint8Array =>
  join([Uint8Array.from([0]), u16(DNS_TYPE.OPT), u16(EDNS_PAYLOAD), u32(0), u16(0)])

// ── queries ──────────────────────────────────────────────────────────────

export interface DnsQuestion {
  name: string
  type: number
  class: number
}

export interface DnsQuery {
  id: number
  opcode: number
  /** The resolver asked us to recurse. We never do; it is echoed, never obeyed. */
  rd: boolean
  question: DnsQuestion
  /** The UDP payload the query advertised, or null when it carried no OPT. */
  edns: number | null
}

export type ParseFailure = { ok: false; id: number | null; reason: 'formerr' | 'drop' }
export type ParsedQuery = { ok: true; query: DnsQuery } | ParseFailure

/** The OPT record in the additional section, if the query carried one. */
function ednsOf(buf: Uint8Array, from: number, count: number): number | null {
  let at = from
  for (let i = 0; i < count; i += 1) {
    const name = readName(buf, at)
    if (name === null || name.next + 10 > buf.length) return null
    const type = (buf[name.next] << 8) | buf[name.next + 1]
    const payload = (buf[name.next + 2] << 8) | buf[name.next + 3]
    const rdlength = (buf[name.next + 8] << 8) | buf[name.next + 9]
    if (type === DNS_TYPE.OPT) return Math.max(payload, UDP_FLOOR)
    at = name.next + 10 + rdlength
  }
  return null
}

export function parseQuery(buf: Uint8Array): ParsedQuery {
  if (buf.length < HEADER) return { ok: false, id: null, reason: 'drop' }
  const id = (buf[0] << 8) | buf[1]
  const flags = (buf[2] << 8) | buf[3]
  // A RESPONSE arriving at our port is somebody else's conversation, or a
  // reflection attempt. Silence is the only sane answer to it.
  if ((flags & 0x8000) !== 0) return { ok: false, id, reason: 'drop' }
  const qdcount = (buf[4] << 8) | buf[5]
  const ancount = (buf[6] << 8) | buf[7]
  const nscount = (buf[8] << 8) | buf[9]
  const arcount = (buf[10] << 8) | buf[11]
  if (qdcount !== 1) return { ok: false, id, reason: 'formerr' }
  const name = readName(buf, HEADER)
  if (name === null || name.next + 4 > buf.length) return { ok: false, id, reason: 'formerr' }
  const question: DnsQuestion = {
    name: name.name,
    type: (buf[name.next] << 8) | buf[name.next + 1],
    class: (buf[name.next + 2] << 8) | buf[name.next + 3]
  }
  // Only a plain query carries an OPT we can find cheaply; anything with
  // answer or authority records is not a question and is treated as having
  // none, which costs it nothing but the 512-byte floor.
  const edns = ancount === 0 && nscount === 0 ? ednsOf(buf, name.next + 4, arcount) : null
  return {
    ok: true,
    query: { id, opcode: (flags >> 11) & 0xf, rd: (flags & 0x0100) !== 0, question, edns }
  }
}

// ── answers ──────────────────────────────────────────────────────────────

export interface AnswerSpec {
  id: number
  question: DnsQuestion | null
  rcode: number
  /** Authoritative: true for every name inside our zone, false otherwise. */
  aa: boolean
  rd: boolean
  answers?: readonly DnsRecord[]
  authority?: readonly DnsRecord[]
  /** Echo an OPT when the query carried one — otherwise none, per RFC 6891. */
  edns: number | null
  truncated?: boolean
  /** Echoed back, as RFC 1035 requires; we only ever ACT on opcode 0. */
  opcode?: number
}

const headerBytes = (spec: AnswerSpec, counts: readonly [number, number, number]): Uint8Array => {
  // RA IS ALWAYS 0. We are authoritative for one zone and recurse for nobody;
  // a server that claims recursion invites the whole internet to use it.
  const flags =
    0x8000 |
    (((spec.opcode ?? 0) & 0xf) << 11) |
    (spec.aa ? 0x0400 : 0) |
    (spec.truncated === true ? 0x0200 : 0) |
    (spec.rd ? 0x0100 : 0) |
    (spec.rcode & 0xf)
  return join([
    u16(spec.id),
    u16(flags),
    u16(spec.question === null ? 0 : 1),
    u16(counts[0]),
    u16(counts[1]),
    u16(counts[2])
  ])
}

const questionBytes = (question: DnsQuestion | null): Uint8Array | null => {
  if (question === null) return new Uint8Array(0)
  const name = encodeName(question.name)
  return name === null ? null : join([name, u16(question.type), u16(question.class)])
}

/** The message as asked for. Null only when a record in it cannot be encoded. */
export function buildAnswer(spec: AnswerSpec): Uint8Array | null {
  const question = questionBytes(spec.question)
  if (question === null) return null
  const answers: Uint8Array[] = []
  for (const record of spec.answers ?? []) {
    const encoded = encodeRecord(record)
    if (encoded === null) return null
    answers.push(encoded)
  }
  const authority: Uint8Array[] = []
  for (const record of spec.authority ?? []) {
    const encoded = encodeRecord(record)
    if (encoded === null) return null
    authority.push(encoded)
  }
  const additional = spec.edns === null ? [] : [optRecord()]
  return join([
    headerBytes(spec, [answers.length, authority.length, additional.length]),
    question,
    ...answers,
    ...authority,
    ...additional
  ])
}

/** How many bytes this query allows us over UDP. */
export const budgetFor = (edns: number | null): number =>
  edns === null ? UDP_FLOOR : Math.min(Math.max(edns, UDP_FLOOR), EDNS_PAYLOAD)

/**
 * The answer, or the same answer emptied with TC set.
 *
 * The truncated form keeps the header, the question and the OPT and drops
 * every record — a resolver's only job on TC is to come back over TCP, and
 * sending it half a record set is bytes nobody reads. It is also what holds
 * the amplification factor down: the biggest thing a spoofed UDP packet can
 * make us emit is one small answer or this.
 */
export function answerWithin(spec: AnswerSpec, budget: number): Uint8Array | null {
  const full = buildAnswer(spec)
  if (full === null) return null
  if (full.length <= budget) return full
  return buildAnswer({ ...spec, answers: [], authority: [], truncated: true })
}
