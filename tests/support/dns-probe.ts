import { createSocket } from 'node:dgram'
import { connect } from 'node:net'

/**
 * A SECOND, INDEPENDENT DNS IMPLEMENTATION — the one the tests speak.
 *
 * Deliberately not `registry/src/dns-wire`: a round trip through the same
 * encoder and decoder proves only that they agree with each other. This one is
 * written from RFC 1035 directly, so a mistake in the shipped file shows up as
 * a disagreement rather than as a matching pair of bugs.
 *
 * It is a test helper and knows it: it assumes well-formed input from our own
 * server and throws when surprised, which is exactly what a test wants.
 */

export const T = { A: 1, NS: 2, SOA: 6, TXT: 16, AAAA: 28, OPT: 41, ANY: 255, AXFR: 252 } as const

export interface ProbeQuery {
  name: string
  type: number
  /** Ask with an EDNS0 OPT advertising this payload size. Omit for plain 512. */
  edns?: number
  id?: number
  /** Recursion Desired, so a test can prove RA never comes back set. */
  rd?: boolean
  /** Deliberately wrong class, for the REFUSED case. */
  klass?: number
}

const name = (text: string): Buffer => {
  const labels = text === '' ? [] : text.split('.')
  const parts = labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'latin1')]))
  return Buffer.concat([...parts, Buffer.from([0])])
}

export function buildQuery(query: ProbeQuery): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(query.id ?? 0x4242, 0)
  header.writeUInt16BE(query.rd === true ? 0x0100 : 0, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(0, 10 - 4)
  header.writeUInt16BE(query.edns === undefined ? 0 : 1, 10)
  const question = Buffer.concat([name(query.name), Buffer.alloc(4)])
  question.writeUInt16BE(query.type, question.length - 4)
  question.writeUInt16BE(query.klass ?? 1, question.length - 2)
  if (query.edns === undefined) return Buffer.concat([header, question])
  const opt = Buffer.alloc(11)
  opt.writeUInt8(0, 0)
  opt.writeUInt16BE(T.OPT, 1)
  opt.writeUInt16BE(query.edns, 3)
  opt.writeUInt32BE(0, 5)
  opt.writeUInt16BE(0, 9)
  return Buffer.concat([header, question, opt])
}

/**
 * A NAME SPLIT ACROSS A BACKWARD COMPRESSION POINTER.
 *
 * Not a query: a well-formed query's question starts at offset 12 with nothing
 * before it to point at, so a compressed QUESTION cannot exist and our parser
 * refuses the forward pointer that would fake one. This builds the shape that
 * DOES occur — a suffix written once, and a later name whose tail points back
 * at it — so `readName` can be driven over it directly.
 */
export function buildPointerFixture(prefix: string, suffix: string): { message: Buffer; at: number } {
  const header = Buffer.alloc(12)
  const suffixBytes = name(suffix)
  const labels = prefix.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'latin1')]))
  const pointer = Buffer.alloc(2)
  pointer.writeUInt16BE(0xc000 | header.length, 0)
  return {
    message: Buffer.concat([header, suffixBytes, ...labels, pointer]),
    at: header.length + suffixBytes.length
  }
}

export interface ProbeRecord {
  name: string
  type: number
  klass: number
  ttl: number
  data: string
}

export interface ProbeAnswer {
  id: number
  qr: boolean
  aa: boolean
  tc: boolean
  rd: boolean
  ra: boolean
  rcode: number
  question: { name: string; type: number; klass: number } | null
  answers: ProbeRecord[]
  authority: ProbeRecord[]
  additional: ProbeRecord[]
  /** The OPT record's advertised payload, when one came back. */
  edns: number | null
}

const readName = (buf: Buffer, at: number): [string, number] => {
  const labels: string[] = []
  let offset = at
  let next = -1
  for (let guard = 0; guard < 128; guard += 1) {
    const len = buf[offset]
    if ((len & 0xc0) === 0xc0) {
      if (next < 0) next = offset + 2
      offset = ((len & 0x3f) << 8) | buf[offset + 1]
      continue
    }
    if (len === 0) {
      if (next < 0) next = offset + 1
      return [labels.join('.'), next]
    }
    labels.push(buf.subarray(offset + 1, offset + 1 + len).toString('latin1'))
    offset += 1 + len
  }
  throw new Error('name loop')
}

const rdataText = (type: number, rdata: Buffer): string => {
  if (type === T.A) return [...rdata].join('.')
  if (type === T.AAAA) {
    const parts: string[] = []
    for (let i = 0; i < 16; i += 2) parts.push(rdata.readUInt16BE(i).toString(16))
    return parts.join(':')
  }
  if (type === T.TXT) {
    let out = ''
    let at = 0
    while (at < rdata.length) {
      const len = rdata[at]
      out += rdata.subarray(at + 1, at + 1 + len).toString('utf8')
      at += 1 + len
    }
    return out
  }
  // Our encoder never compresses, so an NS name is whole inside its own rdata.
  if (type === T.NS) return readName(rdata, 0)[0]
  if (type === T.SOA) {
    const [mname, afterM] = readName(rdata, 0)
    const [rname, afterR] = readName(rdata, afterM)
    const nums: number[] = []
    for (let i = 0; i < 5; i += 1) nums.push(rdata.readUInt32BE(afterR + i * 4))
    return `${mname} ${rname} ${nums.join(' ')}`
  }
  return rdata.toString('hex')
}

export function parseAnswer(buf: Buffer): ProbeAnswer {
  const id = buf.readUInt16BE(0)
  const flags = buf.readUInt16BE(2)
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)]
  let at = 12
  let question: ProbeAnswer['question'] = null
  if (counts[0] === 1) {
    const [qname, next] = readName(buf, at)
    question = { name: qname, type: buf.readUInt16BE(next), klass: buf.readUInt16BE(next + 2) }
    at = next + 4
  }
  const section = (n: number): ProbeRecord[] => {
    const out: ProbeRecord[] = []
    for (let i = 0; i < n; i += 1) {
      const [rname, next] = readName(buf, at)
      const type = buf.readUInt16BE(next)
      const klass = buf.readUInt16BE(next + 2)
      const ttl = buf.readUInt32BE(next + 4)
      const length = buf.readUInt16BE(next + 8)
      const rdata = buf.subarray(next + 10, next + 10 + length)
      out.push({ name: rname, type, klass, ttl, data: rdataText(type, rdata) })
      at = next + 10 + length
    }
    return out
  }
  const answers = section(counts[1])
  const authority = section(counts[2])
  const additional = section(counts[3])
  return {
    id,
    qr: (flags & 0x8000) !== 0,
    aa: (flags & 0x0400) !== 0,
    tc: (flags & 0x0200) !== 0,
    rd: (flags & 0x0100) !== 0,
    ra: (flags & 0x0080) !== 0,
    rcode: flags & 0xf,
    question,
    answers,
    authority,
    additional,
    edns: additional.find((r) => r.type === T.OPT)?.klass ?? null
  }
}

/** One question over UDP. Resolves with the raw datagram, or null on timeout. */
export function askUdp(port: number, message: Buffer, timeoutMs = 700): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const done = (value: Buffer | null): void => {
      clearTimeout(timer)
      socket.close()
      resolve(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    socket.on('message', (reply) => done(reply))
    socket.on('error', () => done(null))
    socket.send(message, port, '127.0.0.1')
  })
}

/** One question over TCP, with the two-byte length prefix on both directions. */
export function askTcp(port: number, message: Buffer, timeoutMs = 1500): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let held = Buffer.alloc(0)
    const done = (value: Buffer | null): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => done(null))
    socket.on('error', () => done(null))
    socket.on('connect', () => {
      const framed = Buffer.alloc(2 + message.length)
      framed.writeUInt16BE(message.length, 0)
      message.copy(framed, 2)
      socket.write(framed)
    })
    socket.on('data', (chunk) => {
      held = Buffer.concat([held, chunk])
      if (held.length < 2) return
      const length = held.readUInt16BE(0)
      if (held.length >= 2 + length) done(held.subarray(2, 2 + length))
    })
    socket.on('close', () => resolve(null))
  })
}
