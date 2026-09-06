import { execFileSync } from 'node:child_process'
import { createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildCsr, mintNameKey } from '../src/main/csr-build'
import { bitString, integer, oid, octetString, pem, sequence } from '../src/main/der'
import { DEFAULT_NAME_ZONE, wildcardFor } from '../src/shared/reach-names'

/**
 * TWO INDEPENDENT READERS, because the writer cannot check itself.
 *
 * The registry's own parser (registry/src/csr-read.ts) lives in another
 * process and another branch, so the honest substitute here is OpenSSL —
 * which is what a CA's parser is, at one remove — plus a re-read with
 * node:crypto. A request that both of them agree about is one the registry's
 * DER walker will agree about too; a request only our own code can read would
 * prove nothing at all.
 */

const MAC = '3f2b9c14-7a55-4d2e-9d0f-1c8e6b4a7f30'
const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-csr-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const openssl = (args: string[]): string => execFileSync('openssl', args, { encoding: 'utf8' })

const writeCsr = (name: string, text: string): string => {
  const file = path.join(dir, name)
  writeFileSync(file, text)
  return file
}

describe('the certificate request this Mac sends', () => {
  const pair = mintNameKey()
  const wildcard = wildcardFor(MAC) as string
  const csr = buildCsr({ ...pair, names: [wildcard] })

  it('is a PEM certificate request OpenSSL will read', () => {
    expect(csr.startsWith('-----BEGIN CERTIFICATE REQUEST-----')).toBe(true)
    const text = openssl(['req', '-in', writeCsr('one.pem', csr), '-noout', '-text'])
    expect(text).toContain('Certificate Request')
    expect(text).toContain('id-ecPublicKey')
    expect(text).toContain('prime256v1')
    expect(text).toContain('ecdsa-with-SHA256')
  })

  it('names exactly the wildcard, as a dNSName, and nothing else', () => {
    const text = openssl(['req', '-in', writeCsr('two.pem', csr), '-noout', '-text'])
    expect(text).toContain(`DNS:${wildcard}`)
    // One SAN. `*.<id>.<zone>` and a second name is the request the registry
    // refuses, and a builder that quietly added one would be found only there.
    expect(text.match(/DNS:/g)).toHaveLength(1)
    expect(text).not.toContain('IP Address:')
    // No CN: the registry accepts none or the wildcard, and none is honest.
    expect(text).toMatch(/Subject:\s*\n/)
  })

  it('is signed by its own key', () => {
    const verified = openssl(['req', '-in', writeCsr('three.pem', csr), '-noout', '-verify'])
    expect(verified.toLowerCase()).toContain('verify ok')
  })

  it('carries a common name when one is asked for, and only then', () => {
    const named = buildCsr({ ...pair, names: [wildcard], commonName: wildcard })
    const text = openssl(['req', '-in', writeCsr('four.pem', named), '-noout', '-text'])
    expect(text).toMatch(new RegExp(`CN\\s*=\\s*\\*\\.${MAC}\\.${DEFAULT_NAME_ZONE.replace(/\./g, '\\.')}`))
    expect(text).toContain(`DNS:${wildcard}`)
    expect(openssl(['req', '-in', writeCsr('five.pem', named), '-noout', '-verify']).toLowerCase())
      .toContain('verify ok')
  })

  it('refuses to build a request that names nothing', () => {
    expect(() => buildCsr({ ...pair, names: [] })).toThrow(/name/)
  })

  it('publishes the key the private key belongs to', () => {
    // Re-read the SPKI OpenSSL prints back out of the request, and check it is
    // this pair's public key rather than merely a well-formed one.
    const printed = openssl(['req', '-in', writeCsr('six.pem', csr), '-noout', '-pubkey'])
    const fromCsr = createPublicKey(printed)
    expect(fromCsr.export({ type: 'spki', format: 'der' })).toEqual(
      pair.publicKey.export({ type: 'spki', format: 'der' })
    )
    // And the signature over CertificationRequestInfo verifies with it.
    const der = Buffer.from(csr.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
    const info = readInfo(der)
    expect(verify('sha256', info.info, fromCsr, info.signature)).toBe(true)
  })

  it('builds the same request bytes twice, with a fresh signature each time', () => {
    // A second request for the same names is a DIFFERENT signature (ECDSA is
    // randomised) but the same info bytes — so a cached CSR is never wrong.
    const again = buildCsr({ ...pair, names: [wildcard] })
    expect(again).not.toBe(csr)
    const a = readInfo(Buffer.from(csr.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'))
    const b = readInfo(Buffer.from(again.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'))
    expect(a.info.equals(b.info)).toBe(true)
  })
})

describe('the DER writer underneath it', () => {
  it('writes the shortest form of a length, and the sign byte of an integer', () => {
    // Short form under 128 bytes, long form at and above it.
    expect(octetString(Buffer.alloc(3)).subarray(0, 2)).toEqual(Buffer.from([0x04, 3]))
    expect(octetString(Buffer.alloc(200)).subarray(0, 3)).toEqual(Buffer.from([0x04, 0x81, 200]))
    // 0 is one byte; 128 gains DER's leading zero so it does not read negative.
    expect(integer(0)).toEqual(Buffer.from([0x02, 0x01, 0x00]))
    expect(integer(128)).toEqual(Buffer.from([0x02, 0x02, 0x00, 0x80]))
    expect(integer(127)).toEqual(Buffer.from([0x02, 0x01, 0x7f]))
  })

  it('packs the first two arcs of an object identifier into one byte', () => {
    // 1.2.840.113549 — RSA's arc, the textbook example.
    expect(oid('1.2.840.113549')).toEqual(Buffer.from([0x06, 0x06, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d]))
    expect(() => oid('nope')).toThrow()
  })

  it('writes a BIT STRING with no unused bits, and PEM at 64 columns', () => {
    expect(bitString(Buffer.from([0xff]))).toEqual(Buffer.from([0x03, 0x02, 0x00, 0xff]))
    const text = pem('TEST', Buffer.alloc(120, 7))
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('-----BEGIN TEST-----')
    expect(lines[lines.length - 1]).toBe('-----END TEST-----')
    for (const line of lines.slice(1, -1)) expect(line.length).toBeLessThanOrEqual(64)
  })

  it('nests a SEQUENCE the way a reader expects to walk it', () => {
    const nested = sequence(integer(1), sequence(integer(2)))
    expect(nested[0]).toBe(0x30)
    expect(nested.length).toBe(2 + 3 + 5)
  })
})

/** CertificationRequest → [info, algorithm, signature], as bytes. */
function readInfo(der: Buffer): { info: Buffer; signature: Buffer } {
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
  const request = read(der, 0)
  const info = read(request.content, 0)
  const algorithm = read(request.content, info.next)
  const signature = read(request.content, algorithm.next)
  // Drop the BIT STRING's unused-bit count byte.
  return { info: Buffer.from(info.whole), signature: Buffer.from(signature.content.subarray(1)) }
}
