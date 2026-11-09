import { describe, expect, it, vi } from 'vitest'
import { renderMobileHelp } from '../src/main/mobile-cli-text'
import { mobileEndpoints } from '../src/main/mobile-endpoints'
import { cmdMobile, type SocketServerDeps } from '../src/main/socket-server'
import type { PairingHandout } from '../src/shared/account-v2'
import type { CliRequest } from '../src/shared/model'

/**
 * `cookrew mobile` ON A MACHINE OF AN ACCOUNT (owner 2026-11-09).
 *
 * The account is the way in: the printed line is the machine's relay address
 * with nothing secret on it, and the pairing token — a bearer secret that once
 * leaked into an agent's log — is printed only when asked for with --token.
 * A machine with no account still prints its token links: it has no other door.
 */

const ID = '0189d0f2-9a4c-8f31-9c0e-2b7a5d6e1f40'
const RELAY: PairingHandout = {
  url: `https://cookrew.dev/relay/@anvztor/desktop/${ID}/#pair=SECRETTOKEN&code=SECRETCODE`,
  via: 'relay',
  desktopName: 'Solis',
  deviceId: ID
}
const endpoints = mobileEndpoints({ addresses: ['192.168.2.13'], tailnet: null, secure: true, token: 'SECRETTOKEN' })

describe('cookrew mobile on a signed-in machine', () => {
  const text = renderMobileHelp({ endpoints, pairing: RELAY, secure: true, uncovered: [], tailnet: false })

  it('prints the account way first: the relay address with no token on it', () => {
    const first = text.match(/https?:\/\/\S+/)?.[0]
    // The CLI draws its QR from the first URL in the output.
    expect(first).toBe(`https://cookrew.dev/relay/@anvztor/desktop/${ID}/`)
    expect(text).toContain('@anvztor')
    expect(text).toMatch(/passkey/)
    expect(text).toMatch(/account password/)
  })

  it('prints no token anywhere unless asked', () => {
    expect(text).not.toContain('SECRETTOKEN')
    expect(text).not.toContain('SECRETCODE')
    expect(text).not.toContain('?token=')
    expect(text).toContain('cookrew mobile --token')
  })

  it('with --token, prints today’s token links, the connect code still kept out', () => {
    const asked = renderMobileHelp({ endpoints, pairing: RELAY, secure: true, uncovered: [], tailnet: false, showToken: true })
    expect(asked).toContain('#pair=SECRETTOKEN')
    expect(asked).toContain('?token=SECRETTOKEN')
    expect(asked).not.toContain('SECRETCODE')
  })

  it('a machine with no account keeps printing its token links: it has no other door', () => {
    const direct = renderMobileHelp({
      endpoints,
      pairing: { url: 'https://192.168.2.13:8643/?token=SECRETTOKEN', via: 'direct', desktopName: 'This Mac' },
      secure: true,
      uncovered: [],
      tailnet: false
    })
    expect(direct).toContain('?token=SECRETTOKEN')
  })
})

describe('the --token flag, the way the CLI sends it', () => {
  const deps = (): SocketServerDeps =>
    ({
      rotatePairingToken: vi.fn(),
      mobileEndpoints: () => endpoints,
      uncoveredCertHosts: () => [],
      pairingHandout: () => RELAY
    }) as unknown as SocketServerDeps
  const request = (flags: Record<string, string | boolean> = {}): CliRequest => ({ id: 'r', terminalId: 't', cmd: 'mobile', args: [], flags })

  it('a plain `cookrew mobile` prints no token', () => {
    expect(cmdMobile(request(), deps())).not.toContain('SECRETTOKEN')
  })

  it('`cookrew mobile --token` prints it', () => {
    expect(cmdMobile(request({ token: true }), deps())).toContain('SECRETTOKEN')
  })
})
