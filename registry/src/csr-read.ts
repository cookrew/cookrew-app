import { createPublicKey, verify } from 'node:crypto'

/**
 * WHAT A CERTIFICATE REQUEST ACTUALLY ASKS FOR.
 *
 * node:crypto can make keys, sign, and read a finished X.509 — it cannot read
 * a CSR. So the registry would be forwarding an opaque blob to a CA and
 * hoping, which is precisely the thing it must not do: the CSR is the only
 * place the NAMES are written, and the whole gate on this route is "you may
 * only ask for `*.<your own device id>.<zone>` and nothing else".
 *
 * Hence a DER walker. Deliberately small and deliberately strict — it reads
 * the four facts the gate needs (subject CN, dNSName SANs, key type, key size)
 * and refuses anything it does not fully understand. A parser that guesses is
 * worse than no parser, because the guess is what ends up in a public
 * certificate under our domain.
 *
 * IT ALSO CHECKS THE SIGNATURE. A CSR is a proof that whoever sent it holds
 * the private key; one whose self-signature does not verify is not that proof,
 * whatever names it carries. The CA would catch it too — after we had spent an
 * order and an in-flight slot on it.
 */

const OID_CN = '2.5.4.3'
const OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14'
const OID_SAN = '2.5.29.17'
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1'
const OID_P256 = '1.2.840.10045.3.1.7'
const OID_RSA = '1.2.840.113549.1.1.1'

/** Signature algorithms we will read. PSS is refused rather than mis-verified. */
const SIGNATURES: Record<string, string> = {
  '1.2.840.10045.4.3.2': 'sha256', // ecdsa-with-SHA256
  '1.2.840.10045.4.3.3': 'sha384', // ecdsa-with-SHA384
  '1.2.840.113549.1.1.11': 'sha256', // sha256WithRSAEncryption
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512'
}

const CSR_MAX = 8 * 1024
const SEQUENCE = 0x30
const SET = 0x31
const INTEGER = 0x02
const BIT_STRING = 0x03
const OCTET_STRING = 0x04
const OID_TAG = 0x06
const CONTEXT_0 = 0xa0
/** [2] IMPLICIT IA5String inside GeneralNames — a dNSName. */
const GENERAL_NAME_DNS = 0x82

// ── a very small DER reader ──────────────────────────────────────────────

interface Tlv {
  tag: number
  /** The whole element, header included — what a signature is computed over. */
  whole: Uint8Array
  content: Uint8Array
  /** Where the next element starts. */
  next: number
}

function read(buf: Uint8Array, at: number): Tlv | null {
  if (at + 2 > buf.length) return null
  const tag = buf[at]
  const first = buf[at + 1]
  let length = first
  let headerEnd = at + 2
  if ((first & 0x80) !== 0) {
    const count = first & 0x7f
    // Indefinite length is BER, not DER, and four length bytes is already a
    // 4 GB element. Both are somebody else's file, not ours.
    if (count === 0 || count > 4 || headerEnd + count > buf.length) return null
    length = 0
    for (let i = 0; i < count; i += 1) length = length * 256 + buf[headerEnd + i]
    headerEnd += count
  }
  const end = headerEnd + length
  if (end > buf.length) return null
  return { tag, whole: buf.subarray(at, end), content: buf.subarray(headerEnd, end), next: end }
}

function children(tlv: Tlv): Tlv[] | null {
  const out: Tlv[] = []
  let at = 0
  while (at < tlv.content.length) {
    const child = read(tlv.content, at)
    if (child === null) return null
    out.push(child)
    at = child.next
  }
  return out
}

function oidOf(tlv: Tlv): string | null {
  if (tlv.tag !== OID_TAG || tlv.content.length === 0) return null
  const bytes = tlv.content
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40]
  let value = 0
  for (let i = 1; i < bytes.length; i += 1) {
    value = value * 128 + (bytes[i] & 0x7f)
    if ((bytes[i] & 0x80) === 0) {
      parts.push(value)
      value = 0
    }
  }
  return parts.join('.')
}

// ── the facts the gate needs ─────────────────────────────────────────────

export type CsrKey = { kind: 'ec'; curve: string } | { kind: 'rsa'; bits: number }

export interface CsrFacts {
  /** The subject's common name, or null when there is none — which is fine. */
  commonName: string | null
  /** dNSName SANs, lowercased, in the order the CSR lists them. */
  dnsNames: readonly string[]
  key: CsrKey
  der: Uint8Array
}

export type CsrRead = { ok: true; csr: CsrFacts } | { ok: false; reason: string }

const bad = (reason: string): CsrRead => ({ ok: false, reason })

/** PEM to DER, with the header a CSR is allowed to carry and no other. */
export function csrDer(pem: unknown): Uint8Array | null {
  if (typeof pem !== 'string' || pem.length === 0 || pem.length > CSR_MAX) return null
  const found = /-----BEGIN (?:NEW )?CERTIFICATE REQUEST-----([A-Za-z0-9+/=\s]+)-----END (?:NEW )?CERTIFICATE REQUEST-----/.exec(
    pem
  )
  if (found === null) return null
  const der = Buffer.from(found[1].replace(/\s+/g, ''), 'base64')
  return der.length === 0 || der.length > CSR_MAX ? null : new Uint8Array(der)
}

const commonNameOf = (subject: Tlv): string | null => {
  for (const rdn of children(subject) ?? []) {
    if (rdn.tag !== SET) continue
    for (const pair of children(rdn) ?? []) {
      const parts = children(pair)
      if (parts === null || parts.length < 2) continue
      if (oidOf(parts[0]) === OID_CN) return Buffer.from(parts[1].content).toString('utf8')
    }
  }
  return null
}

const keyOf = (spki: Tlv): CsrKey | null => {
  const parts = children(spki)
  if (parts === null || parts.length !== 2 || parts[1].tag !== BIT_STRING) return null
  const algorithm = children(parts[0])
  if (algorithm === null || algorithm.length === 0) return null
  const kind = oidOf(algorithm[0])
  if (kind === OID_EC_PUBLIC_KEY) {
    const curve = algorithm.length > 1 ? oidOf(algorithm[1]) : null
    return curve === null ? null : { kind: 'ec', curve: curve === OID_P256 ? 'P-256' : curve }
  }
  if (kind !== OID_RSA) return null
  // The BIT STRING's first content byte is the count of unused bits (0 here).
  const inner = read(parts[1].content.subarray(1), 0)
  if (inner === null || inner.tag !== SEQUENCE) return null
  const rsa = children(inner)
  if (rsa === null || rsa.length < 1 || rsa[0].tag !== INTEGER) return null
  // A leading zero is DER's sign byte, not a bit of the modulus.
  const modulus = rsa[0].content[0] === 0 ? rsa[0].content.subarray(1) : rsa[0].content
  return { kind: 'rsa', bits: modulus.length * 8 }
}

const sansOf = (attributes: Tlv): string[] | null => {
  const out: string[] = []
  for (const attribute of children(attributes) ?? []) {
    const parts = children(attribute)
    if (parts === null || parts.length !== 2) continue
    if (oidOf(parts[0]) !== OID_EXTENSION_REQUEST) continue
    for (const set of children(parts[1]) ?? []) {
      if (set.tag !== SEQUENCE) continue
      for (const extension of children(set) ?? []) {
        const fields = children(extension)
        if (fields === null || fields.length < 2) continue
        if (oidOf(fields[0]) !== OID_SAN) continue
        const value = fields[fields.length - 1]
        if (value.tag !== OCTET_STRING) return null
        const names = read(value.content, 0)
        if (names === null || names.tag !== SEQUENCE) return null
        for (const name of children(names) ?? []) {
          // ONLY dNSName. An IP, an email or a URI in a SAN is a name we would
          // be asking a public CA to certify without ever having checked it.
          if (name.tag !== GENERAL_NAME_DNS) return null
          out.push(Buffer.from(name.content).toString('utf8').toLowerCase())
        }
      }
    }
  }
  return out
}

/**
 * A CSR's names and key, or a one-word reason. Never throws: this runs on a
 * body somebody POSTed.
 */
export function readCsr(pem: unknown): CsrRead {
  const der = csrDer(pem)
  if (der === null) return bad('not a PEM certificate request')
  const request = read(der, 0)
  if (request === null || request.tag !== SEQUENCE) return bad('not a DER SEQUENCE')
  const top = children(request)
  if (top === null || top.length !== 3) return bad('not a CertificationRequest')
  const [info, algorithm, signature] = top
  if (info.tag !== SEQUENCE || signature.tag !== BIT_STRING) return bad('not a CertificationRequest')

  const fields = children(info)
  if (fields === null || fields.length < 3) return bad('unreadable request info')
  const [, subject, spki] = fields
  const key = keyOf(spki)
  if (key === null) return bad('unreadable public key')
  const attributes = fields.find((field) => field.tag === CONTEXT_0)
  const dnsNames = attributes === undefined ? [] : sansOf(attributes)
  if (dnsNames === null) return bad('unreadable subject alternative names')

  // `?? []` AND a length check, because `30 00` is a legal DER SEQUENCE with
  // nothing in it: `children` answers an empty array, not null, and indexing
  // [0] of that hands `undefined` to a reader whose docblock promises never to
  // throw — inside a route that has already told the caller nothing.
  const algorithmParts = children(algorithm) ?? []
  if (algorithmParts.length === 0) return bad('unsupported signature algorithm')
  const hash = SIGNATURES[oidOf(algorithmParts[0]) ?? '']
  if (hash === undefined) return bad('unsupported signature algorithm')
  try {
    const publicKey = createPublicKey({ key: Buffer.from(spki.whole), format: 'der', type: 'spki' })
    // The BIT STRING's leading byte is the unused-bit count; the rest is the
    // signature over the DER of CertificationRequestInfo exactly as it arrived.
    if (!verify(hash, Buffer.from(info.whole), publicKey, Buffer.from(signature.content.subarray(1)))) {
      return bad('the request is not signed by its own key')
    }
  } catch {
    return bad('the request is not signed by its own key')
  }

  return { ok: true, csr: { commonName: commonNameOf(subject), dnsNames, key, der } }
}
