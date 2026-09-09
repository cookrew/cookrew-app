import { describe, expect, it } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { csrDer, readCsr } from '../registry/src/csr-read'
import { DER, ecPair, issueLeaf, makeCa, makeCsr, paddedRsaSpki, rsaPair, spkiFromCsr } from './support/x509-forge'

/**
 * THE CSR READER, AGAINST REQUESTS BUILT BY A DIFFERENT IMPLEMENTATION.
 *
 * The reader is the gate on the whole cert route: it decides which names the
 * registry will ask a public CA to certify under cookrew.dev. So it is driven
 * with requests written by the suite's own DER writer, which shares no code
 * with it, and with requests that have been tampered with afterwards.
 */

const NAME = '*.abcd1234-aaaa-bbbb-cccc-000000000001.d.cookrew.dev'

describe('reading a certificate request', () => {
  it('reads the SANs, the CN and an EC P-256 key', () => {
    const out = readCsr(makeCsr({ pair: ecPair(), names: [NAME] }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.csr.dnsNames).toEqual([NAME])
    expect(out.csr.commonName).toBeNull()
    expect(out.csr.key).toEqual({ kind: 'ec', curve: 'P-256' })
    expect(out.csr.der.length).toBeGreaterThan(100)
  })

  it('reads a CN when one is there, and an RSA modulus size', () => {
    const out = readCsr(makeCsr({ pair: rsaPair(2048), names: [NAME], commonName: NAME }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.csr.commonName).toBe(NAME)
    expect(out.csr.key).toEqual({ kind: 'rsa', bits: 2048 })
  })

  it('reads several SANs in order, and none at all', () => {
    const many = readCsr(makeCsr({ pair: ecPair(), names: [NAME, 'a.example.test'] }))
    expect(many.ok && many.csr.dnsNames).toEqual([NAME, 'a.example.test'])
    const none = readCsr(makeCsr({ pair: ecPair(), names: [] }))
    expect(none.ok && none.csr.dnsNames).toEqual([])
  })

  it('refuses a request whose signature no longer covers its names', () => {
    const pem = makeCsr({ pair: ecPair(), names: [NAME] })
    const der = Buffer.from(csrDer(pem)!)
    // Flip one character of the name: the bytes still parse, the proof does not.
    const at = der.indexOf(Buffer.from('cookrew', 'latin1'))
    expect(at).toBeGreaterThan(0)
    der[at] = der[at] ^ 0x01
    const tampered = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----\n`
    const out = readCsr(tampered)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('signed')
  })

  it('refuses what is not a request at all, without throwing', () => {
    for (const bad of [undefined, null, 42, '', 'hello', '-----BEGIN CERTIFICATE REQUEST-----\nZm9v\n-----END CERTIFICATE REQUEST-----']) {
      expect(readCsr(bad as unknown).ok).toBe(false)
    }
    // A PEM of the right shape carrying somebody else's DER.
    const ca = makeCa()
    const asRequest = ca.certificate
      .replace('BEGIN CERTIFICATE', 'BEGIN CERTIFICATE REQUEST')
      .replace('END CERTIFICATE', 'END CERTIFICATE REQUEST')
    expect(readCsr(asRequest).ok).toBe(false)
  })

  it('refuses a request bigger than any real one', () => {
    expect(csrDer(`-----BEGIN CERTIFICATE REQUEST-----\n${'A'.repeat(20000)}\n-----END CERTIFICATE REQUEST-----`)).toBeNull()
  })
})

describe('the forged CA, so the issuance test rests on something real', () => {
  it('issues a leaf node:crypto itself can parse', () => {
    const ca = makeCa()
    const csr = makeCsr({ pair: ecPair(), names: [NAME] })
    const notAfter = new Date(Date.now() + 90 * 86400_000)
    const chain = issueLeaf({
      ca,
      spki: spkiFromCsr(csr),
      names: [NAME],
      serial: 12345,
      notBefore: new Date(Date.now() - 3600_000),
      notAfter
    })
    expect(chain.split('BEGIN CERTIFICATE').length - 1).toBe(2)
    const leaf = new X509Certificate(chain)
    expect(leaf.subjectAltName).toContain(NAME)
    // Seconds, because a UTCTime has no milliseconds in it.
    expect(Math.abs(new Date(leaf.validTo).getTime() - notAfter.getTime())).toBeLessThan(1000)
  })
})

/**
 * H1 — THE PARSER'S PROMISE. Its docblock says it never throws, and the route
 * above it answers a body somebody POSTed. An element the reader reaches into
 * without checking that anything is there is the one shape that breaks both.
 */
describe('a request built to break the reader', () => {
  /** The three top-level elements of a CertificationRequest, as raw bytes. */
  const read = (buf: Buffer, at: number): { whole: Buffer; content: Buffer; next: number } => {
    const first = buf[at + 1]
    let length = first
    let headerEnd = at + 2
    if ((first & 0x80) !== 0) {
      const count = first & 0x7f
      length = 0
      for (let i = 0; i < count; i += 1) length = length * 256 + buf[headerEnd + i]
      headerEnd += count
    }
    return {
      whole: buf.subarray(at, headerEnd + length),
      content: buf.subarray(headerEnd, headerEnd + length),
      next: headerEnd + length
    }
  }
  const split = (pem: string): Buffer[] => {
    const body = read(Buffer.from(csrDer(pem)!), 0).content
    const info = read(body, 0)
    const algorithm = read(body, info.next)
    const signature = read(body, algorithm.next)
    return [info.whole, algorithm.whole, signature.whole]
  }
  const rewrap = (parts: readonly Buffer[]): string =>
    `-----BEGIN CERTIFICATE REQUEST-----\n${DER.seq(...parts).toString('base64')}\n-----END CERTIFICATE REQUEST-----\n`

  it('refuses an EMPTY signatureAlgorithm sequence rather than throwing', () => {
    const [info, , signature] = split(makeCsr({ pair: ecPair(), names: [NAME] }))
    // `30 00` — a well-formed SEQUENCE with nothing in it. The reader used to
    // index [0] of that and die inside a route with a response half written.
    const out = readCsr(rewrap([info, Buffer.from([0x30, 0x00]), signature]))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('unsupported signature algorithm')
  })

  it('refuses a signatureAlgorithm whose first element is not an OID', () => {
    const [info, , signature] = split(makeCsr({ pair: ecPair(), names: [NAME] }))
    for (const algorithm of [DER.seq(DER.int(1)), DER.seq(DER.null()), DER.seq(DER.seq())]) {
      expect(readCsr(rewrap([info, algorithm, signature])).ok).toBe(false)
    }
  })

  it('keeps the round trip intact when nothing was tampered with', () => {
    const pem = makeCsr({ pair: ecPair(), names: [NAME] })
    expect(readCsr(rewrap(split(pem))).ok).toBe(true)
  })
})

/**
 * L3 — A KEY'S SIZE IS ARITHMETIC, NOT A BYTE COUNT.
 *
 * The modulus was measured by the length of its DER encoding, and DER as
 * OpenSSL accepts it is not minimal: left-pad the INTEGER with zeros and a
 * 1024-bit key reads as 2056 bits. It verifies its own signature, so every
 * other check on the way through passes, and the gate in names.ts waves a key
 * half the size it demands straight into a public certificate.
 */
describe('how big the key actually is', () => {
  it('reads the modulus length from the key, not from how it was written', () => {
    const pair = rsaPair(1024)
    const out = readCsr(makeCsr({ pair, names: [NAME], spki: paddedRsaSpki(pair.publicKey) }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.csr.key).toEqual({ kind: 'rsa', bits: 1024 })
  })

  it('still reads an ordinary 2048-bit request as 2048', () => {
    const out = readCsr(makeCsr({ pair: rsaPair(2048), names: [NAME] }))
    expect(out.ok && out.csr.key).toEqual({ kind: 'rsa', bits: 2048 })
  })
})
