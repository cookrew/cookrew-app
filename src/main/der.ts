/**
 * A MINIMAL DER WRITER, AND WHY THIS FILE HAD TO EXIST.
 *
 * node:crypto can make a key and sign bytes; it cannot write a certificate
 * request. The only alternatives were shelling out to `openssl req` — which
 * would put this Mac's private key on a command line and into a child process
 * for no gain, since the key must stay here — or adding a dependency whose
 * whole job is 200 lines of tag-length-value.
 *
 * SCOPE: writing only, and only the handful of types a CSR is made of. There
 * is no reader here on purpose. The thing that READS a request is the registry
 * (registry/src/csr-read.ts), written from the same RFCs and sharing no code
 * with this — so a request built here and accepted there is two independent
 * implementations agreeing, which is worth more than one shared helper.
 *
 * DER, not BER: definite lengths, shortest form, no indefinite encoding. Every
 * function here produces the one canonical spelling, because a signature is
 * over BYTES and a second spelling of the same value is a different signature.
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

const cat = (parts: readonly Buffer[]): Buffer => Buffer.concat([...parts])

/** SEQUENCE — the shape almost everything in a request is. */
export const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, cat(parts))

/** SET — an RDN's one-or-more attribute values, and the attribute's values. */
export const set = (...parts: Buffer[]): Buffer => tlv(0x31, cat(parts))

/** INTEGER, minimal two's-complement with DER's sign byte when needed. */
export const integer = (value: number): Buffer => {
  const out: number[] = []
  let n = Math.floor(Math.abs(value))
  do {
    out.unshift(n & 0xff)
    n = Math.floor(n / 256)
  } while (n > 0)
  let bytes = Buffer.from(out)
  // A leading 0x80-or-more byte would read as negative; DER prefixes a zero.
  if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return tlv(0x02, bytes)
}

export const utf8String = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'))

/**
 * PrintableString. Kept for the one place a CSR may want it — and refusing
 * anything outside the printable set rather than writing a lie about the tag,
 * because a reader that trusts the tag would then read bytes it cannot.
 */
const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]*$/
export const printableString = (text: string): Buffer | null =>
  PRINTABLE.test(text) ? tlv(0x13, Buffer.from(text, 'latin1')) : null

/** OCTET STRING, which is how an extension carries its own DER. */
export const octetString = (content: Buffer): Buffer => tlv(0x04, content)

/** BIT STRING with no unused bits — the only form anything here produces. */
export const bitString = (content: Buffer): Buffer =>
  tlv(0x03, Buffer.concat([Buffer.from([0]), content]))

/**
 * A context tag: `[n]`. Constructed for a wrapper such as a CSR's attributes;
 * primitive when the field is IMPLICIT — an IMPLICIT tag REPLACES the value's
 * own tag rather than wrapping it, which is how a dNSName (`[2] IMPLICIT
 * IA5String`) is written with no IA5String tag anywhere in the bytes.
 */
export const context = (n: number, content: Buffer, constructed = true): Buffer =>
  tlv((constructed ? 0xa0 : 0x80) | n, content)

/** OBJECT IDENTIFIER from dotted decimal. Two first arcs pack into one byte. */
export const oid = (text: string): Buffer => {
  const parts = text.split('.').map(Number)
  if (parts.length < 2 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`not an object identifier: ${text}`)
  }
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
}

/** DER to PEM, wrapped at 64 characters as every tool expects to read it. */
export const pem = (label: string, der: Buffer): string => {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}
