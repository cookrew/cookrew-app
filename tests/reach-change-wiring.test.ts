// THE WIRING a unit test cannot run: index.ts and the two servers. Pinned by
// reading the source, the way the mobile auth tests pin the auth delegate —
// the behaviours are tested in network-watch.test.ts, reach.test.ts and
// companion-reach-wake.test.ts; this says the pieces are connected.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('an address change reaches the phone without a restart', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')
  const server = readFileSync('src/main/mobile-server.ts', 'utf8')
  const api = readFileSync('src/main/mobile-api.ts', 'utf8')

  it('the Mac watches its own addresses, on a clock and on waking', () => {
    expect(main).toContain('createNetworkWatch({')
    expect(main).toContain("powerMonitor.on('resume'")
    expect(main).toContain("powerMonitor.on('unlock-screen'")
  })

  it('a change re-issues the certificate and republishes before anything is announced', () => {
    const wiring = main.slice(main.indexOf('createNetworkWatch({'))
    expect(wiring).toContain('refreshMobileCert()')
    expect(wiring.indexOf('refreshMobileCert()')).toBeLessThan(wiring.indexOf("republish('addresses changed"))
    expect(server).toContain('export async function refreshMobileCert(')
  })

  it('an ACCEPTED card that differs is what the phone hears about — on the stream and over IPC', () => {
    expect(main).toContain('onChanged: ')
    expect(main).toContain("reachBus.emit('changed'")
    expect(main).toContain("send('reach:changed')")
    expect(api).toContain('send("reach"')
    expect(api).toContain('deps.reachBus?.on("changed"')
    expect(api).toContain('deps.reachBus?.removeListener("changed"')
  })
})

describe('the watch costs nothing to run', () => {
  it('reads the interfaces and the CACHED tailnet — never a `tailscale status` fork on its clock', () => {
    const main = readFileSync('src/main/index.ts', 'utf8')
    const server = readFileSync('src/main/mobile-server.ts', 'utf8')
    const wiring = main.slice(main.indexOf('createNetworkWatch({'), main.indexOf('networkWatch.start()'))
    expect(wiring).toContain('read: advertisedHostsNow')
    expect(wiring).not.toContain('mobileEndpointList')
    const reader = server.slice(server.indexOf('export function advertisedHostsNow'))
    expect(reader.slice(0, 200)).toContain('tailnetCache.value')
    expect(reader.slice(0, 200)).not.toContain('cachedTailnet()')
  })
})
