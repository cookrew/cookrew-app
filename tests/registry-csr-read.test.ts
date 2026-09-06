import { describe, expect, it } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { csrDer, readCsr } from '../registry/src/csr-read'
import { ecPair, issueLeaf, makeCa, makeCsr, rsaPair, spkiFromCsr } from './support/x509-forge'

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
