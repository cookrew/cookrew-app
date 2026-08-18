import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { canonicalHost, certPlan, ensureCert, missingHosts, sansOf } from '../src/main/cert'

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

/**
 * A cert issued while Tailscale WAS up. This is the state the cellular bug
 * destroys: everything below is about keeping the three tailnet entries here
 * alive across a reissue that happens while Tailscale is down.
 */
const TAILNET_SANS = [
  'localhost',
  '127.0.0.1',
  '192.168.2.13',
  '100.101.102.103',
  'FD7A:115C:A1E0:0:0:0:5401:51A4',
  'workbench.example-tailnet.ts.net'
]

describe('certPlan — the cert may not forget the tailnet', () => {
  it('keeps the tailnet SANs when the requested set is LAN-only', () => {
    // The cellular bug exactly: Tailscale is Stopped, so readTailnet() answers
    // null and only the (new) Wi-Fi address is requested. Without retention
    // the reissued cert covers Wi-Fi and nothing else, and the phone gets a
    // name mismatch on the one address that works off the LAN.
    const plan = certPlan(TAILNET_SANS, { ips: ['192.168.5.40'], dnsNames: [] })
    expect(plan.ips).toContain('192.168.5.40')
    expect(plan.ips).toContain('100.101.102.103')
    expect(plan.ips.map(canonicalHost)).toContain('fd7a:115c:a1e0::5401:51a4')
    expect(plan.dnsNames).toContain('workbench.example-tailnet.ts.net')
  })

  it('lets a departed LAN address go', () => {
    // Retention is deliberately narrow. A LAN address belongs to a network,
    // not to this machine, so carrying every Wi-Fi ever joined would grow the
    // SAN list without end and cover addresses now owned by someone else.
    const plan = certPlan(TAILNET_SANS, { ips: ['192.168.5.40'], dnsNames: [] })
    expect(plan.ips).not.toContain('192.168.2.13')
  })

  it('does not duplicate a tailnet host that is also being requested', () => {
    const plan = certPlan(TAILNET_SANS, {
      ips: ['192.168.2.13', '100.101.102.103'],
      dnsNames: ['workbench.example-tailnet.ts.net']
    })
    expect(plan.ips.filter((ip) => ip === '100.101.102.103')).toHaveLength(1)
    expect(plan.dnsNames).toHaveLength(1)
  })

  it('is a plain pass-through when there is no previous cert', () => {
    expect(certPlan([], { ips: ['192.168.2.13'], dnsNames: [] })).toEqual({
      ips: ['192.168.2.13'],
      dnsNames: []
    })
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

  it('KEEPS the tailnet SANs when it reissues with Tailscale down', () => {
    // End to end, through real openssl: cert issued on the tailnet, then a
    // Wi-Fi change forces a reissue during a run where Tailscale never came
    // up. Before retention this is where cellular access died silently.
    const dir = freshDir()
    ensureCert(
      { ips: ['192.168.2.13', '100.101.102.103'], dnsNames: ['workbench.ts.net'] },
      dir
    )
    const before = readFileSync(path.join(dir, 'cert.pem'), 'utf8')

    const after = ensureCert({ ips: ['192.168.5.40'], dnsNames: [] }, dir)
    expect(readFileSync(path.join(dir, 'cert.pem'), 'utf8')).not.toBe(before)

    const sans = sansOf(new X509Certificate(after!.cert).subjectAltName)
    expect(sans).toContain('192.168.5.40')
    expect(sans).toContain('100.101.102.103')
    expect(sans).toContain('workbench.ts.net')
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not reissue merely because Tailscale went down', () => {
    // The retained hosts count as "already covered", so a Tailscale-down run
    // on an unchanged network leaves the cert alone — no phone is asked to
    // accept a new self-signed certificate for nothing.
    const dir = freshDir()
    ensureCert({ ips: ['192.168.2.13', '100.101.102.103'], dnsNames: [] }, dir)
    const before = readFileSync(path.join(dir, 'cert.pem'), 'utf8')
    ensureCert({ ips: ['192.168.2.13'], dnsNames: [] }, dir)
    expect(readFileSync(path.join(dir, 'cert.pem'), 'utf8')).toBe(before)
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
