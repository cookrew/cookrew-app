// THE LAN BY ADDRESS: the profile a phone installs, the route that serves it,
// the row that offers it, and the rows that tell the two LAN spellings apart.
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ensureCert, localCaPem } from '../src/main/cert'
import { caProfile, CA_PROFILE_PATH } from '../src/main/ca-profile'
import { bareNetwork, isBareOrigin } from '../src/shared/trusted-origin'
import { attemptName } from '../src/renderer/src/path/plane-race'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('the profile', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-profile-'))
  ensureCert({ ips: ['192.168.2.40'], dnsNames: [] }, dir)
  const pem = localCaPem(dir)!
  const profile = caProfile(pem)

  it('carries the root as a com.apple.security.root payload, DER in base64, and nothing else', () => {
    expect(profile).toContain('<string>com.apple.security.root</string>')
    expect(profile).toContain('<string>Configuration</string>')
    const der = /<data>\s*([\s\S]*?)\s*<\/data>/.exec(profile)![1].replace(/\s+/g, '')
    expect(Buffer.from(der, 'base64').equals(new X509Certificate(pem).raw)).toBe(true)
    expect(profile).not.toContain('PRIVATE KEY')
  })

  it('is the same profile for the same root, so a second download replaces the first', () => {
    expect(caProfile(pem)).toBe(profile)
    const uuids = [...profile.matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1])
    expect(uuids).toHaveLength(2)
    expect(new Set(uuids).size).toBe(2)
    for (const uuid of uuids) expect(uuid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-8[0-9A-F]{3}-[0-9A-F]{12}$/)
  })

  it('tells the reader where to turn trust on', () => {
    expect(profile).toContain('Certificate Trust Settings')
  })
})

describe('the route', () => {
  it('is public, behind the Host gate and above the pairing gate, and serves the profile type', () => {
    const src = readFileSync('src/main/mobile-server.ts', 'utf8')
    const host = src.indexOf('if (refuseMisdirected(request, response, companionHosts())) return')
    const route = src.indexOf('url.pathname === CA_PROFILE_PATH')
    const identity = src.indexOf('await handleIdentityRoutes(')
    expect(host).toBeGreaterThan(-1)
    expect(route).toBeGreaterThan(host)
    expect(route).toBeLessThan(identity)
    expect(src).toContain("'content-type': profile ? CA_PROFILE_TYPE : 'application/x-pem-file'")
    expect(CA_PROFILE_PATH).toBe('/cookrew-ca.mobileconfig')
  })
})

describe('the bare-address origins', () => {
  it('reads the network off a LAN or tailnet address and nothing else', () => {
    expect(bareNetwork('https://192.168.2.40:8643')).toBe('lan')
    expect(bareNetwork('https://10.0.0.7:8643')).toBe('lan')
    expect(bareNetwork('https://100.68.81.64:8643')).toBe('tailnet')
    expect(bareNetwork('https://8.8.8.8:8643')).toBeNull()
    expect(bareNetwork(`https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`)).toBeNull()
    expect(bareNetwork('not a url')).toBeNull()
    expect(isBareOrigin('https://192.168.2.40:8643')).toBe(true)
    expect(isBareOrigin(`https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`)).toBe(false)
  })

  it('gives the bare address its own row, apart from the name that spells it', () => {
    expect(attemptName(`https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`)).toBe('192.168.2.40:8643')
    expect(attemptName('https://192.168.2.40:8643')).toBe('192.168.2.40:8643 by address')
  })

  it('is never sent to the zone oracle, which answers for names only', () => {
    const src = readFileSync('src/renderer/src/path/plane-race.ts', 'utf8')
    const settle = src.slice(src.indexOf('const settleNames'))
    expect(settle.indexOf('if (isBareOrigin(probe.origin)) return probe')).toBeLessThan(settle.indexOf('await ask(probe.origin)'))
  })
})
