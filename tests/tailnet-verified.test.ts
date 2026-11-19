// PLAIN HTTP ONLY ON A VERIFIED TAILNET (owner ruling 2026-11-17, lane Magpie): an address
// counts as tailnet only when this computer's Tailscale says so, never because it looks like
// 100.64/10 or ends in .ts.net. No Tailscale, or an answer that cannot be read: not a tailnet.
import { describe, expect, it } from 'vitest'
import { createTailnetView, parseTailscaleStatus, type Tailnet } from '../src/main/route/tailnet'
import { plainRemoteProviders } from '../src/main/route/remote-ports'
import { shareUrls } from '../src/main/route/share-keys'

const STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'], DNSName: 'mac.tail1234.ts.net.' },
  Peer: { k1: { TailscaleIPs: ['100.90.1.2'], DNSName: 'solis.tail1234.ts.net.' } }
})

describe('parseTailscaleStatus', () => {
  it('reads this computer’s and its peers’ addresses and names', () => {
    const t = parseTailscaleStatus(STATUS) as Tailnet
    expect(t.self).toEqual(['100.101.102.103', 'fd7a:115c:a1e0::1', 'mac.tail1234.ts.net'])
    expect(t.peers).toEqual(['100.90.1.2', 'solis.tail1234.ts.net'])
  })

  it('knows nothing when Tailscale is not running or the answer is not its own', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped', Self: { TailscaleIPs: ['100.1.1.1'] } }))).toBeNull()
    expect(parseTailscaleStatus('not json')).toBeNull()
    expect(parseTailscaleStatus('{}')).toBeNull()
  })
})

describe('the tailnet view', () => {
  it('starts knowing nothing, learns from a read, and forgets on a failed one', async () => {
    let answer: string | null = STATUS
    const view = createTailnetView(async () => answer)
    expect(view.known()).toBeNull()
    await view.refresh()
    expect(view.known()?.peers).toContain('100.90.1.2')
    answer = null
    await view.refresh()
    expect(view.known()).toBeNull()
  })
})

describe('where it applies', () => {
  const t = parseTailscaleStatus(STATUS)
  const interfaces = {
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    utun9: [{ address: '100.64.9.9', family: 'IPv4', internal: false }]
  }

  it('gives plain http only for this computer’s own verified tailnet address', () => {
    expect(shareUrls(interfaces, 3425, t)).toEqual(['https://192.168.1.20:3425', 'http://100.101.102.103:3425', 'https://100.64.9.9:3425'])
    expect(shareUrls(interfaces, 3425, null)).toEqual(['https://192.168.1.20:3425', 'https://100.101.102.103:3425', 'https://100.64.9.9:3425'])
  })

  it('warns of plain http to anything but a verified tailnet peer', () => {
    const json = JSON.stringify({
      providers: [
        { id: 'peer', preset: 'remote-magpie', chat: 'http://100.90.1.2:3425/v1' },
        { id: 'named', preset: 'remote-magpie', chat: 'http://solis.tail1234.ts.net:3425/v1' },
        { id: 'lookalike', preset: 'remote-magpie', chat: 'http://100.80.0.1:3425/v1' },
        { id: 'fakename', preset: 'remote-magpie', chat: 'http://evil.ts.net:3425/v1' }
      ]
    })
    const env = { home: '/h', env: {} }
    expect(plainRemoteProviders(env, () => json, t).map((r) => r.id)).toEqual(['fakename', 'lookalike'])
    expect(plainRemoteProviders(env, () => json, null).map((r) => r.id)).toEqual(['fakename', 'lookalike', 'named', 'peer'])
  })
})
