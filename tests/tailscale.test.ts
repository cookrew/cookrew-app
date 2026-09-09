import { describe, expect, it } from 'vitest'
import {
  isTailnetAddress,
  isTailnetHost,
  parseTailscaleStatus,
  readTailnet,
  readTailnetAsync
} from '../src/main/tailscale'

/**
 * Shape-accurate stand-in for `tailscale status --json`. The values are
 * synthetic on purpose — a real status carries the machine's node key, the
 * owner's email and its public WAN address, none of which belong in a repo.
 * The FIELDS are the ones a real 1.94 status emits.
 */
const STATUS = JSON.stringify({
  Version: '1.94.1-t62c6f1cd7-g09fea6572',
  TUN: true,
  BackendState: 'Running',
  TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'],
  MagicDNSSuffix: 'example-tailnet.ts.net',
  CertDomains: ['workbench.example-tailnet.ts.net'],
  CurrentTailnet: {
    Name: 'someone@example.com',
    MagicDNSSuffix: 'example-tailnet.ts.net',
    MagicDNSEnabled: true
  },
  Self: {
    ID: 'nABCDEF',
    HostName: 'Workbench (1994)',
    // Real statuses carry the FQDN with a trailing dot.
    DNSName: 'workbench.example-tailnet.ts.net.',
    OS: 'macOS',
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'],
    Online: true
  },
  Peer: {}
})

describe('isTailnetAddress', () => {
  it('accepts the CGNAT range Tailscale allocates from', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true)
    expect(isTailnetAddress('100.101.102.103')).toBe(true)
    expect(isTailnetAddress('100.127.255.254')).toBe(true)
  })

  it('rejects the addresses either side of it — 100.x is NOT all Tailscale', () => {
    // 100.64.0.0/10 is 100.64 → 100.127. A naive /^100\./ test would call
    // both of these a tailnet address and mislabel a real LAN.
    expect(isTailnetAddress('100.63.255.255')).toBe(false)
    expect(isTailnetAddress('100.128.0.1')).toBe(false)
  })

  it('rejects ordinary LAN and loopback addresses', () => {
    for (const address of ['192.168.2.13', '10.0.0.4', '172.16.0.9', '127.0.0.1', '198.18.0.1']) {
      expect(isTailnetAddress(address)).toBe(false)
    }
  })

  it('accepts the tailnet IPv6 ULA prefix and rejects other v6', () => {
    expect(isTailnetAddress('fd7a:115c:a1e0::1234:5678')).toBe(true)
    expect(isTailnetAddress('FD7A:115C:A1E0::1')).toBe(true)
    expect(isTailnetAddress('fe80::6c60:fe11:ef0c:1430')).toBe(false)
  })

  it('rejects malformed input rather than throwing', () => {
    for (const junk of ['', '100', '100.64.0', '100.64.0.256', 'not-an-address']) {
      expect(isTailnetAddress(junk)).toBe(false)
    }
  })
})

describe('parseTailscaleStatus', () => {
  it('lifts the identity a phone needs to reach this machine', () => {
    const tailnet = parseTailscaleStatus(STATUS)
    expect(tailnet).not.toBeNull()
    expect(tailnet?.ips).toEqual(['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'])
    // The trailing dot is stripped — it is legal in DNS but not in a URL host.
    expect(tailnet?.magicDnsName).toBe('workbench.example-tailnet.ts.net')
    expect(tailnet?.magicDnsEnabled).toBe(true)
    expect(tailnet?.certDomains).toEqual(['workbench.example-tailnet.ts.net'])
  })

  it('reports NOT running when the backend is stopped or logged out', () => {
    for (const state of ['Stopped', 'NeedsLogin', 'NoState']) {
      const stopped = parseTailscaleStatus(JSON.stringify({ BackendState: state }))
      expect(stopped).toBeNull()
    }
  })

  it('survives a status with MagicDNS off — the IP still works', () => {
    const raw = JSON.stringify({
      BackendState: 'Running',
      TailscaleIPs: ['100.101.102.103'],
      CurrentTailnet: { MagicDNSEnabled: false },
      Self: { DNSName: '', TailscaleIPs: ['100.101.102.103'] }
    })
    const tailnet = parseTailscaleStatus(raw)
    expect(tailnet?.ips).toEqual(['100.101.102.103'])
    expect(tailnet?.magicDnsName).toBeNull()
    expect(tailnet?.magicDnsEnabled).toBe(false)
  })

  it('returns null rather than throwing on junk', () => {
    for (const junk of ['', 'not json', '{]', 'null', '[]']) {
      expect(parseTailscaleStatus(junk)).toBeNull()
    }
  })

  it('drops addresses that are not actually tailnet addresses', () => {
    // Defensive: whatever the CLI claims, only CGNAT/ULA addresses get
    // advertised as a tailnet route.
    const raw = JSON.stringify({
      BackendState: 'Running',
      TailscaleIPs: ['100.101.102.103', '192.168.2.13'],
      Self: { TailscaleIPs: ['100.101.102.103', '192.168.2.13'] }
    })
    expect(parseTailscaleStatus(raw)?.ips).toEqual(['100.101.102.103'])
  })
})

describe('readTailnet', () => {
  it('returns the identity when the CLI answers', () => {
    const tailnet = readTailnet({ run: () => STATUS, exists: () => true })
    expect(tailnet?.magicDnsName).toBe('workbench.example-tailnet.ts.net')
  })

  it('returns null when Tailscale is not installed — this is the common case', () => {
    expect(readTailnet({ run: () => STATUS, exists: () => false })).toBeNull()
  })

  it('returns null when the CLI throws instead of crashing the app', () => {
    const tailnet = readTailnet({
      run: () => {
        throw new Error('tailscaled not running')
      },
      exists: () => true
    })
    expect(tailnet).toBeNull()
  })
})

describe('readTailnetAsync', () => {
  it('does not settle until the background CLI result arrives', async () => {
    let answer!: (value: string) => void
    const pending = new Promise<string>((resolve) => {
      answer = resolve
    })
    let settled = false
    const result = readTailnetAsync({ run: () => pending, exists: () => true }).then((value) => {
      settled = true
      return value
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    answer(STATUS)
    await expect(result).resolves.toMatchObject({
      magicDnsName: 'workbench.example-tailnet.ts.net'
    })
  })

  it('degrades to no tailnet when an async probe rejects', async () => {
    await expect(
      readTailnetAsync({
        run: () => Promise.reject(new Error('tailscaled not running')),
        exists: () => true
      })
    ).resolves.toBeNull()
  })
})

describe('isTailnetHost — what a cert must never lose', () => {
  it('accepts tailnet addresses of both families and MagicDNS names', () => {
    expect(isTailnetHost('100.101.102.103')).toBe(true)
    expect(isTailnetHost('fd7a:115c:a1e0::1234:5678')).toBe(true)
    expect(isTailnetHost('FD7A:115C:A1E0:0:0:0:5401:51A4')).toBe(true)
    expect(isTailnetHost('workbench.example-tailnet.ts.net')).toBe(true)
  })

  it('rejects LAN addresses, look-alike names and empty input', () => {
    // Retention is what keeps these OUT of a cert forever: a LAN address
    // belongs to a network, not to this machine, so it may be dropped.
    expect(isTailnetHost('192.168.2.13')).toBe(false)
    expect(isTailnetHost('100.12.0.1')).toBe(false)
    expect(isTailnetHost('evil-ts.net')).toBe(false)
    expect(isTailnetHost('  ')).toBe(false)
  })
})
