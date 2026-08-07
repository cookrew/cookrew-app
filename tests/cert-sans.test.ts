import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { canonicalHost, ensureCert, missingHosts, sansOf } from '../src/main/cert'

/**
 * A cert generated before Tailscale was installed. This is the real failure:
 * ensureCert cached it, the tailnet address was never in the SAN list, and
 * the phone got a name-mismatch on the ONE address that works off the LAN.
 */
const LAN_ONLY_SANS = 'DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.2.13'

describe('sansOf', () => {
  it('reads both DNS and IP entries out of a SAN string', () => {
    expect(sansOf(LAN_ONLY_SANS)).toEqual(['localhost', '127.0.0.1', '192.168.2.13'])
  })

  it('survives an empty or absent SAN extension', () => {
    expect(sansOf(undefined)).toEqual([])
    expect(sansOf('')).toEqual([])
  })
})

describe('canonicalHost — IPv6 is written two different ways', () => {
  it('matches OpenSSL’s expanded uppercase form to the OS’s compressed one', () => {
    // openssl x509 prints FD7A:115C:A1E0:0:0:0:5401:51A4; os.networkInterfaces
    // and Tailscale both report fd7a:115c:a1e0::5401:51a4. Comparing those as
    // strings says "not covered" for an address that IS covered.
    expect(canonicalHost('FD7A:115C:A1E0:0:0:0:5401:51A4')).toBe(
      canonicalHost('fd7a:115c:a1e0::5401:51a4')
    )
  })

  it('leaves IPv4 and DNS names alone apart from case', () => {
    expect(canonicalHost('192.168.2.13')).toBe('192.168.2.13')
    expect(canonicalHost('Workbench.Example.TS.net')).toBe('workbench.example.ts.net')
  })

  it('returns malformed input unchanged rather than throwing', () => {
    expect(canonicalHost('::not::valid::')).toBe('::not::valid::')
  })
})

describe('missingHosts', () => {
  it('does NOT report an IPv6 host the cert covers in expanded form', () => {
    // The regression this guards: a false "missing" here makes ensureCert
    // regenerate the cert on EVERY launch, so every paired phone and the TV
    // have to re-accept a new self-signed cert each time the app restarts.
    const sans = sansOf('DNS:localhost, IP Address:FD7A:115C:A1E0:0:0:0:5401:51A4')
    expect(missingHosts(sans, { ips: ['fd7a:115c:a1e0::5401:51a4'], dnsNames: [] })).toEqual([])
  })

  it('names the tailnet host a LAN-era cert does not cover', () => {
    const missing = missingHosts(sansOf(LAN_ONLY_SANS), {
      ips: ['192.168.2.13', '100.101.102.103'],
      dnsNames: ['workbench.example-tailnet.ts.net']
    })
    expect(missing).toEqual(['100.101.102.103', 'workbench.example-tailnet.ts.net'])
  })

  it('is empty when the cert already covers everything', () => {
    expect(
      missingHosts(sansOf(LAN_ONLY_SANS), { ips: ['192.168.2.13'], dnsNames: ['localhost'] })
    ).toEqual([])
  })
})

describe('ensureCert', () => {
  const dirs: string[] = []
  const freshDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-cert-'))
    dirs.push(dir)
    return dir
  }

  it('generates a cert covering the given IPs and DNS names', () => {
    const dir = freshDir()
    const cert = ensureCert({ ips: ['192.168.2.13'], dnsNames: ['workbench.ts.net'] }, dir)
    expect(cert).not.toBeNull()
    const sans = sansOf(new X509Certificate(cert!.cert).subjectAltName)
    expect(sans).toContain('192.168.2.13')
    expect(sans).toContain('workbench.ts.net')
    expect(sans).toContain('localhost')
    rmSync(dir, { recursive: true, force: true })
  })

  it('REGENERATES when a new host appears — the Tailscale case', () => {
    const dir = freshDir()
    const before = ensureCert({ ips: ['192.168.2.13'], dnsNames: [] }, dir)
    const beforePem = readFileSync(path.join(dir, 'cert.pem'), 'utf8')

    // Tailscale comes up after the cert was first written.
    const after = ensureCert(
      { ips: ['192.168.2.13', '100.101.102.103'], dnsNames: ['workbench.ts.net'] },
      dir
    )
    const afterPem = readFileSync(path.join(dir, 'cert.pem'), 'utf8')

    expect(afterPem).not.toBe(beforePem)
    expect(before).not.toBeNull()
    const sans = sansOf(new X509Certificate(after!.cert).subjectAltName)
    expect(sans).toContain('100.101.102.103')
    expect(sans).toContain('workbench.ts.net')
    // The LAN address must survive the regeneration.
    expect(sans).toContain('192.168.2.13')
    rmSync(dir, { recursive: true, force: true })
  })

  it('reuses the existing cert when it already covers every host', () => {
    const dir = freshDir()
    ensureCert({ ips: ['192.168.2.13'], dnsNames: [] }, dir)
    const first = readFileSync(path.join(dir, 'cert.pem'), 'utf8')
    ensureCert({ ips: ['192.168.2.13'], dnsNames: [] }, dir)
    expect(readFileSync(path.join(dir, 'cert.pem'), 'utf8')).toBe(first)
    rmSync(dir, { recursive: true, force: true })
  })
})
