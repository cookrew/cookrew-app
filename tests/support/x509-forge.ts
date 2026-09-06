import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'

/**
 * A DER WRITER, AND THE TWO THINGS THE SUITE NEEDS IT FOR.
 *
 * node:crypto can make a key and sign bytes; it cannot write a certificate
 * request and it cannot issue a certificate. Both are needed to drive the cert
 * route end to end without a network and without a checked-in fixture that
 * pins a device id for ever — so the ~150 lines of DER live here, in the tests,
 * where a mistake is a red test rather than a shipped bug.
 *
 * The registry's own CSR reader (registry/src/csr-read.ts) is a READER written
 * from the same RFCs and shares no code with this, which is the point: a CSR
 * built here and parsed there is two independent implementations agreeing.
 */

const tlv = (tag: number, content: Buffer): Buffer => {
  if (content.length < 128) return Buffer.concat([Buffer.from([tag, content.length]), content])
  const bytes: number[] = []
  let length = content.length
  while (length > 0) {
    bytes.unshift(length & 0xff)
    length >>>= 8
  }
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), content])
}

const cat = (...parts: Buffer[]): Buffer => Buffer.concat(parts)

export const DER = {
  seq: (...parts: Buffer[]): Buffer => tlv(0x30, cat(...parts)),
  set: (...parts: Buffer[]): Buffer => tlv(0x31, cat(...parts)),
  bool: (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00])),
  null: (): Buffer => tlv(0x05, Buffer.alloc(0)),
  octet: (content: Buffer): Buffer => tlv(0x04, content),
  utf8: (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8')),
  ia5: (text: string): Buffer => tlv(0x16, Buffer.from(text, 'latin1')),
  bitString: (content: Buffer): Buffer => tlv(0x03, cat(Buffer.from([0]), content)),
  context: (n: number, content: Buffer, constructed = true): Buffer =>
    tlv((constructed ? 0xa0 : 0x80) | n, content),
  int: (value: number | Buffer): Buffer => {
    let bytes: Buffer
    if (typeof value === 'number') {
      const out: number[] = []
      let n = Math.floor(value)
      do {
        out.unshift(n & 0xff)
        n = Math.floor(n / 256)
      } while (n > 0)
      bytes = Buffer.from(out)
    } else {
      bytes = value
    }
    while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) bytes = bytes.subarray(1)
    if ((bytes[0] & 0x80) !== 0) bytes = cat(Buffer.from([0]), bytes)
    return tlv(0x02, bytes)
  },
  oid: (text: string): Buffer => {
    const parts = text.split('.').map(Number)
    const bytes = [parts[0] * 40 + parts[1]]
    for (const part of parts.slice(2)) {
      const chunk: number[] = []
      let n = part
      do {
        chunk.unshift(n & 0x7f)
        n >>>= 7
      } while (n > 0)
      for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80
      bytes.push(...chunk)
    }
    return tlv(0x06, Buffer.from(bytes))
  },
  utcTime: (at: Date): Buffer => {
    const two = (n: number): string => String(n).padStart(2, '0')
    const text =
      two(at.getUTCFullYear() % 100) +
      two(at.getUTCMonth() + 1) +
      two(at.getUTCDate()) +
      two(at.getUTCHours()) +
      two(at.getUTCMinutes()) +
      two(at.getUTCSeconds()) +
      'Z'
    return tlv(0x17, Buffer.from(text, 'latin1'))
  }
}

const OID = {
  cn: '2.5.4.3',
  extensionRequest: '1.2.840.113549.1.9.14',
  san: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  rsaSha256: '1.2.840.113549.1.1.11'
}

const pem = (label: string, der: Buffer): string =>
  `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`

const name = (commonName: string | null): Buffer =>
  commonName === null ? DER.seq() : DER.seq(DER.set(DER.seq(DER.oid(OID.cn), DER.utf8(commonName))))

const sanExtension = (names: readonly string[]): Buffer =>
  DER.seq(
    DER.oid(OID.san),
    DER.octet(DER.seq(...names.map((one) => DER.context(2, Buffer.from(one, 'latin1'), false))))
  )

const spkiOf = (key: KeyObject): Buffer =>
  Buffer.from(key.export({ type: 'spki', format: 'der' }) as Buffer)

const isEc = (key: KeyObject): boolean => key.asymmetricKeyType === 'ec'

const signatureAlgorithm = (key: KeyObject): Buffer =>
  isEc(key) ? DER.seq(DER.oid(OID.ecdsaSha256)) : DER.seq(DER.oid(OID.rsaSha256), DER.null())

export interface Pair {
  privateKey: KeyObject
  publicKey: KeyObject
}

export const ecPair = (): Pair => generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
export const rsaPair = (bits = 2048): Pair => generateKeyPairSync('rsa', { modulusLength: bits })

/** A PEM certificate request for these dNSNames, signed by its own key. */
export function makeCsr(options: { pair: Pair; names: readonly string[]; commonName?: string | null }): string {
  const attributes =
    options.names.length === 0
      ? DER.context(0, Buffer.alloc(0))
      : DER.context(
          0,
          DER.seq(DER.oid(OID.extensionRequest), DER.set(DER.seq(sanExtension(options.names))))
        )
  const info = DER.seq(
    DER.int(0),
    name(options.commonName === undefined ? null : options.commonName),
    spkiOf(options.pair.publicKey),
    attributes
  )
  const signature = sign('sha256', info, options.pair.privateKey)
  return pem('CERTIFICATE REQUEST', DER.seq(info, signatureAlgorithm(options.pair.privateKey), DER.bitString(signature)))
}

export interface Ca {
  pair: Pair
  certificate: string
}

/** A one-off root, made per test run. It signs leaves and nothing else. */
export function makeCa(commonName = 'Cookrew Test CA'): Ca {
  const pair = ecPair()
  const now = new Date()
  const tbs = DER.seq(
    DER.context(0, DER.int(2)),
    DER.int(1),
    signatureAlgorithm(pair.privateKey),
    name(commonName),
    DER.seq(DER.utcTime(new Date(now.getTime() - 86400_000)), DER.utcTime(new Date(now.getTime() + 3650 * 86400_000))),
    name(commonName),
    spkiOf(pair.publicKey),
    DER.context(3, DER.seq(DER.seq(DER.oid(OID.basicConstraints), DER.bool(true), DER.octet(DER.seq(DER.bool(true))))))
  )
  const signature = sign('sha256', tbs, pair.privateKey)
  return {
    pair,
    certificate: pem('CERTIFICATE', DER.seq(tbs, signatureAlgorithm(pair.privateKey), DER.bitString(signature)))
  }
}

/** A leaf for these names, signed by the CA. Returned with the CA appended. */
export function issueLeaf(options: {
  ca: Ca
  spki: Buffer
  names: readonly string[]
  serial: number
  notBefore: Date
  notAfter: Date
}): string {
  const tbs = DER.seq(
    DER.context(0, DER.int(2)),
    DER.int(options.serial),
    signatureAlgorithm(options.ca.pair.privateKey),
    name('Cookrew Test CA'),
    DER.seq(DER.utcTime(options.notBefore), DER.utcTime(options.notAfter)),
    name(options.names[0] ?? 'leaf'),
    options.spki,
    DER.context(3, DER.seq(sanExtension(options.names)))
  )
  const signature = sign('sha256', tbs, options.ca.pair.privateKey)
  const leaf = pem('CERTIFICATE', DER.seq(tbs, signatureAlgorithm(options.ca.pair.privateKey), DER.bitString(signature)))
  return `${leaf}${options.ca.certificate}`
}

/** The SubjectPublicKeyInfo out of a CSR, so a fake CA can certify that key. */
export function spkiFromCsr(csrPem: string): Buffer {
  const der = Buffer.from(csrPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
  // CertificationRequest → CertificationRequestInfo → [version, subject, spki]
  const readOne = (buf: Buffer, at: number): { content: Buffer; whole: Buffer; next: number } => {
    const first = buf[at + 1]
    let length = first
    let headerEnd = at + 2
    if ((first & 0x80) !== 0) {
      const count = first & 0x7f
      length = 0
      for (let i = 0; i < count; i += 1) length = length * 256 + buf[headerEnd + i]
      headerEnd += count
    }
    return { content: buf.subarray(headerEnd, headerEnd + length), whole: buf.subarray(at, headerEnd + length), next: headerEnd + length }
  }
  const request = readOne(der, 0)
  const info = readOne(request.content, 0)
  const version = readOne(info.content, 0)
  const subject = readOne(info.content, version.next)
  return Buffer.from(readOne(info.content, subject.next).whole)
}

export const keyFromPem = (text: string): KeyObject => createPrivateKey(text)
