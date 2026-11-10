import { machineCopy } from '../src/shared/machine-words'
import { describe, expect, it } from 'vitest'
import { parsePairingFragment } from '../src/shared/pairing-url'
import { pairingHandout } from '../src/main/pairing-handout'
import { reachCard } from '../src/main/reach'

/**
 * WHAT A MACHINE HANDS OUT TO BE SCANNED. A machine of an account hands out an
 * address (its level on the console) and no credential; a machine with no
 * account hands out its own address on the network, which carries its pairing
 * token. A token still read from a pasted `#pair=` fragment is read here.
 */

const DEVICE = '0189d0f2-9a4c-8f31-9c0e-2b7a5d6e1f40'
const TOKEN = 'a-persisted-pairing-token'

describe('reading the fragment back', () => {
  it('takes the token with or without the leading #', () => {
    expect(parsePairingFragment(`#pair=${TOKEN}`)).toBe(TOKEN)
    expect(parsePairingFragment(`pair=${TOKEN}`)).toBe(TOKEN)
  })

  it('is null for a fragment that carries something else, or nothing', () => {
    expect(parsePairingFragment('')).toBeNull()
    expect(parsePairingFragment('#')).toBeNull()
    expect(parsePairingFragment('#pair=')).toBeNull()
    expect(parsePairingFragment('#other=x')).toBeNull()
  })
})

describe('what the desktop hands its two surfaces', () => {
  const endpoints = [
    { url: 'https://mac.tail1234.ts.net:8643/?token=t', kind: 'tailscale' },
    { url: 'https://192.168.2.40:8643/?token=t', kind: 'lan' },
    { url: 'https://localhost:8643/?token=t', kind: 'loopback' }
  ]

  it('is this machine’s address on the console when it has an account: an address, with no token on it', () => {
    const handout = pairingHandout({
      account: () => ({ username: 'drej', deviceId: DEVICE, name: 'This Mac' }),
      consoleOrigin: () => 'https://console.cookrew.dev',
      endpoints: () => endpoints,
      pairingToken: () => TOKEN
    })
    expect(handout).toEqual({
      url: `https://console.cookrew.dev/d/${DEVICE}`,
      via: 'console',
      desktopName: 'This Mac',
      deviceId: DEVICE
    })
    expect(handout?.url).not.toContain(TOKEN)
  })

  it('falls back to the direct address when the console is nowhere this app would send a phone, or the id is not a machine’s', () => {
    const at = (consoleAt: string, deviceId: string): ReturnType<typeof pairingHandout> =>
      pairingHandout({ account: () => ({ username: 'drej', deviceId, name: 'This Mac' }), consoleOrigin: () => consoleAt, endpoints: () => endpoints, pairingToken: () => TOKEN })
    expect(at('javascript:alert(1)', DEVICE)?.via).toBe('direct')
    expect(at('', DEVICE)?.via).toBe('direct')
    expect(at('https://console.cookrew.dev', '../../v2/me')?.via).toBe('direct')
    expect(at('https://console.cookrew.dev/', DEVICE.toUpperCase())?.url).toBe(`https://console.cookrew.dev/d/${DEVICE}`)
  })

  it('falls back to the most reachable DIRECT address with no account', () => {
    const handout = pairingHandout({
      account: () => null,
      consoleOrigin: () => 'https://console.cookrew.dev',
      endpoints: () => endpoints,
      pairingToken: () => TOKEN
    })
    expect(handout).toEqual({
      url: 'https://mac.tail1234.ts.net:8643/?token=t',
      via: 'direct',
      desktopName: machineCopy('This Mac', process.platform)
    })
  })

  it('never offers loopback as the thing to scan', () => {
    const handout = pairingHandout({
      account: () => null,
      consoleOrigin: () => 'https://console.cookrew.dev',
      endpoints: () => [{ url: 'https://localhost:8643/?token=t', kind: 'loopback' }],
      pairingToken: () => TOKEN
    })
    expect(handout).toBeNull()
  })

  it('is nothing before the server has a token to hand out', () => {
    expect(
      pairingHandout({
        account: () => ({ username: 'drej', deviceId: DEVICE, name: 'This Mac' }),
        consoleOrigin: () => 'https://console.cookrew.dev',
        endpoints: () => endpoints,
        pairingToken: () => null
      })
    ).toBeNull()
  })
})

describe('the reach card still carries no credential', () => {
  it('publishes the addresses and neither the token nor the pairing URL', () => {
    const card = reachCard({
      deviceId: DEVICE,
      endpoints: [
        { url: `https://192.168.2.40:8643/?token=${TOKEN}`, kind: 'lan', host: '192.168.2.40' }
      ],
      certFp: 'ff'.repeat(32),
      relay: true,
      at: 0
    })
    const published = JSON.stringify(card)
    expect(published).not.toContain(TOKEN)
    expect(published).not.toContain('pair=')
    expect(published).not.toContain('token')
  })
})

describe('no link through the registry carries a credential any more', () => {
  it('nothing in the app builds the relay page’s address: that page is gone, and its link was a key', () => {
    const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const root = path.join(__dirname, '..', 'src')
    const building: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (/\.tsx?$/.test(entry.name) && /`[^`]*\/relay\/@\$\{/.test(readFileSync(file, 'utf8'))) building.push(path.relative(root, file))
      }
    }
    walk(root)
    expect(building).toEqual([])
  })
})
