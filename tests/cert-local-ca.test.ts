// THIS MAC'S OWN ROOT: made once, kept across reissues, and a serving
// certificate an iPhone will accept once the root is trusted.
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureCert, issuedByLocalCa, LEAF_DAYS, leafReplacement, localCaPem } from '../src/main/cert'

const fresh = () => mkdtempSync(path.join(tmpdir(), 'cookrew-ca-'))
const HOSTS = { ips: ['192.168.2.40', '100.68.81.64'], dnsNames: ['mac.tailnet.ts.net'] }
const DAY = 24 * 60 * 60 * 1000

describe('the local root', () => {
  it('is a CA, kept 0600, and signs a serving certificate that is NOT a CA', () => {
    const dir = fresh()
    const cert = ensureCert(HOSTS, dir)!
    const ca = new X509Certificate(localCaPem(dir)!)
    const leaf = new X509Certificate(cert.cert)
    expect(ca.ca).toBe(true)
    expect(leaf.ca).toBe(false)
    expect(issuedByLocalCa(leaf, ca)).toBe(true)
    expect(statSync(path.join(dir, 'ca-key.pem')).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(dir, 'key.pem')).mode & 0o777).toBe(0o600)
    // The chain is served whole: the serving certificate first, then the root.
    expect(readFileSync(path.join(dir, 'cert.pem'), 'utf8').match(/BEGIN CERTIFICATE/g)).toHaveLength(2)
  })

  it('serves a certificate iOS accepts: serverAuth, under 825 days, the addresses in its SANs', () => {
    const dir = fresh()
    const cert = ensureCert(HOSTS, dir)!
    const leaf = new X509Certificate(cert.cert)
    const days = (new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime()) / DAY
    expect(days).toBeLessThanOrEqual(LEAF_DAYS + 1)
    expect(days).toBeLessThan(825)
    const text = execFileSync('openssl', ['x509', '-noout', '-text'], { input: cert.cert, encoding: 'utf8' })
    expect(text).toMatch(/TLS Web Server Authentication/)
    expect(leaf.subjectAltName).toContain('IP Address:192.168.2.40')
    expect(leaf.subjectAltName).toContain('IP Address:100.68.81.64')
    expect(leaf.subjectAltName).toContain('DNS:mac.tailnet.ts.net')
  })

  it('a reissue for a new address keeps the SAME root, so a phone trusts once', () => {
    const dir = fresh()
    const first = ensureCert(HOSTS, dir)!
    const root = localCaPem(dir)!.toString()
    const again = ensureCert({ ...HOSTS, ips: [...HOSTS.ips, '10.0.0.7'] }, dir)!
    expect(again.cert.toString()).not.toBe(first.cert.toString())
    expect(localCaPem(dir)!.toString()).toBe(root)
    expect(new X509Certificate(again.cert).subjectAltName).toContain('IP Address:10.0.0.7')
    // And an unchanged host set changes nothing at all.
    expect(ensureCert({ ...HOSTS, ips: [...HOSTS.ips, '10.0.0.7'] }, dir)!.cert.toString()).toBe(again.cert.toString())
  })

  it('replaces the self-signed certificate from before the root existed', () => {
    const dir = fresh()
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '3650', '-subj', '/CN=Cookrew Mobile', '-addext', 'subjectAltName=IP:192.168.2.40,IP:100.68.81.64,DNS:mac.tailnet.ts.net'], { stdio: 'ignore' })
    const old = readFileSync(path.join(dir, 'cert.pem'), 'utf8')
    const cert = ensureCert(HOSTS, dir)!
    expect(cert.cert.toString()).not.toBe(old)
    expect(issuedByLocalCa(new X509Certificate(cert.cert), new X509Certificate(localCaPem(dir)!))).toBe(true)
  })

  it('says why a serving certificate must go: missing hosts, a foreign issuer, or a month from its end', () => {
    const dir = fresh()
    const cert = ensureCert(HOSTS, dir)!
    const leaf = new X509Certificate(cert.cert)
    const ca = new X509Certificate(localCaPem(dir)!)
    expect(leafReplacement(leaf, ca, [])).toBeNull()
    expect(leafReplacement(leaf, ca, ['10.0.0.7'])).toMatch(/missing 10.0.0.7/)
    expect(leafReplacement(ca, ca, [])).toMatch(/not issued/)
    const late = new Date(leaf.validTo).getTime() - 10 * DAY
    expect(leafReplacement(leaf, ca, [], late)).toMatch(/expire/)
  })

  it('a client that trusts ONLY the root completes a TLS handshake by bare IP', async () => {
    const dir = fresh()
    const cert = ensureCert({ ips: ['127.0.0.1'], dnsNames: [] }, dir)!
    const server = https.createServer({ key: cert.key, cert: cert.cert }, (_req, res) => res.end('hello'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const body = await new Promise<string>((resolve, reject) => {
        https
          .get({ host: '127.0.0.1', port, path: '/', ca: localCaPem(dir)!, rejectUnauthorized: true }, (res) => {
            let text = ''
            res.on('data', (chunk) => (text += chunk))
            res.on('end', () => resolve(text))
          })
          .on('error', reject)
      })
      expect(body).toBe('hello')
    } finally {
      server.close()
    }
  })
})
