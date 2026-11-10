import { describe, expect, it, vi } from 'vitest'
import { renderMobileHelp } from '../src/main/mobile-cli-text'
import { mobileEndpoints } from '../src/main/mobile-endpoints'
import { cmdMobile, type SocketServerDeps } from '../src/main/socket-server'
import type { PairingHandout } from '../src/shared/account-v2'
import type { CliRequest } from '../src/shared/model'

/**
 * `cookrew mobile` ON A MACHINE OF AN ACCOUNT (owner 2026-11-09).
 *
 * The account is the way in: the printed line is the machine's own address on
 * the console (0.6.0), which is an address and nothing else, and the pairing
 * token — a bearer secret that once leaked into an agent's log — is printed
 * only when asked for with --token. A machine with no account still prints its
 * token links: it has no other door.
 */

const ID = '0189d0f2-9a4c-8f31-9c0e-2b7a5d6e1f40'
const CONSOLE: PairingHandout = {
  url: `https://console.cookrew.dev/d/${ID}`,
  via: 'console',
  desktopName: 'Solis',
  deviceId: ID
}
const endpoints = mobileEndpoints({ addresses: ['192.168.2.13'], tailnet: null, secure: true, token: 'SECRETTOKEN' })

describe('cookrew mobile on a signed-in machine', () => {
  const text = renderMobileHelp({ endpoints, pairing: CONSOLE, secure: true, uncovered: [], tailnet: false })

  it('prints the account way first: this machine’s address on the console, with nothing secret on it', () => {
    const first = text.match(/https?:\/\/\S+/)?.[0]
    // The CLI draws its QR from the first URL in the output.
    expect(first).toBe(`https://console.cookrew.dev/d/${ID}`)
    // It is the only address printed: no relay page, no token link.
    expect(text.match(/https?:\/\/\S+/g)).toEqual([`https://console.cookrew.dev/d/${ID}`])
    expect(text).not.toContain('/relay/')
    expect(text).toMatch(/passkey/)
    expect(text).toMatch(/account password/)
  })

  it('prints no token anywhere unless asked', () => {
    expect(text).not.toContain('SECRETTOKEN')
    expect(text).not.toContain('SECRETCODE')
    expect(text).not.toContain('?token=')
    // And it does not offer a flag that would print nothing here.
    expect(text).not.toContain('--token')
  })

  it('with --token, a machine of an account still prints no token: the links would open nothing', () => {
    const asked = renderMobileHelp({ endpoints, pairing: CONSOLE, secure: true, uncovered: [], tailnet: false, showToken: true })
    expect(asked).not.toContain('SECRETTOKEN')
    expect(asked).not.toContain('#pair=')
    expect(asked).toMatch(/signed in/)
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
      pairingHandout: () => CONSOLE
    }) as unknown as SocketServerDeps
  const request = (flags: Record<string, string | boolean> = {}): CliRequest => ({ id: 'r', terminalId: 't', cmd: 'mobile', args: [], flags })

  it('a plain `cookrew mobile` prints no token', () => {
    expect(cmdMobile(request(), deps())).not.toContain('SECRETTOKEN')
  })

  it('`cookrew mobile --token` prints it on a machine with no account, and not on a machine of one', () => {
    expect(cmdMobile(request({ token: true }), deps())).not.toContain('SECRETTOKEN')
    const alone = { ...deps(), pairingHandout: () => null } as unknown as SocketServerDeps
    expect(cmdMobile(request({ token: true }), alone)).toContain('SECRETTOKEN')
  })

  it('a machine of an account whose console address cannot be handed out still prints no token, with or without the flags', () => {
    // The handout is null there (pairing-handout.ts): that must not read as "no account".
    const stuck = (): SocketServerDeps => ({ ...deps(), pairingHandout: () => null, signedIn: () => true }) as unknown as SocketServerDeps
    const asked: Record<string, string | boolean>[] = [{}, { token: true }, { rotate: true }]
    for (const flags of asked) {
      const text = cmdMobile(request(flags), stuck())
      expect(text, JSON.stringify(flags)).not.toContain('SECRETTOKEN')
      expect(text, JSON.stringify(flags)).not.toContain('?token=')
    }
    expect(cmdMobile(request(), stuck())).toMatch(/signed in/)
    expect(cmdMobile(request(), stuck())).toMatch(/COOKREW_CONSOLE/)
  })

  it('`cookrew mobile --rotate` on a machine of an account prints no token either', () => {
    const rotating = deps()
    const text = cmdMobile(request({ rotate: true }), rotating)
    expect(rotating.rotatePairingToken).toHaveBeenCalledTimes(1)
    expect(text).not.toContain('SECRETTOKEN')
    expect(text).toMatch(/watch/i)
  })
})
